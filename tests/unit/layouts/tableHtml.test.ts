import { describe, expect, it } from "vitest";
import type { TableSpec } from "@beaver/agent-core/layouts/table";
import {
    buildTableDocument,
    renderTableHtml,
    TABLE_CSS,
} from "../../../src/services/reports/tableHtml";
import { CSS_RULE_BUDGET } from "../../../src/services/reports/reportHtml";

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
    it("produces a self-contained document with no script and no external references", () => {
        const { html } = buildTableDocument(spec);
        expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/https?:\/\/(?!doi\.org)/);
        // rem is meaningless without a pinned root.
        expect(html).toContain("html { font-size: 14px; }");
    });

    it("stays under the reader's CSS rule budget", () => {
        const { cssRuleCount } = buildTableDocument(spec);
        expect(cssRuleCount).toBeLessThan(CSS_RULE_BUDGET);
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
