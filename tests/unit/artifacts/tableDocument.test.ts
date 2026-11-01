import { describe, expect, it } from "vitest";
import {
    cellInvariantError,
    REFERENCE_COLUMN_ID,
    rowInvariantError,
    SELECT_COLORS,
    TABLE_SPEC_VERSION,
    type Cell,
    type CellProvenance,
    type CellValue,
    type Evidence,
    type RowRef,
    type TableSpec,
    validateTableSpec,
    jsonBytes,
    MAX_SPEC_BYTES,
} from "@beaver/agent-core/layouts/table";
import {
    BEAVER_HOME_URL,
    buildTableDocument,
    renderedFileHash,
    renderedSpecHash,
    renderTableHtml,
    TABLE_CSS,
    TABLE_FILE_HASH_ATTRIBUTE,
    TABLE_SPEC_HASH_ATTRIBUTE,
} from "../../../src/services/artifacts/tableDocument";
import { CSS_RULE_BUDGET, escapeHtml } from "../../../src/utils/html";

/** A written cell with an answer; by default one the producer filled, which carries no marks. */
function answered(
    value: CellValue,
    provenance: CellProvenance = "system",
    extra: Record<string, unknown> = {},
): Cell {
    return { outcome: "answered", provenance, value, ...extra } as Cell;
}

/** The reference cell the producer fills for a row. */
function reference(display_name: string, extra: Record<string, string> = {}): Cell {
    return answered({ kind: "reference", display_name, ...extra }, "system");
}

/** A library item row's reference. */
function itemRef(key: string, libraryId = 1, libraryRef = "u"): RowRef {
    return { kind: "item", library_ref: libraryRef, library_id: libraryId, zotero_key: key };
}

/** An item row's fields, naming the attachment it is filled from when there is one. */
function itemRow(
    key: string,
    attachment?: string,
    libraryId = 1,
    libraryRef = "u",
): { ref: RowRef; documents?: string[] } {
    return {
        ref: itemRef(key, libraryId, libraryRef),
        ...(attachment ? { documents: [`${libraryRef}-${attachment}`] } : {}),
    };
}

/** Evidence as a test writes it: the document defaults to the row's. */
type TestEvidence = Omit<Evidence, "document"> & { document?: string };

const spec: TableSpec = {
    id: "t",
    title: "Results",
    description: "From OpenAlex",
    anchor_column_id: "ref",
    columns: [
        { id: "ref", header: "Item", type: "reference" },
        { id: "cites", header: "Citations", type: "text" },
        {
            id: "type",
            header: "Type",
            type: "select",
            options: [{ label: "Article", color: "blue" }, { label: "Book" }],
        },
        { id: "oa", header: "OA", type: "boolean" },
        { id: "abstract", header: "Abstract", type: "text" },
    ],
    rows: [
        {
            id: "r1",
            ref: itemRef("K1"),
            cells: {
                ref: reference("Alpha"),
                cites: answered({ kind: "text", text: "10" }, "metadata"),
                type: answered({ kind: "select", label: "Article" }),
                oa: answered({ kind: "boolean", value: true }),
                abstract: answered({ kind: "text", text: "First abstract" }),
            },
        },
        {
            id: "r2",
            ref: itemRef("K2"),
            cells: {
                ref: reference("Beta"),
                cites: answered({ kind: "text", text: "90" }, "metadata"),
                type: answered({ kind: "select", label: "Book" }),
                oa: answered({ kind: "boolean", value: false }),
                abstract: answered({ kind: "text", text: "Second abstract" }),
            },
        },
        {
            // No citation count: it must sort last in *both* directions.
            id: "r3",
            cells: {
                ref: reference("Gamma"),
                type: answered({ kind: "select", label: "Article" }),
            },
        },
    ],
    sort: { column_id: "cites", direction: "desc" },
    capabilities: { row_actions: ["reveal", "open"] },
};

/** The markup of one grid cell, from its opening tag to the end of its row. */
function cellHtml(html: string, rowId: string, columnId: string): string {
    const start = html.indexOf(`id="${rowId}/${columnId}"`);
    return html.slice(start, html.indexOf("</summary>", start));
}

/** The expanded detail of one row. */
function detailHtml(html: string, rowId: string): string {
    const start = html.search(new RegExp(`<details class="[^"]*" id="${rowId}">`));
    const detail = html.indexOf('<div class="bt-d">', start);
    return html.slice(detail, html.indexOf("</details>", detail));
}

/** The numbers of every citation marker, in document order. */
function markerNumbers(html: string): string[] {
    return [...html.matchAll(/class="bt-cite[^"]*"[^>]*>(\d+)</g)].map((m) => m[1]);
}

/**
 * The document's text, near enough for offset comparisons: annotations anchor
 * into text, and markup is not text. Entities are left alone, since both sides of a
 * comparison carry the same ones.
 */
function textOf(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "");
}

const HASH = "0123456789abcdef".repeat(4);

describe("renderTableHtml", () => {
    it("bakes the producer's sort into document order, so a viewer with no CSS still agrees", () => {
        const html = renderTableHtml(spec);
        const order = [
            ...html.matchAll(/<details class="[^"]*" id="([^"]+)"/g),
        ].map((m) => m[1]);
        expect(order).toEqual(["r2", "r1", "r3"]);
    });

    it("has no sort, filter or row-height controls, only rows in the producer's order", () => {
        const html = renderTableHtml(spec);
        expect(html).not.toMatch(/<input\b/);
        expect(html).not.toMatch(/<label\b/);
        expect(html).not.toContain("bt-toolbar");
        expect(html).not.toContain("bt-sorters");
        expect(html).not.toContain(":checked");
        // No per-row rank properties and no filter classes.
        expect(html).not.toMatch(/<details [^>]*style=/);
        expect(html).not.toMatch(/bt-v\d+-\d+/);
        expect(html).toContain('<details class="bt-r" id="r2">');
    });

    it("renders the table's description under its title", () => {
        const html = renderTableHtml(spec);
        expect(html).toContain('<h1 class="bt-t">Results</h1><p class="bt-cap">From OpenAlex</p>');
    });

    it("escapes producer text, including inside attributes", () => {
        const hostile: TableSpec = {
            ...spec,
            title: '<img src=x onerror="alert(1)">',
            rows: [
                {
                    id: '"><script>alert(1)</script>',
                    cells: { ref: reference("</span><b>bold</b>") },
                },
            ],
        };
        const html = renderTableHtml(hostile);
        expect(html).not.toContain("<script>");
        expect(html).not.toContain("<img src=x");
        expect(html).not.toContain("<b>bold</b>");
        expect(html).toContain("&lt;script&gt;");
    });

    it("links only zotero: and https: destinations", () => {
        const withLinks: TableSpec = {
            ...spec,
            columns: [
                ...spec.columns,
                { id: "url", header: "URL", type: "link" },
            ],
            rows: [
                {
                    id: "r1",
                    cells: {
                        url: answered(
                            { kind: "link", url: "javascript:alert(1)", label: "bad" },
                            "system",
                        ),
                    },
                },
                {
                    id: "r2",
                    cells: {
                        url: answered({ kind: "link", url: "https://doi.org/10.1/x" }, "system"),
                    },
                },
            ],
        };
        const html = renderTableHtml(withLinks);
        expect(html).not.toContain("javascript:");
        expect(html).toContain('href="https://doi.org/10.1/x"');
    });

    it("emits a row's verbs only where the host supplied a URI for them", () => {
        const html = renderTableHtml(spec, {
            linksFor: (row) =>
                row.ref?.kind === "item" && row.ref.zotero_key === "K1"
                    ? { reveal: "zotero://select/library/items/K1" }
                    : {},
        });
        expect(html).toContain('href="zotero://select/library/items/K1"');
        // K2 got no URI, so it gets no link rather than a dead one.
        expect(html).not.toContain("items/K2");
    });

    it("draws the primary verb on the anchor cell and never a column of its own", () => {
        // A context-file row declares `open`, but a static document has no
        // link for a local file, so its anchor carries no control.
        const files: TableSpec = {
            ...spec,
            capabilities: { row_actions: ["open", "import"] },
            rows: [
                {
                    id: "f1",
                    ref: { kind: "file", ext_key: "AB12CD34" },
                    cells: { ref: reference("notes.pdf") },
                },
            ],
        };
        const html = renderTableHtml(files, { linksFor: () => ({}) });
        expect(html).not.toContain("bt-ref-act");
        expect(html).not.toContain("bt-acts");

        const linked = renderTableHtml(spec, {
            linksFor: () => ({ reveal: "zotero://select/library/items/K1" }),
        });
        // The reveal link sits inside the anchor cell; the expanded detail
        // lists it too.
        expect(linked).toMatch(
            /class="bt-c[^"]*bt-anchor"[^>]*>.*?<a class="bt-act bt-ref-act" href="zotero:\/\/select\/library\/items\/K1"/,
        );
        expect(linked).toContain('class="bt-d-actions"');
        expect(linked).not.toContain("bt-acts");
    });
});

describe("buildTableDocument", () => {
    it("produces a self-contained document that carries no script", () => {
        const { html } = buildTableDocument(spec);
        expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
        expect(html).not.toMatch(/<script\b/i);
        // Nothing is fetched over the network: the only external URL the
        // document carries is the notice's own link, which is not a resource.
        expect(html.match(/https?:\/\/(?!doi\.org)[^"']*/g) ?? []).toEqual([
            BEAVER_HOME_URL,
        ]);
        // rem is meaningless without a pinned root.
        expect(html).toContain("html { font-size: 14px; }");
    });

    it("is a rendering of the spec, not a copy of it", () => {
        // `table.json` is the table; the snapshot carries none of its state.
        const { html } = buildTableDocument(fullSpec);
        expect(html).not.toContain('"columns"');
        expect(html).not.toContain('"spec_version"');
        expect(html).not.toContain("SNAP1234");
    });

    it("says the table needs the plugin, and links to it", () => {
        const { html } = buildTableDocument(spec);
        expect(html).toContain('<aside class="bt-nb">');
        expect(html).toContain(`href="${BEAVER_HOME_URL}"`);
        // The notice is above the table, where it is read.
        expect(html.indexOf('class="bt-nb"')).toBeLessThan(
            html.indexOf('class="bt-wrap"'),
        );
    });

    it("carries nothing that needs the plugin: no commands, no host mark, no script", () => {
        const { html } = buildTableDocument(spec);
        expect(html).not.toContain("data-bt-command");
        expect(html).not.toContain("bt-export");
        expect(html).not.toContain("data-beaver-active");
        expect(html).not.toContain("data-cite-");
        expect(html).not.toMatch(/<script\b|\son[a-z]+=/i);
        // The one control is the notice's dismiss, which needs no script.
        expect(html.match(/<input\b[^>]*>/g)).toEqual([
            '<input type="checkbox" id="beaver-table-notice-dismiss" class="bt-ctl">',
        ]);
    });

    it("marks the document so a viewer can recognise it without parsing", () => {
        const { html } = buildTableDocument(spec);
        expect(html).toContain(
            `<html lang="en" data-beaver-table="${TABLE_SPEC_VERSION}">`,
        );
    });

    it("stays under the reader's CSS rule budget", () => {
        const { cssRuleCount } = buildTableDocument(spec);
        expect(cssRuleCount).toBeLessThan(CSS_RULE_BUDGET);
    });

    it("stays under the budget however wide the table, since no rule depends on the spec", () => {
        const columns = Array.from({ length: 20 }, (_, i) => ({
            id: `c${i}`,
            header: `Column ${i}`,
            type: "select" as const,
            options: Array.from({ length: 6 }, (_, j) => ({ label: `v${j}` })),
        }));
        const wide: TableSpec = { id: "w", columns, rows: [] };
        expect(buildTableDocument(wide).cssRuleCount).toBeLessThan(
            CSS_RULE_BUDGET,
        );
    });

    it("keeps the table stylesheet free of control selectors", () => {
        expect(TABLE_CSS).not.toContain(":checked");
    });
});

describe("the spec hash", () => {
    it("is written as a root attribute and read back", () => {
        const { html } = buildTableDocument(spec, { specSha256: HASH });
        expect(html).toContain(
            `<html lang="en" data-beaver-table="${TABLE_SPEC_VERSION}" ${TABLE_SPEC_HASH_ATTRIBUTE}="${HASH}">`,
        );
        expect(renderedSpecHash(html)).toBe(HASH);
    });

    it("is left out unless it is a SHA-256 hex digest", () => {
        for (const specSha256 of ["not-a-hash", HASH.toUpperCase(), HASH.slice(1), `${HASH}" onload="x`]) {
            const { html } = buildTableDocument(spec, { specSha256 });
            expect(html).not.toContain(TABLE_SPEC_HASH_ATTRIBUTE);
            expect(renderedSpecHash(html)).toBeNull();
        }
    });

    it("is written beside the digest of the whole table.json, and both read back", () => {
        const FILE = "fedcba9876543210".repeat(4);
        const { html } = buildTableDocument(spec, { specSha256: HASH, fileSha256: FILE });
        expect(html).toContain(
            `<html lang="en" data-beaver-table="${TABLE_SPEC_VERSION}" ${TABLE_SPEC_HASH_ATTRIBUTE}="${HASH}" ${TABLE_FILE_HASH_ATTRIBUTE}="${FILE}">`,
        );
        expect(renderedSpecHash(html)).toBe(HASH);
        expect(renderedFileHash(html)).toBe(FILE);
        // A commit that leaves the spec alone still changes the synced file.
        const next = buildTableDocument(spec, { specSha256: HASH, fileSha256: HASH }).html;
        expect(next).not.toBe(html);
        expect(buildTableDocument(spec, { fileSha256: "nope" }).html).not.toContain(TABLE_FILE_HASH_ATTRIBUTE);
    });

    it("reads null from a document that names none", () => {
        expect(renderedSpecHash(buildTableDocument(spec).html)).toBeNull();
        expect(renderedSpecHash("<!DOCTYPE html><html><body>Nope</body></html>")).toBeNull();
    });

    it("is read only from the root, never from table content", () => {
        const spoofed: TableSpec = {
            ...spec,
            rows: [
                {
                    id: "r1",
                    cells: {
                        abstract: answered({
                            kind: "text",
                            text: `<html ${TABLE_SPEC_HASH_ATTRIBUTE}="${HASH}">`,
                        }),
                    },
                },
            ],
        };
        expect(renderedSpecHash(buildTableDocument(spoofed).html)).toBeNull();
    });

    it("changes no text, so a new hash never moves an annotation", () => {
        const without = buildTableDocument(spec).html;
        const withHash = buildTableDocument(spec, { specSha256: HASH }).html;
        expect(withHash).not.toBe(without);
        expect(textOf(withHash)).toBe(textOf(without));
    });
});

describe("category definitions", () => {
    const coded: TableSpec = {
        id: "c",
        columns: [
            {
                id: "design",
                header: "Design",
                type: "select",
                description: "What is the study design?",
                options: [
                    { label: "RCT", color: "blue", description: "Random <assignment> to arms." },
                    { label: "Observational", color: "green" },
                ],
            },
            { id: "notes", header: "Notes", type: "text" },
        ],
        rows: [{ id: "r1", cells: { design: answered({ kind: "select", label: "RCT" }) } }],
    };

    it("lists each select column's categories in a collapsed codebook under the table", () => {
        const html = renderTableHtml(coded);
        const codebook = html.slice(html.indexOf('<details class="bt-codebook">'));
        expect(codebook).toMatch(/^<details class="bt-codebook"><summary class="bt-codebook-h">Codebook<\/summary>/);
        expect(codebook).toContain('<h3 class="bt-cb-h">Design</h3><p class="bt-cb-q">What is the study design?</p>');
        expect(codebook).toContain('<li><span class="bt-cb-l">RCT</span> — Random &lt;assignment&gt; to arms.</li>');
        expect(codebook).toContain('<li><span class="bt-cb-l">Observational</span></li>');
        expect(codebook).not.toContain("Notes");
        expect(buildTableDocument(coded).html).not.toMatch(/<script/i);
    });

    it("shows definitions on the header and the pill", () => {
        const html = renderTableHtml(coded);
        expect(html).toContain('title="What is the study design?\n\nCategories\nRCT — Random &lt;assignment&gt; to arms."');
        expect(cellHtml(html, "r1", "design")).toContain('title="Random &lt;assignment&gt; to arms."');
    });

    it("adds no codebook to a table without definitions", () => {
        const plain: TableSpec = {
            ...coded,
            columns: [{ ...coded.columns[0], options: [{ label: "RCT" }, { label: "Observational" }] }],
        };
        expect(renderTableHtml(plain)).not.toContain("bt-codebook");
    });
});

describe("select pills", () => {
    it("renders every colour in the shared palette as itself, not as grey", () => {
        // The renderer checks a declared colour against agent-core's palette.
        // A colour added there but missing from a list restated here would
        // silently come out grey in every stored table.
        for (const color of SELECT_COLORS) {
            const html = renderTableHtml({
                id: "p",
                columns: [
                    {
                        id: "tag",
                        header: "Tag",
                        type: "select",
                        options: [{ label: "Alpha", color }],
                    },
                ],
                rows: [
                    {
                        id: "r1",
                        cells: { tag: answered({ kind: "select", label: "Alpha" }) },
                    },
                ],
            });
            expect(html).toContain(`bt-pill bt-pill--${color}`);
        }
    });

    it("has a stylesheet rule for every colour in the palette", () => {
        // A colour the renderer emits but the sheet does not style is unstyled
        // in every stored table.
        for (const color of SELECT_COLORS) {
            expect(TABLE_CSS).toContain(`.bt-pill.bt-pill--${color} {`);
        }
    });

    it("falls back to grey for a colour outside the palette", () => {
        const html = renderTableHtml({
            id: "p",
            columns: [
                {
                    id: "tag",
                    header: "Tag",
                    type: "select",
                    options: [
                        { label: "Alpha", color: "chartreuse" as never },
                    ],
                },
            ],
            rows: [
                {
                    id: "r1",
                    cells: { tag: answered({ kind: "select", label: "Alpha" }) },
                },
            ],
        });
        expect(html).toContain("bt-pill bt-pill--gray");
        expect(html).not.toContain("chartreuse");
    });
});

describe("citations", () => {
    const columns: TableSpec["columns"] = [
        { id: REFERENCE_COLUMN_ID, header: "Item", type: "reference", system: true },
        { id: "finding", header: "Finding", type: "text" },
    ];

    /**
     * A row whose finding the filler read from the row's document, resting on
     * `evidence`. A row without a document has none to cite.
     */
    function citedRow(
        id: string,
        place: { ref?: RowRef; documents?: string[] } | undefined,
        evidence: TestEvidence[],
        referenceCell: Cell | null = reference(id),
    ): TableSpec["rows"][number] {
        const documents = place?.documents;
        const entries = evidence.map((entry) => ({ document: documents?.[0] ?? "u-NODOC", ...entry }));
        return {
            id,
            ...(place?.ref ? { ref: place.ref } : {}),
            ...(documents ? { documents } : {}),
            cells: {
                ...(referenceCell ? { [REFERENCE_COLUMN_ID]: referenceCell } : {}),
                finding: answered({ kind: "text", text: `Finding of ${id}.` }, "model", {
                    documents: [...new Set(entries.map((entry) => entry.document))],
                    evidence: entries,
                }),
            },
        };
    }

    const cited: TableSpec = {
        id: "c",
        columns,
        rows: [
            citedRow(
                "r1",
                itemRow("P1", "K1"),
                [{ locator: "s4", quote: "a 13% performance increase", page: 3 }],
                reference("Bloom 2015", {
                    formatted_citation: "Bloom, N. 2015. Does working from home work?",
                    content_kind: "pdf",
                }),
            ),
            citedRow("r2", itemRow("P2", "K2"), [{ locator: "s1", quote: "no effect", page: 0 }], reference("Beta")),
            // A row without a reference cannot be cited.
            citedRow("r3", undefined, [{ locator: "s1", quote: "uncitable" }]),
        ],
    };

    it("numbers each source once, in the order it is met", () => {
        const html = renderTableHtml(cited);
        const markers = markerNumbers(html);
        // A marker sits in the grid cell and again after its passage in the
        // row's expansion, so what matters is that each source kept one number.
        expect([...new Set(markers)]).toEqual(["1", "2"]);
        expect(markers.filter((m) => m === "1")).toHaveLength(2);
    });

    it("quotes each passage once, in the expanded row, followed by its marker", () => {
        const html = renderTableHtml(cited);
        expect(html.split("a 13% performance increase")).toHaveLength(2);
        expect(detailHtml(html, "r1")).toMatch(/“a 13% performance increase”<a class="bt-cite bt-cite--locator"[^>]*>1<\/a>/);
        expect(cellHtml(html, "r1", "finding")).toMatch(/Finding of r1\.<\/span><a class="bt-cite/);
        // No reference, nothing to cite: the answer stands without a marker.
        expect(cellHtml(html, "r3", "finding")).not.toContain("bt-cite");
    });

    it("gives every passage from one paper that paper's number and lists the paper once", () => {
        const paper: TableSpec = {
            id: "s",
            columns: [...columns, { id: "method", header: "Method", type: "text" }],
            rows: [
                {
                    id: "r",
                    ...itemRow("P1", "A1"),
                    cells: {
                        [REFERENCE_COLUMN_ID]: reference("Paper One", {
                            formatted_citation: "Paper One",
                            content_kind: "pdf",
                        }),
                        finding: answered({ kind: "text", text: "One." }, "model", {
                            documents: ["u-A1"],
                            evidence: [
                                { document: "u-A1", locator: "s1", quote: "first", page: 0 },
                                { document: "u-A1", locator: "s9", quote: "second", page: 2 },
                            ],
                        }),
                        method: answered({ kind: "text", text: "Two." }, "model", {
                            documents: ["u-A1"],
                            evidence: [{ document: "u-A1", locator: "s20", quote: "a survey", page: 5 }],
                        }),
                    },
                },
            ],
        };
        const html = renderTableHtml(paper);
        const markers = markerNumbers(html);
        // The passages of both answers are all the one paper's: three in the
        // grid and the same three in the expansion.
        expect(markers).toEqual(["1", "1", "1", "1", "1", "1"]);
        // Each marker opens its own passage's page.
        expect(html).toContain('href="zotero://open/library/items/A1?page=1"');
        expect(html).toContain('href="zotero://open/library/items/A1?page=3"');
        expect(html).toContain('href="zotero://open/library/items/A1?page=6"');
        const sources = html.slice(html.indexOf('class="bt-srcs"'));
        expect(sources.match(/<li /g)).toHaveLength(1);
        // The entry reveals the paper; the file it was read from is a separate link.
        expect(sources).toContain('href="zotero://select/library/items/P1" title="Show in library"');
        expect(sources).toContain('href="zotero://open/library/items/A1">Open PDF</a>');
    });

    it("keeps one marker per evidence entry, even for one source", () => {
        const twice: TableSpec = {
            id: "t",
            columns,
            rows: [
                citedRow("r1", itemRow("P1", "K1"), [
                    { locator: "s4", quote: "rose", page: 3 },
                    { locator: "s5", quote: "rose again", page: 3 },
                ]),
            ],
        };
        const html = renderTableHtml(twice);
        expect(markerNumbers(cellHtml(html, "r1", "finding"))).toEqual(["1", "1"]);
    });

    it("names a located passage's page in the marker's tooltip and link, and never its boxes", () => {
        const located: TableSpec = {
            id: "l",
            columns,
            rows: [
                citedRow("r1", itemRow("P1", "K1"), [
                    { locator: "s3", quote: "the passage", page: 2, boxes: [[11.5, 22.5, 33.5, 44.5]] },
                ]),
            ],
        };
        const html = renderTableHtml(located);
        expect(html).toContain('title="r1 — Page 3" href="zotero://open/library/items/K1?page=3"');
        expect(html).not.toContain("22.5");
        expect(html).not.toContain("data-cite-");
    });

    it("marks an answer taken from title and abstract, which cites nothing", () => {
        const fromAbstract: TableSpec = {
            id: "m",
            columns,
            rows: [
                {
                    id: "r1",
                    ref: itemRef("P1"),
                    cells: {
                        [REFERENCE_COLUMN_ID]: reference("Bloom 2015"),
                        finding: answered({ kind: "text", text: "Remote work." }, "model", {
                            reasoning: "The abstract says so.",
                        }),
                    },
                },
            ],
        };
        const html = renderTableHtml(fromAbstract);
        expect(cellHtml(html, "r1", "finding")).toContain("From title and abstract");
        expect(html).not.toContain("bt-cite");
        expect(html).not.toContain("bt-srcs");
        // The reasoning stays in `table.json`; the tab's inspector shows it.
        expect(html).not.toContain("The abstract says so.");
    });

    it("opens the cited page, and names the source and the page in its tooltip", () => {
        const html = renderTableHtml(cited);
        expect(cellHtml(html, "r1", "finding")).toContain(
            '<a class="bt-cite bt-cite--locator" title="Bloom 2015 — Page 4" href="zotero://open/library/items/K1?page=4">1</a>',
        );
    });

    it("colours a marker by what it points at", () => {
        const mixed: TableSpec = {
            id: "x",
            columns,
            rows: [
                citedRow("r1", itemRow("P1", "K1"), [{ locator: "s4", quote: "located", page: 3 }]),
                citedRow(
                    "r3",
                    { ref: { kind: "file", ext_key: "F1", label: "notes.pdf" }, documents: ["ext-F1"] },
                    [{ locator: "s2", quote: "in a file", page: 1 }],
                ),
            ],
        };
        const html = renderTableHtml(mixed);
        expect(cellHtml(html, "r1", "finding")).toContain("bt-cite bt-cite--locator");
        // An attached file has no link here; the marker is a span.
        expect(cellHtml(html, "r3", "finding")).toContain('<span class="bt-cite bt-cite--locator"');
    });

    it("lists the cited sources so a saved table stands on its own", () => {
        const listed: TableSpec = {
            ...cited,
            rows: [
                ...cited.rows,
                // A row with a reference but no reference cell has nothing to name it by.
                citedRow("r4", itemRow("P4", "K4"), [{ locator: "s1", quote: "unnamed", page: 0 }], null),
            ],
        };
        const html = renderTableHtml(listed);
        const sources = html.slice(html.indexOf('class="bt-srcs"'));
        const entries = [...sources.matchAll(/<li id="bt-src-(\d+)"[\s\S]*?<\/li>/g)];
        expect(entries.map((m) => m[1])).toEqual(["1", "2", "3"]);
        // The formatted citation, else the short name, else a placeholder.
        expect(entries[0][0]).toContain("Bloom, N. 2015. Does working from home work?");
        expect(entries[1][0]).toContain("Beta");
        expect(entries[2][0]).toContain("Source unavailable");
    });

    it("strips citation tags from a text value instead of printing them raw", () => {
        const html = renderTableHtml({
            ...cited,
            rows: [
                {
                    id: "r1",
                    cells: {
                        finding: answered({
                            kind: "text",
                            text: 'Claim. <citation id="u-ABCD1234" loc="s1"/> <citation/>',
                        }),
                    },
                },
            ],
        });
        expect(html).not.toContain("&lt;citation");
        expect(html).toContain("Claim.");
    });

    it("names the cited item's library, so a group citation is not a dead link", () => {
        // `library/` is the personal library. A citation into a group resolves
        // to nothing under it, and only the host knows which is which — hence
        // the `citationScopeFor` seam.
        const inGroup: TableSpec = {
            ...cited,
            rows: [
                citedRow(
                    "r1",
                    itemRow("P1", "K1", 7, "g4242"),
                    [{ locator: "s4", quote: "a 13% performance increase", page: 3 }],
                ),
            ],
        };

        const html = renderTableHtml(inGroup, {
            citationScopeFor: (libraryId) =>
                libraryId === 7 ? "groups/4242" : "library",
        });

        expect(html).toContain(
            'href="zotero://open/groups/4242/items/K1?page=4"',
        );
        expect(html).not.toContain("zotero://open/library/items/K1");
        // The bibliography entry has to agree with the marker above it.
        expect(
            [...html.matchAll(/zotero:\/\/open\/groups\/4242\/items\/K1/g)]
                .length,
        ).toBeGreaterThan(1);
        expect(html).toContain('href="zotero://select/groups/4242/items/P1"');
    });

    it("falls back to the personal library when no host supplies a scope", () => {
        const html = renderTableHtml(cited);
        expect(html).toContain('href="zotero://open/library/items/K1?page=4"');
    });

    it("renders no sources section for a table without evidence", () => {
        expect(renderTableHtml(spec)).not.toContain("bt-srcs");
        expect(renderTableHtml({ ...cited, rows: [] })).not.toContain("bt-srcs");
    });
});

describe("cell states", () => {
    const columns: TableSpec["columns"] = [
        { id: REFERENCE_COLUMN_ID, header: "Item", type: "reference", system: true },
        { id: "a", header: "Answer", type: "text" },
    ];

    it("shows staleness beside a failure's error", () => {
        const html = renderTableHtml({
            id: "states",
            columns: [{ id: "a", header: "Answer", type: "text" }],
            rows: [
                {
                    id: "r",
                    cells: {
                        a: {
                            outcome: "failed",
                            provenance: "model",
                            error_code: "no_locator",
                            error: "Failed inspection",
                            stale: true,
                        },
                    },
                },
            ],
        });
        expect(html).toContain(
            'Failed inspection</span><small class="bt-cell-state"> · <span class="bt-stale" title="The question changed">Stale</span></small>',
        );
    });

    it("says a failure failed even when it names no error", () => {
        const html = renderTableHtml({
            id: "f",
            columns: [{ id: "a", header: "Answer", type: "text" }],
            rows: [{ id: "r", cells: { a: { outcome: "failed", provenance: "model" } as Cell } }],
        });
        expect(html).toContain('<span class="bt-err">Could not be answered</span>');
    });

    it("preserves every outcome and who wrote it in the snapshot", () => {
        const states: TableSpec = {
            id: "outcomes",
            columns,
            rows: [
                {
                    id: "unreported",
                    ...itemRow("P1", "K1"),
                    cells: {
                        [REFERENCE_COLUMN_ID]: reference("Unreported 2020"),
                        a: {
                            outcome: "not_reported",
                            provenance: "model",
                            documents: ["u-K1"],
                            reasoning: "The methods section names no sample.",
                            evidence: [{ document: "u-K1", locator: "s12", quote: "We   surveyed\n firms.", page: 4 }],
                        },
                    },
                },
                { id: "blank", cells: { a: { outcome: "cleared", provenance: "user" } } },
                { id: "mine", cells: { a: answered({ kind: "text", text: "My answer" }, "user") } },
                {
                    id: "tentative",
                    ...itemRow("P3", "K3"),
                    cells: {
                        a: answered({ kind: "text", text: "Tentative answer" }, "model", {
                            documents: ["u-K3"],
                            confidence: "low",
                            stale: true,
                        }),
                    },
                },
                {
                    id: "meta",
                    ref: itemRef("P2"),
                    cells: { a: answered({ kind: "text", text: "From the abstract" }, "model") },
                },
                {
                    id: "broken",
                    cells: { a: { outcome: "failed", provenance: "model", error_code: "no_support", error: "Timed out" } },
                },
            ],
        };
        const { html } = buildTableDocument(states);

        expect(cellHtml(html, "unreported", "a")).toContain("Not reported");
        // A not-reported finding still cites where it looked.
        expect(cellHtml(html, "unreported", "a")).toContain('class="bt-cite');
        expect(cellHtml(html, "blank", "a")).toContain("Cleared by you");
        expect(cellHtml(html, "mine", "a")).toContain("Edited by you");
        // Prose is never marked for review, whatever its confidence.
        expect(cellHtml(html, "tentative", "a")).toContain(
            '<small class="bt-cell-state"> · <span class="bt-stale" title="The question changed">Stale</span></small>',
        );
        expect(cellHtml(html, "meta", "a")).toContain("From title and abstract");
        expect(cellHtml(html, "broken", "a")).toContain("Timed out");

        // The expanded row shows the closest passages; the reason stays in
        // `table.json`.
        const detail = detailHtml(html, "unreported");
        expect(detail).toContain('<div class="bt-d-h">Closest passages</div>');
        expect(detail).not.toContain("The methods section names no sample.");
        expect(detail).toMatch(/<li>“We surveyed firms\.”<a class="bt-cite[^>]*>\d<\/a><\/li>/);

        const footer = /<footer class="bt-foot">([^<]*)<\/footer>/.exec(html)![1];
        expect(footer).toBe("6 rows · 1 not reported · 1 failed · 1 from title and abstract");
        expect(html).not.toContain("contenteditable");
        expect(html).not.toMatch(/<script\b/i);
    });

    it("never counts a column as filling in the footer", () => {
        const html = renderTableHtml({
            id: "f",
            columns: [
                { id: "a", header: "Answer", type: "text", status: "filling", progress: { done: 1, total: 3 } },
            ],
            rows: [{ id: "r", cells: {} }],
        });
        const footer = /<footer class="bt-foot">([^<]*)<\/footer>/.exec(html)![1];
        expect(footer).toBe("1 row");
    });
});

describe("how answers read", () => {
    const columns: TableSpec["columns"] = [
        { id: REFERENCE_COLUMN_ID, header: "Item", type: "reference", system: true },
        { id: "rct", header: "RCT?", type: "boolean" },
        { id: "share", header: "Share (%)", type: "text" },
        { id: "note", header: "Note", type: "text" },
    ];
    const doc = "u-K1";
    const filler = (value: CellValue, extra: Record<string, unknown> = {}) =>
        answered(value, "model", { documents: [doc], ...extra });
    const row = (id: string, cells: Record<string, Cell>, extra: Record<string, unknown> = {}) => ({
        id,
        ...itemRow(`P${id}`, "K1"),
        ...extra,
        cells: { [REFERENCE_COLUMN_ID]: reference(id), ...cells },
    });

    it("writes a no as the word, in muted type, never as an empty cell", () => {
        const html = renderTableHtml({
            id: "b",
            columns,
            rows: [row("r", { rct: filler({ kind: "boolean", value: false }) })],
        });
        expect(cellHtml(html, "r", "rct")).toContain('<span class="bt-no">No</span>');
        expect(TABLE_CSS).toContain(".bt-wrap .bt-no { color: var(--t-fade); }");
    });

    it("heads a no's passages as evidence, leaves out its reason, and says when an answer cites none", () => {
        const html = renderTableHtml({
            id: "a",
            columns,
            rows: [
                row("r", {
                    rct: filler({ kind: "boolean", value: false }, {
                        reasoning: "No randomisation is described.",
                        evidence: [{ document: doc, locator: "s7", quote: "Participants chose a group." }],
                    }),
                }),
                row("u", {
                    rct: filler({ kind: "boolean", value: false }, {
                        reasoning: "Randomisation is never mentioned.",
                    }),
                }),
            ],
        });
        expect(cellHtml(html, "r", "rct")).toContain('<span class="bt-no">No</span>');
        const detail = detailHtml(html, "r");
        const heading = detail.indexOf('<div class="bt-d-h">Evidence</div>');
        expect(heading).toBeGreaterThan(0);
        expect(detail).not.toContain("No randomisation is described.");
        expect(detail.indexOf("<li>“Participants chose a group.”")).toBeGreaterThan(heading);
        const uncited = detailHtml(html, "u");
        expect(uncited).not.toContain("Randomisation is never mentioned.");
        expect(uncited).not.toContain("bt-d-h");
        expect(uncited).toContain('<div class="bt-d-uncited">No passage cited</div>');
        expect(detail).not.toContain("bt-d-uncited");
    });

    it("heads every answer's passages as evidence, a category negative's too", () => {
        const design: TableSpec["columns"][number] = {
            id: "design",
            header: "Design",
            type: "select",
            options: [{ label: "No case study" }, { label: "Case study" }],
        };
        const quote = [{ document: doc, locator: "s7", quote: "Randomly assigned." }];
        const html = renderTableHtml({
            id: "e",
            columns: [...columns, design],
            rows: [
                row("r", {
                    rct: filler({ kind: "boolean", value: true }, { evidence: quote }),
                    design: filler({ kind: "select", label: "No case study" }, { evidence: quote }),
                }),
            ],
        });
        const detail = detailHtml(html, "r");
        expect(detail.split('<div class="bt-d-h">Evidence</div>').length - 1).toBe(2);
        expect(detail).not.toContain("Related passages");
        expect(detail).not.toContain("Closest passages");
    });

    it("never marks an answer for review, whatever its stored confidence", () => {
        const html = renderTableHtml({
            id: "r",
            columns,
            rows: [
                row("r", {
                    share: filler({ kind: "text", text: "3" }, { confidence: "medium" }),
                    note: filler({ kind: "text", text: "Medium prose" }, { confidence: "medium" }),
                    rct: filler({ kind: "boolean", value: true }, { confidence: "low" }),
                }),
                // The user's own answer is never marked.
                row("u", { note: answered({ kind: "text", text: "Mine" }, "user") }),
            ],
        });
        expect(html).not.toContain("To review");
        expect(html).not.toContain("bt-review");
        const footer = /<footer class="bt-foot">([^<]*)<\/footer>/.exec(html)![1];
        expect(footer).toBe("2 rows");
    });

    it("sets a cited table row's caption and header rows in small type above the quote", () => {
        const html = renderTableHtml({
            id: "c",
            columns,
            rows: [
                row("r", {
                    share: filler({ kind: "text", text: "41" }, {
                        evidence: [
                            {
                                document: doc,
                                locator: "s30",
                                quote: "Women 41",
                                context: "Table 2. Participants | Group | %",
                            },
                        ],
                    }),
                }),
            ],
        });
        expect(detailHtml(html, "r")).toContain(
            '<li><span class="bt-ev-ctx">Table 2. Participants | Group | %</span>“Women 41”',
        );
        expect(TABLE_CSS).toContain(".bt-ev-ctx { display: block; font-size: 12px; color: var(--t-fade); }");
    });

    it("says why a cell is stale", () => {
        const html = renderTableHtml({
            id: "s",
            columns,
            rows: [
                row("question", { note: filler({ kind: "text", text: "Old question" }, { stale: true }) }),
                // The row now names another document than the answer was read from.
                row("moved", { note: filler({ kind: "text", text: "Old file" }) }, { documents: ["u-K2"] }),
                // Answered from title and abstract, and the row has since gained a document.
                row("gained", { note: answered({ kind: "text", text: "From abstract" }, "model") }),
                // Never stale by the row rule: the user's own answer.
                row("user", { note: answered({ kind: "text", text: "Mine" }, "user") }, { documents: ["u-K2"] }),
            ],
        });
        expect(cellHtml(html, "question", "note")).toContain('<span class="bt-stale" title="The question changed">Stale</span>');
        const documentChanged = `<span class="bt-stale" title="The paper${escapeHtml("'")}s document changed">Stale</span>`;
        expect(cellHtml(html, "moved", "note")).toContain(documentChanged);
        expect(cellHtml(html, "gained", "note")).toContain(documentChanged);
        expect(cellHtml(html, "gained", "note")).toContain("From title and abstract");
        expect(cellHtml(html, "user", "note")).not.toContain("Stale");
    });

    it("keeps a failed row's error style and says why it stopped, telling nothing to read from a read error", () => {
        const html = renderTableHtml({
            id: "f",
            columns,
            rows: [
                row("empty", {}, {
                    documents: undefined,
                    failure: { code: "no_source", message: "This item has no document or abstract to read." },
                }),
                row("locked", {}, { failure: { code: "encrypted", message: "The PDF is password-protected." } }),
                row("fine", { note: filler({ kind: "text", text: "Read" }) }),
            ],
        });
        expect(html).toMatch(/<details class="bt-r[^"]* bt-r-err" id="empty"/);
        expect(html).toMatch(/<details class="bt-r[^"]* bt-r-err" id="locked"/);
        expect(html).not.toMatch(/<details class="[^"]*bt-r-err[^"]*" id="fine"/);
        expect(detailHtml(html, "empty")).toContain(
            '<p class="bt-d-err"><strong>Nothing to read.</strong> This item has no document or abstract to read.</p>',
        );
        expect(detailHtml(html, "locked")).toContain(
            '<p class="bt-d-err"><strong>Could not be read.</strong> The PDF is password-protected.</p>',
        );
        // Its unattempted cells stay empty.
        expect(cellHtml(html, "locked", "note")).toContain('<span class="bt-empty"></span>');
        const footer = /<footer class="bt-foot">([^<]*)<\/footer>/.exec(html)![1];
        expect(footer).toBe("3 rows · 2 papers could not be read");
    });
});

/**
 * One spec that exercises every part of the model a stored table has to keep:
 * all seven cell kinds, every outcome and provenance, `confidence` and
 * `stale`, answers from the document and from title and abstract,
 * evidence with table context, a select with a declared vocabulary, a
 * screening decision with its reasoning, a library row, an external row, a
 * context-file row with a row failure, row origins and the approved sources.
 */
const fullSpec: TableSpec = {
    id: "full",
    spec_version: TABLE_SPEC_VERSION,
    key: "SNAP1234",
    version: 7,
    title: "Screening",
    description: "Every cell kind at once",
    anchor_column_id: "ref",
    sources: [{ id: "src1", type: "items", ids: ["u-K1", "openalex:W123"] }],
    columns: [
        {
            id: "ref",
            header: "Item",
            type: "reference",
            details: { kind: "text", text: "The paper as it was found." },
        },
        {
            id: "decision",
            header: "Include?",
            type: "select",
            role: "decision",
            description: "Does it meet the inclusion criteria?",
            options: [
                { label: "Include", color: "green" },
                { label: "Exclude", color: "red" },
            ],
        },
        {
            id: "n",
            header: "Sample",
            type: "text",
            align: "end",
            width: 120,
        },
        { id: "when", header: "Published", type: "date", priority: "primary" },
        { id: "oa", header: "OA", type: "boolean" },
        {
            id: "finding",
            header: "Finding",
            type: "text",
            description: "What did it find?",
            details: { kind: "list", items: ["Read the results section"] },
            status: "filling",
            progress: { done: 2, total: 3 },
            wrap: "clamp",
        },
        {
            id: "url",
            header: "DOI",
            type: "link",
            system: true,
            sortable: false,
            filterable: false,
            wrap: "nowrap",
            priority: "secondary",
            width: "fill",
        },
    ],
    rows: [
        {
            id: "a1b2c3",
            ...itemRow("K1", "A1"),
            in_library: true,
            origin: [{ source: "src1", date: "2026-10-01" }],
            cells: {
                ref: answered(
                    {
                        kind: "reference",
                        display_name: "Bloom et al. 2015",
                        title: "Does working from home work?",
                        subtitle: "Bloom et al.",
                        venue: "QJE",
                        item_type: "journalArticle",
                        formatted_citation: "Bloom, N. et al. 2015. Does working from home work? QJE.",
                        content_kind: "pdf",
                    },
                    "system",
                ),
                decision: answered({ kind: "select", label: "Include" }, "model", {
                    documents: ["u-A1"],
                    confidence: "high",
                    reasoning: "Randomised, and on topic.",
                    evidence: [{ document: "u-A1", locator: "s12", quote: "Employees were randomly assigned.", page: 2 }],
                }),
                n: answered({ kind: "text", text: "about 1,200" }, "model", {
                    documents: ["u-A1"],
                    confidence: "medium",
                    evidence: [
                        {
                            document: "u-A1",
                            locator: "s3",
                            quote: "1,200",
                            page: 1,
                            boxes: [[10, 20, 30, 40]],
                            context: "Table 1. Sample. | Group | N",
                        },
                    ],
                }),
                when: answered({ kind: "date", value: "2015-02", display: "Feb 2015" }, "model"),
                oa: answered({ kind: "boolean", value: false }, "model", {
                    documents: ["u-A1"],
                    reasoning: "No open-access statement anywhere in the paper.",
                }),
                finding: answered(
                    { kind: "text", text: "Performance rose 13%." },
                    "model",
                    {
                        documents: ["u-A1"],
                        stale: true,
                        evidence: [
                            { document: "u-A1", locator: "s40-s41", quote: "a 13% performance increase", page: 3 },
                            { document: "u-A1", locator: "s52", quote: "of which 9% came from more minutes", page: 4 },
                        ],
                    },
                ),
                url: answered(
                    {
                        kind: "link",
                        url: "https://doi.org/10.1093/qje/qju032",
                        label: "10.1093/qje/qju032",
                    },
                    "system",
                ),
            },
        },
        {
            id: "d4e5f6",
            ref: {
                kind: "external",
                source: "openalex",
                source_id: "W123",
                reference: {
                    source: "openalex",
                    source_id: "W123",
                    title: "Remote work and productivity",
                    authors: ["Nguyen, T."],
                    year: 2019,
                    library_items: [],
                },
            },
            in_library: false,
            actions: ["import"],
            origin: [{ source: "src1", date: "2026-10-01" }],
            cells: {
                ref: reference("Remote work and productivity", { subtitle: "Nguyen" }),
                decision: answered({ kind: "select", label: "Exclude" }, "user"),
                n: {
                    outcome: "not_reported",
                    provenance: "model",
                    reasoning: "The abstract gives no sample size.",
                },
                when: answered({ kind: "date", value: "2019" }, "model"),
                oa: { outcome: "cleared", provenance: "user" },
                finding: { outcome: "failed", provenance: "model", error_code: "no_locator", error: "Extraction failed" },
            },
        },
        {
            id: "g7h8i9",
            ref: { kind: "file", ext_key: "f1", label: "protocol.pdf" },
            documents: ["ext-f1"],
            failure: { code: "encrypted", message: "The file could not be read." },
            cells: { ref: reference("protocol.pdf") },
        },
    ],
    sort: { column_id: "when", direction: "asc" },
    capabilities: {
        sortable: true,
        filterable: true,
        expandable_rows: true,
        row_actions: ["reveal", "open", "import"],
        allow_add_column: true,
        allow_add_row: true,
    },
    cost_estimate: { per_row_credits: 2, estimated_seconds: 45 },
};

describe("a stored table's rendering", () => {
    it("is built from a spec every cell of which a store would accept", () => {
        expect(validateTableSpec(fullSpec)).toEqual([]);
        for (const row of fullSpec.rows) {
            expect(rowInvariantError(row)).toBeUndefined();
            for (const cell of Object.values(row.cells)) {
                expect(cellInvariantError(cell)).toBeUndefined();
            }
        }
    });

    it("is byte-for-byte the same on a second build", () => {
        expect(buildTableDocument(fullSpec, { specSha256: HASH }).html).toBe(
            buildTableDocument(fullSpec, { specSha256: HASH }).html,
        );
    });

    it("renders every evidence entry as a marker and lists each source once", () => {
        const { html } = buildTableDocument(fullSpec);
        // Four evidence entries, each marked in the grid and after its quote.
        const detail = detailHtml(html, "a1b2c3");
        expect(markerNumbers(detail)).toEqual(["1", "1", "1", "1"]);
        expect(markerNumbers(html)).toHaveLength(8);
        const sources = html.slice(html.indexOf('class="bt-srcs"'));
        expect(sources.match(/<li /g)).toHaveLength(1);
        expect(sources).toContain("Bloom, N. et al. 2015. Does working from home work? QJE.");
    });

    it("escapes a cell that tries to inject markup", () => {
        const hostile: TableSpec = {
            ...fullSpec,
            rows: [
                {
                    id: "r1",
                    cells: {
                        finding: answered(
                            {
                                kind: "text",
                                text: "</script><!-- <script>alert(1)</script> --> still here",
                            },
                            "user",
                        ),
                    },
                },
            ],
        };
        const { html } = buildTableDocument(hostile);
        expect(html).not.toMatch(/<\/?script\b/i);
        expect(html).toContain("&lt;script&gt;alert(1)");
        expect(html).toContain("still here");
    });

    it("does not move the text before a row when a later row changes", () => {
        const before = buildTableDocument(spec).html;
        // `spec` sorts by citations descending, so Gamma (no count) is last.
        const after = buildTableDocument({
            ...spec,
            rows: spec.rows.map((row) =>
                row.id === "r3"
                    ? {
                          ...row,
                          cells: {
                              ...row.cells,
                              abstract: answered({ kind: "text", text: "A late addition" }),
                          },
                      }
                    : row,
            ),
        }).html;

        expect(after).not.toBe(before);
        const cut = textOf(before).indexOf("Gamma");
        expect(cut).toBeGreaterThan(0);
        expect(textOf(after).indexOf("Gamma")).toBe(cut);
        expect(textOf(after).slice(0, cut)).toBe(textOf(before).slice(0, cut));
    });
});

describe("a stored table stands on its own", () => {
    it("references no external resource", () => {
        const { html } = buildTableDocument(fullSpec, {
            linksFor: () => ({
                reveal: "zotero://select/library/items/K1",
                open: "zotero://open/library/items/K1",
            }),
        });
        // No stylesheet, script or image to fetch.
        expect(html).not.toMatch(/<link\b/i);
        expect(html).not.toMatch(/<img\b/i);
        expect(html).not.toMatch(/\bsrc=/i);
        expect(html).not.toMatch(/@import/i);
        expect(html).not.toMatch(/url\(/i);
        expect(html).not.toMatch(/chrome:\/\//i);
        // Row verbs are `zotero://` content links, which resolve locally.
        expect(html).toContain('href="zotero://select/library/items/K1"');
    });

    it("stays under the reader's CSS budget at the design caps", () => {
        const columns = Array.from({ length: 30 }, (_, i) =>
            i % 3 === 0
                ? {
                      id: `c${i}`,
                      header: `Column ${i}`,
                      type: "select" as const,
                      options: Array.from({ length: 10 }, (_, j) => ({ label: `v${j}` })),
                  }
                : { id: `c${i}`, header: `Column ${i}`, type: "text" as const },
        );
        const { cssRuleCount } = buildTableDocument({ id: "caps", columns, rows: [] });
        expect(cssRuleCount).toBeLessThan(CSS_RULE_BUDGET);
        expect(cssRuleCount).toBe(buildTableDocument(spec).cssRuleCount);
    });
});

describe("reading layout", () => {
    const spec: TableSpec = {
        id: "l",
        columns: [
            { id: "ref", header: "Paper", type: "reference" },
            { id: "q", header: "Question", type: "text" },
        ],
        rows: [{ id: "r", cells: { ref: reference("A") } }],
    };

    it("shows up to eight lines of an answer in the grid, the rest when the row expands", () => {
        expect(TABLE_CSS).toContain(".bt-body { --lines: 8; --title-lines: 3;");
        expect(TABLE_CSS).toContain(".bt-d .bt-clamp, .bt-d .bt-title { display: block; -webkit-line-clamp: unset;");
    });

    it("shares the frame's width between flexible columns instead of fixing them", () => {
        const html = renderTableHtml(spec);
        expect(html).toContain("--cols:2.6rem minmax(11rem, 1.3fr) minmax(8rem, 1fr)");
    });

    it("offers no export, which only the Beaver tab can run", () => {
        const html = renderTableHtml(spec);
        expect(html).not.toContain("data-bt-command");
        expect(TABLE_CSS).not.toContain("bt-export");
    });
});

describe("what the static page carries", () => {
    const words =
        "the effect of conditional cash transfers on school enrolment among adolescent girls in rural districts was positive".split(" ");
    const prose = (length: number, seed: number): string => {
        let out = "";
        for (let i = seed; out.length < length; i += 7) out += `${words[i % words.length]} `;
        return out.trim();
    };

    /**
     * A filled table at the spec cap: two evidence entries a cell with boxes,
     * a context on one entry in ten, and a reasoning on every model cell.
     */
    function capSizedSpec(rows: number, questions: number): TableSpec {
        const columns: TableSpec["columns"] = [
            { id: REFERENCE_COLUMN_ID, header: "Reference", type: "reference", system: true },
            ...Array.from({ length: questions }, (_, c) => ({
                id: `q${c}`,
                header: `Question ${c}`,
                type: "text" as const,
                description: prose(90, c),
            })),
        ];
        return {
            id: "cap",
            title: "Cap",
            columns,
            rows: Array.from({ length: rows }, (_, r) => {
                const document = `u-A${r}`;
                const cells: Record<string, Cell> = {
                    [REFERENCE_COLUMN_ID]: reference(`Author ${r} (2011)`, {
                        title: prose(80, r),
                        subtitle: "Baird, McIntosh, Özler",
                        venue: "Quarterly Journal of Economics",
                    }),
                };
                for (let c = 0; c < questions; c++) {
                    cells[`q${c}`] = answered({ kind: "text", text: prose(180, r + c) }, "model", {
                        documents: [document],
                        reasoning: prose(300, c),
                        evidence: [0, 1].map((e) => ({
                            document,
                            locator: `s${10 + e}.${c}`,
                            quote: prose(220, r + c + e),
                            page: 3 + e,
                            boxes: [[72.1, 120.4, 523.9, 133.2], [72.1, 134.6, 401.2, 147.4]],
                            ...((r * questions + c) % 10 === 0 ? { context: prose(160, c) } : {}),
                        })),
                    });
                }
                return { id: `r${r}`, ref: itemRef(`K${r}`), documents: [document], cells };
            }),
        };
    }

    it("renders every row, answers, quotes and contexts, and leaves out reasoning and boxes", () => {
        const table = capSizedSpec(3, 2);
        table.rows[0].cells.q0 = {
            ...table.rows[0].cells.q0,
            reasoning: "REASONING-MARK",
        } as Cell;
        const html = buildTableDocument(table).html;
        expect(html.match(/<details class="bt-r" id="r\d+">/g)).toHaveLength(3);
        const firstQuote = (table.rows[0].cells.q0 as { evidence: Evidence[] }).evidence[0];
        expect(html).toContain(`“${firstQuote.quote}”`);
        expect(html).toContain(`<span class="bt-ev-ctx">${firstQuote.context}</span>`);
        expect(html).not.toContain("REASONING-MARK");
        expect(html).not.toContain("523.9");
    });

    it("stays close to the size of table.json at the spec cap", () => {
        const table = capSizedSpec(940, 7);
        const json = jsonBytes({ spec: table });
        expect(json).toBeLessThanOrEqual(MAX_SPEC_BYTES);
        expect(json).toBeGreaterThan(0.9 * MAX_SPEC_BYTES);
        const { html } = buildTableDocument(table, { specSha256: HASH, fileSha256: HASH });
        // Measured at about 1.25 times; the enhanced document was 3.3 times.
        expect(html.length / json).toBeLessThan(1.4);
        expect(html.match(/<details class="bt-r" id="r\d+">/g)).toHaveLength(940);
    });
});
