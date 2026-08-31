import { describe, expect, it } from "vitest";
import {
    SELECT_COLORS,
    TABLE_SPEC_VERSION,
    type TableSpec,
} from "@beaver/agent-core/layouts/table";
import {
    buildTableDocument,
    parseTableDocument,
    renderTableHtml,
    TABLE_CSS,
} from "../../../src/services/artifacts/tableDocument";
import { CSS_RULE_BUDGET } from "../../../src/utils/html";

const spec: TableSpec = {
    id: "t",
    title: "Results",
    caption: "From OpenAlex",
    anchor_column_id: "ref",
    columns: [
        { id: "ref", header: "Item", type: "reference" },
        { id: "cites", header: "Citations", type: "number" },
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
            ref: { kind: "item", library_id: 1, zotero_key: "K1" },
            cells: {
                ref: { value: { kind: "reference", display_name: "Alpha" } },
                cites: { value: { kind: "number", value: 10 } },
                type: { value: { kind: "select", label: "Article" } },
                oa: { value: { kind: "boolean", value: true } },
                abstract: { value: { kind: "text", text: "First abstract" } },
            },
        },
        {
            id: "r2",
            ref: { kind: "item", library_id: 1, zotero_key: "K2" },
            cells: {
                ref: { value: { kind: "reference", display_name: "Beta" } },
                cites: { value: { kind: "number", value: 90 } },
                type: { value: { kind: "select", label: "Book" } },
                oa: { value: { kind: "boolean", value: false } },
                abstract: { value: { kind: "text", text: "Second abstract" } },
            },
        },
        {
            // No citation count: it must sort last in *both* directions.
            id: "r3",
            cells: {
                ref: { value: { kind: "reference", display_name: "Gamma" } },
                type: { value: { kind: "select", label: "Article" } },
            },
        },
    ],
    sort: { column_id: "cites", direction: "desc" },
    capabilities: { row_actions: ["reveal", "open"] },
};

/** The `--o<i>` / `--p<i>` pair a row carries, by row id. */
function ranksFor(html: string, rowId: string): Record<string, number> {
    const row = new RegExp(
        `<details class="[^"]*" id="${rowId}" style="([^"]*)"`,
    ).exec(html);
    if (!row) return {};
    return Object.fromEntries(
        row[1]
            .split(";")
            .filter(Boolean)
            .map((pair) => {
                const [name, value] = pair.split(":");
                return [name.replace("--", ""), Number(value)];
            }),
    );
}

describe("renderTableHtml", () => {
    it("bakes the producer's sort into document order, so a viewer with no CSS still agrees", () => {
        const { html } = renderTableHtml(spec);
        const order = [
            ...html.matchAll(/<details class="[^"]*" id="([^"]+)"/g),
        ].map((m) => m[1]);
        expect(order).toEqual(["r2", "r1", "r3"]);
    });

    it("ranks an empty cell last in both directions", () => {
        const { html } = renderTableHtml(spec);
        // Column index 1 is Citations: r3 has no value.
        expect(ranksFor(html, "r3").o1).toBe(2);
        expect(ranksFor(html, "r3").p1).toBe(2);
        // …while the two filled rows swap ends.
        expect(ranksFor(html, "r1").o1).toBe(0);
        expect(ranksFor(html, "r1").p1).toBe(1);
        expect(ranksFor(html, "r2").o1).toBe(1);
        expect(ranksFor(html, "r2").p1).toBe(0);
    });

    it("emits one filter rule per value and tags the rows it matches", () => {
        const { html } = renderTableHtml(spec, { idPrefix: "x" });
        // Type is column 2, Article is its first option.
        expect(html).toContain(
            "#x-f0-1:checked ~ .bt-scroll .bt-r:not(.bt-v2-0)",
        );
        expect(html).toMatch(/<details class="bt-r bt-v2-0 bt-v3-1" id="r1"/);
        // Boolean columns get a group too.
        expect(html).toContain(
            "#x-f1-1:checked ~ .bt-scroll .bt-r:not(.bt-v3-1)",
        );
    });

    it("checks the radio matching the producer's sort", () => {
        const { html } = renderTableHtml(spec, { idPrefix: "x" });
        expect(html).toContain('id="x-sd1" class="bt-ctl" checked');
        expect(html).not.toContain('id="x-sa1" class="bt-ctl" checked');
    });

    it("omits the controls when the caller asks for a plain document", () => {
        const { html } = renderTableHtml(spec, { controls: false });
        expect(html).not.toContain("bt-ctl");
        expect(html).not.toContain("bt-toolbar");
        // The rows are still there, still in the producer's order.
        expect(html).toContain('id="r2"');
    });

    it("escapes producer text, including inside attributes", () => {
        const hostile: TableSpec = {
            ...spec,
            title: '<img src=x onerror="alert(1)">',
            rows: [
                {
                    id: '"><script>alert(1)</script>',
                    cells: {
                        ref: {
                            value: {
                                kind: "reference",
                                display_name: "</span><b>bold</b>",
                            },
                        },
                    },
                },
            ],
        };
        const { html } = renderTableHtml(hostile);
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
                        url: {
                            value: {
                                kind: "link",
                                url: "javascript:alert(1)",
                                label: "bad",
                            },
                        },
                    },
                },
                {
                    id: "r2",
                    cells: {
                        url: {
                            value: {
                                kind: "link",
                                url: "https://doi.org/10.1/x",
                            },
                        },
                    },
                },
            ],
        };
        const { html } = renderTableHtml(withLinks);
        expect(html).not.toContain("javascript:");
        expect(html).toContain('href="https://doi.org/10.1/x"');
    });

    it("emits a row's verbs only where the host supplied a URI for them", () => {
        const { html } = renderTableHtml(spec, {
            linksFor: (ref) =>
                ref.kind === "item" && ref.zotero_key === "K1"
                    ? {
                          selectUri: "zotero://select/library/items/K1",
                          openUri: null,
                      }
                    : {},
        });
        expect(html).toContain('href="zotero://select/library/items/K1"');
        // K2 got no URI, so it gets no link rather than a dead one.
        expect(html).not.toContain("items/K2");
    });
});

describe("buildTableDocument", () => {
    it("produces a self-contained document whose only script is the embedded spec", () => {
        const { html } = buildTableDocument(spec);
        expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
        // Data, not code: the document still runs nothing.
        expect([...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])).toEqual([
            '<script type="application/json" id="beaver-table-spec">',
        ]);
        expect(html).not.toMatch(/https?:\/\/(?!doi\.org)/);
        // rem is meaningless without a pinned root.
        expect(html).toContain("html { font-size: 14px; }");
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

    it("sheds its filters rather than break the reader's theming", () => {
        // Wide enough that its filter rules alone would break the budget.
        const columns = Array.from({ length: 40 }, (_, i) => ({
            id: `c${i}`,
            header: `Column ${i}`,
            type: "select" as const,
            options: Array.from({ length: 6 }, (_, j) => ({ label: `v${j}` })),
        }));
        const wide = renderTableHtml({ id: "w", columns, rows: [] });
        // Sorting survives; the filter bar does not.
        expect(wide.html).toContain("bt-sorters");
        expect(wide.html).not.toContain("bt-fg-h");
    });

    it("stays under the budget for a table with many sortable and filterable columns", () => {
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

    it("keeps the static stylesheet free of the id selectors that vary per table", () => {
        // Anything naming a control id belongs in the per-table block, or two
        // tables in one document would drive each other.
        expect(TABLE_CSS).not.toContain(":checked");
    });
});

describe("select pills", () => {
    it("renders every colour in the shared palette as itself, not as grey", () => {
        // The renderer checks a declared colour against agent-core's palette.
        // A colour added there but missing from a list restated here would
        // silently come out grey in every stored table.
        for (const color of SELECT_COLORS) {
            const { html } = renderTableHtml({
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
                        cells: {
                            tag: { value: { kind: "select", label: "Alpha" } },
                        },
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
        const { html } = renderTableHtml({
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
                    cells: { tag: { value: { kind: "select", label: "Alpha" } } },
                },
            ],
        });
        expect(html).toContain("bt-pill bt-pill--gray");
        expect(html).not.toContain("chartreuse");
    });
});

describe("citations", () => {
    const cited: TableSpec = {
        id: "c",
        columns: [
            { id: "ref", header: "Item", type: "reference" },
            { id: "finding", header: "Finding", type: "text" },
        ],
        rows: [
            {
                id: "r1",
                cells: {
                    ref: {
                        value: { kind: "reference", display_name: "Alpha" },
                    },
                    finding: {
                        value: {
                            kind: "text",
                            text: 'Performance rose 13%. <citation id="1-K1" loc="page4"/>',
                        },
                    },
                },
            },
            {
                id: "r2",
                cells: {
                    ref: { value: { kind: "reference", display_name: "Beta" } },
                    finding: {
                        value: {
                            kind: "text",
                            // The same source again, and one with no metadata.
                            text: 'No effect. <citation id="1-K1" loc="page4"/> <citation id="1-K9"/>',
                        },
                    },
                },
            },
        ],
        citations: [
            {
                citation_id: "c1",
                raw_tag: '<citation id="1-K1" loc="page4"/>',
                display_name: "Bloom 2015",
                formatted_citation:
                    "Bloom, N. 2015. Does working from home work?",
                preview: "a 13% performance increase",
                pages: [4],
                resolved_ref: {
                    kind: "zotero",
                    library_id: 1,
                    zotero_key: "K1",
                },
            },
        ],
    };

    it("numbers each source once, in the order it is met", () => {
        const { html } = renderTableHtml(cited);
        const markers = [...html.matchAll(/data-bt-cite="(\d+)"/g)].map(
            (m) => m[1],
        );
        // Each cell is rendered twice — in its row and in that row's detail —
        // so what matters is that the repeated source kept one number and the
        // unknown one took the next.
        expect([...new Set(markers)]).toEqual(["1", "2"]);
        expect(markers.filter((m) => m === "1").length).toBeGreaterThan(1);
    });

    it("opens the cited page, and carries the card's parts", () => {
        const { html } = renderTableHtml(cited);
        expect(html).toContain('href="zotero://open/library/items/K1?page=4"');
        // Kept apart so a host can lay them out the way the app does.
        expect(html).toContain('data-cite-name="Bloom 2015"');
        expect(html).toContain('data-cite-loc="Page 4"');
        expect(html).toContain("a 13% performance increase");
        expect(html).toContain("Highlights passage on page 4");
        // …and joined into a `title` for a viewer that can show no card.
        const title = /title="([^"]*)"[^>]*data-bt-cite/.exec(html)![1];
        expect(title).toContain("Bloom 2015");
        expect(title).toContain("Page 4");
    });

    it("colours a marker by what it points at", () => {
        const { html } = renderTableHtml(cited);
        // A locator lands on a passage; a bare tag with no metadata does not.
        expect(html).toContain("bt-cite bt-cite--locator");
        expect(html).toContain("bt-cite bt-cite--item");
    });

    it("lists the cited sources so a saved table stands on its own", () => {
        const { html } = renderTableHtml(cited);
        expect(html).toContain("Bloom, N. 2015. Does working from home work?");
        // A tag with no metadata still gets a numbered entry rather than vanishing.
        expect(html).toContain("Source unavailable");
        expect([...html.matchAll(/<li id="bt-src-\d+"/g)]).toHaveLength(2);
    });

    it("drops a tag it cannot parse instead of printing it raw", () => {
        const { html } = renderTableHtml({
            ...cited,
            rows: [
                {
                    id: "r1",
                    cells: {
                        finding: {
                            value: { kind: "text", text: "Claim. <citation/>" },
                        },
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
            citations: [
                {
                    ...cited.citations![0],
                    resolved_ref: {
                        kind: "zotero",
                        library_id: 7,
                        library_ref: "g4242",
                        zotero_key: "K1",
                    },
                },
            ],
        };

        const { html } = renderTableHtml(inGroup, {
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
    });

    it("falls back to the personal library when no host supplies a scope", () => {
        const { html } = renderTableHtml(cited);
        expect(html).toContain('href="zotero://open/library/items/K1?page=4"');
    });

    it("renders no sources section for a table without citations", () => {
        const { html } = renderTableHtml({
            ...cited,
            citations: undefined,
            rows: [],
        });
        expect(html).not.toContain("bt-srcs");
    });
});


/**
 * One spec that exercises every part of the model a stored table has to keep:
 * all seven cell kinds, both flags, `stale`, every provenance, a select with a
 * declared vocabulary, a screening decision with its details, a library row, an
 * external row, a context-file row, and a citation with a preview.
 */
const fullSpec: TableSpec = {
    id: "full",
    key: "SNAP1234",
    version: 7,
    title: "Screening",
    caption: "Every cell kind at once",
    anchor_column_id: "ref",
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
            role: "screening_decision",
            description: "Does it meet the inclusion criteria?",
            options: [
                { label: "Include", color: "green" },
                { label: "Exclude", color: "red" },
            ],
        },
        {
            id: "n",
            header: "Sample",
            type: "number",
            unit: "participants",
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
            id: "item:1:K1",
            ref: { kind: "item", library_id: 1, zotero_key: "K1" },
            in_library: true,
            cells: {
                ref: {
                    value: {
                        kind: "reference",
                        display_name: "Does working from home work?",
                        subtitle: "Bloom et al.",
                        venue: "QJE",
                        item_type: "journalArticle",
                        library_items: [{ library_id: 1, zotero_key: "K1" }],
                    },
                    provenance: "imported",
                },
                decision: {
                    value: { kind: "select", label: "Include" },
                    details: { kind: "text", text: "Randomised, and on topic." },
                    provenance: "asserted",
                },
                n: {
                    value: { kind: "number", value: 1200 },
                    provenance: "extracted",
                    flag: "unsure",
                },
                when: {
                    value: { kind: "date", value: "2015-02", display: "Feb 2015" },
                    provenance: "extracted",
                },
                oa: { value: { kind: "boolean", value: true }, provenance: "user" },
                finding: {
                    value: {
                        kind: "text",
                        text: 'Performance rose 13%. <citation id="1-K1" loc="page4"/>',
                    },
                    details: { kind: "list", items: ["Nine months", "Call centre"] },
                    provenance: "extracted",
                },
                url: {
                    value: {
                        kind: "link",
                        url: "https://doi.org/10.1093/qje/qju032",
                        label: "10.1093/qje/qju032",
                    },
                    provenance: "imported",
                    stale: true,
                },
            },
        },
        {
            id: "ext:openalex:W123",
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
            cells: {
                ref: {
                    value: {
                        kind: "reference",
                        display_name: "Remote work and productivity",
                        subtitle: "Nguyen",
                    },
                    provenance: "imported",
                },
                decision: {
                    value: { kind: "select", label: "Exclude" },
                    details: { kind: "list", items: ["Wrong population"] },
                    provenance: "user",
                },
                n: { status: "pending" },
                when: {
                    value: { kind: "date", value: "2019" },
                    provenance: "asserted",
                    flag: "unsourced",
                },
                oa: { value: { kind: "boolean", value: false }, provenance: "user" },
                finding: { status: "error", error: "Extraction failed" },
            },
        },
        {
            id: "file:f1",
            ref: { kind: "file", ext_key: "f1", label: "protocol.pdf" },
            status: "error",
            error: "The file could not be read.",
            cells: {
                ref: {
                    value: { kind: "reference", display_name: "protocol.pdf" },
                    provenance: "imported",
                },
            },
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
    citations: [
        {
            citation_id: "c1",
            raw_tag: '<citation id="1-K1" loc="page4"/>',
            display_name: "Bloom 2015",
            formatted_citation: "Bloom, N. 2015. Does working from home work?",
            preview: "a 13% performance increase",
            pages: [4],
            resolved_ref: { kind: "zotero", library_id: 1, zotero_key: "K1" },
        },
    ],
};

/**
 * The document's text, near enough for offset comparisons: annotations anchor
 * into text, and markup — including the inline style attributes that carry the
 * sort ranks — is not text. Entities are left alone, since both sides of a
 * comparison carry the same ones.
 */
function textOf(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "");
}

/** The JSON the document carries, as written (still `<`-escaped). */
function embeddedJson(html: string): string {
    return /id="beaver-table-spec">([\s\S]*?)<\/script>/.exec(html)![1];
}

describe("the embedded spec", () => {
    it("round-trips a spec that uses every part of the model", () => {
        const { html } = buildTableDocument(fullSpec);
        expect(parseTableDocument(html)).toEqual({
            ok: true,
            spec: { ...fullSpec, spec_version: TABLE_SPEC_VERSION },
        });
    });

    it("stamps the format version, and passes an existing one through", () => {
        const stamped = parseTableDocument(buildTableDocument(fullSpec).html);
        expect(stamped.ok && stamped.spec.spec_version).toBe(TABLE_SPEC_VERSION);
        // Identity and revision belong to the store, so they survive untouched.
        expect(stamped.ok && stamped.spec.key).toBe("SNAP1234");
        expect(stamped.ok && stamped.spec.version).toBe(7);
    });

    it("serialises compactly, since the JSON is machine state", () => {
        const json = embeddedJson(buildTableDocument(fullSpec).html);
        expect(json).not.toContain("\n");
        // Re-serialising it compactly changes nothing, so it was compact: no
        // indentation and no space the data did not put there.
        expect(json).toBe(
            JSON.stringify(JSON.parse(json)).replace(/</g, "\\u003c"),
        );
    });

    it("survives a cell that tries to close the script element", () => {
        const hostile: TableSpec = {
            ...fullSpec,
            rows: [
                {
                    id: "r1",
                    cells: {
                        finding: {
                            value: {
                                kind: "text",
                                text: "</script><!-- <script>alert(1)</script> --> still here",
                            },
                            provenance: "user",
                        },
                    },
                },
            ],
        };
        const { html } = buildTableDocument(hostile);
        // Nothing in the data can end the element early, so the document still
        // has exactly one script and it still parses.
        expect([...html.matchAll(/<\/script>/gi)]).toHaveLength(1);
        expect(embeddedJson(html)).not.toContain("<");
        const parsed = parseTableDocument(html);
        expect(parsed).toEqual({
            ok: true,
            spec: { ...hostile, spec_version: TABLE_SPEC_VERSION },
        });
        // …and the rendered cell escaped it rather than running it.
        expect(html).not.toContain("<script>alert(1)</script>");
        expect(html).toContain("&lt;script&gt;alert(1)");
    });

    it("is byte-for-byte the same on a second build", () => {
        expect(buildTableDocument(fullSpec).html).toBe(
            buildTableDocument(fullSpec).html,
        );
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
                              abstract: {
                                  value: {
                                      kind: "text" as const,
                                      text: "A late addition",
                                  },
                              },
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

describe("parseTableDocument", () => {
    it("reports a document that carries no spec", () => {
        expect(
            parseTableDocument("<!DOCTYPE html><html><body>Nope</body></html>"),
        ).toEqual({ ok: false, reason: "no_spec" });
    });

    it("refuses a newer format, and says which one", () => {
        const { html } = buildTableDocument({ ...fullSpec, spec_version: 999 });
        expect(parseTableDocument(html)).toEqual({
            ok: false,
            reason: "unsupported_version",
            specVersion: 999,
        });
    });

    it("reports malformed JSON rather than throwing", () => {
        const broken =
            '<!DOCTYPE html><html><body><script type="application/json" ' +
            'id="beaver-table-spec">{"id":</script></body></html>';
        const parsed = parseTableDocument(broken);
        expect(parsed.ok).toBe(false);
        expect(parsed.ok === false && parsed.reason).toBe("invalid");
        expect(parsed.ok === false && parsed.detail).toBeTruthy();
    });

    it("reports JSON that parses but is not a table", () => {
        const notATable =
            '<!DOCTYPE html><html><body><script type="application/json" ' +
            'id="beaver-table-spec">{"id":"t","columns":[]}</script></body></html>';
        const parsed = parseTableDocument(notATable);
        expect(parsed.ok === false && parsed.reason).toBe("invalid");
    });
});

describe("a stored table stands on its own", () => {
    it("references no external resource", () => {
        const { html } = buildTableDocument(fullSpec, {
            linksFor: () => ({
                selectUri: "zotero://select/library/items/K1",
                openUri: "zotero://open/library/items/K1",
            }),
        });
        // No stylesheet, script or image to fetch — the only `src`-less
        // stylesheet is the inline <style>, and the only script is data.
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
        // 20 columns, seven of them selects declaring ten categories each —
        // the shape that drives the per-table rules.
        const columns = Array.from({ length: 20 }, (_, i) =>
            i % 3 === 0
                ? {
                      id: `c${i}`,
                      header: `Column ${i}`,
                      type: "select" as const,
                      options: Array.from({ length: 10 }, (_, j) => ({
                          label: `v${j}`,
                      })),
                  }
                : { id: `c${i}`, header: `Column ${i}`, type: "text" as const },
        );
        const { html, cssRuleCount } = buildTableDocument({
            id: "caps",
            columns,
            rows: [],
        });
        // The filters must survive, or the budget is met by shedding them.
        expect(html).toContain("bt-fg-h");
        expect(cssRuleCount).toBeLessThan(CSS_RULE_BUDGET);
    });
});

describe("things a stored table must survive", () => {
    it("keeps the embedded spec after the table, where it cannot displace annotation offsets", () => {
        const { html } = buildTableDocument(spec);
        const script = html.indexOf("<script");
        // Snapshot annotations anchor by character offset into the document's
        // text, so the spec has to come after every piece of the table. Pinned
        // because the cost of moving it is invisible: the document still
        // renders, and every other test here still passes.
        expect(script).toBeGreaterThan(html.lastIndexOf("</section>"));
        expect(html.indexOf("<script")).toBe(html.lastIndexOf("<script"));
        expect(html.trimEnd().endsWith("</html>")).toBe(true);
    });

    it("renders a number that no longer survives a save as no value at all", () => {
        // JSON has no NaN, so `JSON.stringify` stores it as null and a reloaded
        // table would render `null.toLocaleString()`. Both directions read as
        // an empty cell instead of throwing.
        const withNaN: TableSpec = {
            id: "n",
            columns: [{ id: "size", header: "Size", type: "number" }],
            rows: [
                {
                    id: "r1",
                    cells: {
                        size: {
                            value: { kind: "number", value: Number.NaN },
                            provenance: "asserted",
                        },
                    },
                },
            ],
        };
        expect(() => buildTableDocument(withNaN)).not.toThrow();

        const parsed = parseTableDocument(buildTableDocument(withNaN).html);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        // Re-rendering what came back is the case that used to throw.
        expect(() => buildTableDocument(parsed.spec)).not.toThrow();
        expect(buildTableDocument(parsed.spec).html).toContain("bt-empty");
    });

    it("points a filter chip at the rows that actually carry its label", () => {
        // The chip and the row class are two halves of one index. An open
        // select enumerated once over sorted rows and once over the spec's
        // used to pair each chip with a different label's rows.
        const openSelect: TableSpec = {
            id: "f",
            columns: [{ id: "d", header: "Design", type: "select" }],
            sort: { column_id: "d", direction: "asc" },
            rows: [
                {
                    id: "zeta",
                    cells: {
                        d: {
                            value: { kind: "select", label: "Zeta" },
                            provenance: "asserted",
                        },
                    },
                },
                {
                    id: "alpha",
                    cells: {
                        d: {
                            value: { kind: "select", label: "Alpha" },
                            provenance: "asserted",
                        },
                    },
                },
            ],
        };
        const { html } = buildTableDocument(openSelect, { controls: true });

        // The chip labelled "Alpha" hides everything that is not class N; the
        // Alpha row must be the row carrying class N.
        const chip = /class="bt-fo bt-fo0-(\d+)"[^>]*>Alpha</.exec(html);
        expect(chip).not.toBeNull();
        const rule = new RegExp(
            `#bt-f0-${chip![1]}:checked ~ \\.bt-scroll \\.bt-r:not\\.?\\(\\.(bt-v0-\\d+)\\)`
        ).exec(html);
        expect(rule).not.toBeNull();
        const alphaRow = /<details class="([^"]*)" id="alpha"/.exec(html);
        expect(alphaRow?.[1]).toContain(rule![1]);
    });
});
