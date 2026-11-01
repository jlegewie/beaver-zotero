/**
 * The row merge, held to the `table-merges` fixtures (a new case there is
 * picked up with no change here).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeRows, normalizeDoi, normalizeIdentifiers, identifierCell } from "@beaver/agent-core/layouts/tableMerge";
import type { Row } from "@beaver/agent-core/layouts/table";

const dir = fileURLToPath(new URL("../../fixtures/artifacts/table-merges/", import.meta.url));
// Tables hold Zotero regular items and external works only: the attachment,
// annotation and file row kinds are being removed (K1/K2), and the merge no
// longer gives them an identity of their own.
const OTHER_ROW_KINDS = new Set([
    "annotation-annotation-same-key.json",
    "annotation-item.json",
    "attachment-external.json",
    "attachment-item-parent.json",
    "attachment-item-unrelated.json",
    "file-external.json",
    "file-file-same-key.json",
    "file-item.json",
]);
const cases = readdirSync(dir)
    .filter((file) => file.endsWith(".json") && !OTHER_ROW_KINDS.has(file))
    .sort()
    .map((file) => ({ file, fixture: JSON.parse(readFileSync(path.join(dir, file), "utf8")) }));

/** Drops nulls and empty defaults the Python models wrote, so shapes compare. */
function clean(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
                .map(([k, v]) => [k, clean(v)]),
        );
    return value;
}

describe("the table-merges fixture corpus", () => {
    it("is populated", () => expect(cases.length).toBeGreaterThan(20));
    for (const { file, fixture } of cases)
        it(`${file}: ${fixture.name}`, () => {
            const existing = structuredClone(fixture.existing) as Row[];
            const result = mergeRows(existing, fixture.incoming);
            expect(clean(result.rows)).toEqual(clean(fixture.after.rows));
            expect(result.added).toEqual(fixture.after.added);
            expect(result.merged).toBe(fixture.after.merged);
            expect(existing).toEqual(fixture.existing);
        });
});

describe("identifiers", () => {
    it("normalises a DOI out of a resolver URL and copied punctuation", () => {
        expect(normalizeDoi("https://doi.org/10.1000/ABC.")).toBe("10.1000/ABC");
        expect(normalizeDoi("(10.1234/x)")).toBe("10.1234/x");
        expect(normalizeDoi("10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0")).toBe(
            "10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0",
        );
        expect(normalizeDoi("undefined")).toBeNull();
    });
    it("reads several ISBNs as ISBN-13 and an arXiv id without its version", () => {
        expect(normalizeIdentifiers({ isbn: "0-306-40615-2 978-0-306-40615-7", arXivID: "arXiv:2101.00001v2" })).toEqual({
            isbn: ["9780306406157"],
            arxiv: ["2101.00001"],
        });
    });
    it("shows the most specific identifier", () => {
        expect(identifierCell({ isbn: ["9780306406157"], pmid: ["123"] })?.value).toEqual({
            kind: "link",
            url: "https://pubmed.ncbi.nlm.nih.gov/123",
            label: "PMID 123",
        });
    });
    it("gives an incoming row with a taken id a fresh one", () => {
        const stored: Row = { id: "r1", cells: {}, ref: { kind: "file", ext_key: "AAAA0001" } };
        const incoming: Row = { id: "r1", cells: {}, ref: { kind: "file", ext_key: "BBBB0002" } };
        const result = mergeRows([stored], [{ row: incoming }]);
        expect(result.rows).toHaveLength(2);
        expect(result.added).toEqual([result.rows[1].id]);
        expect(result.rows[1].id).not.toBe("r1");
    });
    it("is indexed for a thousand rows", () => {
        const rows: Row[] = Array.from({ length: 1000 }, (_, i) => ({
            id: `r${i}`,
            cells: {},
            ref: { kind: "item", library_ref: "u", zotero_key: `K${String(i).padStart(7, "0")}` },
        }));
        const started = performance.now();
        const result = mergeRows(rows, rows.map((row) => ({ row, identifiers: { doi: `10.1000/${row.id}` } })));
        expect(performance.now() - started).toBeLessThan(2000);
        expect(result.merged).toBe(1000);
        expect(result.rows).toHaveLength(1000);
    });
});
