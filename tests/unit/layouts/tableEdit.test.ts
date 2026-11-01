/**
 * One `edit_table` call through the engine (`applyEdit`) and a new table from
 * resolved sources (`buildTable`, `previewFacts`), pure: no Zotero.
 */
import { describe, expect, it } from "vitest";
import contract from "../../fixtures/artifacts/provider-contract.json";
import { applyEdit, buildTable, previewFacts, type ResolvedSource } from "@beaver/agent-core/layouts/tableEdit";
import type { Row, TableSpec } from "@beaver/agent-core/layouts/table";

type Case = { name: string; before?: TableSpec; request: any; response: any };
const NOW = "2026-10-31T12:00:00.000Z";

/** The spec as the store returns it, without its stamped key and version. */
function content(spec: TableSpec): TableSpec {
    const { key: _k, version: _v, ...rest } = spec;
    return rest as TableSpec;
}

describe("the provider-contract apply_edit cases", () => {
    // The cases that need no source resolution replay exactly.
    for (const name of ["apply-edit-title-description", "apply-edit-columns", "apply-edit-remove-rows"]) {
        it(name, () => {
            const fixture = (contract as Case[]).find((c) => c.name === name)!;
            const result = applyEdit(fixture.before!, fixture.request.operations, { added: [], refreshed: new Map() }, NOW);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(content(result.spec)).toEqual(content(fixture.response.spec));
            expect(result.changes).toEqual(fixture.response.changes);
        });
    }
});

function paper(key: string, opts: { doc?: boolean; doi?: string; title?: string } = {}): ResolvedSource["papers"][number] {
    const row: Row = {
        id: `r-${key}`,
        ref: { kind: "item", library_ref: "u", zotero_key: key },
        ...(opts.doc ? { documents: [`u-${key.slice(0, 5)}PDF`] } : {}),
        cells: {
            _reference: {
                outcome: "answered",
                provenance: "system",
                value: { kind: "reference", display_name: key, title: opts.title ?? `A study called ${key} of things` },
            },
        },
        in_library: true,
    };
    return { row, identifiers: opts.doi ? { doi: opts.doi } : null, mode: opts.doc ? "document" : "title_abstract" };
}

function source(id: string, papers: ResolvedSource["papers"], extra: Partial<ResolvedSource> = {}): ResolvedSource {
    return {
        entry: id === "s1" ? { id, type: "items", ids: papers.map((p) => `u-${(p.row.ref as any).zotero_key}`) } : { id, type: "library", scope: { kind: "collection", library_ref: "u", key: "CASHTRN2", name: "Cash" } },
        papers,
        total: papers.length,
        truncated: false,
        rejected: [],
        ...extra,
    };
}

describe("creating a table", () => {
    it("merges papers across sources, unions their origins and reports the duplicates", () => {
        const resolved = [source("s1", [paper("AAAAAAAA", { doc: true })]), source("s2", [paper("AAAAAAAA", { doc: true }), paper("BBBBBBBB")])];
        const facts = previewFacts(resolved);
        expect(facts).toMatchObject({ rows: 2, duplicates: 1, total: 3, documents: 1, title_abstract: 1, no_input: 0 });
        const result = buildTable(
            { id: "t", title: "T", columns: [{ header: "Design", type: "select", options: [{ label: "RCT" }, { label: "Other" }] }] },
            resolved,
            "2026-10-31",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.spec.columns.map((c) => c.id)).toEqual(["_reference", "_year", "_identifier", "design"]);
        expect(result.spec.columns[3].options).toEqual([{ label: "RCT", color: "blue" }, { label: "Other", color: "green" }]);
        expect(result.spec.rows.map((r) => r.origin?.map((o) => o.source))).toEqual([["s1", "s2"], ["s2"]]);
        expect(result.changes).toEqual([
            { op: "add_source", source: "s1", type: "items", rows_added: 1, rows_restored: 0, duplicates: 0, rejected: [] },
            { op: "add_source", source: "s2", type: "library", kind: "collection", name: "Cash", library_ref: "u", rows_added: 1, rows_restored: 0, duplicates: 1, rejected: [] },
            { op: "add_column", column: "design", header: "Design" },
        ]);
    });
    it("refuses a source cut short, no rows and an unusable source", () => {
        expect(buildTable({ id: "t", title: "T" }, [source("s2", [paper("AAAAAAAA")], { truncated: true, total: 1800 })], "d")).toMatchObject({ ok: false, code: "too_large" });
        expect(buildTable({ id: "t", title: "T" }, [source("s2", [])], "d")).toMatchObject({ ok: false, code: "no_rows" });
        expect(buildTable({ id: "t", title: "T" }, [source("s2", [], { error: "Gone." })], "d")).toMatchObject({ ok: false, code: "source_unavailable", message: "sources[0]: Gone." });
        expect(buildTable({ id: "t", title: "T" }, [source("s1", [paper("AAAAAAAA"), paper("BBBBBBBB")])], "d", 1)).toMatchObject({ ok: false, code: "too_large" });
    });
    it("derives unique column ids from headers, a generic one for a header without letters", () => {
        const result = buildTable(
            { id: "t", title: "T", columns: [{ header: "Sample size", type: "text" }, { header: "Sample size", type: "text" }, { header: "研究", type: "text" }] },
            [source("s1", [paper("AAAAAAAA")])],
            "d",
        );
        expect(result.ok && result.spec.columns.slice(3).map((c) => c.id)).toEqual(["sample_size", "sample_size_2", "column"]);
    });
});

describe("editing a table", () => {
    const base = (): TableSpec => {
        const built = buildTable(
            { id: "t", title: "T", columns: [{ header: "N", type: "text", description: "How many?" }] },
            [source("s1", [paper("AAAAAAAA", { doc: true })]), source("s2", [paper("BBBBBBBB"), paper("CCCCCCCC")])],
            "2026-10-30",
        );
        if (!built.ok) throw new Error(built.message);
        const spec = built.spec;
        for (const row of spec.rows)
            row.cells.n = { outcome: "answered", provenance: "model", value: { kind: "text", text: "1" }, ...(row.documents ? { documents: row.documents } : {}) };
        return spec;
    };
    it("adds papers to the items entry, restores a removed paper and merges a known one", () => {
        const removed = applyEdit(base(), { remove_rows: ["r-BBBBBBBB"] }, { added: [], refreshed: new Map() }, NOW);
        if (!removed.ok) throw new Error(removed.message);
        expect(removed.spec.removed).toEqual([{ ref: { kind: "item", library_ref: "u", zotero_key: "BBBBBBBB" }, removed_at: NOW }]);
        const added = source("s1", [paper("BBBBBBBB"), paper("DDDDDDDD"), paper("AAAAAAAA", { doc: true })]);
        const result = applyEdit(removed.spec, { add_sources: [{ type: "items", ids: ["u-BBBBBBBB", "u-DDDDDDDD", "u-AAAAAAAA"] }] }, { added: [added], refreshed: new Map() }, NOW);
        if (!result.ok) throw new Error(result.message);
        expect(result.changes).toEqual([{ op: "add_source", source: "s1", type: "items", rows_added: 1, rows_restored: 1, duplicates: 1, rejected: [] }]);
        expect(result.spec.removed).toBeUndefined();
        expect(result.spec.sources![0].ids).toEqual(["u-AAAAAAAA", "u-BBBBBBBB", "u-DDDDDDDD"]);
        // The stored row kept its answer.
        expect(result.spec.rows[0].cells.n).toBeDefined();
    });
    it("refresh skips removed papers, adds new ones and reports rows no longer found, keeping staleness", () => {
        let spec = base();
        const stale = applyEdit(spec, { update_columns: [{ id: "n", description: "How many people?" }] }, { added: [], refreshed: new Map() }, NOW);
        if (!stale.ok) throw new Error(stale.message);
        const removed = applyEdit(stale.spec, { remove_rows: ["r-CCCCCCCC"] }, { added: [], refreshed: new Map() }, NOW);
        if (!removed.ok) throw new Error(removed.message);
        spec = removed.spec;
        const refreshed = new Map([["s2", source("s2", [paper("CCCCCCCC"), paper("EEEEEEEE")])]]);
        const result = applyEdit(spec, { refresh_sources: true }, { added: [], refreshed }, NOW);
        if (!result.ok) throw new Error(result.message);
        expect(result.changes).toEqual([{ op: "refresh_source", source: "s2", kind: "collection", name: "Cash", library_ref: "u", rows_added: 1, removed_skipped: 1, no_longer_found: 1 }]);
        expect(result.spec.rows.find((r) => r.id === "r-BBBBBBBB")!.cells.n.stale).toBe(true);
    });
    it("is all or nothing: a bad entry late in the call changes nothing", () => {
        const spec = base();
        const result = applyEdit(spec, { title: "New", remove_columns: ["n", "missing"] }, { added: [], refreshed: new Map() }, NOW);
        expect(result).toMatchObject({ ok: false, code: "unknown_column" });
        expect((result as any).message).toContain("remove_columns[1]");
        expect(spec.title).toBe("T");
    });
    it("refuses an addition over the row cap", () => {
        const result = applyEdit(base(), { add_sources: [{ type: "items", ids: ["u-DDDDDDDD"] }] }, { added: [source("s1", [paper("DDDDDDDD")])], refreshed: new Map() }, NOW, 3);
        expect(result).toMatchObject({ ok: false, code: "too_large" });
    });
    it("refuses a library source the table already has, and a source that cannot be resolved", () => {
        const again = source("s2", [paper("BBBBBBBB")]);
        expect(applyEdit(base(), { add_sources: [{ type: "library", scope: again.entry.scope! }] }, { added: [again], refreshed: new Map() }, NOW)).toMatchObject({ ok: false, code: "invalid_edit" });
        const broken = source("s2", [], { error: "Gone." });
        expect(applyEdit(base(), { add_sources: [{ type: "library", scope: { kind: "tag", library_ref: "u", tag: "x" } }] }, { added: [broken], refreshed: new Map() }, NOW)).toMatchObject({ ok: false, code: "source_unavailable", message: "add_sources[0]: Gone." });
    });
});

describe("review fixes", () => {
    it("creates the rows the preview showed when identifiers bridge papers across sources", () => {
        const both = paper("AAAAAAAA", { title: "A long study title here" });
        both.identifiers = { doi: "10.1/x", pmid: "77" };
        const pmidOnly = paper("BBBBBBBB", { title: "Another title entirely different" });
        pmidOnly.identifiers = { pmid: "77" };
        const resolved = [source("s1", [both]), source("s2", [pmidOnly])];
        expect(previewFacts(resolved).rows).toBe(1);
        const result = buildTable({ id: "t", title: "T" }, resolved, "2026-10-31");
        expect(result.ok && result.spec.rows).toHaveLength(1);
        expect(result.ok && result.changes).toEqual([
            { op: "add_source", source: "s1", type: "items", rows_added: 1, rows_restored: 0, duplicates: 0, rejected: [] },
            { op: "add_source", source: "s2", type: "library", kind: "collection", name: "Cash", library_ref: "u", rows_added: 0, rows_restored: 0, duplicates: 1, rejected: [] },
        ]);
    });
    it("refuses to refresh from a source cut short by the row cap", () => {
        const built = buildTable({ id: "t", title: "T" }, [source("s2", [paper("BBBBBBBB")])], "2026-10-30");
        if (!built.ok) throw new Error(built.message);
        const refreshed = new Map([["s2", source("s2", [paper("BBBBBBBB")], { truncated: true, total: 1500 })]]);
        expect(applyEdit(built.spec, { refresh_sources: true }, { added: [], refreshed }, NOW)).toMatchObject({ ok: false, code: "too_large" });
    });
    it("refreshes only the sources the table had, alongside a source it adds", () => {
        const built = buildTable({ id: "t", title: "T" }, [source("s2", [paper("BBBBBBBB")])], "2026-10-30");
        if (!built.ok) throw new Error(built.message);
        const tag: ResolvedSource = { ...source("s9", [paper("CCCCCCCC")]), entry: { id: "new", type: "library", scope: { kind: "tag", library_ref: "u", tag: "t" } } };
        const refreshed = new Map([["s2", source("s2", [paper("BBBBBBBB"), paper("DDDDDDDD")])]]);
        const result = applyEdit(built.spec, { add_sources: [{ type: "library", scope: tag.entry.scope! }], refresh_sources: true }, { added: [tag], refreshed }, NOW);
        expect(result.ok && result.changes.map((c) => c.op)).toEqual(["add_source", "refresh_source"]);
    });
});

describe("review fixes, refresh", () => {
    it("merges papers refreshed from two sources with their full identifiers", () => {
        const tag: ResolvedSource = { ...source("s3", []), entry: { id: "s3", type: "library", scope: { kind: "tag", library_ref: "u", tag: "t" } } };
        const built = buildTable({ id: "t", title: "T" }, [source("s2", [paper("AAAAAAAA")]), tag], "2026-10-30");
        if (!built.ok) throw new Error(built.message);
        const both = paper("BBBBBBBB", { title: "First title words here" });
        both.identifiers = { doi: "10.1/x", pmid: "77" };
        const pmid = paper("CCCCCCCC", { title: "Other title words here" });
        pmid.identifiers = { pmid: "77" };
        const refreshed = new Map([
            ["s2", source("s2", [paper("AAAAAAAA"), both])],
            ["s3", { ...tag, papers: [pmid] }],
        ]);
        const result = applyEdit(built.spec, { refresh_sources: true }, { added: [], refreshed }, NOW);
        if (!result.ok) throw new Error(result.message);
        expect(result.spec.rows).toHaveLength(2);
        expect(result.changes.map((c) => (c as any).rows_added)).toEqual([1, 0]);
    });
});

describe("option edits in the change list", () => {
    const withDesign = (): TableSpec => {
        const built = buildTable(
            {
                id: "t",
                title: "T",
                columns: [
                    {
                        header: "Design",
                        type: "select",
                        description: "What is the design?",
                        options: [{ label: "RCT", description: "Randomized" }, { label: "Cohort" }, { label: "Other" }],
                    },
                ],
            },
            [source("s1", [paper("AAAAAAAA"), paper("BBBBBBBB"), paper("CCCCCCCC")])],
            "2026-10-30",
        );
        if (!built.ok) throw new Error(built.message);
        const [a, b, c] = built.spec.rows;
        a.cells.design = { outcome: "answered", provenance: "model", value: { kind: "select", label: "Other" } };
        b.cells.design = { outcome: "answered", provenance: "user", value: { kind: "select", label: "Other" } };
        c.cells.design = { outcome: "answered", provenance: "model", value: { kind: "select", label: "RCT" } };
        return built.spec;
    };
    const edit = (spec: TableSpec, options: any[]) =>
        applyEdit(spec, { update_columns: [{ id: "design", options }] }, { added: [], refreshed: new Map() }, NOW);

    it("counts the user's answers a removed option clears, and does not call it a new question", () => {
        const result = edit(withDesign(), [{ label: "RCT" }, { label: "Cohort" }]);
        if (!result.ok) throw new Error(result.message);
        expect(result.changes).toEqual([
            { op: "update_column", column: "design", header: "Design", fields: ["options"], stale: 0, cleared: 2, user_cleared: 1, relabelled: 0 },
        ]);
    });
    it("reads a rename that keeps its definition as an options change only", () => {
        const result = edit(withDesign(), [{ label: "Randomized trial", previous_label: "RCT" }, { label: "Cohort" }, { label: "Other" }]);
        if (!result.ok) throw new Error(result.message);
        expect(result.changes[0]).toMatchObject({ fields: ["options"], stale: 0, relabelled: 1 });
    });
    it("pairs a re-spelled option as the engine does: its definition decides the question", () => {
        const kept = edit(withDesign(), [{ label: "rct" }, { label: "Cohort" }, { label: "Other" }]);
        expect(kept.ok && kept.changes[0]).toMatchObject({ fields: ["options"], stale: 0 });
        const cleared = edit(withDesign(), [{ label: "rct", description: null }, { label: "Cohort" }, { label: "Other" }]);
        expect(cleared.ok && cleared.changes[0]).toMatchObject({ fields: ["question", "options"], stale: 3 });
    });
    it("reads removing an option with a definition as a new question, as its staleness does", () => {
        const result = edit(withDesign(), [{ label: "Cohort" }, { label: "Other" }]);
        expect(result.ok && result.changes[0]).toMatchObject({ fields: ["question", "options"], cleared: 1, stale: 2 });
    });
    it("reads a new definition, on a kept or an added option, as a new question", () => {
        const defined = edit(withDesign(), [{ label: "RCT" }, { label: "Cohort", description: "Followed over time" }, { label: "Other" }]);
        expect(defined.ok && defined.changes[0]).toMatchObject({ fields: ["question"], stale: 3 });
        const added = edit(withDesign(), [{ label: "RCT" }, { label: "Cohort" }, { label: "Other" }, { label: "Case study", description: "One case" }]);
        expect(added.ok && added.changes[0]).toMatchObject({ fields: ["question", "options"] });
    });
});
