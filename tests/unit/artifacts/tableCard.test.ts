import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TableResultView } from "../../../react/components/agentRuns/toolResultViews/TableResultView";
import { ToolResultView } from "../../../react/components/agentRuns/ToolResultView";

const record = {
    reference: {
        kind: "table" as const,
        key: "u-ABCDEFGH",
        title: "Original title",
    },
    change: "Added a column",
    summary: { rows: 3, columns: 2 },
    saved: false,
};

describe("historical table cards", () => {
    it("renders the step summary without a provider or a full result body", () => {
        const html = renderToStaticMarkup(
            React.createElement(TableResultView, {
                view: { view_type: "table", record },
            }),
        );
        expect(html).toContain("Added a column");
        expect(html).toContain("3 rows · 2 columns");
        // A write whose bookkeeping failed reads as the success it is.
        expect(html).not.toContain("bookkeeping");
        expect(html).not.toContain("<table");
        expect(html).not.toContain("Edit table");
        expect(html).not.toContain("<button");
    });
    it("lists the change counters after the counts, singular for one", () => {
        const html = renderToStaticMarkup(
            React.createElement(TableResultView, {
                view: {
                    view_type: "table",
                    record: {
                        ...record,
                        saved: true,
                        changes: { rows_added: 1, cells_changed: 9, columns_removed: 0 },
                    },
                },
            }),
        );
        expect(html).toContain("3 rows · 2 columns");
        expect(html).toContain("1 row added · 9 cells changed");
        expect(html).not.toContain("columns removed");
        expect(html).not.toContain("Changes are committed");
    });
    it.each(["answered", "filled"])("summarizes a creation in one line of visible columns and %s cells", (count) => {
        const html = renderToStaticMarkup(
            React.createElement(TableResultView, {
                view: {
                    view_type: "table",
                    record: {
                        ...record,
                        change: "Created table",
                        saved: true,
                        summary: {
                            rows: 5,
                            columns: 4,
                            columns_detail: {
                                paper: { [count]: 5 }, _year: { system: true, [count]: 5 }, _doi: { system: true, [count]: 4 }, q: { [count]: 4 },
                            } as never,
                        },
                        changes: { rows_added: 5, columns_added: 4, cells_changed: 10 },
                    },
                },
            }),
        );
        expect(html).toContain("5 rows · 2 columns · 9 of 10 cells filled");
        expect(html).not.toContain("Created table");
        expect(html).not.toContain("rows added");
    });
    it("counts content columns and leaves system metadata out", () => {
        const html = renderToStaticMarkup(
            React.createElement(TableResultView, {
                view: {
                    view_type: "table",
                    record: {
                        ...record,
                        saved: true,
                        summary: {
                            rows: 3,
                            columns: 3,
                            columns_detail: {
                                item: {},
                                kind: { system: true, role: "row_type", distribution: { Book: 2, Article: 1 } },
                                _year: { system: true },
                            } as never,
                        },
                    },
                },
            }),
        );
        expect(html).toContain("3 rows · 1 column");
    });
    it("renders unknown outcomes as inspection instructions", () => {
        const result = {
            part_kind: "tool-return" as const,
            tool_name: "create_table",
            tool_call_id: "call",
            content: { ok: false, error_code: "outcome_unknown" },
        };
        const html = renderToStaticMarkup(
            React.createElement(ToolResultView, { result }),
        );
        expect(html).toContain("operation may have completed");
        expect(html).toContain("Inspect Zotero");
        expect(html).not.toContain("Tool results not available");
    });
    it("renders schema pauses without offering an approval editor", () => {
        const html = renderToStaticMarkup(
            React.createElement(ToolResultView, {
                result: {
                    part_kind: "tool-return",
                    tool_name: "fill_table",
                    tool_call_id: "paused-fill",
                    content: { ok: false, error_code: "schema_changed" },
                },
            }),
        );
        expect(html).toContain("Extraction paused");
        expect(html).toContain("Request a new plan in chat");
        expect(html).not.toContain("<input");
        expect(html).not.toContain("<textarea");
    });
});

describe("stage lines", () => {
    const stages = {
        rows: 12, sources: 1, columns: 3, rows_without_document: 2,
        remaining_rows: 12, remaining_cells: 36, answered: 0, metadata_only: 0, failed: 0, stale: 0,
    };
    it("says what a partial fill left and what came from metadata, and never counts rows without attachments", async () => {
        const { formatTableStages } = await import("../../../react/components/agentRuns/toolResultViews/TableResultView");
        expect(
            formatTableStages({ ...record, change: "Created table", run: "none", stages }),
        ).toEqual([]);
        expect(
            formatTableStages({ ...record, change: "Filled table", stages: { ...stages, answered: 9, remaining_rows: 9 } }),
        ).toEqual(["9 rows still to fill"]);
        expect(
            formatTableStages({ ...record, change: "Read table", stages: { ...stages, answered: 4, remaining_rows: 0, metadata_only: 4 } }),
        ).toEqual(["4 answers from title and abstract only"]);
        expect(formatTableStages(record)).toEqual([]);
    });
});

describe("recorded columns", () => {
    const columns = [
        { id: "country", header: "Country studied", type: "text", description: "What country does the study analyze?" },
        { id: "design", header: "Study design", type: "select", options: ["RCT", "Observational", "Other"] },
    ];
    const created = {
        ...record,
        change: "Created table",
        saved: true,
        description: "Compare studies by country and design.",
        sources: [
            { id: "s1", type: "library", kind: "collection", name: "Gender & Labor Market", library_ref: "u", rows: 10 },
            { id: "s2", type: "items", rows: 2 },
        ],
        columns,
        summary: {
            rows: 12,
            columns: 4,
            columns_detail: {
                _reference: { system: true, answered: 12 },
                _year: { system: true, answered: 12 },
                country: { answered: 0 },
                design: { answered: 0 },
            } as never,
        },
        changes: { rows_added: 12, columns_added: 4 },
    };
    const render = (value: typeof created) =>
        renderToStaticMarkup(
            React.createElement(TableResultView, { view: { view_type: "table", record: value } }),
        );

    it("renders the description and each question column from the record alone", () => {
        const html = render(created);
        expect(html).toContain("Compare studies by country and design.");
        expect(html).toContain("Country studied");
        expect(html).toContain("What country does the study analyze?");
        // Each column carries the create card's type tag; a category column
        // shows its options as chips.
        expect(html).toContain(">Text</span>");
        expect(html).toContain(">Category</span>");
        expect(html).toContain('<span class="table-card-option">Observational</span>');
        expect(html).toContain("12 rows · 2 columns · not filled yet");
        expect(html).not.toContain("attachment");
        expect(html).not.toContain("Created table");
    });
    it("names each source with the rows it added", () => {
        const html = render(created);
        expect(html).toContain(">Sources<");
        expect(html).toContain("Gender &amp; Labor Market");
        expect(html).toContain("10 rows");
        expect(html).toContain("Selected items");
        expect(html).toContain("2 rows");
        expect(html.indexOf(">Sources<")).toBeLessThan(html.indexOf(">Columns<"));
    });
    it("shows per-column progress once anything is answered", () => {
        const html = render({
            ...created,
            summary: {
                ...created.summary,
                columns_detail: { ...(created.summary.columns_detail as object), country: { answered: 8 }, design: { answered: 12 } } as never,
            },
        });
        expect(html).toContain("8/12");
        expect(html).toContain("12/12");
        expect(html).toContain("20 of 24 cells filled");
    });
});

describe("fill stage card", () => {
    const outcomes = JSON.parse(
        readFileSync(join(__dirname, "../../fixtures/artifacts/table-tool-outcomes.json"), "utf8"),
    );

    it("says what the fill did from the recorded call", async () => {
        const { formatFillLines } = await import("../../../react/components/agentRuns/toolResultViews/TableResultView");
        expect(formatFillLines(outcomes.fill_record)).toEqual([
            "Filled 5 of 14 rows",
            "9 rows not started: more credits were not approved",
        ]);
        const html = renderToStaticMarkup(
            React.createElement(TableResultView, { view: { view_type: "table", record: outcomes.fill_record } }),
        );
        expect(html).toContain("Filled 5 of 14 rows");
        expect(html).toContain("9 rows still to fill");
    });

    it("lists failures, skipped cells, metadata answers and credits, and nothing for a call that ran no fill", async () => {
        const { formatFillLines } = await import("../../../react/components/agentRuns/toolResultViews/TableResultView");
        const fill = {
            ...outcomes.fill_record.fill,
            rows: 20,
            rows_filled: 17,
            rows_failed: 2,
            rows_not_started: { deadline: 1 },
            rows_without_input: 3,
            rows_uncertain: 1,
            from_metadata: 4,
            skipped: { user_cell: 1, row_removed: 2 },
            credits_charged: 6.5,
        };
        expect(formatFillLines({ ...outcomes.fill_record, fill })).toEqual([
            "Filled 17 of 20 rows",
            "2 rows failed",
            "1 row not started: the fill ran out of time",
            "1 row answered but not confirmed saved",
            "3 rows without a document or abstract",
            "4 answers from title and abstract only",
            "1 cell skipped: edited by you",
            "2 cells skipped: row removed during the fill",
            "6.5 credits charged",
        ]);
        expect(formatFillLines({ ...outcomes.fill_record, run: "none" })).toEqual([]);
        expect(formatFillLines(record)).toEqual([]);
    });

    it("words a declined fill card as a fill, not a creation", () => {
        const html = renderToStaticMarkup(
            React.createElement(ToolResultView, {
                result: {
                    part_kind: "tool-return",
                    tool_name: "fill_table",
                    tool_call_id: "declined-fill",
                    content: { ok: false, error_code: "declined", error: "The user declined the fill. Nothing was filled." },
                },
            }),
        );
        expect(html).toContain("The fill was declined. Nothing was filled.");
        expect(html).not.toContain("Nothing was created");
        const credits = renderToStaticMarkup(
            React.createElement(ToolResultView, {
                result: {
                    part_kind: "tool-return",
                    tool_name: "fill_table",
                    tool_call_id: "credits",
                    content: { ok: false, error_code: "credits_declined", error: "x" },
                },
            }),
        );
        expect(credits).toContain("More credits were declined earlier in this run");
    });

    it("says when a created table's fill did not run", () => {
        const html = renderToStaticMarkup(
            React.createElement(ToolResultView, {
                result: {
                    part_kind: "tool-return",
                    tool_name: "create_table",
                    tool_call_id: "create-and-fill",
                    content: { ok: true, run: "none", fill_error: "Zotero stopped responding, so the fill did not run." },
                },
            }),
        );
        expect(html).toContain("The table was created, but the fill did not run.");
        expect(html).not.toContain("Zotero stopped responding, so the fill");
    });
});

describe("statuses written for the model", () => {
    it("shows its own words when Zotero stopped responding, not the instructions to the model", () => {
        const html = renderToStaticMarkup(
            React.createElement(ToolResultView, {
                result: {
                    part_kind: "tool-return",
                    tool_name: "fill_table",
                    tool_call_id: "unresponsive",
                    content: {
                        ok: false,
                        error_code: "zotero_unresponsive",
                        error: "Zotero stopped responding, so the fill did not run. Do not retry this or any other change to the library in this turn; tell the user Zotero stopped responding.",
                    },
                },
            }),
        );
        expect(html).toContain("Zotero stopped responding, so the table operation did not finish.");
        expect(html).not.toContain("Do not retry");
    });
});
