import { describe, expect, it } from "vitest";

import { findCandidates } from "../../../src/beaver-extract/regions/candidates";
import {
    CONFIDENCE_MARGIN,
    LINE_CAPTION,
    LINE_FURNITURE,
    LINE_GUTTER,
    LINE_MARGIN,
    LINE_RUNNING,
    LINE_SKEWED,
    REGION_MIN_PROB,
    detectRegions,
    resolveOverlaps,
    routeLines,
    type DetectedRegion,
} from "../../../src/beaver-extract/regions/RegionDetector";
import { GRID_CLUSTER_MIN, clusterRects, gridCluster } from "../../../src/beaver-extract/regions/cluster";
import { EMPTY_DOC_CONTEXT, REGION_FEATURES, REGION_FEATURE_VERSION, candidateFeatures } from "../../../src/beaver-extract/regions/features";
import type { Rect } from "../../../src/beaver-extract/regions/geometry";
import { assertCompatible, predictRegionClass, type RegionModelWeights } from "../../../src/beaver-extract/regions/model";
import {
    NOTE_CAPTION_RE,
    isFigureCaption,
    isTableCaption,
    lineNumberGutter,
    pageLines,
    pagePrimitives,
    type RegionLine,
} from "../../../src/beaver-extract/regions/pageSignals";
import type { RawPageData } from "@beaver/agent-core/extract/types";
import {
    GRAPHICS_SUMMARY_STRIDE,
    GS_FLAG,
    GS_KIND,
    type GraphicsSummary,
} from "../../../src/beaver-extract/worker/graphicsSummary";

const W = 612;
const H = 792;
const BS = 10;

interface Rec {
    kind: number;
    bbox: Rect;
    flags?: number;
    rgb?: number;
    alpha?: number;
    segments?: number;
    hash?: number;
}

function summary(recs: Rec[], grid?: { size: number; cells: number[] }): GraphicsSummary {
    const records = new Float32Array(recs.length * GRAPHICS_SUMMARY_STRIDE);
    recs.forEach((r, i) => {
        records.set(
            [r.kind, ...r.bbox, r.flags ?? 0, r.rgb ?? 0, r.alpha ?? 255, r.segments ?? 4, 1, 0, r.hash ?? 0],
            i * GRAPHICS_SUMMARY_STRIDE,
        );
    });
    let gridArray: Float32Array | null = null;
    if (grid) {
        gridArray = new Float32Array(grid.size * grid.size);
        for (const c of grid.cells) gridArray[c] = 1;
    }
    return {
        area: [0, 0, W, H],
        seen: { fillPath: 0, strokePath: 0, image: 0, imageMask: 0, shade: 0 },
        count: recs.length,
        records,
        overflow: grid !== undefined,
        incomplete: false,
        grid: gridArray,
        gridSize: grid?.size ?? 0,
    };
}

/** A text line as `pageLines` derives it from a structured-text line in `font`. */
function line(bbox: Rect, text: string, size = BS, font = "Times-Roman", rotation = 0): RegionLine {
    const page: RawPageData = {
        pageIndex: 0,
        pageNumber: 1,
        width: W,
        height: H,
        blocks: [
            {
                type: "text",
                bbox: { l: bbox[0], t: bbox[1], r: bbox[2], b: bbox[3] },
                lines: [
                    {
                        wmode: 0,
                        bbox: { l: bbox[0], t: bbox[1], r: bbox[2], b: bbox[3] },
                        font: { name: font, family: font, weight: "normal", style: "normal", size },
                        x: bbox[0],
                        y: bbox[3],
                        text,
                        rotation,
                    },
                ],
            },
        ],
    } as unknown as RawPageData;
    return pageLines(page)[0];
}

const PROSE_TEXT = "the quick brown fox jumps over the lazy dog again and again";
const prose = (y: number, x0 = 72, x1 = 540) => line([x0, y, x1, y + 11], PROSE_TEXT);

/** A plot: a stroked frame plus curve strokes inside `box`. */
function plot(box: Rect): Rec[] {
    const [x0, y0, x1, y1] = box;
    return [
        { kind: GS_KIND.strokePath, bbox: box, flags: GS_FLAG.isRect },
        { kind: GS_KIND.strokePath, bbox: [x0 + 5, y0 + 10, x1 - 5, y1 - 10], flags: GS_FLAG.hasCurve, rgb: 0xff0000 },
        { kind: GS_KIND.strokePath, bbox: [x0 + 5, y0 + 20, x1 - 5, y1 - 20], flags: GS_FLAG.hasCurve, rgb: 0x0000ff },
    ];
}

describe("clusterRects", () => {
    it("groups rects within the gap and separates distant ones", () => {
        const rects: Rect[] = [
            [0, 0, 10, 10],
            [13, 0, 20, 10], // 3pt away: joins with a 4pt gap
            [100, 100, 110, 110],
        ];
        const groups = clusterRects(rects, 4).map((g) => [...g].sort());
        expect(groups).toHaveLength(2);
        expect(groups).toContainEqual([0, 1]);
        expect(groups).toContainEqual([2]);
    });

    it("chains through a rect that spans many buckets", () => {
        const rects: Rect[] = [
            [0, 0, 5, 5],
            [0, 6, 400, 8], // long rule, compared against every rect
            [395, 9, 400, 14],
        ];
        expect(clusterRects(rects, 2)).toHaveLength(1);
    });

    it("switches to the occupancy grid for dense pages with the same grouping", () => {
        const rects: Rect[] = [];
        for (let i = 0; i < GRID_CLUSTER_MIN + 10; i++) {
            const x = 50 + (i % 100) * 2;
            const y = 50 + Math.floor(i / 100) * 2;
            rects.push([x, y, x + 1, y + 1]);
        }
        rects.push([500, 700, 510, 710]);
        const groups = clusterRects(rects, 4);
        expect(groups).toHaveLength(2);
        expect(groups.map((g) => g.length).sort((a, b) => a - b)).toEqual([1, GRID_CLUSTER_MIN + 10]);
        expect(gridCluster(rects.slice(0, 100), 4)).toHaveLength(1);
    });
});

describe("pagePrimitives", () => {
    it("types primitives and drops tiny images and near-invisible marks", () => {
        const prims = pagePrimitives(
            summary([
                { kind: GS_KIND.image, bbox: [100, 100, 300, 250], hash: 7 },
                { kind: GS_KIND.image, bbox: [10, 10, 14, 14] }, // tiny
                { kind: GS_KIND.strokePath, bbox: [100, 100, 400, 500], alpha: 20 }, // watermark-faint
                { kind: GS_KIND.fillPath, bbox: [0, 0, W, H], rgb: 0xeeeeee }, // page background
                { kind: GS_KIND.fillPath, bbox: [100, 300, 400, 400], flags: GS_FLAG.isRect, rgb: 0xffffff },
                { kind: GS_KIND.fillPath, bbox: [100, 420, 101.5, 421.5], flags: GS_FLAG.isRect },
                { kind: GS_KIND.fillPath, bbox: [72, 450, 540, 451] },
                { kind: GS_KIND.fillPath, bbox: [72, 460, 80, 470], segments: 12 },
                { kind: GS_KIND.fillPath, bbox: [72, 480, 400, 520], flags: GS_FLAG.isRect, rgb: 0x3366aa },
            ]),
            W,
            H,
            BS,
        );
        expect(prims.map((p) => p.kind)).toEqual(["image", "bg", "white", "pixel", "hrule", "glyph", "box"]);
        expect(prims[0].imageHash).toBe(7);
    });

    it("reads long, thin images as rules", () => {
        const prims = pagePrimitives(
            summary([
                { kind: GS_KIND.image, bbox: [202, 50, 214, 714] }, // column separator bitmap
                { kind: GS_KIND.image, bbox: [72, 100, 300, 250] },
            ]),
            W,
            H,
            BS,
        );
        expect(prims.map((p) => p.kind)).toEqual(["vrule", "image"]);
    });

    it("reads hairline images as rules: a pixel stretched along a table's rules and cell borders", () => {
        const prims = pagePrimitives(
            summary([
                { kind: GS_KIND.imageMask, bbox: [72, 109.2, 584.3, 109.7] }, // a rule across the table
                { kind: GS_KIND.imageMask, bbox: [174.3, 109.6, 174.8, 175.5] }, // one cell's border
                { kind: GS_KIND.imageMask, bbox: [72, 300, 80, 300.5] }, // a dash, too short for a rule
                { kind: GS_KIND.imageMask, bbox: [72, 320, 584, 320.5], rgb: 0xffffff }, // painted white: nothing
            ]),
            W,
            H,
            BS,
        );
        expect(prims.map((p) => p.kind)).toEqual(["hrule", "vrule"]);
        // A raster stored as touching strips, one per row of pixels, is one image, no set of rules.
        const strips = pagePrimitives(
            summary(Array.from({ length: 20 }, (_, k): Rec => ({ kind: GS_KIND.image, bbox: [48, 337 + 0.35 * k, 273, 337.35 + 0.35 * k] }))),
            W,
            H,
            BS,
        );
        expect(strips.map((p) => p.kind)).toEqual(["image"]);
        expect(strips[0].bbox.map((v) => Math.round(v))).toEqual([48, 337, 273, 344]);
    });

    it("turns runs of overflow-grid cells into coarse marks", () => {
        const size = 32;
        const prims = pagePrimitives(summary([], { size, cells: [3 * size + 4, 3 * size + 5, 3 * size + 9] }), W, H, BS);
        expect(prims).toHaveLength(2);
        const cw = W / size;
        expect(prims[0].kind).toBe("mark");
        expect(prims[0].bbox[0]).toBeCloseTo(4 * cw);
        expect(prims[0].bbox[2]).toBeCloseTo(6 * cw);
        expect(prims[1].bbox[0]).toBeCloseTo(9 * cw);
    });
});

describe("findCandidates", () => {
    it("keeps figures stacked around a caption apart", () => {
        const g = summary([...plot([72, 72, 300, 200]), ...plot([72, 222, 300, 360])]);
        const lines = [
            line([72, 206, 104, 216], "Fig. 2.", 8),
            line([108, 206, 300, 216], "A small-font caption that could pass for a label", 8),
            line([72, 366, 104, 376], "Fig. 3.", 8),
            prose(400),
        ];
        const found = findCandidates(lines, pagePrimitives(g, W, H, BS), W, H, BS);
        const boxes = found.candidates.filter((c) => c.source === "graphics").map((c) => c.bbox);
        expect(boxes).toHaveLength(2);
        expect(boxes[0][3]).toBeLessThan(206);
        expect(boxes[1][1]).toBeGreaterThan(216);
    });

    it("links a caption whose label is its own line beside the figure", () => {
        const g = summary(plot([150, 90, 460, 360]));
        const lines = [
            line([72, 408, 96, 420], "Fig. 4."),
            line([105, 408, 455, 420], "Comparison of all proposed schemes for seven cells"),
            prose(440),
        ];
        const found = findCandidates(lines, pagePrimitives(g, W, H, BS), W, H, BS);
        expect(found.figureCaptions[0].bbox).toEqual([72, 408, 455, 420]);
        const cand = found.candidates.find((c) => !c.anchored)!;
        const features = candidateFeatures(cand, found, EMPTY_DOC_CONTEXT);
        expect(features).toHaveLength(REGION_FEATURES.length);
        expect(features[REGION_FEATURES.indexOf("fig_caption")]).toBe(1);
        expect(features[REGION_FEATURES.indexOf("plot_frames")]).toBe(1);
    });

    it("treats full-width image strips carrying the text as a scan", () => {
        const strips: Rec[] = [];
        for (let y = 0; y < H; y += 99) strips.push({ kind: GS_KIND.image, bbox: [0, y, W, Math.min(H, y + 99)] });
        const lines = [prose(100), prose(200), prose(300)];
        const found = findCandidates(lines, pagePrimitives(summary(strips), W, H, BS), W, H, BS);
        expect(found.scanned).toBe(true);
        expect(found.candidates.filter((c) => c.source === "graphics")).toHaveLength(0);
    });

    it("does not let a text box chain its contents into one cluster", () => {
        // A shaded sidebar holding prose and a small plot: the box is page furniture,
        // so the plot stays a candidate of its own.
        const g = summary([
            { kind: GS_KIND.fillPath, bbox: [300, 60, 560, 500], flags: GS_FLAG.isRect, rgb: 0xdde4ee },
            ...plot([320, 300, 540, 450]),
        ]);
        const sidebar = (y: number) => line([310, y, 550, y + 11], PROSE_TEXT);
        const lines = [sidebar(80), sidebar(92), sidebar(104), prose(600)];
        const found = findCandidates(lines, pagePrimitives(g, W, H, BS), W, H, BS);
        const boxes = found.candidates.filter((c) => c.source === "graphics").map((c) => c.bbox);
        expect(boxes).toEqual([[320, 300, 540, 450]]);
    });

    it("does not grow a figure over a page-long margin stamp", () => {
        const g = summary(plot([300, 60, 560, 200]));
        const stamp = line([565, 20, 573, 780], "Downloaded from https://example.org on 1 January 2026", 5, "Arial", 90);
        const found = findCandidates([stamp, prose(300), prose(312)], pagePrimitives(g, W, H, BS), W, H, BS);
        const boxes = found.candidates.filter((c) => c.source === "graphics").map((c) => c.bbox);
        expect(boxes).toEqual([[300, 60, 560, 200]]);
    });

    it("takes the content inside a frame that also encloses the figure's caption and notes", () => {
        const frame: Rec[] = [
            { kind: GS_KIND.strokePath, bbox: [300, 52, 540, 52] },
            { kind: GS_KIND.strokePath, bbox: [300, 260, 540, 260] },
            { kind: GS_KIND.strokePath, bbox: [300, 52, 300, 260] },
            { kind: GS_KIND.strokePath, bbox: [540, 52, 540, 260] },
        ];
        const drawing: Rec[] = [
            { kind: GS_KIND.strokePath, bbox: [304, 76, 536, 230], flags: GS_FLAG.hasCurve, rgb: 0xff0000 },
            { kind: GS_KIND.fillPath, bbox: [400, 120, 420, 140], flags: GS_FLAG.hasCurve },
        ];
        const caption = line([306, 60, 520, 70], "Figure 1. Directed acyclic graph of the effect");
        const notes = line([306, 236, 520, 246], "Notes: Observed covariates are left implicit here.", 8);
        const boxes = (recs: Rec[], lines: RegionLine[]) =>
            findCandidates([...lines, prose(300), prose(312)], pagePrimitives(summary(recs), W, H, BS), W, H, BS)
                .candidates.filter((c) => c.source === "graphics")
                .map((c) => c.bbox);
        expect(boxes([...frame, ...drawing], [caption, notes])).toEqual([[304, 76, 536, 230]]);
        // A legend set inside the frame, apart from the drawing, stays in the figure.
        const legend = line([420, 232, 500, 240], "Treatment group", 7);
        const notesBelow = line([306, 246, 520, 255], "Notes: Observed covariates are left implicit here.", 8);
        expect(boxes([...frame, ...drawing.map((r) => ({ ...r, bbox: [r.bbox[0], r.bbox[1], r.bbox[2], Math.min(r.bbox[3], 210)] as Rect }))], [caption, legend, notesBelow])).toEqual([
            [304, 76, 536, 240],
        ]);
        // An axis title of many words, centred under the drawing, stays in the figure too.
        const title = line([360, 232, 480, 242], "Number of students enrolled in the program");
        expect(boxes([...frame, ...drawing.map((r) => ({ ...r, bbox: [r.bbox[0], r.bbox[1], r.bbox[2], Math.min(r.bbox[3], 210)] as Rect }))], [caption, title, notesBelow])).toEqual([
            [304, 76, 536, 242],
        ]);
        // Also in a full-width frame, where the title is wider than half the page.
        const wideFrame: Rec[] = [
            { kind: GS_KIND.strokePath, bbox: [50, 52, 562, 52] },
            { kind: GS_KIND.strokePath, bbox: [50, 280, 562, 280] },
            { kind: GS_KIND.strokePath, bbox: [50, 52, 50, 280] },
            { kind: GS_KIND.strokePath, bbox: [562, 52, 562, 280] },
        ];
        const wideDrawing: Rec[] = [
            { kind: GS_KIND.strokePath, bbox: [54, 76, 558, 210], flags: GS_FLAG.hasCurve, rgb: 0xff0000 },
            { kind: GS_KIND.fillPath, bbox: [300, 120, 320, 140], flags: GS_FLAG.hasCurve },
        ];
        const wideTitle = line([135, 232, 477, 242], "Number of students enrolled in the program by local treatment group and year");
        const wideCaption = line([60, 60, 520, 70], "Figure 1. Directed acyclic graph of the effect");
        const wideNotes = line([60, 262, 520, 271], "Notes: Observed covariates are left implicit here.", 8);
        expect(boxes([...wideFrame, ...wideDrawing], [wideCaption, wideTitle, wideNotes])).toEqual([[54, 76, 558, 242]]);
        // So does one wrapped over two lines.
        const wrapped = [
            line([350, 232, 490, 242], "Number of students enrolled in the"),
            line([345, 244, 495, 254], "program for each local treatment group"),
        ];
        const notesLow = line([306, 262, 520, 271], "Notes: Observed covariates are left implicit here.", 8);
        const tallFrame: Rec[] = frame.map((r) => ({
            ...r,
            bbox: [r.bbox[0], r.bbox[1] === 260 ? 280 : r.bbox[1], r.bbox[2], r.bbox[3] === 260 ? 280 : r.bbox[3]] as Rect,
        }));
        expect(boxes([...tallFrame, ...drawing.map((r) => ({ ...r, bbox: [r.bbox[0], r.bbox[1], r.bbox[2], Math.min(r.bbox[3], 210)] as Rect }))], [caption, ...wrapped, notesLow])).toEqual([
            [304, 76, 536, 254],
        ]);
        // A rotated axis title along the drawing's side, inside the frame, stays in the figure.
        const narrow: Rec[] = [{ ...drawing[0], bbox: [330, 76, 536, 230] }, drawing[1]];
        const axis = line([306, 120, 315, 200], "Share of respondents", 8, "Helvetica", 90);
        expect(boxes([...frame, ...narrow], [caption, axis, notes])[0][0]).toBeLessThanOrEqual(306);
        // An axis title just outside the frame, against its border, stays with the figure.
        const outside = line([284, 120, 293, 200], "Share of respondents", 8, "Helvetica", 90);
        expect(boxes([...frame, ...narrow], [caption, outside, notes])[0][0]).toBe(284);
        // Unrotated text beside it, as far away, heading running text there is no label of the drawing.
        const heading = line([302, 130, 316, 140], "References");
        const entries = [line([302, 146, 326, 156], PROSE_TEXT), line([302, 158, 326, 168], PROSE_TEXT), line([302, 170, 326, 180], PROSE_TEXT)];
        expect(boxes([...frame, ...narrow], [caption, heading, ...entries, notes])[0][0]).toBe(330);
        // A legend beside the drawing, in a strip of the frame without running text, stays too.
        const left: Rec[] = [{ ...drawing[0], bbox: [304, 76, 450, 230] }, { ...drawing[1], bbox: [400, 120, 420, 140] }];
        const legend2 = line([480, 140, 530, 150], "Treatment group");
        expect(boxes([...frame, ...left], [caption, legend2, notes])[0][2]).toBe(530);
        // A heading over running text in that strip heads a text column the frame holds.
        const column = [line([480, 156, 536, 166], PROSE_TEXT), line([480, 168, 536, 178], PROSE_TEXT), line([480, 180, 536, 190], PROSE_TEXT)];
        expect(boxes([...frame, ...left], [caption, line([480, 140, 530, 150], "References"), ...column, notes])[0][2]).toBe(450);
        // A label without width (a zero-size text box) joins once; extraction completes.
        const flat = line([420, 232, 420, 240], "x", 7);
        expect(boxes([...frame, ...drawing], [caption, flat, notes])[0][3]).toBeGreaterThanOrEqual(230);
        // Panels inside the frame, one inset apart from it, stay one figure.
        const panels: Rec[] = [
            { kind: GS_KIND.strokePath, bbox: [304, 76, 400, 230], flags: GS_FLAG.hasCurve, rgb: 0xff0000 },
            { kind: GS_KIND.strokePath, bbox: [460, 100, 520, 200], flags: GS_FLAG.hasCurve, rgb: 0x0000ff },
        ];
        expect(boxes([...frame, ...panels], [caption, notes])).toEqual([[304, 76, 520, 230]]);
        // A table framed with its caption keeps its rows beyond its inner rules, of any text.
        const tableCaption = line([306, 60, 520, 70], "Table 1. Estimated effects of the treatment");
        const rules: Rec[] = [
            ...frame,
            { kind: GS_KIND.strokePath, bbox: [306, 110, 534, 110] },
            { kind: GS_KIND.strokePath, bbox: [306, 230, 534, 230] },
            { kind: GS_KIND.strokePath, bbox: [306, 170, 534, 170] },
        ];
        const tableRows = [
            line([306, 85, 534, 95], "Outcome variable measured over the full follow-up period"),
            line([306, 120, 534, 130], "β1 = 0.25 (0.10)", BS, "CMMI10"),
            line([306, 245, 534, 255], "Observations and fixed effects for every model"),
        ];
        expect(boxes(rules, [tableCaption, ...tableRows, notes.bbox[1] > 255 ? notes : line([306, 262, 520, 271], "Notes: Standard errors in parentheses.", 8)])).toEqual([
            [306, 85, 534, 255],
        ]);
        // Including a wrapped prose cell below the last inner rule, however many lines it runs.
        const tallFrame2: Rec[] = frame.map((r) => ({
            ...r,
            bbox: [r.bbox[0], r.bbox[1] === 260 ? 290 : r.bbox[1], r.bbox[2], r.bbox[3] === 260 ? 290 : r.bbox[3]] as Rect,
        }));
        const upperRules: Rec[] = [
            { kind: GS_KIND.strokePath, bbox: [306, 110, 534, 110] },
            { kind: GS_KIND.strokePath, bbox: [306, 200, 534, 200] },
        ];
        const cell = [210, 222, 234, 246].map((y) => line([306, y, 534, y + 11], PROSE_TEXT));
        expect(boxes([...tallFrame2, ...upperRules], [tableCaption, line([306, 120, 534, 130], "Outcome 0.25 (0.10)"), ...cell])[0][3]).toBe(257);
        // A frame with no caption inside it is part of the figure.
        expect(boxes([...frame, ...drawing], [])).toEqual([[300, 52, 540, 260]]);
        // Rules along three edges are no frame.
        expect(boxes([frame[0], frame[1], frame[2], ...drawing], [caption, notes])).toEqual([[300, 52, 540, 260]]);
        // Nor is caption text set beside the drawing a frame's caption.
        const beside = line([306, 140, 380, 150], "Figure 1. Directed acyclic graph");
        expect(boxes([...frame, ...drawing], [beside])).toEqual([[300, 52, 540, 260]]);
    });

    it("keeps a full-width photo on a born-digital page", () => {
        const g = summary([{ kind: GS_KIND.image, bbox: [0, 72, W, 400] }]);
        const found = findCandidates([prose(420), prose(435), prose(450)], pagePrimitives(g, W, H, BS), W, H, BS);
        expect(found.scanned).toBe(false);
        expect(found.candidates).toHaveLength(1);
    });
});

describe("captions", () => {
    it("recognizes figure, table and note captions but not prose that starts with the word", () => {
        const figures = ["Fig. 5 Numerical", "Figure S2. x", "Supplementary Figure 2", "Extended Data Fig. 3 x", "Box 2 Perspectives", "Video 6. aPS1", "图 1", "Graphique 1. Résultats", "Figura 2: x"];
        const tables = ["Table 1", "TABLE I.", "Table  A.3 Age", "TABLE 1 (Continued)", "Appendix Table A1", "Tableau 1. Résultats"];
        const prose = ["Tablet computers are", "Figures show that", "Box plots of", "Table of contents", "Tables 1 and 2 show"];
        for (const t of figures) expect(isFigureCaption(t), t).toBe(true);
        for (const t of tables) expect(isTableCaption(t), t).toBe(true);
        for (const t of prose) expect(isFigureCaption(t) || isTableCaption(t), t).toBe(false);
        for (const t of ["Note. x", "Source: OECD", "* p < .05", "Credit: X"]) expect(NOTE_CAPTION_RE.test(t), t).toBe(true);
        expect(NOTE_CAPTION_RE.test("Sources of bias are")).toBe(false);
    });
});

describe("routeLines", () => {
    it("routes lines to the smallest region holding them, never running text or captions", () => {
        const region = (bbox: Rect, label: DetectedRegion["label"]): DetectedRegion => ({ bbox, anchored: false, features: [], label });
        const regions = [
            region([50, 50, 400, 400], "picture"),
            region([100, 100, 200, 200], "table"), // a table drawn inside the figure area
            region([450, 50, 550, 100], "other"),
        ];
        const lines = [
            line([110, 110, 150, 120], "cell"), // inside both: the smaller region wins
            line([60, 300, 120, 310], "axis label"),
            line([60, 320, 390, 330], PROSE_TEXT), // running text inside the figure box
            line([60, 340, 200, 350], "Figure 1. A caption"),
            line([460, 60, 500, 70], "unclassified"),
            line([60, 500, 300, 510], "prose outside"),
        ];
        const flags = [0, 0, LINE_RUNNING, LINE_CAPTION, 0, 0];
        expect(routeLines(lines, flags, regions)).toEqual([1, 0, -1, -1, -1, -1]);
    });

    it("gives decorations no text and never routes page furniture", () => {
        const region = (bbox: Rect, label: DetectedRegion["label"]): DetectedRegion => ({ bbox, anchored: false, features: [], label });
        const regions = [region([50, 50, 550, 700], "picture"), region([60, 60, 300, 120], "decoration")];
        const lines = [
            line([70, 70, 290, 110], "The Health System Dynamics Framework"), // a title on a banner
            line([100, 300, 140, 340], "Q4 2019"), // a small label set at an angle
            line([100, 100, 500, 650], "UNCORRECTED PROOF"), // a watermark across the page
        ];
        const flags = [0, LINE_SKEWED, LINE_SKEWED | LINE_FURNITURE];
        // The title falls to the figure holding the banner; the label to its figure.
        expect(routeLines(lines, flags, regions)).toEqual([0, 0, -1]);
        expect(routeLines(lines, flags, [regions[1]])).toEqual([-1, -1, -1]);
    });
});

describe("routeLines margin text and equation numbers", () => {
    const region = (bbox: Rect, label: DetectedRegion["label"]): DetectedRegion => ({ bbox, anchored: false, features: [], label });

    it("keeps the document's margin text out of regions, except a continued table's header row", () => {
        // A running header the figure box reaches over.
        const figure = [line([72, 30, 300, 40], "Journal of Neuroscience 41"), line([100, 120, 140, 130], "Time (s)")];
        expect(routeLines(figure, [LINE_MARGIN, 0], [region([60, 25, 540, 400], "picture")])).toEqual([-1, 0]);
        // A continued table repeats its header at the top of each page; its rows follow it directly.
        const continued = [
            line([72, 60, 160, 70], "Authenticity issue"),
            line([300, 60, 360, 70], "Markers"),
            line([72, 80, 160, 90], "Geographical origin"),
            line([300, 80, 400, 90], "Chlorogenic acid"),
        ];
        const table = [region([60, 55, 540, 300], "table")];
        expect(routeLines(continued, [LINE_MARGIN, LINE_MARGIN, 0, 0], table)).toEqual([0, 0, 0, 0]);
        // A header with a two-line cell: its second line reaches past the margin band, and
        // the first row follows three line heights below the margin text.
        const twoLine = [
            line([61, 71, 106, 79], "Author (year)"),
            line([459, 71, 489, 79], "Research"),
            line([459, 81, 484, 89], "method"),
            line([61, 102, 331, 110], "Motoyama and From resource munificence"),
            line([459, 102, 496, 110], "Single case"),
        ];
        expect(routeLines(twoLine, [LINE_MARGIN, LINE_MARGIN, 0, 0, 0], [region([40, 66, 520, 400], "table")])).toEqual([0, 0, 0, 0, 0]);
        // Both header lines in the margin band: the rows follow the second.
        expect(routeLines(twoLine, [LINE_MARGIN, LINE_MARGIN, LINE_MARGIN, 0, 0], [region([40, 66, 520, 400], "table")])).toEqual([0, 0, 0, 0, 0]);
        // A running header has a caption, not a row, between it and the table.
        const headed = [line([72, 30, 300, 40], "J Pathol Inform 2019"), line([72, 50, 400, 60], "Table 1: Patient characteristics"), ...continued.slice(2)];
        expect(routeLines(headed, [LINE_MARGIN, LINE_CAPTION, 0, 0], [region([60, 25, 540, 300], "table")])).toEqual([-1, -1, 0, 0]);
        // A header cell of words reads as running text too; the rows that follow it make it the
        // table's.
        const wordy = [
            line([72, 60, 280, 70], "Authenticity issue raised in the reviewed studies"),
            line([300, 60, 360, 70], "Markers"),
            line([72, 80, 160, 90], "Geographical origin"),
            line([300, 80, 400, 90], "Chlorogenic acid"),
            line([72, 100, 160, 110], "Species substitution"),
            line([300, 100, 400, 110], "DNA barcodes"),
            line([72, 120, 160, 130], "Adulteration"),
            line([300, 120, 400, 130], "Fatty acids"),
        ];
        const wordyFlags = [LINE_MARGIN | LINE_RUNNING, LINE_MARGIN, 0, 0, 0, 0, 0, 0];
        expect(routeLines(wordy, wordyFlags, [region([60, 55, 540, 300], "table")])).toEqual(Array(8).fill(0));
        // A running header over the page stays margin text.
        const head = [line([72, 30, 400, 40], "Journal of Food Composition and Analysis 41 (2024)"), ...wordy.slice(2)];
        expect(routeLines(head, [LINE_MARGIN | LINE_RUNNING, 0, 0, 0, 0, 0, 0], [region([60, 25, 540, 300], "table")])[0]).toBe(-1);
        // So does one set in the table's columns, a gap above its rows.
        const split = [line([72, 45, 160, 55], "Dong and Maynard"), line([300, 45, 360, 55], "Page 7"), ...wordy.slice(2)];
        expect(routeLines(split, [LINE_MARGIN, LINE_MARGIN, 0, 0, 0, 0, 0, 0], [region([60, 75, 540, 300], "table")]).slice(0, 2)).toEqual([-1, -1]);
    });

    it("carries every line of a merged table fragment into the table, skewed ones too", () => {
        const rows = (y: number): RegionLine[] =>
            [0, 12, 24].flatMap((d) => [
                line([72, y + d, 140, y + d + 10], `C57BL/${y + d} mice`),
                line([250, y + d, 360, y + d + 10], "Shanghai Model Organisms"),
                line([400, y + d, 440, y + d + 10], `SM-${y + d}`),
            ]);
        const ruled: Rect[] = [100, 112, 124, 136, 148, 160, 172, 184].map((y): Rect => [70, y - 2.5, 540, y - 2]);
        // A stamp set at an angle inside the lower fragment's box.
        const stamp = { ...line([460, 140, 500, 160], "DRAFT"), skewed: true };
        const lines = [...rows(100), ...rows(136), stamp, prose(300), prose(314), prose(328)];
        const flags = lines.map((l) => (l === stamp ? LINE_SKEWED : l.text === PROSE_TEXT ? LINE_RUNNING : 0));
        const regions = [region([70, 98, 540, 134], "table"), region([70, 134, 540, 170], "table")];
        const routes = routeLines(lines, flags, regions, ruled);
        expect(regions[1]).toMatchObject({ label: "other", containedIn: 0 });
        expect(routes.slice(0, 19)).toEqual(Array(19).fill(0));
        // The table's box takes in the fragment's.
        expect(regions[0].bbox).toEqual([70, 98, 540, 170]);
    });

    it("keeps table fragments with another region between them apart", () => {
        const rows = (y: number): RegionLine[] =>
            [0, 12, 24].flatMap((d) => [
                line([72, y + d, 140, y + d + 10], `C57BL/${y + d} mice`),
                line([250, y + d, 360, y + d + 10], "Shanghai Model Organisms"),
                line([400, y + d, 440, y + d + 10], `SM-${y + d}`),
            ]);
        const ruled: Rect[] = [100, 112, 124, 152, 164, 176, 188].map((y): Rect => [70, y - 2.5, 540, y - 2]);
        const formula = line([250, 138, 360, 148], "x = a + b");
        const lines = [...rows(100), formula, ...rows(152), prose(300), prose(314), prose(328)];
        const flags = lines.map((l) => (l.text === PROSE_TEXT ? LINE_RUNNING : 0));
        const regions = [region([70, 98, 540, 134], "table"), region([70, 150, 540, 186], "table"), region([240, 136, 370, 150], "formula")];
        const routes = routeLines(lines, flags, regions, ruled);
        expect(regions[1].label).toBe("table");
        expect(routes.slice(0, 19)).toEqual([...Array(9).fill(0), 2, ...Array(9).fill(1)]);
    });

    it("leaves a list marker opening a line of the neighbouring column to its list", () => {
        const equation = line([72, 100, 200, 112], "E = mc² + ∑ᵢ pᵢ²/2m");
        const marker = line([300, 101, 314, 111], "(1)"); // a list's number in the right column
        const item = line([320, 101, 540, 111], "the first item of the list continues here");
        expect(routeLines([equation, marker, item], [0, 0, LINE_RUNNING], [region([70, 98, 202, 114], "formula")])).toEqual([0, -1, -1]);
        // The equation's own number at its column's edge, nearer the next column than the
        // equation: the column's lines run out to it.
        const lines = [
            line([72, 140, 200, 152], "F = ma"),
            line([270, 141, 284, 151], "(2)"),
            line([300, 141, 540, 151], "the second paragraph of the column starts here"),
            line([72, 170, 284, 180], "where the force acts on the mass of the body"),
        ];
        const flags = [0, 0, LINE_RUNNING, LINE_RUNNING];
        expect(routeLines(lines, flags, [region([70, 138, 202, 154], "formula")])).toEqual([0, 0, -1, -1]);
        // No line of the equation's column: one running across both columns, one ending short
        // of the number, one beside the equation rather than under it, one far below it.
        const others: Rect[] = [
            [72, 170, 540, 180],
            [72, 170, 240, 180],
            [230, 170, 284, 180],
            [72, 400, 284, 410],
        ];
        for (const bbox of others) {
            const variant = [...lines.slice(0, 3), line(bbox, "where the force acts on the mass")];
            expect(routeLines(variant, flags, [region([70, 138, 202, 154], "formula")])).toEqual([0, -1, -1, -1]);
        }
        // A number that ends its row is the equation's.
        expect(routeLines([equation, marker], [0, 0], [region([70, 98, 202, 114], "formula")])).toEqual([0, 0]);
    });

    it("gives an equation number beside or just below its equation to that equation", () => {
        const lines = [
            line([51, 642, 270, 662], "ASM{U(x, y)} = F−1{F{U(x, y)} ⋅ H(fx, fy)}"),
            line([272, 669, 292, 678], "(6)"), // a baseline lower, just right of the box
            line([400, 700, 520, 712], "y = ax + b"),
            line([530, 700, 545, 712], "(7)"), // on the equation's row
            line([51, 740, 270, 752], "z = c"),
            line([110, 752, 260, 762], "where the sum runs over"), // prose between the equation and the number
            line([272, 754, 292, 763], "(8)"),
        ];
        const flags = [0, 0, 0, 0, 0, LINE_RUNNING, 0];
        const regions = [region([51, 642, 270, 662], "formula"), region([400, 700, 520, 712], "formula"), region([51, 740, 270, 752], "formula")];
        expect(routeLines(lines, flags, regions)).toEqual([0, 0, 1, 1, 2, -1, -1]);
    });
});

describe("lineNumberGutter", () => {
    it("finds a manuscript's line numbers in the margin, numbering text and blank lines alike", () => {
        const lines = Array.from({ length: 12 }, (_, k) => [
            line([40, 100 + 20 * k, 52, 110 + 20 * k], String(127 + k)),
            ...(k === 6 ? [] : [prose(100 + 20 * k, 72, 540)]),
        ]).flat();
        const gutter = lineNumberGutter(lines);
        expect([...gutter].map((l) => l.text)).toEqual(Array.from({ length: 12 }, (_, k) => String(127 + k)));
    });

    it("finds line numbers set centred, whose edges shift from one digit to two", () => {
        // A one-digit number spans 11.2–16.8, a two-digit one 8–20: neither edge lines up, the centres do.
        const lines = Array.from({ length: 20 }, (_, k) => [
            line(k < 9 ? [11.2, 54 + 22 * k, 16.8, 69 + 22 * k] : [8, 54 + 22 * k, 20, 69 + 22 * k], String(k + 1)),
            prose(50 + 22 * k, 28, 333),
        ]).flat();
        expect(lineNumberGutter(lines).size).toBe(20);
    });

    it("leaves a table's row numbers in the text body alone", () => {
        // Numbered rows of a table that starts at the body's left edge.
        const rows = Array.from({ length: 12 }, (_, k) => [
            line([72, 100 + 14 * k, 80, 110 + 14 * k], String(k + 1)),
            line([100, 100 + 14 * k, 300, 110 + 14 * k], "Systolic blood pressure reading"),
        ]).flat();
        expect(lineNumberGutter([...rows, prose(300), prose(314)]).size).toBe(0);
        // Numbers in the margin that do not count up line by line are no gutter either.
        const scattered = Array.from({ length: 12 }, (_, k) => line([40, 100 + 20 * k, 52, 110 + 20 * k], String((k * 7) % 13)));
        expect(lineNumberGutter([...scattered, ...Array.from({ length: 12 }, (_, k) => prose(100 + 20 * k))]).size).toBe(0);
    });

    it("leaves the number column of a table that fills the page alone", () => {
        // The descriptions set the text body, so the numbers stand outside it.
        const rows = (value: boolean) =>
            Array.from({ length: 12 }, (_, k) => [
                line([40, 100 + 14 * k, 50, 110 + 14 * k], String(k + 1)),
                line([72, 100 + 14 * k, 300, 110 + 14 * k], "Systolic blood pressure at rest"),
                ...(value ? [line([400, 100 + 14 * k, 430, 110 + 14 * k], `${120 + k}.5`)] : []),
            ]).flat();
        // Its rows hold the table's values.
        expect(lineNumberGutter(rows(true)).size).toBe(0);
        // Its numbers stand under a heading of their own, below the table's caption.
        const caption = line([40, 60, 400, 70], "Table 2. Measurements taken during the visit");
        expect(lineNumberGutter([caption, line([40, 80, 58, 90], "No."), ...rows(false)]).size).toBe(0);
        // A page number over the column is no start of its numbering.
        expect(lineNumberGutter([line([40, 30, 52, 40], "316"), caption, line([40, 80, 58, 90], "No."), ...rows(false)]).size).toBe(0);
        // A short caption, a continued page's running head, or none: the heading counts all the same.
        const short = line([40, 60, 160, 70], "Table 2. Measurements");
        expect(lineNumberGutter([short, line([40, 80, 58, 90], "No."), ...rows(false)]).size).toBe(0);
        const runningHead = line([200, 40, 400, 50], "Journal of Clinical Measurement 12");
        expect(lineNumberGutter([runningHead, line([40, 60, 58, 70], "No."), ...rows(false)]).size).toBe(0);
        expect(lineNumberGutter([line([40, 85, 58, 95], "No."), ...rows(false)]).size).toBe(0);
        // Without either, the column reads as line numbers.
        expect(lineNumberGutter([caption, ...rows(false)]).size).toBe(12);
    });

    it("keeps a manuscript's gutter beside references, page furniture and a second gutter", () => {
        // Numbered references: their marks number items and are no values.
        const references = Array.from({ length: 12 }, (_, k) => [
            line([40, 100 + 20 * k, 52, 110 + 20 * k], String(400 + k)),
            line([72, 100 + 20 * k, 84, 110 + 20 * k], `${k + 1}.`),
            prose(100 + 20 * k, 90, 540),
        ]).flat();
        // A running head in the margin above all of the page's text is furniture.
        const head = line([40, 40, 52, 50], "Pg");
        expect(lineNumberGutter([head, ...references]).size).toBe(12);
        // Under the page's first text, a heading that runs on into the body, or a mark of
        // no words in the margin, is no heading of the column.
        const opening = [prose(54), line([40, 72, 300, 82], "Supplementary methods for the trial"), line([42, 86, 48, 94], "†")];
        expect(lineNumberGutter([...opening, ...references]).size).toBe(12);
        // Numbers in both margins number the same lines.
        const both = Array.from({ length: 12 }, (_, k) => [
            line([40, 100 + 20 * k, 52, 110 + 20 * k], String(1 + k)),
            prose(100 + 20 * k),
            line([560, 100 + 20 * k, 572, 110 + 20 * k], String(1 + k)),
        ]).flat();
        expect(lineNumberGutter(both).size).toBe(24);
    });

    it("never routes the gutter, and keeps it out of a table's rows", () => {
        const region = (bbox: Rect, label: DetectedRegion["label"]): DetectedRegion => ({ bbox, anchored: false, features: [], label });
        const lines = [line([40, 100, 52, 110], "64"), line([72, 100, 200, 110], "Cornelius Senf"), line([300, 100, 420, 110], "Kristoffer")];
        expect(routeLines(lines, [LINE_GUTTER, 0, 0], [region([30, 90, 430, 120], "table")])).toEqual([-1, 0, 0]);
    });
});

describe("routeLines paragraphs", () => {
    it("returns to its paragraph a line of numbers a figure box took under it", () => {
        const region = (bbox: Rect, label: DetectedRegion["label"]): DetectedRegion => ({ bbox, anchored: false, features: [], label });
        const lines = [
            line([42, 100, 291, 111], "Meta-analysis found no significant effect of massage on"),
            line([42, 112, 291, 123], "fatigue with high study heterogeneity (SMD 0.47, 95% CI"),
            line([42, 124, 260, 135], "−0.28 to 1.22; participants=171; studies=5; I2=86%)"),
            line([42, 136, 94, 147], "(figure 3C)."),
            line([42, 170, 120, 181], "Hopper et al."), // a figure label under a sentence's end
            line([330, 124, 400, 135], "Barlow et al."), // a label of the figure beside
        ];
        const flags = [LINE_RUNNING, LINE_RUNNING, 0, 0, 0, 0];
        expect(routeLines(lines, flags, [region([40, 20, 560, 470], "picture")])).toEqual([-1, -1, -1, -1, 0, 0]);
    });

    it("returns a loosely leaded paragraph's last line to it at the paragraph's line pitch", () => {
        const region = (bbox: Rect, label: DetectedRegion["label"]): DetectedRegion => ({ bbox, anchored: false, features: [], label });
        // Lines 18 apart, 11 high: the gap between them is wider than a tight paragraph's.
        const lead = (y: number) => [
            line([42, 100, 291, 111], "Specifically, using equations (4.5) and (4.7) we can"),
            line([42, 118, 291, 129], "derive the equilibrium time that agent i devotes to"),
            line([42, y, 100, y + 11], "violence as"),
        ];
        const eq = (y: number) => region([40, y - 1, 300, y + 40], "formula");
        expect(routeLines(lead(136), [LINE_RUNNING, LINE_RUNNING, 0], [eq(136)])).toEqual([-1, -1, -1]);
        // Set off by display space, it is not the paragraph's line.
        expect(routeLines(lead(150), [LINE_RUNNING, LINE_RUNNING, 0], [eq(150)])).toEqual([-1, -1, 0]);
    });

    it("leaves a display equation set at the margin under its lead-in to the formula", () => {
        const region = (bbox: Rect, label: DetectedRegion["label"]): DetectedRegion => ({ bbox, anchored: false, features: [], label });
        const lines = [
            line([42, 100, 291, 111], "The energy of the mixed state is the sum of the two"),
            line([42, 112, 291, 123], "contributions, which after averaging is given by"),
            line([42, 124, 200, 135], "∫ 2π dθ ∫ ∞ dr r φ† δH φ = v"),
        ];
        expect(routeLines(lines, [LINE_RUNNING, LINE_RUNNING, 0], [region([40, 122, 300, 140], "formula")])).toEqual([-1, -1, 0]);
    });
});

describe("detectRegions", () => {
    it("keeps a diagonal watermark out of detection and flags it as furniture", () => {
        const page = {
            pageIndex: 0,
            pageNumber: 1,
            width: W,
            height: H,
            blocks: [
                [126, 87, 553, 695, "UNCORRECTED PROOF", 59],
                [72, 100, 540, 111, PROSE_TEXT, BS],
                [72, 113, 540, 124, PROSE_TEXT, BS],
            ].map(([l, t, r, b, text, size]) => ({
                type: "text",
                bbox: { l, t, r, b },
                lines: [
                    {
                        wmode: 0,
                        bbox: { l, t, r, b },
                        font: { name: "Times-Roman", family: "Times", weight: "normal", style: "normal", size },
                        x: l,
                        y: b,
                        text,
                        rotation: 0,
                    },
                ],
            })),
        } as unknown as RawPageData;
        const detection = detectRegions(page, summary([]), { pageIndex: 0, route: true });
        expect(detection.candidates).toEqual([]);
        const { lines, flags } = detection.routing!;
        const mark = lines.findIndex((l) => l.text === "UNCORRECTED PROOF");
        expect(flags[mark]).toBe(LINE_SKEWED | LINE_FURNITURE);
        expect(lines.filter((l) => l.text === PROSE_TEXT)).toHaveLength(2);
    });

    it("flags the document's margin text of words or page numbers, not a repeating symbol", () => {
        const raw = (l: number, t: number, r: number, b: number, text: string) => ({
            wmode: 0,
            bbox: { l, t, r, b },
            font: { name: "Times-Roman", family: "Times", weight: "normal", style: "normal", size: BS },
            x: l,
            y: b,
            text,
            rotation: 0,
        });
        const header = raw(72, 30, 300, 41, "Journal of Testing Studies");
        const number = raw(520, 30, 540, 41, "41");
        const sum = raw(300, 60, 310, 71, "∑");
        const pageOf = raw(263, 739, 329, 748, "2201416 (6 of 10)");
        const body = raw(72, 100, 540, 111, PROSE_TEXT);
        const page = {
            pageIndex: 0,
            pageNumber: 1,
            width: W,
            height: H,
            blocks: [header, number, sum, pageOf, body].map((l) => ({ type: "text", bbox: l.bbox, lines: [l] })),
        } as unknown as RawPageData;
        const detection = detectRegions(page, summary([]), { pageIndex: 0, route: true, margin: new Set([header, number, sum, pageOf] as never[]) });
        const { lines, flags } = detection.routing!;
        const flagOf = (text: string) => flags[lines.findIndex((l) => l.text === text)] & LINE_MARGIN;
        expect([flagOf("Journal of Testing Studies"), flagOf("41"), flagOf("2201416 (6 of 10)"), flagOf("∑"), flagOf(PROSE_TEXT)]).toEqual([LINE_MARGIN, LINE_MARGIN, LINE_MARGIN, 0, 0]);
    });
});

describe("resolveOverlaps", () => {
    const region = (bbox: Rect, label: DetectedRegion["label"]): DetectedRegion => ({
        bbox,
        anchored: false,
        features: [],
        label,
    });

    it("keeps the largest of competing regions, whatever their class", () => {
        const regions = [
            region([110, 110, 200, 200], "picture"), // panel inside the figure
            region([100, 100, 400, 400], "picture"), // the figure
            region([350, 100, 500, 200], "picture"), // overlaps by a third: kept
            region([120, 300, 180, 380], "formula"), // inside the figure: a fragment
            region([100, 450, 400, 600], "table"), // graphics candidate of a table
            region([105, 455, 400, 610], "table"), // text candidate of the same table
            region([100, 700, 400, 720], "other"), // unclassified: untouched
        ];
        resolveOverlaps(regions);
        expect(regions.map((r) => r.label)).toEqual(["other", "picture", "picture", "other", "other", "table", "other"]);
        expect(regions[0].containedIn).toBe(1);
        expect(regions[3].containedIn).toBe(1);
        expect(regions[4].containedIn).toBe(5);
        expect(regions[2].containedIn).toBeUndefined();
        expect(regions[6].containedIn).toBeUndefined();
    });

    it("drops a region that holds a far more probable one", () => {
        const scored = (bbox: Rect, label: DetectedRegion["label"], p: number): DetectedRegion => ({
            ...region(bbox, label),
            probs: { other: 1 - p, picture: 0, decoration: 0, table: 0, formula: 0, [label!]: p },
        });
        const regions = [
            scored([100, 80, 550, 700], "picture", 0.74), // a page-sized weak region
            scored([90, 60, 500, 350], "picture", 0.99), // the figure, mostly inside it
            scored([120, 400, 300, 600], "picture", 0.74 + CONFIDENCE_MARGIN - 0.01), // not confident enough
        ];
        resolveOverlaps(regions);
        expect(regions.map((r) => r.label)).toEqual(["other", "picture", "picture"]);

        // Without the confident figure, the weaker one's panel is part of it as before.
        const again = [scored([100, 80, 550, 700], "picture", 0.74), scored([120, 400, 300, 600], "picture", 0.9)];
        resolveOverlaps(again);
        expect(again.map((r) => r.label)).toEqual(["picture", "other"]);
    });
});

type LogisticRegionModel = Extract<RegionModelWeights, { format: "bxm-logistic-v1" }>;

describe("region model", () => {
    const model = (overrides: Partial<LogisticRegionModel> = {}): LogisticRegionModel => ({
        format: "bxm-logistic-v1",
        featureVersion: REGION_FEATURE_VERSION,
        features: [...REGION_FEATURES],
        classes: ["other", "picture", "decoration"],
        mean: REGION_FEATURES.map(() => 0),
        scale: REGION_FEATURES.map(() => 1),
        coef: [REGION_FEATURES.map(() => 0), REGION_FEATURES.map((_, i) => (i === 0 ? 2 : 0)), REGION_FEATURES.map(() => 0)],
        intercept: [0, 0, 0],
        trainedOn: "test",
        ...overrides,
    });

    it("returns softmax probabilities keyed by class", () => {
        const x = REGION_FEATURES.map((_, i) => (i === 0 ? 1 : 0));
        const probs = predictRegionClass(model(), x);
        expect(probs.other + probs.picture + probs.decoration).toBeCloseTo(1);
        expect(probs.picture).toBeCloseTo(Math.exp(2) / (Math.exp(2) + 2));
    });

    it("sums tree leaves per class on top of the baseline", () => {
        // One stump per class on feature 1: left leaf when x[1] <= 0.5.
        const stump = (score: number, left: number, right: number) => ({
            score,
            feature: [1, -1, -1],
            threshold: [0.5, 0, 0],
            left: [1, 0, 0],
            right: [2, 0, 0],
            value: [0, left, right],
        });
        const trees: RegionModelWeights = {
            format: "bxm-trees-v1",
            featureVersion: REGION_FEATURE_VERSION,
            features: [...REGION_FEATURES],
            classes: ["other", "picture", "decoration"],
            baseline: [0, 0.5, 0],
            trees: [stump(0, 0, 0), stump(1, -0.5, 1.5), stump(2, 0, 0), stump(1, 0, 0.5)],
            trainedOn: "test",
        };
        const x = REGION_FEATURES.map(() => 0);
        expect(predictRegionClass(trees, x).picture).toBeCloseTo(1 / 3);
        x[1] = 1;
        expect(predictRegionClass(trees, x).picture).toBeCloseTo(Math.exp(2.5) / (Math.exp(2.5) + 2));
    });

    it("reports a region only when its class is at least REGION_MIN_PROB probable", () => {
        const page = { pageIndex: 0, pageNumber: 1, width: W, height: H, blocks: [] } as unknown as RawPageData;
        const g = summary([{ kind: GS_KIND.image, bbox: [72, 72, 400, 300] }]);
        const labelFor = (pictureLogit: number) => {
            const five: LogisticRegionModel = model({
                classes: ["other", "picture", "decoration", "table", "formula"],
                coef: [0, 1, 2, 3, 4].map(() => REGION_FEATURES.map(() => 0)),
                intercept: [0, pictureLogit, -20, -20, -20],
            });
            return detectRegions(page, g, { pageIndex: 0, model: five }).candidates[0].label;
        };
        // picture probability = e^a / (e^a + 1)
        const floor = REGION_MIN_PROB.picture;
        expect(labelFor(Math.log(floor / (1 - floor)) + 0.05)).toBe("picture");
        expect(labelFor(Math.log(0.6 / 0.4))).toBe("other");
    });

    it("rejects weights trained on another feature set", () => {
        expect(() => assertCompatible(model())).not.toThrow();
        expect(() => assertCompatible(model({ featureVersion: REGION_FEATURE_VERSION - 1 }))).toThrow();
        expect(() => assertCompatible(model({ features: [...REGION_FEATURES].reverse() }))).toThrow();
    });
});
