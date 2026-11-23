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

/** A run that made the calls whose returns `parts` holds (unless `madeHere` is false), then got them back. */
function run(id: string, parts: unknown[], { madeHere = true, parked }: { madeHere?: boolean; parked?: unknown } = {}): AgentRun {
    const calls = (parts as Array<{ tool_name: string; tool_call_id: string }>).map((part) => ({
        part_kind: "tool-call",
        tool_name: part.tool_name,
        tool_call_id: part.tool_call_id,
        args: {},
    }));
    return {
        id,
        model_messages: [
            ...(madeHere ? [{ kind: "response", parts: calls }] : []),
            { kind: "request", run_id: id, parts, instructions: "" },
        ],
        ...(parked ? { parked } : {}),
    } as unknown as AgentRun;
}

/** A run whose fill call parked on its job and has not returned. */
function parkedFill(id: string, toolName: string, toolCallId: string, table: string, result?: unknown): AgentRun {
    return {
        id,
        model_messages: [
            { kind: "response", parts: [{ part_kind: "tool-call", tool_name: toolName, tool_call_id: toolCallId, args: {} }] },
        ],
        parked: {
            version: 1,
            parked_at: "2026-11-19T12:00:00Z",
            reason: "timeout",
            requests: [{
                kind: "table_fill",
                tool_call_id: toolCallId,
                tool_name: toolName,
                correlation_id: "job-1",
                request: { type: "background_job", kind: "table_fill", job_id: "job-1" },
                state: { job_id: "job-1", table, title: "Soil carbon", rows: 300 },
                ...(result ? { result } : {}),
            }],
        },
    } as unknown as AgentRun;
}

describe("table artifacts for the end-of-run list", () => {
    it("treats read_table as a read and the other table tools as writes", () => {
        expect(isTableWriteToolName("read_table")).toBe(false);
        for (const name of ["create_table", "edit_table", "fill_table"])
            expect(isTableWriteToolName(name)).toBe(true);
        // `edit_rows` is no longer a table tool.
        expect(isTableWriteToolName("edit_rows")).toBe(false);
        expect(tableRecordFromMetadata(undefined)).toBeNull();
        expect(
            tableRecordFromMetadata({ view: { view_type: "item_list" } }),
        ).toBeNull();
    });

    it("folds several writes to one table into one entry that keeps its first call and last record, with that record's run", () => {
        const artifacts = collectTableArtifacts([
            run("run-1", [
                tableReturn("create_table", "call-1", "u-AAAAAAAA", "Created table", 0),
                tableReturn("read_table", "call-2", "u-AAAAAAAA", "Read", 0),
                tableReturn("fill_table", "call-3", "u-AAAAAAAA", "Filled 4 rows", 4),
            ]),
            run("run-2", [
                tableReturn("edit_table", "call-4", "u-BBBBBBBB", "Added a row", 9),
                tableReturn("edit_table", "call-5", "u-AAAAAAAA", "Added a column", 4),
                {
                    part_kind: "tool-return",
                    tool_name: "edit_table",
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
                recordRunId: "run-2",
            },
            {
                runId: "run-2",
                toolcallId: "call-4",
                created: false,
                record: expect.objectContaining({ change: "Added a row" }),
                recordRunId: "run-2",
            },
        ]);
    });

    it("leaves out a return that closes a call another answer made", () => {
        const closing = run("run-2", [tableReturn("fill_table", "call-1", "u-AAAAAAAA", "Filled table", 4)], { madeHere: false });
        expect(collectTableArtifacts([closing])).toEqual([]);
    });

    it("lists the table of a fill call the answer left open, from the state it parked with", () => {
        const stopped = { kind: "table_fill", job_id: "job-1", status: "done" };
        const artifacts = collectTableArtifacts([parkedFill("run-1", "create_table", "call-1", "u-CCCCCCCC", stopped)]);
        expect(artifacts).toEqual([
            {
                runId: "run-1",
                toolcallId: "call-1",
                created: true,
                recordRunId: "run-1",
                record: {
                    reference: { kind: "table", key: "u-CCCCCCCC", title: "Soil carbon" },
                    change: "",
                    summary: { rows: 300 },
                    run: "fill",
                },
            },
        ]);
    });

    it("keeps a returned record over an open fill call on the same table", () => {
        const created = run("run-1", [tableReturn("edit_table", "call-1", "u-CCCCCCCC", "Added a column", 3)]);
        const filling = parkedFill("run-2", "fill_table", "call-2", "u-CCCCCCCC");
        const [artifact] = collectTableArtifacts([created, filling]);
        expect(artifact).toMatchObject({ toolcallId: "call-1", record: { change: "Added a column" } });
    });

    it("tolerates runs without stored messages", () => {
        expect(
            collectTableArtifacts([{ id: "run-1" } as unknown as AgentRun]),
        ).toEqual([]);
    });
});
