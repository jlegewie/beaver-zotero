import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
    exportCellDetails,
    exportColumns,
    toCsv,
} from "@beaver/agent-core/layouts/tableExport";
import { sortRows, type TableSpec } from "@beaver/agent-core/layouts/table";
import { writeXlsx } from "@beaver/agent-export/xlsx/writeXlsx";

const spec: TableSpec = {
    id: "t",
    title: "Police exposure",
    description: "What each paper finds.",
    columns: [
        { id: "_reference", header: "Reference", type: "reference", system: true },
        { id: "_year", header: "Year", type: "date", system: true },
        { id: "_identifier", header: "Identifier", type: "link", system: true },
        {
            id: "design",
            header: "Design",
            type: "select",
            description: "Which design?",
            options: [
                { label: "RCT", color: "green", description: "Randomised." },
                { label: "Observational", color: "blue" },
            ],
        },
        { id: "finding", header: "=Finding", type: "text", description: "Main finding?" },
        { id: "causal", header: "Causal", type: "boolean" },
    ],
    rows: [
        {
            id: "a",
            ref: { kind: "item", library_ref: "u", zotero_key: "AAAA1111" },
            documents: ["u-DOC1"],
            cells: {
                _reference: {
                    outcome: "answered",
                    provenance: "system",
                    value: {
                        kind: "reference",
                        display_name: "Smith 2020",
                        title: "Stops, race & age",
                        subtitle: "Jane Smith; Ann Lee",
                        venue: "Socius",
                    },
                },
                _year: { outcome: "answered", provenance: "system", value: { kind: "date", value: "2020" } },
                _identifier: {
                    outcome: "answered",
                    provenance: "system",
                    value: { kind: "link", url: "https://doi.org/10.1/x", label: "10.1/x" },
                },
                design: {
                    outcome: "answered",
                    provenance: "model",
                    value: { kind: "select", label: "RCT" },
                    documents: ["u-DOC1"],
                    confidence: "high",
                    reasoning: "Randomised assignment.",
                    evidence: [
                        { document: "u-DOC1", locator: "s1.2", quote: "We randomised schools.", page: 2 },
                    ],
                },
                finding: {
                    outcome: "answered",
                    provenance: "model",
                    value: { kind: "text", text: 'Stops rise, "sharply"<citation id="u-DOC1" loc="s1.3"/>' },
                    documents: ["u-DOC1"],
                    confidence: "low",
                    stale: true,
                },
                causal: { outcome: "answered", provenance: "user", value: { kind: "boolean", value: true } },
            },
        },
        {
            id: "b",
            ref: { kind: "item", library_ref: "g42", zotero_key: "BBBB2222" },
            cells: {
                _reference: {
                    outcome: "answered",
                    provenance: "system",
                    value: { kind: "reference", display_name: "Jones 2018" },
                },
                _year: { outcome: "answered", provenance: "system", value: { kind: "date", value: "2018" } },
                design: { outcome: "not_reported", provenance: "model", reasoning: "No design is described." },
                finding: { outcome: "failed", provenance: "model", error_code: "no_locator", error: "no passage" },
            },
        },
    ],
};

describe("exportColumns", () => {
    it("splits the paper column into its parts and keeps every question column", () => {
        expect(exportColumns(spec).map((c) => c.header)).toEqual([
            "Title",
            "Authors",
            "Publication",
            "Year",
            "Identifier",
            "Design",
            "=Finding",
            "Causal",
        ]);
    });

    it("leaves out a part of the paper column that no row has, never a question column", () => {
        const rows = [spec.rows[1]];
        expect(exportColumns(spec, rows).map((c) => c.header)).toEqual([
            "Title",
            "Year",
            "Design",
            "=Finding",
            "Causal",
        ]);
    });
});

describe("toCsv", () => {
    it("writes one column per field with values only, no evidence, reasoning or state", () => {
        expect(toCsv(spec).split("\r\n")).toEqual([
            "Title,Authors,Publication,Year,Identifier,Design,'=Finding,Causal",
            `"Stops, race & age",Jane Smith; Ann Lee,Socius,2020,10.1/x,RCT,"Stops rise, ""sharply""",Yes`,
            "Jones 2018,,,2018,,Not reported,,",
        ]);
        const csv = toCsv(spec);
        expect(csv).not.toMatch(/citation|evidence|reasoning|state|stale|model|high|low/i);
    });

    it("follows the given row order", () => {
        const rows = sortRows(spec, { column_id: "_year", direction: "asc" });
        expect(toCsv(spec, rows).split("\r\n")[1]).toMatch(/^Jones 2018,/);
    });
});

describe("exportCellDetails", () => {
    it("lists question cells with reasoning or passages, with 1-based pages", () => {
        const details = exportCellDetails(spec);
        expect(details.map((d) => [d.row.id, d.column.id, d.reasoning, d.passages])).toEqual([
            ["a", "design", "Randomised assignment.", [{ quote: "We randomised schools.", page: 3 }]],
            ["b", "design", "No design is described.", []],
        ]);
    });
});

describe("writeXlsx", () => {
    async function open(bytes: Uint8Array) {
        const zip = await JSZip.loadAsync(bytes);
        const read = (name: string) => zip.file(name)!.async("string");
        return { zip, read };
    }

    it("writes the table, evidence and about sheets with styles, links and a filter", async () => {
        const { bytes, stats } = await writeXlsx({ spec, exportedAt: new Date("2026-11-05T12:00:00Z") });
        expect(stats).toEqual({ rows: 2, columns: 8, evidenceRows: 2 });
        const { zip, read } = await open(bytes);
        expect(Object.keys(zip.files)).toEqual(
            expect.arrayContaining([
                "[Content_Types].xml",
                "xl/workbook.xml",
                "xl/styles.xml",
                "xl/sharedStrings.xml",
                "xl/worksheets/sheet1.xml",
                "xl/worksheets/sheet2.xml",
                "xl/worksheets/sheet3.xml",
                "xl/worksheets/_rels/sheet1.xml.rels",
            ]),
        );
        const workbook = await read("xl/workbook.xml");
        expect(workbook).toContain('<sheet name="Table" sheetId="1" r:id="rId1"/>');
        expect(workbook).toContain('<sheet name="Evidence" sheetId="2" r:id="rId2"/>');
        expect(workbook).toContain('<sheet name="About" sheetId="3" r:id="rId3"/>');
        expect(workbook).toContain("'Table'!$A$1:$H$3");

        const table = await read("xl/worksheets/sheet1.xml");
        expect(table).toContain('state="frozen"');
        expect(table).toContain('<autoFilter ref="A1:H3"/>');
        // The year is a number; the empty failed cell still carries its border style.
        expect(table).toContain('<c r="D2" s="5"><v>2020</v></c>');
        expect(table).toContain('<c r="G3" s="2"/>');

        const links = await read("xl/worksheets/_rels/sheet1.xml.rels");
        expect(links).toContain('Target="zotero://select/library/items/AAAA1111"');
        expect(links).toContain('Target="zotero://select/groups/42/items/BBBB2222"');
        expect(links).toContain('Target="https://doi.org/10.1/x"');

        const strings = await read("xl/sharedStrings.xml");
        expect(strings).toContain("Stops, race &amp; age");
        expect(strings).toContain("=Finding");
        expect(strings).toContain("Stops rise, &quot;sharply&quot;");
        expect(strings).not.toContain("citation");
        expect(strings).toContain("p. 3: “We randomised schools.”");
        expect(strings).toContain("RCT: Randomised.");
        expect(strings).toContain("2026-11-05");
    });

    it("colours a category cell by its option and omits the evidence sheet when nothing is cited", async () => {
        const bare: TableSpec = {
            ...spec,
            rows: spec.rows.map((row) => ({
                ...row,
                cells: Object.fromEntries(
                    Object.entries(row.cells).map(([id, cell]) => [
                        id,
                        { ...cell, reasoning: undefined, evidence: undefined } as typeof cell,
                    ]),
                ),
            })),
        };
        const { read, zip } = await open((await writeXlsx({ spec: bare })).bytes);
        expect(zip.file("xl/worksheets/sheet3.xml")).toBeNull();
        expect(await read("xl/workbook.xml")).not.toContain("Evidence");
        // Green is the third category colour (gray, blue, green): style 11 + 2.
        expect(await read("xl/worksheets/sheet1.xml")).toMatch(/<c r="F2" s="13" t="s">/);
        expect(await read("xl/styles.xml")).toContain('<fgColor rgb="FFE4F8EB"/>');
    });

    it("drops characters XML cannot carry", async () => {
        const odd: TableSpec = {
            ...spec,
            rows: [
                {
                    id: "c",
                    cells: {
                        finding: {
                            outcome: "answered",
                            provenance: "user",
                            value: { kind: "text", text: "bad\u0001char\uD800" },
                        },
                    },
                },
            ],
        };
        const { read } = await open((await writeXlsx({ spec: odd })).bytes);
        expect(await read("xl/sharedStrings.xml")).toContain("<t>badchar</t>");
    });
});
