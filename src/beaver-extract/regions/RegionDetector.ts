/**
 * Region detector: picture and decoration regions on a PDF page, from the page's
 * text lines and its MuPDF graphics summary — no layout model.
 *
 * Pipeline: typed primitives → clustered candidates (grown over labels, panels
 * merged, caption-anchored regions added) → features → logistic-regression class
 * (picture / decoration / other). Without a model it returns candidates and
 * features only (used to export training data).
 *
 * Detection mode only: results are reported through the CLI and debug tooling;
 * extraction output does not use them yet.
 */
import type { RawPageData } from "@beaver/agent-core/extract/types";

import type { GraphicsSummary } from "../worker/graphicsSummary";
import { findCandidates } from "./candidates";
import { EMPTY_DOC_CONTEXT, candidateFeatures, type RegionDocContext } from "./features";
import { intersect, rectArea, type Rect } from "./geometry";
import { assertCompatible, predictRegionClass, type RegionClass, type RegionModelWeights } from "./model";
import { bodySize, pageLines, pagePrimitives } from "./pageSignals";

export interface DetectedRegion {
    bbox: Rect;
    anchored: boolean;
    /** Feature vector in `REGION_FEATURES` order. */
    features: number[];
    /** Present when a model was given. */
    probs?: Record<RegionClass, number>;
    /**
     * Class when a model was given: the most probable one, except that a
     * picture lying mostly inside a larger picture becomes "other" (see
     * `containedIn`).
     */
    label?: RegionClass;
    /** Index of the larger picture region this candidate is a fragment of. */
    containedIn?: number;
}

/** A picture with at least this share of its area inside a larger picture is a fragment of it. */
export const CONTAINED_FRACTION = 0.8;

export interface RegionDetection {
    pageIndex: number;
    scanned: boolean;
    bodySize: number;
    candidates: DetectedRegion[];
    /** Detector time, excluding the graphics summary (collected with the text pass). */
    ms: number;
}

export interface DetectRegionsOptions {
    pageIndex: number;
    doc?: RegionDocContext;
    model?: RegionModelWeights | null;
}

export function detectRegions(page: RawPageData, graphics: GraphicsSummary, opts: DetectRegionsOptions): RegionDetection {
    const start = performance.now();
    if (opts.model) assertCompatible(opts.model);
    const lines = pageLines(page);
    const bs = bodySize(lines);
    const primitives = pagePrimitives(graphics, page.width, page.height, bs);
    const found = findCandidates(lines, primitives, page.width, page.height, bs);
    const doc = opts.doc ?? EMPTY_DOC_CONTEXT;
    const candidates = found.candidates.map((c): DetectedRegion => {
        const features = candidateFeatures(c, found, doc);
        const region: DetectedRegion = { bbox: c.bbox, anchored: c.anchored, features };
        if (opts.model) {
            const probs = predictRegionClass(opts.model, features);
            region.probs = probs;
            region.label = opts.model.classes.reduce((a, b) => (probs[b] > probs[a] ? b : a));
        }
        return region;
    });
    if (opts.model) markContainedPictures(candidates);
    return {
        pageIndex: opts.pageIndex,
        scanned: found.scanned,
        bodySize: bs,
        candidates,
        ms: performance.now() - start,
    };
}

/**
 * Pictures lying mostly inside a larger picture (a panel, or a caption-anchored
 * region beside its cluster) become fragments of it. Largest first; the
 * research repo's `drop_contained` applies the same rule when scoring.
 */
export function markContainedPictures(regions: DetectedRegion[]): void {
    const pictures = regions
        .map((_, i) => i)
        .filter((i) => regions[i].label === "picture")
        .sort((a, b) => rectArea(regions[b].bbox) - rectArea(regions[a].bbox));
    const kept: number[] = [];
    for (const i of pictures) {
        const box = regions[i].bbox;
        const outer = kept.find((k) => rectArea(intersect(box, regions[k].bbox)) >= CONTAINED_FRACTION * rectArea(box));
        if (outer === undefined) {
            kept.push(i);
        } else {
            regions[i].label = "other";
            regions[i].containedIn = outer;
        }
    }
}
