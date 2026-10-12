/**
 * `items export --task regions-v2`: per page, the units the region pass works
 * on (text pieces and drawing primitives) and what the shipped detector (v5)
 * did with each, observed inside the production pipeline (`segmentPages`), so
 * the document context and line flags are those of a real extraction.
 *
 * Every box is in the structured export's public frame: PDF points, top-left
 * origin, the page as MuPDF displays it (its `/Rotate` applied). The page's
 * text orientation (`textRotation`) is reported but not applied, as in the
 * structured export: on a page set sideways, boxes stay in the displayed frame.
 */

import type { RawLine, RawLineDetailed } from "@beaver/agent-core/extract/types";
import type { Rect } from "../schema";
import { roundRect } from "../schema/bbox";
import type { RegionDetection } from "../regions/RegionDetector";
import { REGION_FEATURES, REGION_FEATURE_VERSION } from "../regions/features";
import { pagePrimitives, sourceLines, type RegionLine } from "../regions/pageSignals";
import { splitRegionItems, type RegionItemDraft } from "../regions/regionItems";
import { REGION_MODEL } from "../regions/weights";
import { DEFAULT_REGION_CONTEXT_PAGES } from "../worker/regionOps";
import type { RegionPassObserver, RegionPassPage } from "./structured";

export const REGIONS_EXPORT_FORMAT = "beaver-regions-v1";
export const REGIONS_EXPORT_TASK = "regions-v2";

/** Fields of a `primitives` tuple. */
export const PRIMITIVE_FIELDS = ["kind", "x0", "y0", "x1", "y1", "rgb", "curve", "stroked", "rect", "imageHash"] as const;

/** Bits of a piece's `flags` (the detector's `LINE_*` flags). */
export const LINE_FLAG_BITS = { running: 1, caption: 2, skewed: 4, furniture: 8, gutter: 16, margin: 32 } as const;

/** `v5Route` of text that stayed in the prose. */
export const ROUTE_PROSE = -1;
/**
 * `v5Route` of text v5 took out of the prose without emitting an item for it:
 * furniture it set aside as margin text (`LINE_FURNITURE`, a diagonal
 * watermark), or lines absorbed by a region that emitted no item.
 */
export const ROUTE_DROPPED = -2;

/** Monospaced font families, by name (the walk records no fixed-pitch flag). */
const MONO_FONT_RE =
    /mono|courier|consol|menlo|typewriter|inconsolata|lucidaconsole|lucidasanstypewriter|andale|letter ?gothic|prestige|ocr-?[ab]\b|fixedsys|^(?:[A-Z]{6}\+)?(?:cmtt|sftt|lmtt|txtt|pcrr|ectt|tctt|rm-?lmtt|nimbusmon)/i;

/** What `items export --task regions-v2` records once per export (the manifest). */
export function regionsExportManifest(): Record<string, unknown> {
    return {
        format: REGIONS_EXPORT_FORMAT,
        feature_set: null,
        feature_version: null,
        primitive_fields: PRIMITIVE_FIELDS,
        line_flags: LINE_FLAG_BITS,
        v5: {
            model: REGION_MODEL?.trainedOn ?? null,
            feature_version: REGION_FEATURE_VERSION,
            features: REGION_FEATURES,
            context_pages: DEFAULT_REGION_CONTEXT_PAGES,
        },
    };
}

export interface RegionsExportPiece {
    /** `p<k>`, k in the page's structured-text order (first part's line, then its offset). */
    id: string;
    bbox: Rect;
    text: string;
    /** Inked (non-space) characters. */
    chars: number;
    /** Font setting most inked characters; "" when unknown. */
    font: string;
    /** Type size setting most inked characters. */
    size: number;
    mono: boolean;
    bold: boolean;
    italic: boolean;
    /** 0 horizontal, 90 reading down the page, 270 reading up it. */
    rot: 0 | 90 | 270;
    skewed: boolean;
    /**
     * 0-based index of its structured-text line among the page's non-blank
     * lines; a piece joined from fragments of several lines has its first
     * fragment's, and lists all of them in `sources`.
     */
    source: number;
    sources?: number[];
    /** The detector's `LINE_*` bits (`LINE_FLAG_BITS`) as production sets them. */
    flags: number;
    /**
     * Where v5 finally put the piece's text: `ROUTE_PROSE`, `ROUTE_DROPPED` (out of
     * the prose without an item, such as furniture set aside as margin text), or
     * the index in `v5.regions` of the item that took it. A piece joined from
     * fragments that went different ways gets the route of most of its ink,
     * and lists each fragment's in `v5Parts`.
     */
    v5Route: number;
    v5Parts?: { source: number; chars: number; v5Route: number }[];
}

/** [kind, x0, y0, x1, y1, rgb, curve, stroked, rect, imageHash] (`PRIMITIVE_FIELDS`). */
export type RegionsExportPrimitive = [string, number, number, number, number, number, 0 | 1, 0 | 1, 0 | 1, number];

export interface RegionsExportCandidate {
    bbox: Rect;
    anchored: boolean;
    /** In `REGION_FEATURES` order (null for a non-finite value). */
    features: (number | null)[];
    probs?: Record<string, number>;
    label?: string;
    containedIn?: number;
}

export interface RegionsExportPage {
    index: number;
    width: number;
    height: number;
    /** The page's `/Rotate`, already applied to every box. */
    rotation: number;
    /** Dominant text orientation (the reading frame production derives); not applied to boxes. */
    textRotation: number;
    bodySize: number;
    scanned: boolean;
    error?: string;
    timing: { walkMs: number; regionsMs: number };
    graphics: { records: number; overflow: boolean; incomplete: boolean };
    pieces: RegionsExportPiece[];
    primitives: RegionsExportPrimitive[];
    v5: {
        /**
         * The emitted region items (kind, public box) and their candidate: the
         * structured export's region items, in detection order.
         */
        regions: { kind: string; bbox: Rect; candidate: number }[];
        /** Candidates after classification, overlap resolution and routing (table merges). */
        candidates: RegionsExportCandidate[];
    };
}

export interface RegionsExportRow {
    format: typeof REGIONS_EXPORT_FORMAT;
    schema: string;
    feature_set: null;
    feature_version: null;
    page_count: number;
    pages: RegionsExportPage[];
}

/**
 * Collects the export pages of one structured run (`RegionPassObserver`).
 * `pages` limits the pages written; the whole document still runs.
 */
export class RegionsExportCollector implements RegionPassObserver {
    private readonly out = new Map<number, RegionsExportPage>();

    constructor(
        private readonly bboxPrecision: number,
        private readonly pages?: ReadonlySet<number>,
    ) {}

    page(pass: RegionPassPage): void {
        if (this.pages && !this.pages.has(pass.pageIndex)) return;
        this.out.set(pass.pageIndex, regionsExportPage(pass, this.bboxPrecision));
    }

    row(schema: string, pageCount: number): RegionsExportRow {
        return {
            format: REGIONS_EXPORT_FORMAT,
            schema,
            feature_set: null,
            feature_version: null,
            page_count: pageCount,
            pages: [...this.out.values()].sort((a, b) => a.index - b.index),
        };
    }
}

const ms = (v: number) => Math.round(v * 100) / 100;

export function regionsExportPage(pass: RegionPassPage, precision: number): RegionsExportPage {
    const { page, graphics, detection, result } = pass;
    const box = (r: Rect) => roundRect(r, precision);
    const items = result.items.length ? splitRegionItems(result.items, pass.regionPieces) : [];
    const pieces = detection ? exportPieces(detection, sourceLines(page), items, result.destinations, new Set(result.margin), box) : [];
    const primitives = detection
        ? pagePrimitives(graphics, page.width, page.height, detection.bodySize).map(
              (p): RegionsExportPrimitive => [
                  p.kind,
                  ...box(p.bbox),
                  p.rgb,
                  p.curve ? 1 : 0,
                  p.stroked ? 1 : 0,
                  p.rect ? 1 : 0,
                  p.imageHash,
              ],
          )
        : [];
    return {
        index: pass.pageIndex,
        width: page.width,
        height: page.height,
        rotation: page.rotation,
        textRotation: pass.textRotation,
        bodySize: detection?.bodySize ?? 0,
        scanned: detection?.scanned ?? false,
        ...(pass.error !== undefined ? { error: pass.error } : {}),
        timing: { walkMs: ms(pass.walkMs), regionsMs: ms(pass.regionsMs) },
        graphics: { records: graphics.count, overflow: graphics.overflow, incomplete: graphics.incomplete },
        pieces,
        primitives,
        v5: {
            regions: items.map((item) => ({
                kind: item.kind,
                bbox: box([item.bbox.l, item.bbox.t, item.bbox.r, item.bbox.b]),
                candidate: item.region,
            })),
            candidates: (detection?.candidates ?? []).map((c) => ({
                bbox: box(c.bbox),
                anchored: c.anchored,
                features: c.features.map((v) => (Number.isFinite(v) ? v : null)),
                ...(c.probs ? { probs: c.probs } : {}),
                ...(c.label !== undefined ? { label: c.label } : {}),
                ...(c.containedIn !== undefined ? { containedIn: c.containedIn } : {}),
            })),
        },
    };
}

/** The pieces `routeLines` routed, with their final v5 route, in structured-text order. */
function exportPieces(
    detection: RegionDetection,
    numbered: readonly RawLine[],
    items: readonly RegionItemDraft[],
    destinations: ReadonlyMap<number, number> | undefined,
    furniture: ReadonlySet<RawLine>,
    box: (r: Rect) => Rect,
): RegionsExportPiece[] {
    const routing = detection.routing;
    if (!routing) return [];
    // A region's line is in its item; furniture left the prose as margin text.
    const route = (part: RegionLine): number => {
        const region = destinations?.get(part.source);
        if (region !== undefined) return itemOf(region, part.bbox, items);
        return furniture.has(numbered[part.source - 1]) ? ROUTE_DROPPED : ROUTE_PROSE;
    };
    const rows = routing.lines.map((line, i) => {
        const parts = line.parts ?? [line];
        const routes = parts.map(route);
        const font = majorityFont(parts, numbered);
        const sources = [...new Set(parts.map((p) => p.source - 1))];
        const first = parts.reduce((a, b) => (b.source < a.source || (b.source === a.source && b.range[0] < a.range[0]) ? b : a));
        const piece: Omit<RegionsExportPiece, "id"> = {
            bbox: box(line.bbox),
            text: line.text,
            chars: line.inkChars,
            font: font.name,
            size: Math.round((line.inkSize ?? line.size) * 100) / 100,
            mono: MONO_FONT_RE.test(font.name),
            bold: font.bold,
            italic: font.italic,
            rot: line.rot,
            skewed: line.skewed === true,
            source: first.source - 1,
            ...(sources.length > 1 ? { sources } : {}),
            flags: routing.flags[i],
            v5Route: majorityRoute(parts, routes),
            ...(new Set(routes).size > 1
                ? { v5Parts: parts.map((p, k) => ({ source: p.source - 1, chars: p.inkChars, v5Route: routes[k] })) }
                : {}),
        };
        return { piece, order: [first.source, first.range[0]] };
    });
    rows.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
    return rows.map(({ piece }, k) => ({ id: `p${k}`, ...piece }));
}

/**
 * The emitted item holding text of `region` at `bbox`: the region's item, or,
 * when column detection split it into several, the one whose cells overlap the
 * text most (else whose box is nearest).
 */
function itemOf(region: number, bbox: Rect, items: readonly RegionItemDraft[]): number {
    let best = ROUTE_DROPPED;
    let bestScore = -Infinity;
    items.forEach((item, k) => {
        if (item.region !== region) return;
        let score = 0;
        for (const row of item.rows) for (const cell of row) score += overlap(bbox, cell.bbox);
        // Without overlapping cells (a figure's dropped tick labels), the nearest box.
        if (score === 0) score = -distance(bbox, item.bbox);
        if (score > bestScore) {
            best = k;
            bestScore = score;
        }
    });
    return best;
}

function overlap(r: Rect, b: { l: number; t: number; r: number; b: number }): number {
    const w = Math.min(r[2], b.r) - Math.max(r[0], b.l);
    const h = Math.min(r[3], b.b) - Math.max(r[1], b.t);
    return w > 0 && h > 0 ? w * h : 0;
}

function distance(r: Rect, b: { l: number; t: number; r: number; b: number }): number {
    const dx = Math.max(0, b.l - r[2], r[0] - b.r);
    const dy = Math.max(0, b.t - r[3], r[1] - b.b);
    return Math.hypot(dx, dy);
}

/** The route of most of the parts' ink; a tie goes to the earlier part. */
function majorityRoute(parts: readonly RegionLine[], routes: readonly number[]): number {
    if (routes.every((r) => r === routes[0])) return routes[0];
    const ink = new Map<number, number>();
    parts.forEach((p, k) => ink.set(routes[k], (ink.get(routes[k]) ?? 0) + Math.max(1, p.inkChars)));
    let best = routes[0];
    for (const [r, n] of ink) if (n > ink.get(best)!) best = r;
    return best;
}

/** Font name, weight and style setting most inked characters of the parts (their lines' font runs). */
function majorityFont(parts: readonly RegionLine[], numbered: readonly RawLine[]): { name: string; bold: boolean; italic: boolean } {
    const ink = new Map<string, { n: number; bold: boolean; italic: boolean }>();
    const add = (name: string, bold: boolean, italic: boolean, n: number) => {
        const key = `${name}\u0000${bold}\u0000${italic}`;
        const entry = ink.get(key) ?? { n: 0, bold, italic };
        entry.n += n;
        ink.set(key, entry);
    };
    for (const part of parts) {
        const line = numbered[part.source - 1] as RawLineDetailed | undefined;
        if (!line) continue;
        const chars = [...line.text];
        const runs = line.spans?.length ? line.spans : [{ start: 0, font: line.font }];
        const [a, b] = part.range;
        for (let r = 0; r < runs.length; r++) {
            const s0 = Math.max(a, runs[r].start);
            const s1 = Math.min(b, r + 1 < runs.length ? runs[r + 1].start : chars.length);
            let n = 0;
            for (let i = s0; i < s1; i++) if (chars[i] !== undefined && !/\s/.test(chars[i])) n++;
            const font = runs[r].font as { name: string; weight?: string; style?: string };
            if (n > 0) add(font.name, font.weight === "bold", font.style === "italic", n);
        }
    }
    let best = { name: parts[0]?.font ?? "", bold: false, italic: false };
    let bestN = 0;
    for (const [key, entry] of ink) {
        if (entry.n > bestN) {
            best = { name: key.slice(0, key.indexOf("\u0000")), bold: entry.bold, italic: entry.italic };
            bestN = entry.n;
        }
    }
    return best;
}
