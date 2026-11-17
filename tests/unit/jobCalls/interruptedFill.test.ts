import { describe, expect, it } from "vitest";
import type { Row, TableSpec } from "@beaver/agent-core/layouts/table";
import { interruptedFillResult } from "../../../src/services/jobCalls/interruptedFill";

const answered = (text: string) => ({ outcome: "answered" as const, provenance: "model" as const, value: { kind: "text" as const, text }, documents: [] });

function row(id: string, cells: Row["cells"] = {}, extra: Partial<Row> = {}): Row {
    return {
        id,
        ref: { kind: "item", library_ref: "u", zotero_key: `K${id.toUpperCase()}`.padEnd(8, "X") },
        ...extra,
        cells: { _reference: { outcome: "answered", provenance: "system", value: { kind: "reference", display_name: id, title: id } }, ...cells },
    };
}

function table(rows: Row[]): TableSpec {
    return {
        id: "t",
        title: "Trials",
        columns: [
            { id: "_reference", header: "Reference", type: "reference", system: true },
            { id: "method", header: "Method", type: "text", description: "What method?" },
        ],
        rows,
    } as TableSpec;
}

const coverage = {
    target: { libraryID: 1, key: "TABLE001" },
    title: "Trials",
    rows: ["a", "b", "c", "d"].map((id) => ({ row: id, columns: ["method"] })),
    rows_total: 4,
    credits_planned: 0.8,
};

describe("an interrupted fill's result", () => {
    it("counts the rows the shutdown flush saved, the failed rows, and the rest as not started", () => {
        const spec = table([
            row("a", { method: answered("RCT") }),
            row("b", { method: answered("Survey") }),
            row("c", {}, { failure: { code: "read_failed", message: "Unreadable" } } as Partial<Row>),
            row("d"),
        ]);
        const result = interruptedFillResult("job-1", coverage, spec, () => true);
        expect(result).toMatchObject({
            kind: "table_fill",
            job_id: "job-1",
            status: "done",
            interrupted: true,
            progress: { state: "done", rows_total: 4, rows_done: 3, rows_failed: 1, credits_planned: 0.8 },
            result: {
                rows_answered: 2,
                answered: 2,
                stopped_by: "shutdown",
                not_started: { shutdown: 1 },
                row_failures: { read_failed: 1 },
                failed_row_ids: ["c"],
            },
        });
    });

    it("leaves out what may not leave the device", () => {
        const spec = table([row("a"), row("b", {}, { failure: { code: "read_failed", message: "x" } } as Partial<Row>)]);
        const result = interruptedFillResult("job-1", coverage, spec, () => false);
        expect(result.result.failed_row_ids).toEqual([]);
        expect(result.result.pending).toBeNull();
    });

    it("skips covered rows deleted since", () => {
        const result = interruptedFillResult("job-1", coverage, table([row("a", { method: answered("RCT") })]), () => true);
        expect(result.result).toMatchObject({ rows_answered: 1, not_started: {} });
    });
});
