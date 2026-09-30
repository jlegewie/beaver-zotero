import { describe, expect, it } from "vitest";

import { findCandidates } from "../../../src/beaver-extract/regions/candidates";
import { markContainedPictures, type DetectedRegion } from "../../../src/beaver-extract/regions/RegionDetector";
import { GRID_CLUSTER_MIN, clusterRects, gridCluster } from "../../../src/beaver-extract/regions/cluster";
import { EMPTY_DOC_CONTEXT, REGION_FEATURES, REGION_FEATURE_VERSION, candidateFeatures } from "../../../src/beaver-extract/regions/features";
import type { Rect } from "../../../src/beaver-extract/regions/geometry";
import {
    assertCompatible,
    predictRegionClass,
    type LogisticRegionModel,
    type TreeRegionModel,
} from "../../../src/beaver-extract/regions/model";
import { pagePrimitives, type RegionLine } from "../../../src/beaver-extract/regions/pageSignals";
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
        grid: gridArray,
        gridSize: grid?.size ?? 0,
    };
}

function line(bbox: Rect, text: string, size = BS): RegionLine {
    return { bbox, text, size, rot: false, words: text.split(/\s+/).length, nchar: text.length };
}

const prose = (y: number, x0 = 72, x1 = 540) =>
    line([x0, y, x1, y + 11], "the quick brown fox jumps over the lazy dog again and again");

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
        const boxes = found.candidates.filter((c) => !c.anchored).map((c) => c.bbox);
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
        expect(found.candidates.filter((c) => !c.anchored)).toHaveLength(0);
    });

    it("keeps a full-width photo on a born-digital page", () => {
        const g = summary([{ kind: GS_KIND.image, bbox: [0, 72, W, 400] }]);
        const found = findCandidates([prose(420), prose(435), prose(450)], pagePrimitives(g, W, H, BS), W, H, BS);
        expect(found.scanned).toBe(false);
        expect(found.candidates).toHaveLength(1);
    });
});

describe("markContainedPictures", () => {
    const region = (bbox: Rect, label: DetectedRegion["label"]): DetectedRegion => ({
        bbox,
        anchored: false,
        features: [],
        label,
    });

    it("turns pictures inside a larger picture into fragments of it", () => {
        const regions = [
            region([110, 110, 200, 200], "picture"), // panel inside the figure
            region([100, 100, 400, 400], "picture"), // the figure
            region([350, 100, 500, 200], "picture"), // overlaps by a third: kept
            region([120, 300, 180, 380], "table"), // not a picture: untouched
        ];
        markContainedPictures(regions);
        expect(regions.map((r) => r.label)).toEqual(["other", "picture", "picture", "table"]);
        expect(regions[0].containedIn).toBe(1);
        expect(regions[2].containedIn).toBeUndefined();
    });
});

describe("region model", () => {
    const model = (overrides: Partial<LogisticRegionModel> = {}): LogisticRegionModel => ({
        kind: "logistic",
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
        const stump = (left: number, right: number) => [1, 0.5, 1, 2, 0, -1, 0, 0, 0, left, -1, 0, 0, 0, right];
        const trees: TreeRegionModel = {
            kind: "trees",
            featureVersion: REGION_FEATURE_VERSION,
            features: [...REGION_FEATURES],
            classes: ["other", "picture", "decoration"],
            baseline: [0, 0.5, 0],
            trees: [[stump(0, 0)], [stump(-0.5, 1.5), stump(0, 0.5)], [stump(0, 0)]],
            trainedOn: "test",
        };
        const x = REGION_FEATURES.map(() => 0);
        expect(predictRegionClass(trees, x).picture).toBeCloseTo(1 / 3);
        x[1] = 1;
        expect(predictRegionClass(trees, x).picture).toBeCloseTo(Math.exp(2.5) / (Math.exp(2.5) + 2));
    });

    it("rejects weights trained on another feature set", () => {
        expect(() => assertCompatible(model())).not.toThrow();
        expect(() => assertCompatible(model({ featureVersion: REGION_FEATURE_VERSION - 1 }))).toThrow();
        expect(() => assertCompatible(model({ features: [...REGION_FEATURES].reverse() }))).toThrow();
    });
});
