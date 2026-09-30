/**
 * Page signals for region detection: text lines (from the structured-text walk)
 * and typed drawing primitives (from the MuPDF graphics summary).
 */
import type { RawPageData } from "@beaver/agent-core/extract/types";

import { GRAPHICS_SUMMARY_STRIDE, GS_FIELD, GS_FLAG, GS_KIND, type GraphicsSummary } from "../worker/graphicsSummary";
import type { Rect } from "./geometry";

export const FIGURE_CAPTION_RE =
    /^\s*(fig(ure)?s?\.?|chart|graph|map|exhibit|diagram|plate|illustration|scheme|photo(graph)?|abb(ildung|\.)|grafik|graphique|gr[áa]fico|figura|рис(унок|\.)|图|圖|그림)\s*[\dIVXA-Z]+[.:\s\-–—]/i;
export const TABLE_CAPTION_RE = /^\s*(table|tab\.|tabelle|tableau|tabla|表|표)\s*[\dIVXA-Z]+[.:\s\-–—]/i;
export const NUMERIC_RE = /^[\s\d.,\-–−+%()*<>=±$€/:;a-zA-Z]{0,3}\d[\d.,\-–−+%()*<>=±$€/:;\s]*$/;

export interface RegionLine {
    bbox: Rect;
    text: string;
    size: number;
    /** Vertical writing direction (rotated 90/270 or vertical writing mode). */
    rot: boolean;
    /** Whitespace-separated words; each two CJK characters count as one word. */
    words: number;
    nchar: number;
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

function wordCount(text: string): number {
    const cjk = text.match(CJK_RE)?.length ?? 0;
    return text.split(/\s+/).length + Math.floor(cjk / 2);
}

export type PrimitiveKind =
    | "image" | "mark" | "glyph" | "pixel" | "hrule" | "vrule" | "box" | "white" | "bg";

export interface Primitive {
    bbox: Rect;
    kind: PrimitiveKind;
    /** 0xRRGGBB, or -1 when the primitive has no colour (images, shadings). */
    rgb: number;
    curve: boolean;
    stroked: boolean;
    /** The path is a single axis-aligned rectangle. */
    rect: boolean;
    /** 24-bit image data hash (images), 0 otherwise. */
    imageHash: number;
}

export function pageLines(page: RawPageData): RegionLine[] {
    const lines: RegionLine[] = [];
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            const text = line.text.trim();
            if (!text) continue;
            const b = line.bbox;
            lines.push({
                bbox: [b.l, b.t, b.r, b.b],
                text,
                size: line.font.size,
                rot: line.wmode === 1 || line.rotation === 90 || line.rotation === 270,
                words: wordCount(text),
                nchar: text.length,
            });
        }
    }
    return lines;
}

/** Character-weighted mode of horizontal line font sizes (0.5pt bins). */
export function bodySize(lines: readonly RegionLine[]): number {
    const counts = new Map<number, number>();
    for (const l of lines) {
        if (l.rot) continue;
        const k = Math.round(l.size * 2) / 2;
        counts.set(k, (counts.get(k) ?? 0) + l.nchar);
    }
    let best = 10;
    let bestCount = -1;
    for (const [size, n] of counts) {
        if (n > bestCount && size > 0) {
            best = size;
            bestCount = n;
        }
    }
    return best;
}

export function isProse(l: RegionLine, bs: number): boolean {
    return (
        !l.rot &&
        l.words >= 6 &&
        Math.abs(l.size - bs) <= Math.max(0.8, 0.12 * bs) &&
        !NUMERIC_RE.test(l.text)
    );
}

export function isCaptionLine(l: RegionLine): boolean {
    return FIGURE_CAPTION_RE.test(l.text) || TABLE_CAPTION_RE.test(l.text);
}

/** Fainter primitives (alpha out of 255) are watermarks or invisible helpers, not content. */
const MIN_VISIBLE_ALPHA = 32;

function isWhite(rgb: number): boolean {
    return ((rgb >> 16) & 255) >= 240 && ((rgb >> 8) & 255) >= 240 && (rgb & 255) >= 240;
}

/** Typed primitives from the graphics summary (near-invisible primitives and tiny images dropped). */
export function pagePrimitives(g: GraphicsSummary, pageWidth: number, pageHeight: number, bs: number): Primitive[] {
    const out: Primitive[] = [];
    const pageArea = pageWidth * pageHeight;
    const r = g.records;
    for (let o = 0; o < g.count * GRAPHICS_SUMMARY_STRIDE; o += GRAPHICS_SUMMARY_STRIDE) {
        const kindCode = r[o + GS_FIELD.kind];
        if (r[o + GS_FIELD.alpha] < MIN_VISIBLE_ALPHA) continue;
        const bbox: Rect = [r[o + GS_FIELD.x0], r[o + GS_FIELD.y0], r[o + GS_FIELD.x1], r[o + GS_FIELD.y1]];
        const w = bbox[2] - bbox[0];
        const h = bbox[3] - bbox[1];
        const flags = r[o + GS_FIELD.flags];
        const curve = (flags & GS_FLAG.hasCurve) !== 0;
        const isRect = (flags & GS_FLAG.isRect) !== 0;
        const rgb = r[o + GS_FIELD.rgb];
        let kind: PrimitiveKind;
        if (kindCode === GS_KIND.image || kindCode === GS_KIND.imageMask) {
            if (w < 6 || h < 6) continue;
            kind = "image";
        } else if (w * h > 0.6 * pageArea) {
            kind = "bg";
        } else if (kindCode === GS_KIND.shade) {
            kind = "mark";
        } else if (kindCode === GS_KIND.fillPath && isWhite(rgb)) {
            kind = "white";
        } else if (kindCode === GS_KIND.fillPath && isRect && Math.max(w, h) <= 2.2) {
            kind = "pixel"; // rect runs and dots: vectorised bitmaps, dotted leaders
        } else if (Math.min(w, h) <= 2 && Math.max(w, h) > 3 * bs && !curve) {
            kind = w >= h ? "hrule" : "vrule";
        } else if (kindCode === GS_KIND.fillPath && h <= 1.8 * bs && w <= 2.5 * bs && r[o + GS_FIELD.segments] >= 4) {
            kind = "glyph"; // glyph outlines drawn as paths
        } else if (kindCode === GS_KIND.fillPath && isRect && w > 6 * bs && h > 2 * bs) {
            kind = "box";
        } else {
            kind = "mark";
        }
        out.push({
            bbox,
            kind,
            rgb: kindCode === GS_KIND.image || kindCode === GS_KIND.shade ? -1 : rgb,
            curve,
            stroked: kindCode === GS_KIND.strokePath,
            rect: isRect,
            imageHash: kindCode === GS_KIND.image || kindCode === GS_KIND.imageMask ? r[o + GS_FIELD.imageHash] : 0,
        });
    }
    if (g.grid) out.push(...overflowMarks(g));
    return out;
}

/**
 * Primitives past the record cap survive only as grid counts; each horizontal
 * run of occupied cells becomes one coarse mark so dense drawings still form
 * candidates.
 */
function overflowMarks(g: GraphicsSummary): Primitive[] {
    const n = g.gridSize;
    const [ax0, ay0, ax1, ay1] = g.area;
    const cw = (ax1 - ax0) / n;
    const ch = (ay1 - ay0) / n;
    const out: Primitive[] = [];
    for (let row = 0; row < n; row++) {
        let start = -1;
        for (let col = 0; col <= n; col++) {
            const occupied = col < n && g.grid![row * n + col] > 0;
            if (occupied && start < 0) start = col;
            if (!occupied && start >= 0) {
                out.push({
                    bbox: [ax0 + start * cw, ay0 + row * ch, ax0 + col * cw, ay0 + (row + 1) * ch],
                    kind: "mark",
                    rgb: -1,
                    curve: false,
                    stroked: false,
                    rect: false,
                    imageHash: 0,
                });
                start = -1;
            }
        }
    }
    return out;
}
