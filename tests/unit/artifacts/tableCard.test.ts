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
    it("lists the change counters on their own line, singular for one", () => {
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
