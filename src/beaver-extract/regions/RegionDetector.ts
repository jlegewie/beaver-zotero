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
import { intersect, overlapFrac, rectArea, type Rect } from "./geometry";
import { assertCompatible, predictRegionClass, type RegionClass, type RegionModelWeights } from "./model";
import { bodySize, mergeRowFragments, pageLines, pagePrimitives, type RegionLine } from "./pageSignals";

export interface DetectedRegion {
    bbox: Rect;
    anchored: boolean;
    /** Feature vector in `REGION_FEATURES` order. */
    features: number[];
    /** Present when a model was given. */
    probs?: Record<RegionClass, number>;
    /**
     * Class when a model was given: the most probable one, except that a region
     * overlapping a larger region becomes "other" (see `resolveOverlaps`).
     */
    label?: RegionClass;
    /** Index of the larger region this candidate duplicates or is a fragment of. */
    containedIn?: number;
}

/** A region with at least this share of its area inside a larger region is part of it. */
export const CONTAINED_FRACTION = 0.8;
/** Regions overlapping a larger region at this IoU or more duplicate it. */
export const DUPLICATE_IOU = 0.5;
/**
 * A candidate is a region only when its class is at least this probable.
 * Uncertain regions would move prose out of the text for little gain; the bar
 * is lower for tables, whose mistakes reformat text instead of hiding it.
 * Chosen by severity-weighted text impact across the evaluation sets.
 */
export const REGION_MIN_PROB: Readonly<Record<Exclude<RegionClass, "other">, number>> = {
    picture: 0.7,
    decoration: 0.7,
    table: 0.6,
    formula: 0.7,
};

/** Line flags in `RegionDetection.lines`. */
export const LINE_RUNNING = 1;
export const LINE_CAPTION = 2;

export interface RegionDetection {
    pageIndex: number;
    scanned: boolean;
    bodySize: number;
    candidates: DetectedRegion[];
    /**
     * With `includeLines`: the page's text lines as [x0, y0, x1, y1, chars, flags,
     * region] (flags `LINE_RUNNING`, `LINE_CAPTION`; region = index of the
     * candidate the line is routed to, or -1; see `routeLines`), for measuring how
     * regions route text.
     */
    lines?: number[][];
    /** Detector time, excluding the graphics summary (collected with the text pass). */
    ms: number;
}

export interface DetectRegionsOptions {
    pageIndex: number;
    doc?: RegionDocContext;
    model?: RegionModelWeights | null;
    includeLines?: boolean;
}

export function detectRegions(page: RawPageData, graphics: GraphicsSummary, opts: DetectRegionsOptions): RegionDetection {
    const start = performance.now();
    if (opts.model) assertCompatible(opts.model);
    const pieces = pageLines(page);
    const bs = bodySize(pieces);
    const primitives = pagePrimitives(graphics, page.width, page.height, bs);
    const lines = mergeRowFragments(pieces, primitives);
    const found = findCandidates(lines, primitives, page.width, page.height, bs);
    const doc = opts.doc ?? EMPTY_DOC_CONTEXT;
    const candidates = found.candidates.map((c): DetectedRegion => {
        const features = candidateFeatures(c, found, doc);
        const region: DetectedRegion = { bbox: c.bbox, anchored: c.anchored, features };
        if (opts.model) {
            const probs = predictRegionClass(opts.model, features);
            region.probs = probs;
            const best = opts.model.classes.reduce((a, b) => (probs[b] > probs[a] ? b : a));
            region.label = best !== "other" && probs[best] < REGION_MIN_PROB[best] ? "other" : best;
        }
        return region;
    });
    if (opts.model) resolveOverlaps(candidates);
    const ms = performance.now() - start;
    const detection: RegionDetection = { pageIndex: opts.pageIndex, scanned: found.scanned, bodySize: bs, candidates, ms };
    if (opts.includeLines) {
        const flags = lines.map(
            (l) => (found.running.has(l) ? LINE_RUNNING : 0) | (found.captionText.has(l) ? LINE_CAPTION : 0),
        );
        const routes = routeLines(lines, flags, candidates);
        detection.lines = lines.map((l, i) => [
            ...l.bbox.map((v) => Math.round(v * 10) / 10),
            l.nchar,
            flags[i],
            routes[i],
        ]);
    }
    return detection;
}

/**
 * Classified regions compete for space, largest first: a region mostly inside a
 * kept one (a panel, an axis-label group, an equation inside a table) or
 * overlapping it heavily (the graphics and text candidates of one table) becomes
 * part of it. The research repo's `resolve_overlaps` applies the same rule when
 * scoring.
 */
export function resolveOverlaps(regions: DetectedRegion[]): void {
    const order = regions
        .map((_, i) => i)
        .filter((i) => regions[i].label !== undefined && regions[i].label !== "other")
        .sort((a, b) => rectArea(regions[b].bbox) - rectArea(regions[a].bbox));
    const kept: number[] = [];
    for (const i of order) {
        const box = regions[i].bbox;
        const area = rectArea(box);
        const outer = kept.find((k) => {
            const inter = rectArea(intersect(box, regions[k].bbox));
            const union = area + rectArea(regions[k].bbox) - inter;
            return inter >= CONTAINED_FRACTION * area || (union > 0 && inter / union >= DUPLICATE_IOU);
        });
        if (outer === undefined) {
            kept.push(i);
        } else {
            regions[i].label = "other";
            regions[i].containedIn = outer;
        }
    }
}

/**
 * Where each line goes once regions leave the prose stream: the index of the
 * smallest classified region containing the line's centre, or -1 for prose.
 * Running text and captions always stay in prose — a region absorbs only the
 * text that belongs to it (labels, cells, equation parts).
 */
export function routeLines(
    lines: readonly RegionLine[],
    flags: readonly number[],
    regions: readonly DetectedRegion[],
): number[] {
    return lines.map((l, i) => {
        if (flags[i] & (LINE_RUNNING | LINE_CAPTION)) return -1;
        const cx = (l.bbox[0] + l.bbox[2]) / 2;
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        let best = -1;
        let bestArea = Infinity;
        regions.forEach((r, k) => {
            if (!r.label || r.label === "other") return;
            const b = r.bbox;
            if (cx < b[0] || cx > b[2] || cy < b[1] || cy > b[3]) return;
            const area = rectArea(b);
            if (area < bestArea) {
                best = k;
                bestArea = area;
            }
        });
        return best;
    });
}
