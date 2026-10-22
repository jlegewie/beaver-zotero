import React from "react";
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
        expect(html).toContain("Changes are committed");
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
    it("summarizes a creation in one line of visible columns and filled cells", () => {
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
                                paper: { filled: 5 }, _year: { system: true, filled: 5 }, _doi: { system: true, filled: 4 }, q: { filled: 4 },
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
