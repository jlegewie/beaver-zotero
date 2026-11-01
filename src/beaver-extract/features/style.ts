/**
 * Typography of detected lines, read from their spans and per-glyph style
 * runs: the size and font most glyphs are set in, bold and italic shares,
 * and the size of a leading marker.
 */

import type { RawGlyphMetrics, RawStyleRun } from "@beaver/agent-core/extract/types";
import type { DetectedSpan, PageLine } from "../LineDetector";
import { isBoldFont, isItalicFont } from "../StyleAnalyzer";

/** Visible (non-whitespace) characters of a text. */
export function visibleLength(text: string): number {
    let n = 0;
    for (const ch of text) if (ch.trim() !== "") n++;
    return n;
}

function styleRuns(span: DetectedSpan): readonly RawStyleRun[] | null {
    return span.styleRuns && span.styleRuns.length > 0 ? span.styleRuns : null;
}

/** Size of the line's opening run when it is a short marker (≤ 4 glyphs). */
export function leadMarkerSize(line: PageLine): number | null {
    return leadMarkerRun(line)?.size ?? null;
}

/** The line's opening run when it is a short marker (≤ 4 glyphs): its glyphs and size. */
export function leadMarkerRun(line: PageLine): { chars: number; size: number } | null {
    for (const span of line.spans) {
        const runs = styleRuns(span);
        if (runs) {
            for (const run of runs) {
                if (run.chars === 0) continue;
                return run.chars <= 4 ? { chars: run.chars, size: run.exactSize ?? run.font.size } : null;
            }
        } else {
            const n = visibleLength(span.text);
            if (n === 0) continue;
            return n <= 4 && span.size ? { chars: n, size: span.size } : null;
        }
    }
    return null;
}

/** Font size most of a line's visible glyphs are set in. */
export function lineSize(line: PageLine): number {
    // Glyph counts per size (to the half point); lines use few sizes.
    const sizes: number[] = [];
    const counts: number[] = [];
    const add = (chars: number, size: number | undefined) => {
        if (chars <= 0) return;
        const key = Math.round((size ?? 0) * 2) / 2;
        const k = sizes.indexOf(key);
        if (k >= 0) counts[k] += chars;
        else {
            sizes.push(key);
            counts.push(chars);
        }
    };
    for (const span of line.spans) {
        const runs = styleRuns(span);
        if (runs) {
            for (const run of runs) {
                add(run.chars, run.exactSize ?? run.font.size);
            }
        } else {
            add(visibleLength(span.text), span.size);
        }
    }
    let size = line.fontSize ?? 0;
    let best = -1;
    for (let k = 0; k < sizes.length; k++) {
        if (counts[k] > best) {
            best = counts[k];
            size = sizes[k];
        }
    }
    return size;
}

/** The face of a line's glyphs (`lineFace`). */
export interface LineFace {
    /** Font most visible glyphs are set in ("" when unknown). */
    font: string;
    /** Share of visible glyphs set bold, 0–1. */
    bold: number;
    /** Share of visible glyphs set italic, 0–1. */
    italic: number;
}

/** Font, bold and italic shares of a line, weighted by visible glyphs. */
export function lineFace(line: PageLine): LineFace {
    const fonts = new Map<string, number>();
    let total = 0;
    let bold = 0;
    let italic = 0;
    const add = (chars: number, name: string | undefined, weight: string | undefined, style: string | undefined) => {
        if (chars <= 0) return;
        const font = name ?? "";
        fonts.set(font, (fonts.get(font) ?? 0) + chars);
        total += chars;
        if (isBoldFont(font, weight)) bold += chars;
        if (isItalicFont(font, style)) italic += chars;
    };
    for (const span of line.spans) {
        const runs = styleRuns(span);
        if (runs) {
            for (const run of runs) add(run.chars, run.font.name, run.font.weight, run.font.style);
        } else {
            add(visibleLength(span.text), span.fontName, span.fontWeight, span.fontStyle);
        }
    }
    let font = "";
    let best = 0;
    for (const [name, chars] of fonts) {
        if (chars > best) {
            best = chars;
            font = name;
        }
    }
    return total > 0 ? { font, bold: bold / total, italic: italic / total } : { font, bold: 0, italic: 0 };
}

/** Vertical metrics of the glyphs set in a line's dominant size (`lineGeometry`). */
export interface LineGeometry {
    /** Median glyph origin: the baseline. */
    baseline: number;
    /** Median ascent edge of those glyphs. */
    coreTop: number;
    /** Median descent edge of those glyphs. */
    coreBottom: number;
}

/**
 * Baseline and core of a line, from the glyphs set in its dominant size
 * (`lineSize`, or `dominantSize` when the caller has it), in the line's frame. Taller glyphs merged into the line
 * (inline math, sub- and superscripts) widen its box but not its core. Each
 * source line records the median per size; spans of the same size combine as
 * a median weighted by their glyphs. Null without recorded metrics (no
 * per-glyph walk) or when no glyph has the dominant size.
 */
export function lineGeometry(line: PageLine, dominantSize?: number): LineGeometry | null {
    let parts: RawGlyphMetrics[] | null = null;
    let size = dominantSize ?? NaN;
    for (const span of line.spans) {
        if (!span.glyphMetrics) continue;
        if (Number.isNaN(size)) size = lineSize(line);
        for (const m of span.glyphMetrics) {
            if (m.size === size && m.glyphs > 0) (parts ??= []).push(m);
        }
    }
    if (!parts) return null;
    if (parts.length === 1) return { baseline: parts[0].baseline, coreTop: parts[0].top, coreBottom: parts[0].bottom };
    let total = 0;
    for (const p of parts) total += p.glyphs;
    const weighted = (pick: (p: RawGlyphMetrics) => number) => {
        const sorted = parts!.slice().sort((a, b) => pick(a) - pick(b));
        let seen = 0;
        for (const p of sorted) {
            seen += p.glyphs;
            if (2 * seen >= total) return pick(p);
        }
        return pick(sorted[sorted.length - 1]);
    };
    return { baseline: weighted((p) => p.baseline), coreTop: weighted((p) => p.top), coreBottom: weighted((p) => p.bottom) };
}
