/**
 * Page signals for region detection: text lines (from the structured-text walk)
 * and typed drawing primitives (from the MuPDF graphics summary).
 */
import type { RawLine, RawLineDetailed, RawPageData } from "@beaver/agent-core/extract/types";

import { GRAPHICS_SUMMARY_STRIDE, GS_FIELD, GS_FLAG, GS_KIND, type GraphicsSummary } from "../worker/graphicsSummary";
import type { Rect } from "./geometry";

/** "Supplementary Figure 2", "Extended Data Fig. 3", "Appendix Table A1". */
const CAPTION_PREFIX = String.raw`(?:supp(?:lementary)?\.?\s+|extended\s+data\s+|appendix\s+|online\s+)?`;
/**
 * The caption number after the keyword: digits ("2", "3.1", "S2", "2a"), an
 * upper-case Roman numeral ("IV") or a letter ("A", "A.3"); then punctuation,
 * a space or the end of the piece ("Table 2" alone).
 */
const CAPTION_NUMBER = String.raw`\s*(?:[A-Z]?\d+[a-z]?(?:[.\-–]\d+)*|[IVXLC]+|[A-Z](?:\.\d+)*)(?:[.:\s\-–—]|$)`;
/**
 * Case-sensitive check of the number, so "Tablet …" or "Figures show …" are
 * not captions.
 */
const CAPTION_NUMBER_RE = new RegExp("^" + CAPTION_NUMBER);

/**
 * A caption keyword, matched case-insensitively. The trailing number lookahead
 * makes the alternation backtrack to a longer keyword that shares a prefix
 * ("Tableau 1" past "Table", "Graphique 1" past "Graph", "Figura 1" past "Fig").
 */
function captionKeywordRe(keywords: string): RegExp {
    return new RegExp(String.raw`^\s*` + CAPTION_PREFIX + keywords + `(?=${CAPTION_NUMBER})`, "i");
}

const FIGURE_KEYWORD_RE = captionKeywordRe(
    String.raw`(?:fig(?:ure)?s?\.?|chart|graph|map|exhibit|diagram|plate|illustration|scheme|photo(?:graph)?|video|movie|box|abb(?:ildung|\.)|grafik|graphique|gr[áa]fico|figura|рис(?:унок|\.)|图|圖|그림)`,
);
const TABLE_KEYWORD_RE = captionKeywordRe(String.raw`(?:table|tab\.|tabelle|tableau|tabla|表|표)`);

function captionMatch(keyword: RegExp, text: string): boolean {
    const m = keyword.exec(text);
    return m !== null && CAPTION_NUMBER_RE.test(text.slice(m[0].length));
}

export function isFigureCaption(text: string): boolean {
    return captionMatch(FIGURE_KEYWORD_RE, text);
}

export function isTableCaption(text: string): boolean {
    return captionMatch(TABLE_KEYWORD_RE, text);
}

/**
 * Notes, sources and credits under a figure or table ("Note.", "Source:",
 * "* p < .05"); the label policy counts them as captions.
 */
export const NOTE_CAPTION_RE =
    /^\s*(?:(?:general\s+)?notes?|sources?|credits?|abbreviations?|legend|data\s+source|注|资料来源|数据来源)\s*[:.：]|^\s*[*†‡§]\s*\S/i;
export const NUMERIC_RE = /^[\s\d.,\-–−+%()*<>=±$€/:;a-zA-Z]{0,3}\d[\d.,\-–−+%()*<>=±$€/:;\s]*$/;

/**
 * A right-aligned equation number such as "(12)", "(A.3)", "(2b)" or "[4]"
 * standing alone on its line.
 */
export const EQUATION_NUMBER_RE = /^[(（[]\s*[A-Z]{0,3}[.-]?\d{1,3}(?:[.\-–]\d{1,3})*[a-z]?\s*[)）\]]$/;

/** Fonts whose glyphs are mathematics (TeX math families, OpenType math, Symbol). */
const MATH_FONT_RE =
    /^(?:[A-Z]{6}\+)?(?:CM(?:MI|SY|EX|BSY|MIB)|MSAM|MSBM|EUFM|EUSM|EUEX|RSFS|STIX|XITS|LMMath|LatinModernMath|Asana|Euclid|MTMI|MTSY|MTEX|MathematicalPi|Mathematica|Symbol|.*Math|.*MT ?Extra|txsy|txex|pxsy|pxex|txmi|pxmi|NewCM.*Math)/i;

/** Mathematical symbols: Greek, operators, arrows, letterlike and math alphanumerics. */
const MATH_CHAR_RE = /[\u0391-\u03c9\u2190-\u21ff\u2200-\u22ff\u2A00-\u2AFF\u27C0-\u27EF\u2100-\u214F=<>±×÷∞√∑∏∫∂∇′″]|[\u{1D400}-\u{1D7FF}]/u;

export interface RegionLine {
    bbox: Rect;
    text: string;
    size: number;
    /**
     * Reading direction of vertical text: 90 reads down the page (also vertical
     * writing mode), 270 reads up it; 0 for horizontal text.
     */
    rot: 0 | 90 | 270;
    /**
     * Horizontal text set upside down (rotated 180 degrees). Its `rot` is 0, as
     * detection treats it like any horizontal line; only reading order differs.
     */
    turned?: true;
    /** Whitespace-separated words; each two CJK characters count as one word. */
    words: number;
    nchar: number;
    /** Words of at least three letters, each two CJK characters counting as one (running text has many). */
    alphaWords: number;
    /** Non-space characters set in a math font or that are math symbols. */
    mathChars: number;
    /** Non-space characters. */
    inkChars: number;
    /** Smallest and largest font size on the line (font runs; else `size`). */
    minSize: number;
    maxSize: number;
    /** The line is only an equation number. */
    eqNumber: boolean;
    /**
     * 1-based index of the structured-text line this piece was split from (among
     * its non-blank lines, see `sourceLines`), and that line's piece count.
     */
    source: number;
    pieces: number;
    /** Character range [start, end) of the piece in its source line's text. */
    range: [number, number];
    /** The pieces `mergeRowFragments` joined into this line; absent for a single piece. */
    parts?: RegionLine[];
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
const ALPHA_WORD_RE = /^[\p{L}][\p{L}'’-]{2,}[.,;:!?)]*$/u;

/** Words of at least three letters; each two CJK characters count as one. */
function alphaWordCount(text: string): number {
    const cjk = text.match(CJK_RE)?.length ?? 0;
    return text.split(/\s+/).filter((w) => ALPHA_WORD_RE.test(w)).length + Math.floor(cjk / 2);
}

function wordCount(text: string): number {
    const cjk = text.match(CJK_RE)?.length ?? 0;
    return text.split(/\s+/).length + Math.floor(cjk / 2);
}

const mathFontCache = new Map<string, boolean>();
function isMathFont(name: string): boolean {
    let v = mathFontCache.get(name);
    if (v === undefined) {
        v = MATH_FONT_RE.test(name);
        mathFontCache.set(name, v);
    }
    return v;
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

type FontRun = { start: number; font: { name: string; size: number } };

/** Math and size statistics of chars [a, b) of a line, from its font runs. */
function rangeMath(chars: readonly string[], runs: readonly FontRun[], a: number, b: number) {
    let math = 0;
    let ink = 0;
    let minSize = Infinity;
    let maxSize = 0;
    for (let r = 0; r < runs.length; r++) {
        const s0 = Math.max(a, runs[r].start);
        const s1 = Math.min(b, r + 1 < runs.length ? runs[r + 1].start : chars.length);
        if (s0 >= s1) continue;
        const mathFont = isMathFont(runs[r].font.name);
        let runInk = 0;
        for (let i = s0; i < s1; i++) {
            const c = chars[i];
            if (c === undefined || /\s/.test(c)) continue;
            runInk++;
            if (mathFont || MATH_CHAR_RE.test(c)) math++;
        }
        ink += runInk;
        if (runInk > 0 && runs[r].font.size > 0) {
            minSize = Math.min(minSize, runs[r].font.size);
            maxSize = Math.max(maxSize, runs[r].font.size);
        }
    }
    return { math, ink, minSize, maxSize };
}

/** Gap (in em) between two inked characters that splits a line into separate pieces. */
const SPLIT_GAP_EM = 2;

/**
 * Character ranges of a horizontal line separated by wide gaps: an equation and
 * its number, or table cells that MuPDF set on one line.
 */
function linePieces(line: RawLineDetailed, chars: readonly string[], em: number): [number, number][] {
    const pieces: [number, number][] = [];
    let start = 0;
    let prevRight = -Infinity;
    for (let i = 0; i < line.chars.length; i++) {
        if (/\s/.test(chars[i] ?? " ")) continue;
        const b = line.chars[i].bbox;
        if (prevRight !== -Infinity && b.l - prevRight > SPLIT_GAP_EM * em && i > start) {
            pieces.push([start, i]);
            start = i;
        }
        prevRight = prevRight === -Infinity ? b.r : Math.max(prevRight, b.r);
    }
    pieces.push([start, line.chars.length]);
    return pieces;
}

/** The structured-text lines that `RegionLine.source` numbers (1-based), in page order. */
export function sourceLines(page: RawPageData): RawLine[] {
    const out: RawLine[] = [];
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) if (line.text.trim()) out.push(line);
    }
    return out;
}

export function pageLines(page: RawPageData): RegionLine[] {
    const lines: RegionLine[] = [];
    let source = 0;
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            if (!line.text.trim()) continue;
            const rot = line.rotation === 270 ? 270 : line.wmode === 1 || line.rotation === 90 ? 90 : 0;
            const detailed = line as RawLineDetailed;
            const chars = [...line.text];
            const runs: FontRun[] = detailed.spans?.length ? detailed.spans : [{ start: 0, font: line.font }];
            // Some PDFs set text in a 0-size font scaled by the text matrix: the line
            // height is then the only size there is.
            const height = rot ? line.bbox.r - line.bbox.l : line.bbox.b - line.bbox.t;
            const size = line.font.size > 0 ? line.font.size : Math.max(1, Math.round(height));
            const pieces: [number, number][] =
                !rot && detailed.chars?.length === chars.length
                    ? linePieces(detailed, chars, Math.max(1, size))
                    : [[0, chars.length]];
            source++;
            for (const [a, b] of pieces) {
                const text = chars.slice(a, b).join("").trim();
                if (!text) continue;
                let bbox: Rect = [line.bbox.l, line.bbox.t, line.bbox.r, line.bbox.b];
                if (pieces.length > 1) {
                    bbox = [Infinity, Infinity, -Infinity, -Infinity];
                    for (let i = a; i < b; i++) {
                        if (/\s/.test(chars[i])) continue;
                        const cb = detailed.chars[i].bbox;
                        bbox = [Math.min(bbox[0], cb.l), Math.min(bbox[1], cb.t), Math.max(bbox[2], cb.r), Math.max(bbox[3], cb.b)];
                    }
                }
                const m = rangeMath(chars, runs, a, b);
                lines.push({
                    bbox,
                    text,
                    size,
                    rot,
                    ...(line.rotation === 180 ? { turned: true as const } : {}),
                    words: wordCount(text),
                    nchar: text.length,
                    alphaWords: alphaWordCount(text),
                    mathChars: m.math,
                    inkChars: m.ink,
                    minSize: m.minSize === Infinity ? size : m.minSize,
                    maxSize: m.maxSize || size,
                    eqNumber: EQUATION_NUMBER_RE.test(text),
                    source,
                    pieces: pieces.length,
                    range: [a, b],
                });
            }
        }
    }
    return lines;
}

/** Pieces on one row closer than this many em are words of one line. */
const WORD_GAP_EM = 0.6;
/** Justified word spacing stays below this many em. */
const JUSTIFIED_GAP_EM = 1.6;

/**
 * Join horizontal pieces that are words of one visual line: some PDFs set every
 * word (or word group) as its own text line, which would hide prose from every
 * rule that looks at whole lines. Pieces join when they share a row (most of
 * their height) and sit at most a word space apart, or, in a row of words, at
 * justified spacing (even gaps close to the row's median gap). Table cells,
 * column gutters, equation numbers and sub/superscripts stay separate, and so do
 * pieces with a vertical rule or cell border between them (ruled tables).
 */
export function mergeRowFragments(lines: RegionLine[], prims: readonly Primitive[]): RegionLine[] {
    // Vertical separators as [x, y0, y1]: rules and the side edges of rectangles.
    const separators: [number, number, number][] = [];
    for (const p of prims) {
        if (p.kind === "vrule") separators.push([(p.bbox[0] + p.bbox[2]) / 2, p.bbox[1], p.bbox[3]]);
        else if (p.rect && p.kind !== "bg" && p.kind !== "white") {
            separators.push([p.bbox[0], p.bbox[1], p.bbox[3]], [p.bbox[2], p.bbox[1], p.bbox[3]]);
        }
    }
    const separated = (a: RegionLine, b: RegionLine) => {
        const cy = (a.bbox[1] + a.bbox[3] + b.bbox[1] + b.bbox[3]) / 4;
        return separators.some(([x, y0, y1]) => x > a.bbox[2] - 1 && x < b.bbox[0] + 1 && y0 <= cy && y1 >= cy);
    };
    const upright = lines.filter((l) => !l.rot).sort((a, b) => a.bbox[1] + a.bbox[3] - (b.bbox[1] + b.bbox[3]));
    const rows: RegionLine[][] = [];
    for (const l of upright) {
        const h = l.bbox[3] - l.bbox[1];
        const cy = (l.bbox[1] + l.bbox[3]) / 2;
        let row: RegionLine[] | undefined;
        for (let k = rows.length - 1; k >= 0 && k >= rows.length - 3; k--) {
            const ref = rows[k][0];
            const overlap = Math.min(ref.bbox[3], l.bbox[3]) - Math.max(ref.bbox[1], l.bbox[1]);
            if (Math.abs((ref.bbox[1] + ref.bbox[3]) / 2 - cy) <= 0.35 * h && overlap >= 0.6 * Math.min(h, ref.bbox[3] - ref.bbox[1])) {
                row = rows[k];
                break;
            }
        }
        if (row) row.push(l);
        else rows.push([l]);
    }
    const out: RegionLine[] = lines.filter((l) => l.rot);
    for (const row of rows) {
        row.sort((a, b) => a.bbox[0] - b.bbox[0]);
        const gaps = row.slice(1).map((l, i) => l.bbox[0] - row[i].bbox[2]);
        const sortedGaps = [...gaps].sort((a, b) => a - b);
        const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;
        const wordRow =
            row.length >= 3 &&
            row.filter((l) => l.alphaWords >= 1 && l.mathChars <= 0.2 * l.inkChars).length >= 0.7 * row.length;
        let cur = row[0];
        for (let i = 1; i < row.length; i++) {
            const next = row[i];
            const em = Math.max(1, Math.max(cur.size, next.size));
            const gap = gaps[i - 1];
            const wordGap =
                gap <= WORD_GAP_EM * em ||
                (wordRow && gap <= JUSTIFIED_GAP_EM * em && gap <= 1.5 * medianGap + 1);
            if (wordGap && gap >= -em && !cur.eqNumber && !next.eqNumber && !separated(cur, next)) {
                const text = `${cur.text} ${next.text}`;
                cur = {
                    ...cur,
                    bbox: [cur.bbox[0], Math.min(cur.bbox[1], next.bbox[1]), Math.max(cur.bbox[2], next.bbox[2]), Math.max(cur.bbox[3], next.bbox[3])],
                    text,
                    size: next.nchar > cur.nchar ? next.size : cur.size,
                    words: cur.words + next.words,
                    nchar: cur.nchar + next.nchar + 1,
                    alphaWords: cur.alphaWords + next.alphaWords,
                    mathChars: cur.mathChars + next.mathChars,
                    inkChars: cur.inkChars + next.inkChars,
                    minSize: Math.min(cur.minSize, next.minSize),
                    maxSize: Math.max(cur.maxSize, next.maxSize),
                    eqNumber: false,
                    pieces: 1,
                    parts: [...(cur.parts ?? [cur]), next],
                };
            } else {
                out.push(cur);
                cur = next;
            }
        }
        out.push(cur);
    }
    return out;
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
    return isFigureCaption(l.text) || isTableCaption(l.text) || NOTE_CAPTION_RE.test(l.text);
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
            // A long, thin image is a rule drawn as a bitmap (column separators, header lines).
            if (Math.max(w, h) >= 25 * Math.min(w, h) && (w >= 0.3 * pageWidth || h >= 0.3 * pageHeight)) {
                kind = w >= h ? "hrule" : "vrule";
            } else {
                kind = "image";
            }
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
