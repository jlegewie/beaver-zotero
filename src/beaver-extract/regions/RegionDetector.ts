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
import type { RawLine, RawPageData } from "@beaver/agent-core/extract/types";

import type { GraphicsSummary } from "../worker/graphicsSummary";
import { findCandidates } from "./candidates";
import { EMPTY_DOC_CONTEXT, candidateFeatures, type RegionDocContext } from "./features";
import { intersect, overlapFrac, rectArea, type Rect } from "./geometry";
import { assertCompatible, predictRegionClass, type RegionClass, type RegionModelWeights } from "./model";
import { bodySize, lineNumberGutter, mergeRowFragments, pageLines, pagePrimitives, sourceLines, type RegionLine } from "./pageSignals";
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
/**
 * A manuscript's line numbers (`lineNumberGutter`): kept in the prose as they are,
 * never routed, and no part of a table's rows.
 */
export const LINE_GUTTER = 16;
/**
 * Page furniture the document's margin analysis removes from the prose (running
 * headers and footers, page numbers; `DetectRegionsOptions.margin`): never routed,
 * so it stays with the page and becomes margin text exactly as with regions off.
 */
export const LINE_MARGIN = 32;
/** Margin text (`LINE_MARGIN`) holds at least this many letters, unless it carries a number. */
const MARGIN_MIN_LETTERS = 3;
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
    /**
     * Lines of the page that the paragraph pipeline's margin filter removes (running
     * headers and footers repeated across the document, page numbers). No region
     * takes them (`LINE_MARGIN`).
     */
    margin?: ReadonlySet<RawLine>;
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
    const visual = mergeRowFragments(pieces, primitives);
    // A manuscript's line numbers are furniture: they neither form nor join candidates,
    // no region takes them, and they are no column of a table.
    const gutter = lineNumberGutter(visual);
    const lines = visual.filter((l) => !gutter.has(l));
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
        const routed = [...lines, ...gutter, ...skewed];
        const numbered = opts.margin?.size ? sourceLines(page) : undefined;
        // Furniture is words (a running head) or carries a page number; a symbol, a
        // variable or a panel letter repeating in the margin band is content.
        const inMargin = (l: RegionLine) =>
            !!numbered &&
            ((l.text.match(/\p{L}/gu) ?? []).length >= MARGIN_MIN_LETTERS || /\d/u.test(l.text)) &&
            (l.parts ?? [l]).every((p) => opts.margin!.has(numbered[p.source - 1]));
        const flags = routed.map((l) =>
            l.skewed
                ? LINE_SKEWED | (furniture(l) ? LINE_FURNITURE : 0)
                : gutter.has(l)
                  ? LINE_GUTTER
                  : (found.running.has(l) ? LINE_RUNNING : 0) |
                    (found.captionText.has(l) ? LINE_CAPTION : 0) |
                    (inMargin(l) ? LINE_MARGIN : 0),
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

/** A paragraph's next line starts at most this many of its line heights below the line above... */
const PARAGRAPH_GAP = 0.6;
/** ...or at most this many times the paragraph's own line pitch (loosely leaded text). */
const PARAGRAPH_PITCH = 1.15;
/** A paragraph's line has at most this share of math characters. */
const PARAGRAPH_MATH = 0.2;
/** A sentence ends: terminal punctuation, maybe followed by a closing quote or bracket. */
const SENTENCE_END_RE = /[.!?][\])"'”’]*$/u;

/**
 * A line that a picture or formula box took from a paragraph goes back to it: a
 * line of text set directly under a paragraph line (running text with another
 * paragraph line above it), at its left edge, in its type size and within its
 * width, at the paragraph's line spacing, when that line's sentence goes on.
 * Running-text detection judges lines one by one and misses such a line when it
 * holds mostly numbers or symbols (a statistic, a citation) or few words (the
 * last line of a sentence leading into a display); the paragraph it continues
 * says what it is. The lines that follow it the same way go back too.
 */
function keepParagraphTails(lines: readonly RegionLine[], flags: readonly number[], regions: readonly DetectedRegion[], routes: number[]): void {
    const order = lines
        .map((_, i) => i)
        .filter((i) => !lines[i].rot && !(flags[i] & (LINE_SKEWED | LINE_GUTTER)))
        .sort((a, b) => lines[a].bbox[1] - lines[b].bbox[1]);
    const paragraph = new Set(order.filter((i) => flags[i] & LINE_RUNNING));
    // The line directly above one: the nearest that overlaps it horizontally.
    const above = (i: number): number => {
        const b = lines[i].bbox;
        let best = -1;
        let bestGap = Infinity;
        for (const j of order) {
            const o = lines[j].bbox;
            if (j === i || o[1] >= b[1] || Math.min(o[2], b[2]) <= Math.max(o[0], b[0])) continue;
            const gap = b[1] - o[3];
            if (gap < -0.5 * (b[3] - b[1]) || gap >= bestGap) continue;
            best = j;
            bestGap = gap;
        }
        return best;
    };
    // Baseline to baseline, read off whichever edge sub- and superscripts leave in place.
    const pitch = (upper: Rect, lower: Rect) => Math.min(lower[1] - upper[1], lower[3] - upper[3]);
    const continues = (i: number, j: number, before: number): boolean => {
        const a = lines[j];
        const b = lines[i];
        const h = Math.max(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]);
        return (
            // Text, not a display equation set at the margin under its lead-in.
            /\p{L}{3,}/u.test(b.text) &&
            b.mathChars <= PARAGRAPH_MATH * b.inkChars &&
            (b.bbox[1] - a.bbox[3] <= PARAGRAPH_GAP * h || pitch(a.bbox, b.bbox) <= PARAGRAPH_PITCH * pitch(lines[before].bbox, a.bbox)) &&
            Math.abs(b.bbox[0] - a.bbox[0]) <= 2 &&
            b.bbox[2] <= a.bbox[2] + 2 &&
            Math.abs(b.size - a.size) <= 1 &&
            !SENTENCE_END_RE.test(a.text.trimEnd())
        );
    };
    for (const i of order) {
        const k = routes[i];
        if (k < 0 || (regions[k].label !== "picture" && regions[k].label !== "formula")) continue;
        const j = above(i);
        if (j < 0 || !paragraph.has(j)) continue;
        // The line above is a paragraph's when a paragraph line stands over it too.
        const before = above(j);
        if (before < 0 || !paragraph.has(before) || !continues(i, j, before)) continue;
        routes[i] = -1;
        paragraph.add(i);
    }
}

/** A table's row follows the next one at most this many line heights apart. */
const MARGIN_ROW_GAP = 2;

/**
 * Margin text (`LINE_MARGIN`) stays out of the regions, except rows of a table: a
 * continued table's header repeats at the top of each page, as a running header does,
 * but the table's lines follow it directly. Going toward the page's body, through the
 * table's lines in turn, the first line that is not margin text comes with no gap wider
 * than `MARGIN_ROW_GAP` line heights. A running header stands apart, with a caption or a
 * gap between it and the body.
 */
function keepMarginOut(lines: readonly RegionLine[], flags: readonly number[], regions: readonly DetectedRegion[], routes: number[]): void {
    const initial = [...routes];
    lines.forEach((l, i) => {
        if (!(flags[i] & LINE_MARGIN) || initial[i] < 0) return;
        const k = initial[i];
        const b = l.bbox;
        const h = b[3] - b[1];
        // Toward the body: down from a line above the table's middle, up from one below it.
        const r = regions[k].bbox;
        const down = (b[1] + b[3]) / 2 < (r[1] + r[3]) / 2;
        const ahead = lines
            .map((_, j) => j)
            .filter((j) => j !== i && initial[j] === k && (down ? lines[j].bbox[1] > b[1] : lines[j].bbox[3] < b[3]))
            .sort((p, q) => (down ? lines[p].bbox[1] - lines[q].bbox[1] : lines[q].bbox[3] - lines[p].bbox[3]));
        let edge = down ? b[3] : b[1];
        let tableRow = false;
        for (const j of ahead) {
            const o = lines[j].bbox;
            if ((down ? o[1] - edge : edge - o[3]) > MARGIN_ROW_GAP * h) break;
            if (regions[k].label === "table" && !(flags[j] & LINE_MARGIN)) {
                tableRow = true;
                break;
            }
            edge = down ? Math.max(edge, o[3]) : Math.min(edge, o[1]);
        }
        if (!tableRow) routes[i] = -1;
    });
}

/** An equation number sits at most this many of its line heights below its equation's box. */
const EQ_NUMBER_DROP = 1;
/** A column's lines within this many of a number's line heights of its equation show the column. */
const COLUMN_EDGE_REACH = 10;

/**
 * Whether the number at `i`, right of the equation boxed `f`, stands in the equation's
 * column. A number that ends its row does. One that text follows on its row (a list's
 * marker in the next column, or the next column a gutter away) does when a line of words
 * of the equation's column above or below it (starting left of the equation's right edge)
 * reaches the number and ends before that text: the column's lines run out to the number.
 */
function inEquationColumn(lines: readonly RegionLine[], i: number, f: Rect): boolean {
    const b = lines[i].bbox;
    const h = b[3] - b[1];
    const sameRow = (o: Rect) => Math.min(o[3], b[3]) > Math.max(o[1], b[1]);
    const after = lines.filter((o, j) => j !== i && sameRow(o.bbox) && o.bbox[0] >= b[2] - 2).map((o) => o.bbox[0]);
    if (!after.length) return true;
    const next = Math.min(...after);
    return lines.some(
        (o, j) =>
            j !== i &&
            !o.rot &&
            o.alphaWords >= 1 &&
            !sameRow(o.bbox) &&
            o.bbox[0] < f[2] &&
            o.bbox[2] >= b[0] &&
            o.bbox[2] < next &&
            Math.max(f[1] - o.bbox[3], o.bbox[1] - f[3]) <= COLUMN_EDGE_REACH * h,
    );
}

/**
 * An equation number standing alone on its line (`RegionLine.eqNumber`) that no region
 * holds goes to the equation it numbers: the formula beside it on its row, or the one
 * whose box ends directly above it (a number set a baseline lower, after a tall
 * equation), when no other line stands between them. A number right of the equation
 * must stand in its column (`inEquationColumn`): one in the next column is a list's
 * marker there.
 */
function attachEquationNumbers(lines: readonly RegionLine[], flags: readonly number[], regions: readonly DetectedRegion[], routes: number[]): void {
    lines.forEach((l, i) => {
        if (!l.eqNumber || l.rot || routes[i] >= 0 || flags[i] & (LINE_CAPTION | LINE_FURNITURE | LINE_GUTTER | LINE_MARGIN | LINE_SKEWED)) return;
        const b = l.bbox;
        const h = b[3] - b[1];
        let best = -1;
        let bestGap = Infinity;
        regions.forEach((r, k) => {
            if (r.label !== "formula") return;
            const f = r.bbox;
            if (b[1] < f[1] || b[1] > f[3] + EQ_NUMBER_DROP * h) return;
            // Beside the box, left or right; on the number's row, no other text under the
            // equation or between them (a number on a row of prose is that row's).
            const side = b[0] >= f[2] - 2 ? 1 : b[2] <= f[0] + 2 ? -1 : 0;
            if (!side) return;
            const [x0, x1] = side > 0 ? [f[0], b[0]] : [b[2], f[2]];
            const between = lines.some(
                (o, j) => j !== i && Math.min(o.bbox[3], b[3]) > Math.max(o.bbox[1], b[1]) && o.bbox[0] < x1 && o.bbox[2] > x0 && routes[j] !== k,
            );
            const gap = side > 0 ? b[0] - f[2] : f[0] - b[2];
            if (!between && (side < 0 || inEquationColumn(lines, i, f)) && gap < bestGap) {
                best = k;
                bestGap = gap;
            }
        });
        if (best >= 0) routes[i] = best;
    });
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
 * belongs to it (labels, cells, equation parts) — and so does a line a picture
 * or formula box took from a paragraph it continues (`keepParagraphTails`).
 * Lines that belong to a table's rows join the table, as do rows its box missed
 * between its cells and the horizontal `rules` that rule them
 * (`completeTableRows`); a fragment of the table those rows reach becomes part
 * of it (label "other", `containedIn`).
 * Decorations take no text: what they overlap stays in prose, where margin
 * detection decides about it. Furniture, the document's margin text and
 * line-number gutters are never routed.
 */
export function routeLines(
    lines: readonly RegionLine[],
    flags: readonly number[],
    regions: DetectedRegion[],
    rules: readonly Rect[] = [],
): number[] {
    const routes = lines.map((l, i) => {
        if (flags[i] & (LINE_CAPTION | LINE_FURNITURE | LINE_GUTTER)) return -1;
        // Margin text of words reads as running text, but a continued table's repeated header
        // is such a line too: it goes to the region that holds it, for `keepMarginOut` to judge.
        const marginRow = (flags[i] & (LINE_RUNNING | LINE_MARGIN)) === (LINE_RUNNING | LINE_MARGIN);
        if (flags[i] & LINE_RUNNING && !marginRow) return -1;
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
    keepMarginOut(lines, flags, regions, routes);
    keepParagraphTails(lines, flags, regions, routes);
    attachEquationNumbers(lines, flags, regions, routes);
    const tables = regions.flatMap((r, index) => (r.label === "table" ? [{ index, bbox: r.bbox }] : []));
    if (tables.length) {
        // Skewed lines have no rows to share, and margin text is no part of the body;
        // completion leaves them where they are.
        const upright = lines.flatMap((_, i) => (flags[i] & (LINE_SKEWED | LINE_GUTTER | LINE_MARGIN) ? [] : [i]));
        const sub = upright.map((i) => routes[i]);
        const merged = completeTableRows(
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
        // A table fragment whose rows the completion carried into another table is part of it,
        // with every line routed to it, including those completion leaves where they are.
        const target = (k: number): number => {
            for (let n = 0; merged.has(k) && n <= merged.size; n++) k = merged.get(k)!;
            return k;
        };
        routes.forEach((route, i) => {
            if (merged.has(route)) routes[i] = target(route);
        });
        // Its box joins the table's, with the rules and graphics beyond its text.
        for (const [k] of merged) {
            const into = regions[target(k)];
            const [a, b] = [into.bbox, regions[k].bbox];
            into.bbox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
            regions[k].label = "other";
            regions[k].containedIn = target(k);
        }
    }
    return routes;
}
