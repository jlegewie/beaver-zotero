import { describe, expect, it } from "vitest";

import type { StructuredExtractResult } from "@beaver/agent-core/extract/schema";
import type { BoundingBox, RawLineDetailed, RawPageDataDetailed } from "@beaver/agent-core/extract/types";

import { extractPdf, regionsExport } from "../../../src/beaver-extract/node/api";
import type { RegionPassPage } from "../../../src/beaver-extract/pipeline/structured";
import { ROUTE_DROPPED, ROUTE_PROSE, regionsExportPage, type RegionsExportPage } from "../../../src/beaver-extract/pipeline/regionsExport";
import { REGION_FEATURES } from "../../../src/beaver-extract/regions/features";
import { mergeRowFragments, pageLines } from "../../../src/beaver-extract/regions/pageSignals";
import { LINE_CAPTION, LINE_FURNITURE, LINE_SKEWED, type RegionDetection } from "../../../src/beaver-extract/regions/RegionDetector";
import { regionItemsForPage } from "../../../src/beaver-extract/regions/regionItems";
import type { GraphicsSummary } from "../../../src/beaver-extract/worker/graphicsSummary";
import { syntheticFigurePdf, syntheticSpanningTablePdf } from "../../helpers/syntheticRegionPdf";

const REGION_KINDS = new Set(["picture", "table", "formula"]);

/** The export's page and the structured export's region items, at the same box precision. */
async function exportAndStructured(pdf: () => Uint8Array): Promise<{ page: RegionsExportPage; regions: { kind: string; bbox: number[] }[] }> {
    const row = await regionsExport({ pdfData: pdf(), bboxPrecision: 2 });
    const structured = (await extractPdf({
        pdfData: pdf(),
        mode: "structured",
        schemaVersion: "5",
        structured: { bboxPrecision: 2 },
    })) as StructuredExtractResult;
    const regions = structured.document.pages[0].items
        .filter((item) => REGION_KINDS.has(item.kind))
        .map((item) => ({ kind: item.kind, bbox: item.bbox }));
    return { page: row.pages[0], regions };
}

const sorted = (regions: { kind: string; bbox: number[] }[]) =>
    regions.map(({ kind, bbox }) => ({ kind, bbox })).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
const piece = (page: RegionsExportPage, text: string) => page.pieces.find((p) => p.text === text)!;

describe("regions-v2 export", () => {
    it("records every piece, primitive and candidate, and the regions the structured export emits", async () => {
        const { page, regions } = await exportAndStructured(syntheticFigurePdf);
        expect(sorted(page.v5.regions)).toEqual(sorted(regions));
        expect(page.pieces.map((p) => p.id)).toEqual(page.pieces.map((_, k) => `p${k}`));
        expect(page.graphics).toEqual({ records: expect.any(Number), overflow: false, incomplete: false });
        expect(page.primitives.some(([kind, , , , , , , , , hash]) => kind === "image" && hash !== 0)).toBe(true);
        for (const candidate of page.v5.candidates) expect(candidate.features).toHaveLength(REGION_FEATURES.length);

        // The chart's axis title and its tick labels leave the prose for the picture,
        // although the item drops the ticks; captions stay in the prose.
        const chart = page.v5.regions.findIndex((r) => r.kind === "picture" && r.bbox[1] < 300);
        expect(piece(page, "Time in minutes").v5Route).toBe(chart);
        expect(piece(page, "40").v5Route).toBe(chart);
        const caption = page.pieces.find((p) => p.text.startsWith("Figure 1."))!;
        expect(caption.flags & LINE_CAPTION).toBe(LINE_CAPTION);
        expect(caption.v5Route).toBe(ROUTE_PROSE);
        const prose = page.pieces.find((p) => p.text.startsWith("Region detection"))!;
        expect(prose).toMatchObject({
            v5Route: ROUTE_PROSE,
            font: "Helvetica",
            size: 10,
            chars: prose.text.replace(/\s/g, "").length,
            mono: false,
            rot: 0,
        });
    }, 60_000);

    it("routes a table's cells to the table on a page drawn upside down", async () => {
        const { page, regions } = await exportAndStructured(() => syntheticSpanningTablePdf(true));
        expect(page.textRotation).toBe(180);
        expect(sorted(page.v5.regions)).toEqual(sorted(regions));
        expect(page.v5.regions.map((r) => r.kind)).toEqual(["table"]);
        expect(piece(page, "Covariate 3").v5Route).toBe(0);
        expect(piece(page, "Table 1. A synthetic table spanning both columns.").v5Route).toBe(ROUTE_PROSE);
    }, 60_000);

    it("keeps boxes in the displayed frame of a page with /Rotate", async () => {
        const { page, regions } = await exportAndStructured(() => syntheticFigurePdf(90));
        expect(page).toMatchObject({ rotation: 90, width: 792, height: 612 });
        expect(sorted(page.v5.regions)).toEqual(sorted(regions));
        expect(page.v5.regions.length).toBeGreaterThan(0);
        for (const p of page.pieces) {
            expect(p.bbox[0]).toBeGreaterThanOrEqual(0);
            expect(p.bbox[2]).toBeLessThanOrEqual(page.width);
            expect(p.bbox[3]).toBeLessThanOrEqual(page.height);
        }
        // Text set upright in the content stream reads down the displayed page.
        expect(piece(page, "Time in minutes").rot).toBe(90);
    }, 60_000);

    it("writes only the listed pages", async () => {
        expect((await regionsExport({ pdfData: syntheticFigurePdf(), pages: [] })).pages).toEqual([]);
        expect((await regionsExport({ pdfData: syntheticFigurePdf(), pages: [0] })).pages.map((p) => p.index)).toEqual([0]);
    }, 60_000);
});

const BS = 10;

/** One structured-text line at `y`; cells far apart become separate pieces. */
function line(y: number, cells: [number, number, string][], font = "Times-Roman"): RawLineDetailed {
    const chars: { c: string; bbox: BoundingBox }[] = [];
    let text = "";
    cells.forEach(([x0, x1, t], k) => {
        if (k > 0) {
            const prev = chars[chars.length - 1].bbox;
            chars.push({ c: " ", bbox: { l: prev.r, t: y, r: x0, b: y + 11, origin: "top-left" } });
            text += " ";
        }
        const step = (x1 - x0) / t.length;
        [...t].forEach((c, i) => chars.push({ c, bbox: { l: x0 + i * step, t: y, r: x0 + (i + 1) * step, b: y + 11, origin: "top-left" } }));
        text += t;
    });
    const face = { name: font, family: font, weight: "normal", style: "italic", size: BS };
    return {
        wmode: 0,
        bbox: { l: cells[0][0], t: y, r: cells[cells.length - 1][1], b: y + 11, origin: "top-left" },
        font: face,
        x: cells[0][0],
        y: y + 11,
        text,
        rotation: 0,
        chars: chars.map((ch) => ({ ...ch, quad: [] })),
        spans: [{ start: 0, font: face }],
    } as unknown as RawLineDetailed;
}

/** One-block page of `lines`. */
function syntheticPage(lines: RawLineDetailed[]): RawPageDataDetailed {
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: 612,
        height: 792,
        rotation: 0,
        blocks: [{ type: "text", bbox: lines[0].bbox, lines }],
    } as unknown as RawPageDataDetailed;
}

/** The region pass of `page` with one formula candidate; `flagsOf` gives each routed line's flags. */
function formulaPass(
    page: RawPageDataDetailed,
    flagsOf: (text: string) => number,
    regionPieces?: RegionPassPage["regionPieces"],
): RegionPassPage {
    const routed = mergeRowFragments(pageLines(page), []);
    const flags = routed.map((l) => flagsOf(l.text));
    const detection: RegionDetection = {
        pageIndex: 0,
        scanned: false,
        bodySize: BS,
        candidates: [{ bbox: [70, 95, 440, 115], anchored: false, features: [], label: "formula" }],
        // Furniture is never routed (`routeLines`).
        routing: { lines: routed, flags, routes: flags.map((f) => (f & LINE_FURNITURE ? -1 : 0)) },
        ms: 0,
    };
    const graphics: GraphicsSummary = {
        area: [0, 0, 612, 792],
        seen: { fillPath: 0, strokePath: 0, image: 0, imageMask: 0, shade: 0 },
        count: 0,
        records: new Float32Array(),
        overflow: false,
        incomplete: true,
        grid: null,
        gridSize: 0,
    };
    return {
        pageIndex: 0,
        page,
        graphics,
        textRotation: 0,
        margin: new Set(),
        doc: { imagePageCount: () => 0 },
        detection,
        result: regionItemsForPage(page, detection),
        regionPieces,
        walkMs: 1,
        regionsMs: 2,
    };
}

describe("regionsExportPage", () => {
    it("routes the pieces of a region that column detection split to the item holding each", () => {
        const page = syntheticPage([line(100, [[72, 160, "x = a + b"], [340, 430, "y = c - d"]], "CMMI10")]);
        const out = regionsExportPage(formulaPass(page, () => 0, [[{ members: [0], body: [0] }, { members: [1], body: [1] }]]), 1);
        expect(out.v5.regions).toEqual([
            { kind: "formula", bbox: [72, 100, 160, 111], candidate: 0 },
            { kind: "formula", bbox: [340, 100, 430, 111], candidate: 0 },
        ]);
        expect(out.pieces.map((p) => [p.id, p.text, p.source, p.v5Route])).toEqual([
            ["p0", "x = a + b", 0, 0],
            ["p1", "y = c - d", 0, 1],
        ]);
        expect(out.pieces[0]).toMatchObject({ font: "CMMI10", italic: true, bold: false, chars: 5 });
        expect(out.graphics.incomplete).toBe(true);
    });

    it("marks furniture set aside as margin text as dropped from the prose, not as prose", () => {
        const page = syntheticPage([
            line(100, [[72, 160, "x = a + b"]], "CMMI10"),
            line(400, [[100, 500, "CONFIDENTIAL"]]),
        ]);
        const pass = formulaPass(page, (text) => (text === "CONFIDENTIAL" ? LINE_SKEWED | LINE_FURNITURE : 0));
        expect(pass.result.margin.map((l) => l.text)).toEqual(["CONFIDENTIAL"]);
        const out = regionsExportPage(pass, 1);
        expect(out.pieces.map((p) => [p.text, p.v5Route])).toEqual([
            ["x = a + b", 0],
            ["CONFIDENTIAL", ROUTE_DROPPED],
        ]);
    });
});
