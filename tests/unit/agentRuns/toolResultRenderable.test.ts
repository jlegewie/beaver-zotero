import { describe, expect, it } from "vitest";
import { hasRenderableResult } from "../../../react/components/agentRuns/ToolResultView";
import type { ToolReturnPart } from "@beaver/agent-core/agents/types";

function toolReturn(overrides: Partial<ToolReturnPart> = {}): ToolReturnPart {
    return {
        part_kind: "tool-return",
        tool_name: "find_book_chapters",
        tool_call_id: "call_1",
        content: { chapters: [{ title: "Introduction" }] },
        ...overrides,
    };
}

describe("hasRenderableResult", () => {
    it("is false for a tool return without a view", () => {
        expect(hasRenderableResult(toolReturn())).toBe(false);
    });

    it("is false for a view type this client does not know", () => {
        const result = toolReturn({ metadata: { view: { view_type: "chapter_list", chapters: [] } } });
        expect(hasRenderableResult(result)).toBe(false);
    });

    it("is true for a supported view", () => {
        const result = toolReturn({
            tool_name: "list_tags",
            metadata: { view: { view_type: "tag_list", tool_name: "list_tags", tags: [], total_count: 0 } },
        });
        expect(hasRenderableResult(result)).toBe(true);
    });

    it("is true for a table status without a view", () => {
        const result = toolReturn({
            tool_name: "create_table",
            content: { ok: false, error_code: "outcome_unknown" },
        });
        expect(hasRenderableResult(result)).toBe(true);
    });
});
