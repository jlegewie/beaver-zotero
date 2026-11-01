/**
 * The engine's rules for columns and user cells: option renames and removals,
 * type changes, existing answers, staleness on user cells and what they
 * replaced, column revisions, `replaced` and `restore_cell`, removed papers.
 */
import { describe, expect, it } from "vitest";
import { applyMutations, type TableMutation } from "@beaver/agent-core/layouts/tableMutations";
import { isStale, validateTableSpec, type Cell, type TableSpec } from "@beaver/agent-core/layouts/table";
import { cellsToFill } from "@beaver/agent-core/layouts/tableFill";

const DOC = "u-AAAAAPDF";

function model(label: string, extra: Partial<Cell> = {}): Cell {
    return {
        outcome: "answered",
        provenance: "model",
        value: { kind: "select", label },
        documents: [DOC],
        evidence: [{ document: DOC, locator: "s1", quote: "Assigned by lottery." }],
        reasoning: "The paper says so.",
        ...extra,
    } as Cell;
}

function table(): TableSpec {
    return {
        id: "t",
        spec_version: 2,
        columns: [
            { id: "_reference", header: "Reference", type: "reference", system: true },
            {
                id: "design",
                header: "Design",
                type: "select",
                description: "What is the design?",
                options: [
                    { label: "RCT", color: "blue", description: "Random assignment." },
                    { label: "Observational", color: "green" },
                    { label: "Other", color: "yellow" },
                ],
            },
            { id: "n", header: "N", type: "text", description: "How many?" },
        ],
        rows: [
            { id: "r1", ref: { kind: "item", library_ref: "u", zotero_key: "AAAAAAAA" }, documents: [DOC], cells: { design: model("RCT"), n: { outcome: "answered", provenance: "model", value: { kind: "text", text: "10" }, documents: [DOC] } } },
            { id: "r2", ref: { kind: "item", library_ref: "u", zotero_key: "BBBBBBBB" }, documents: [DOC], cells: { design: model("Observational") } },
            { id: "r3", ref: { kind: "item", library_ref: "u", zotero_key: "CCCCCCCC" }, documents: [DOC], cells: { design: model("Other") } },
        ],
    };
}

function apply(spec: TableSpec, ...mutations: TableMutation[]) {
    const result = applyMutations(spec, mutations);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(validateTableSpec(result.spec).filter((i) => i.code === "invalid_cell")).toEqual([]);
    return result;
}

function correct(spec: TableSpec, row: string, label: string, reasoning?: string) {
    return apply(spec, { op: "set_cells", cells: [{ row, column: "design", cell: { outcome: "answered", provenance: "user", value: { kind: "select", label }, ...(reasoning ? { reasoning } : {}) } as Cell }] }).spec;
}

const design = (spec: TableSpec) => spec.columns.find((c) => c.id === "design")!;
const cell = (spec: TableSpec, row: string, column = "design") => spec.rows.find((r) => r.id === row)!.cells[column];

describe("a user cell keeps the model answer it replaced", () => {
    it("takes the model cell on a correction, a clear and a Not reported mark", () => {
        let spec = correct(table(), "r1", "Observational", "Natural experiment.");
        expect(cell(spec, "r1")).toMatchObject({ provenance: "user", value: { label: "Observational" }, replaced: { provenance: "model", value: { label: "RCT" } } });
        spec = apply(spec, { op: "set_cells", cells: [{ row: "r2", column: "design", cell: { outcome: "cleared", provenance: "user" } }] }).spec;
        expect(cell(spec, "r2").replaced?.value).toEqual({ kind: "select", label: "Observational" });
        spec = apply(spec, { op: "set_cells", cells: [{ row: "r3", column: "design", cell: { outcome: "not_reported", provenance: "user", reasoning: "Not stated." } }] }).spec;
        expect(cell(spec, "r3")).toMatchObject({ outcome: "not_reported", provenance: "user", replaced: { value: { label: "Other" } } });
    });
    it("inherits the replaced answer when the user edits their own cell again", () => {
        let spec = correct(table(), "r1", "Observational");
        spec = correct(spec, "r1", "Other");
        expect(cell(spec, "r1").replaced?.value).toEqual({ kind: "select", label: "RCT" });
    });
    it("drops the replaced evidence, then the field, over the cell's caps", () => {
        const long = "x".repeat(700);
        const base = table();
        base.rows[0].cells.design = model("RCT", { reasoning: long });
        let spec = correct(base, "r1", "Observational", "y".repeat(200));
        expect(cell(spec, "r1").replaced).toMatchObject({ reasoning: long });
        spec = correct(base, "r1", "Observational", "y".repeat(400));
        expect(cell(spec, "r1").replaced).toBeUndefined();
    });
    it("is never selected by a fill", () => {
        const spec = correct(table(), "r1", "Observational");
        expect(cellsToFill(spec, { rows: ["r1"] }).some(([row, column]) => row === "r1" && column === "design")).toBe(false);
    });
});

describe("restore_cell", () => {
    it("restores a valid replaced answer with its stale flag", () => {
        let spec = correct(table(), "r1", "Observational");
        spec = apply(spec, { op: "update_column", column: "design", description: "Which design, as the authors say?" }).spec;
        expect(cell(spec, "r1")).toMatchObject({ provenance: "user", stale: true, replaced: { stale: true } });
        spec = apply(spec, { op: "restore_cell", row: "r1", column: "design" }).spec;
        expect(cell(spec, "r1")).toMatchObject({ provenance: "model", value: { label: "RCT" }, stale: true });
        expect(cell(spec, "r1").replaced).toBeUndefined();
        expect(isStale(spec.rows[0], cell(spec, "r1"))).toBe(true);
    });
    it("deletes the cell when its replaced label was removed", () => {
        let spec = correct(table(), "r1", "Observational");
        spec = apply(spec, { op: "update_column", column: "design", options: [{ label: "Observational" }, { label: "Other" }] }).spec;
        // The removed label goes from replaced; the user's value stays.
        expect(cell(spec, "r1")).toMatchObject({ provenance: "user", value: { label: "Observational" } });
        expect(cell(spec, "r1").replaced).toBeUndefined();
        spec = apply(spec, { op: "restore_cell", row: "r1", column: "design" }).spec;
        expect(cell(spec, "r1")).toBeUndefined();
    });
    it("deletes the cell after a type change and when nothing was replaced", () => {
        let spec = apply(table(), { op: "set_cells", cells: [{ row: "r1", column: "n", cell: null }] }).spec;
        spec = apply(spec, { op: "set_cells", cells: [{ row: "r1", column: "n", cell: { outcome: "answered", provenance: "user", value: { kind: "text", text: "12" } } }] }).spec;
        spec = apply(spec, { op: "restore_cell", row: "r1", column: "n" }).spec;
        expect(cell(spec, "r1", "n")).toBeUndefined();
        // A user cell whose replaced no longer fits the column type.
        const fitted = table();
        fitted.rows[0].cells.n = { outcome: "answered", provenance: "user", value: { kind: "text", text: "12" }, replaced: { outcome: "answered", provenance: "model", value: { kind: "select", label: "RCT" } } } as Cell;
        spec = apply(fitted, { op: "restore_cell", row: "r1", column: "n" }).spec;
        expect(cell(spec, "r1", "n")).toBeUndefined();
    });
    it("restores a replaced label respelled by a rename", () => {
        let spec = correct(table(), "r1", "Observational");
        spec = apply(spec, { op: "update_column", column: "design", options: [{ label: "Randomized trial", previous_label: "RCT" }, { label: "Observational" }, { label: "Other" }] }).spec;
        expect(cell(spec, "r1").replaced?.value).toEqual({ kind: "select", label: "Randomized trial" });
        spec = apply(spec, { op: "restore_cell", row: "r1", column: "design" }).spec;
        expect(cell(spec, "r1")).toMatchObject({ provenance: "model", value: { label: "Randomized trial" } });
        expect(cell(spec, "r1").stale).toBeUndefined();
    });
    it("leaves a model cell alone", () => {
        const spec = apply(table(), { op: "restore_cell", row: "r1", column: "design" }).spec;
        expect(cell(spec, "r1")).toEqual(table().rows[0].cells.design);
    });
});

describe("update_column", () => {
    it("renames an option and relabels its cells without staleness, keeping colour and definition", () => {
        const result = apply(table(), { op: "update_column", column: "design", options: [{ label: "Randomized trial", previous_label: "RCT" }, { label: "Observational" }, { label: "Other" }] });
        expect(design(result.spec).options![0]).toEqual({ label: "Randomized trial", color: "blue", description: "Random assignment." });
        expect(cell(result.spec, "r1")).toMatchObject({ value: { label: "Randomized trial" } });
        expect(cell(result.spec, "r1").stale).toBeUndefined();
        expect(result.reports[0]).toEqual({ relabelled: 1 });
    });
    it("clears the cells of a removed option, user cells included", () => {
        let spec = correct(table(), "r3", "Observational");
        spec = apply(spec, { op: "set_cells", cells: [{ row: "r3", column: "design", cell: { outcome: "answered", provenance: "user", value: { kind: "select", label: "Other" } } }] }).spec;
        const result = apply(spec, { op: "update_column", column: "design", options: [{ label: "RCT" }, { label: "Observational" }] });
        expect(cell(result.spec, "r3")).toBeUndefined();
        expect(result.reports[0]).toMatchObject({ cleared: 1, user_cleared: 1 });
        expect(design(result.spec).options!.map((o) => o.label)).toEqual(["RCT", "Observational"]);
    });
    it("marks surviving answers stale when a defined option is removed, not an undefined one", () => {
        let spec = correct(table(), "r2", "Other");
        const removed = apply(spec, { op: "update_column", column: "design", options: [{ label: "Observational" }, { label: "Other" }] });
        expect(cell(removed.spec, "r1")).toBeUndefined();
        expect(cell(removed.spec, "r3")).toMatchObject({ stale: true });
        expect(cell(removed.spec, "r2")).toMatchObject({ provenance: "user", stale: true, replaced: { stale: true } });
        spec = table();
        const plain = apply(spec, { op: "update_column", column: "design", options: [{ label: "RCT" }, { label: "Observational" }] });
        expect(cell(plain.spec, "r1").stale).toBeUndefined();
    });
    it("adds an option without a definition with no staleness", () => {
        const result = apply(table(), { op: "update_column", column: "design", options: [{ label: "RCT" }, { label: "Observational" }, { label: "Other" }, { label: "Case study" }] });
        expect(result.spec.rows.every((row) => !row.cells.design.stale)).toBe(true);
        expect(design(result.spec).options![3].color).toBeDefined();
    });
    it("marks user cells and their replaced answers stale when the question changes", () => {
        let spec = correct(table(), "r1", "Observational");
        const result = apply(spec, { op: "update_column", column: "design", description: "Which design?" });
        expect(result.reports[0].stale).toBe(3);
        spec = result.spec;
        expect(cell(spec, "r1")).toMatchObject({ stale: true, replaced: { stale: true } });
    });
    it("lets existing_answers keep or refill override the question hash", () => {
        const kept = apply(table(), { op: "update_column", column: "design", description: "What design?", existing_answers: "keep" });
        expect(kept.spec.rows.every((row) => !row.cells.design.stale)).toBe(true);
        expect(design(kept.spec).revision).toBe(1);
        const refilled = apply(table(), { op: "update_column", column: "design", header: "Study design", existing_answers: "refill" });
        expect(refilled.spec.rows.every((row) => row.cells.design.stale)).toBe(true);
        expect(design(refilled.spec).revision).toBe(1);
    });
    it("clears the column on a type change, user cells included, and asks options of a select", () => {
        const spec = correct(table(), "r1", "Observational");
        const result = apply(spec, { op: "update_column", column: "design", type: "text" });
        expect(result.spec.rows.every((row) => !row.cells.design)).toBe(true);
        expect(result.reports[0]).toMatchObject({ cleared: 3, user_cleared: 1 });
        expect(design(result.spec)).toMatchObject({ type: "text", revision: 1 });
        expect(design(result.spec).options).toBeUndefined();
        const refused = applyMutations(table(), [{ op: "update_column", column: "n", type: "select" }]);
        expect(refused).toMatchObject({ ok: false, error: { code: "invalid_mutation" } });
        const select = apply(table(), { op: "update_column", column: "n", type: "select", options: [{ label: "Small" }, { label: "Large" }] });
        expect(design(select.spec)).toBeDefined();
        expect(select.spec.columns.find((c) => c.id === "n")).toMatchObject({ type: "select", options: [{ label: "Small" }, { label: "Large" }] });
    });
    it("increments the revision for every option edit but not for a header or colour change", () => {
        const revision = (mutation: Omit<TableMutation & { op: "update_column" }, "op" | "column">) =>
            design(apply(table(), { op: "update_column", column: "design", ...mutation } as TableMutation).spec).revision ?? 0;
        expect(revision({ header: "Study design" })).toBe(0);
        expect(revision({ options: [{ label: "RCT", color: "red" }, { label: "Observational" }, { label: "Other" }] })).toBe(0);
        expect(revision({ options: [{ label: "Randomized", previous_label: "RCT" }, { label: "Observational" }, { label: "Other" }] })).toBe(1);
        expect(revision({ options: [{ label: "RCT" }, { label: "Observational" }, { label: "Other" }, { label: "New" }] })).toBe(1);
        expect(revision({ options: [{ label: "RCT" }, { label: "Observational" }] })).toBe(1);
        expect(revision({ options: [{ label: "RCT", description: "Lottery." }, { label: "Observational" }, { label: "Other" }] })).toBe(1);
        expect(revision({ description: "New question?" })).toBe(1);
    });
    it("refuses a rename of a label the column lacks, atomically", () => {
        const before = table();
        const result = applyMutations(before, [
            { op: "set_meta", title: "X" },
            { op: "update_column", column: "design", options: [{ label: "Trial", previous_label: "Cohort" }] },
        ]);
        expect(result).toMatchObject({ ok: false, error: { code: "invalid_mutation" } });
        expect(before.title).toBeUndefined();
    });
});

describe("removed papers", () => {
    it("are remembered by an explicit removal and restored by adding the paper again", () => {
        const spec = apply(table(), { op: "remove_rows", rows: ["r2"], removed_at: "2026-10-31T12:00:00.000Z" }).spec;
        expect(spec.removed).toEqual([{ ref: { kind: "item", library_ref: "u", zotero_key: "BBBBBBBB" }, removed_at: "2026-10-31T12:00:00.000Z" }]);
        const result = apply(spec, { op: "add_rows", rows: [{ id: "r9", ref: { kind: "item", library_ref: "u", zotero_key: "BBBBBBBB" }, cells: {} }] });
        expect(result.spec.removed).toBeUndefined();
        expect(result.reports[0]).toEqual({ rows_added: 1, rows_restored: 1 });
    });
    it("are not remembered when a row leaves with its source", () => {
        const base = table();
        base.sources = [{ id: "s1", type: "items", ids: ["u-AAAAAAAA"] }];
        base.rows[0].origin = [{ source: "s1", date: "2026-10-30" }];
        const result = apply(base, { op: "remove_sources", sources: ["s1"] });
        expect(result.spec.rows.map((r) => r.id)).toEqual(["r2", "r3"]);
        expect(result.spec.removed).toBeUndefined();
        expect(result.reports[0]).toEqual({ rows_removed: 1 });
    });
});

describe("add_columns and add_sources", () => {
    it("places columns after a given column", () => {
        const result = apply(table(), { op: "add_columns", columns: [{ id: "a", header: "A", type: "text" }, { id: "b", header: "B", type: "text" }], after: "_reference" });
        expect(result.spec.columns.map((c) => c.id)).toEqual(["_reference", "a", "b", "design", "n"]);
    });
    it("appends ids to the items entry once and refuses a duplicate library entry", () => {
        const base = table();
        base.sources = [{ id: "s1", type: "items", ids: ["u-AAAAAAAA"] }, { id: "s2", type: "library", scope: { kind: "tag", library_ref: "u", tag: "x" } }];
        const result = apply(base, { op: "add_sources", sources: [{ id: "s1", type: "items", ids: ["u-AAAAAAAA", "u-DDDDDDDD"] }] });
        expect(result.spec.sources![0].ids).toEqual(["u-AAAAAAAA", "u-DDDDDDDD"]);
        expect(applyMutations(base, [{ op: "add_sources", sources: [{ id: "s2", type: "library", scope: { kind: "tag", library_ref: "u", tag: "y" } }] }])).toMatchObject({ ok: false });
    });
});
