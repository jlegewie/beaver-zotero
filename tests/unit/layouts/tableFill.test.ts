/**
 * Fill selection and pending work: `cellsToFill` against the shared
 * `table-fill-selection` cases, `pendingWork` against the plugin's
 * `table-pending` cases, and the row failure rules.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { TableSpec } from "@beaver/agent-core/layouts/table";
import {
    PERMANENT_ROW_FAILURE_CODES,
    TableSelectionError,
    cellsToFill,
    pendingWork,
    rereadRows,
    retryableFailedRows,
    rowBlocked,
    rowFailure,
    type PendingWork,
} from "@beaver/agent-core/layouts/tableFill";

const fixturesDir = fileURLToPath(new URL("../../fixtures/artifacts/", import.meta.url));

function loadFixtures<T>(directory: string): { file: string; fixture: T }[] {
    const dir = path.join(fixturesDir, directory);
    return readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => ({ file, fixture: JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T }));
}

interface SelectionFixture {
    name: string;
    spec: TableSpec;
    rows?: string[];
    columns?: string[];
    blocked: string[];
    cells: [string, string][];
}

interface PendingFixture {
    name: string;
    spec: TableSpec;
    pending: PendingWork;
}

describe("the table-fill-selection fixture corpus", () => {
    const fixtures = loadFixtures<SelectionFixture>("table-fill-selection");
    it("is not empty", () => expect(fixtures.length).toBeGreaterThan(0));
    for (const { file, fixture } of fixtures) {
        it(`${file}: ${fixture.name}`, () => {
            expect(cellsToFill(fixture.spec, { rows: fixture.rows, columns: fixture.columns })).toEqual(fixture.cells);
            expect(fixture.spec.rows.filter(rowBlocked).map((row) => row.id)).toEqual(fixture.blocked);
        });
    }
});

describe("the table-pending fixture corpus", () => {
    const fixtures = loadFixtures<PendingFixture>("table-pending");
    it("is not empty", () => expect(fixtures.length).toBeGreaterThan(0));
    for (const { file, fixture } of fixtures) {
        it(`${file}: ${fixture.name}`, () => {
            expect(pendingWork(fixture.spec)).toEqual(fixture.pending);
        });
    }
});

describe("cellsToFill", () => {
    const spec: TableSpec = {
        id: "t",
        columns: [
            { id: "_reference", header: "Reference", type: "reference", system: true },
            { id: "method", header: "Method", type: "text" },
            { id: "decision_x", header: "Unknown", type: "text", role: "something_new" },
        ],
        rows: [{ id: "r1", cells: {} }],
    };

    it("never selects a system column or a column of a role it does not know", () => {
        expect(cellsToFill(spec)).toEqual([["r1", "method"]]);
    });

    it("refuses a row or column the table does not have, or one a filler does not answer", () => {
        expect(() => cellsToFill(spec, { rows: ["nope"] })).toThrow(TableSelectionError);
        expect(() => cellsToFill(spec, { columns: ["nope"] })).toThrow(/does not exist/);
        expect(() => cellsToFill(spec, { columns: ["_reference"] })).toThrow(/not filled/);
    });
});

describe("row failures", () => {
    it("blocks only on permanent failures", () => {
        expect(rowBlocked({ failure: { code: "encrypted", message: "x" } })).toBe(true);
        expect(rowBlocked({ failure: { code: "timeout", message: "x" } })).toBe(false);
        expect(rowBlocked({})).toBe(false);
        expect(PERMANENT_ROW_FAILURE_CODES.has("library_excluded")).toBe(false);
    });

    it("gives each code its message, and reads an unknown code as an unreadable document", () => {
        expect(rowFailure("encrypted")).toEqual({ code: "encrypted", message: "The PDF is password-protected." });
        expect(rowFailure("made_up")).toEqual({ code: "read_failed", message: "The document could not be read." });
        expect(rowFailure("toString").code).toBe("read_failed");
    });

    it("names the rows a retry would work on: failed, and not blocked", () => {
        const spec: TableSpec = {
            id: "t",
            columns: [],
            rows: [
                { id: "a", cells: {}, failure: { code: "encrypted", message: "x" } },
                { id: "b", cells: {}, failure: { code: "deadline", message: "x" } },
                { id: "c", cells: {} },
            ],
        };
        expect(retryableFailedRows(spec)).toEqual(["b"]);
    });
});

describe("rereadRows", () => {
    const answer = { outcome: "answered", provenance: "model", value: { kind: "text", text: "x" }, documents: ["u-A"] } as const;
    const stale = { ...answer, stale: true } as const;
    const columns = [
        { id: "method", header: "Method", type: "text" },
        { id: "sample", header: "Sample", type: "text" },
    ] as TableSpec["columns"];
    const table = (rows: TableSpec["rows"]): TableSpec => ({ id: "t", title: "T", columns, rows });
    /** The default fill's rows, with the columns each answers. */
    const planRows = (spec: TableSpec) => {
        const byRow = new Map<string, string[]>();
        for (const [row, column] of cellsToFill(spec)) byRow.set(row, [...(byRow.get(row) ?? []), column]);
        return [...byRow].map(([row, cols]) => ({ row, columns: cols }));
    };
    const row = (id: string, cells: TableSpec["rows"][number]["cells"] = {}, extra = {}) => ({
        id,
        documents: ["u-A"],
        cells,
        ...extra,
    });

    it("is empty for a first fill", () => {
        const spec = table([row("a"), row("b")]);
        expect(rereadRows(spec, planRows(spec))).toEqual([]);
    });

    it("is empty for rows added to a filled table", () => {
        const spec = table([row("a", { method: answer, sample: answer }), row("b"), row("c")]);
        expect(rereadRows(spec, planRows(spec))).toEqual([]);
    });

    it("is empty for a retry of failed rows", () => {
        const spec = table([
            row("a", { method: answer, sample: answer }),
            row("b", {}, { failure: { code: "timeout", message: "Took too long." } }),
        ]);
        expect(rereadRows(spec, planRows(spec))).toEqual([]);
        expect(rereadRows(spec, retryableFailedRows(spec).map((id) => ({ row: id, columns: ["method", "sample"] })))).toEqual([]);
    });

    it("names answered rows that failed on a new column: a retry reads them again", () => {
        const failure = { code: "timeout", message: "Took too long." };
        const spec = table([row("a", { method: answer }, { failure }), row("b", { method: answer }, { failure })]);
        expect(rereadRows(spec, planRows(spec))).toEqual(["a", "b"]);
    });

    it("names the rows a changed question reads again in a table of one question", () => {
        const one = { ...table([row("a", { method: stale }), row("b", { method: stale })]), columns: [columns[0]] };
        expect(rereadRows(one, planRows(one))).toEqual(["a", "b"]);
    });

    it("names the answered rows a changed question reads again", () => {
        const spec = table([row("a", { method: stale, sample: answer }), row("b", { method: stale, sample: answer }), row("c")]);
        expect(rereadRows(spec, planRows(spec))).toEqual(["a", "b"]);
    });

    it("names the answered rows a column added to a filled table reads", () => {
        const spec = table([row("a", { method: answer }), row("b", { method: answer })]);
        expect(rereadRows(spec, planRows(spec))).toEqual(["a", "b"]);
    });

    it("is empty once a trial answered the new question: the rest are its empty cells", () => {
        const spec = table([row("a", { method: answer, sample: answer }), row("b", { method: answer }), row("c", { method: answer })]);
        expect(rereadRows(spec, planRows(spec))).toEqual([]);
    });

    it("does not count a row whose document changed, which is read again whole", () => {
        const spec = table([
            row("a", { method: answer, sample: answer }),
            row("b", { method: answer, sample: answer }, { documents: ["u-B"] }),
        ]);
        expect(rereadRows(spec, planRows(spec))).toEqual([]);
    });

    it("counts a user's correction of the filler's answer: that paper was read", () => {
        const corrected = { outcome: "answered", provenance: "user", value: { kind: "text", text: "mine" }, replaced: answer } as const;
        const spec = table([row("a", { method: corrected }), row("b", { method: answer })]);
        expect(rereadRows(spec, planRows(spec))).toEqual(["a", "b"]);
    });

    it("counts only the filler's answers, not the user's", () => {
        const user = { outcome: "answered", provenance: "user", value: { kind: "text", text: "mine" } } as const;
        const spec = table([row("a", { method: user }), row("b", { method: user })]);
        expect(rereadRows(spec, planRows(spec))).toEqual([]);
    });
});
