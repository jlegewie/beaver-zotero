import { describe, expect, it } from "vitest";
import type { AgentRun } from "@beaver/agent-core/agents/types";
import {
    collectTableArtifacts,
    isTableWriteToolName,
    tableRecordFromMetadata,
} from "@beaver/agent-core/run-state/tableResults";

function tableReturn(
    toolName: string,
    toolCallId: string,
    key: string,
    change: string,
    rows: number,
) {
    return {
        part_kind: "tool-return" as const,
        tool_name: toolName,
        tool_call_id: toolCallId,
        content: { ok: true },
        metadata: {
            view: {
                view_type: "table",
                record: {
                    reference: { kind: "table", key, title: `Table ${key}` },
                    change,
                    summary: { rows, columns: 2 },
                },
            },
        },
    };
}

function run(id: string, parts: unknown[]): AgentRun {
    return {
        id,
        model_messages: [
            { kind: "request", run_id: id, parts, instructions: "" },
        ],
    } as unknown as AgentRun;
}

describe("table artifacts for the end-of-run list", () => {
    it("treats read_table as a read and the other table tools as writes", () => {
        expect(isTableWriteToolName("read_table")).toBe(false);
        for (const name of ["create_table", "edit_rows", "edit_table", "fill_table"])
            expect(isTableWriteToolName(name)).toBe(true);
        expect(tableRecordFromMetadata(undefined)).toBeNull();
        expect(
            tableRecordFromMetadata({ view: { view_type: "item_list" } }),
        ).toBeNull();
    });

    it("folds several writes to one table into one entry that keeps its first call and last record", () => {
        const artifacts = collectTableArtifacts([
            run("run-1", [
                tableReturn("create_table", "call-1", "u-AAAAAAAA", "Created table", 0),
                tableReturn("read_table", "call-2", "u-AAAAAAAA", "Read", 0),
                tableReturn("fill_table", "call-3", "u-AAAAAAAA", "Filled 4 rows", 4),
            ]),
            run("run-2", [
                tableReturn("edit_rows", "call-4", "u-BBBBBBBB", "Added a row", 9),
                tableReturn("edit_table", "call-5", "u-AAAAAAAA", "Added a column", 4),
                {
                    part_kind: "tool-return",
                    tool_name: "edit_rows",
                    tool_call_id: "call-6",
                    content: { ok: false, error_code: "conflict" },
                },
            ]),
        ]);
        expect(artifacts).toEqual([
            {
                runId: "run-1",
                toolcallId: "call-1",
                created: true,
                record: expect.objectContaining({ change: "Added a column" }),
            },
            {
                runId: "run-2",
                toolcallId: "call-4",
                created: false,
                record: expect.objectContaining({ change: "Added a row" }),
            },
        ]);
    });

    it("tolerates runs without stored messages", () => {
        expect(
            collectTableArtifacts([{ id: "run-1" } as unknown as AgentRun]),
        ).toEqual([]);
    });
});
