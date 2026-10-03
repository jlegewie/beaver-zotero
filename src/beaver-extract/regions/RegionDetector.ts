/**
 * Region detector: pictures, tables, display equations and decorations on a PDF
 * page, from the page's text lines and its MuPDF graphics summary — no layout
 * model.
 *
 * Pipeline: typed primitives → candidates (graphics clusters grown over labels
 * and merged across panels, caption-anchored regions, text groups) → features →
 * boosted-tree classes with per-class probability floors → overlap resolution →
 * line routing. Without a model it returns candidates and features only (used to
 * export training data). Structured extraction turns the result into items
 * (`regionItems.ts`).
 */
import type { RawPageData } from "@beaver/agent-core/extract/types";

import type { GraphicsSummary } from "../worker/graphicsSummary";
import { findCandidates } from "./candidates";
import { EMPTY_DOC_CONTEXT, candidateFeatures, type RegionDocContext } from "./features";
import { intersect, overlapFrac, rectArea, type Rect } from "./geometry";
import { assertCompatible, predictRegionClass, type RegionClass, type RegionModelWeights } from "./model";
import { bodySize, mergeRowFragments, pageLines, pagePrimitives, type RegionLine } from "./pageSignals";
import { completeTableRows } from "./tableRows";

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
 * A region holding a region at least this much more probable than itself is
 * dropped before overlaps are resolved: a page-sized weak region (a full-page
 * background, a stray cluster) must not swallow a confident figure inside it.
 * Chosen on the development sets; the research repo's `resolve_overlaps`
 * applies it with the same margin.
 */
export const CONFIDENCE_MARGIN = 0.25;
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
/** Text set at an angle (`RegionLine.skewed`); it takes no part in detection. */
export const LINE_SKEWED = 4;
/**
 * Skewed text spanning the page (a diagonal watermark): page furniture, read
 * as margin text rather than as part of the layout. Never routed.
 */
export const LINE_FURNITURE = 8;
/** Skewed text spanning at least this share of the page's width and height is furniture. */
const FURNITURE_SPAN = 1 / 3;

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
    /** With `route`: the page's text lines, their flags and where each is routed. */
    routing?: LineRouting;
    /** Detector time, excluding the graphics summary (collected with the text pass). */
    ms: number;
}

export interface LineRouting {
    /** Visual lines (pieces joined by `mergeRowFragments`). */
    lines: RegionLine[];
    /** `LINE_RUNNING` / `LINE_CAPTION` per line. */
    flags: number[];
    /** Index of the candidate each line is routed to, or -1 (see `routeLines`). */
    routes: number[];
    /** The page's horizontal rules (row separators of tables). */
    rules?: Rect[];
    /** The page's vertical rules (row separators of sideways tables). */
    verticalRules?: Rect[];
}

export interface DetectRegionsOptions {
    pageIndex: number;
    doc?: RegionDocContext;
    model?: RegionModelWeights | null;
    includeLines?: boolean;
    /** Also return the line routing as objects (`RegionDetection.routing`). */
    route?: boolean;
}

export function detectRegions(page: RawPageData, graphics: GraphicsSummary, opts: DetectRegionsOptions): RegionDetection {
    const start = performance.now();
    if (opts.model) assertCompatible(opts.model);
    const all = pageLines(page);
    // Skewed text has meaningless boxes: it neither forms nor shapes candidates.
    const pieces = all.filter((l) => !l.skewed);
    const skewed = all.filter((l) => l.skewed);
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
    if (opts.includeLines || opts.route) {
        const furniture = (l: RegionLine) =>
            l.bbox[2] - l.bbox[0] >= FURNITURE_SPAN * page.width && l.bbox[3] - l.bbox[1] >= FURNITURE_SPAN * page.height;
        const routed = [...lines, ...skewed];
        const flags = routed.map((l) =>
            l.skewed
                ? LINE_SKEWED | (furniture(l) ? LINE_FURNITURE : 0)
                : (found.running.has(l) ? LINE_RUNNING : 0) | (found.captionText.has(l) ? LINE_CAPTION : 0),
        );
        const rules = primitives.filter((p) => p.kind === "hrule").map((p) => p.bbox);
        const routes = routeLines(routed, flags, candidates, rules);
        const verticalRules = primitives.filter((p) => p.kind === "vrule").map((p) => p.bbox);
        if (opts.route) detection.routing = { lines: routed, flags, routes, rules, verticalRules };
        if (opts.includeLines) {
            detection.lines = routed.map((l, i) => [
                ...l.bbox.map((v) => Math.round(v * 10) / 10),
                l.nchar,
                flags[i],
                routes[i],
            ]);
        }
    }
    return detection;
}

/**
 * Classified regions compete for space, largest first: a region mostly inside a
 * kept one (a panel, an axis-label group, an equation inside a table) or
 * overlapping it heavily (the graphics and text candidates of one table) becomes
 * part of it. Before that, a region holding a far more probable one
 * (`CONFIDENCE_MARGIN`) becomes "other". The research repo's `resolve_overlaps`
 * applies the same rule when scoring.
 */
export function resolveOverlaps(regions: DetectedRegion[]): void {
    const labelled = regions
        .map((_, i) => i)
        .filter((i) => regions[i].label !== undefined && regions[i].label !== "other");
    const prob = (i: number) => regions[i].probs?.[regions[i].label!] ?? 0;
    const outweighed = labelled.filter((i) =>
        labelled.some(
            (j) =>
                j !== i &&
                rectArea(regions[j].bbox) < rectArea(regions[i].bbox) &&
                prob(j) >= prob(i) + CONFIDENCE_MARGIN &&
                rectArea(intersect(regions[j].bbox, regions[i].bbox)) >= CONTAINED_FRACTION * rectArea(regions[j].bbox),
        ),
    );
    for (const i of outweighed) regions[i].label = "other";
    const order = labelled
        .filter((i) => !outweighed.includes(i))
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
 * Running text and captions stay in prose — a region absorbs only the text that
 * belongs to it (labels, cells, equation parts) — except for lines that belong
 * to a table's rows: those join the table, as do rows its box missed between
 * its cells and the horizontal `rules` that rule them (`completeTableRows`).
 * Decorations take no text: what they overlap stays in prose, where margin
 * detection decides about it. Furniture is never routed.
 */
export function routeLines(
    lines: readonly RegionLine[],
    flags: readonly number[],
    regions: readonly DetectedRegion[],
    rules: readonly Rect[] = [],
): number[] {
    const routes = lines.map((l, i) => {
        if (flags[i] & (LINE_RUNNING | LINE_CAPTION | LINE_FURNITURE)) return -1;
        const cx = (l.bbox[0] + l.bbox[2]) / 2;
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        let best = -1;
        let bestArea = Infinity;
        regions.forEach((r, k) => {
            if (!r.label || r.label === "other" || r.label === "decoration") return;
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
    const tables = regions.flatMap((r, index) => (r.label === "table" ? [{ index, bbox: r.bbox }] : []));
    if (tables.length) {
        // Skewed lines have no rows to share; completion leaves them where they are.
        const upright = lines.flatMap((_, i) => (flags[i] & LINE_SKEWED ? [] : [i]));
        const sub = upright.map((i) => routes[i]);
        completeTableRows(
            {
                lines: upright.map((i) => lines[i]),
                running: upright.map((i) => (flags[i] & LINE_RUNNING) !== 0),
                caption: upright.map((i) => (flags[i] & LINE_CAPTION) !== 0),
                tables,
                rules,
            },
            sub,
        );
        upright.forEach((i, k) => (routes[i] = sub[k]));
    }
    return routes;
}
