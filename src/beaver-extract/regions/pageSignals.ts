/**
 * Page signals for region detection: text lines (from the structured-text walk)
 * and typed drawing primitives (from the MuPDF graphics summary).
 */
import type { RawLine, RawLineDetailed, RawPageData } from "@beaver/agent-core/extract/types";

import { GRAPHICS_SUMMARY_STRIDE, GS_FIELD, GS_FLAG, GS_KIND, type GraphicsSummary } from "../worker/graphicsSummary";
import { UnionFind } from "./cluster";
import { unionRect, type Rect } from "./geometry";

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
/** An equation number (`EQUATION_NUMBER_RE`) that ends a line's text, as in "x = y (B.2)". */
export const EQUATION_NUMBER_END_RE = new RegExp(`(?:^|\\s)${EQUATION_NUMBER_RE.source.slice(1, -1)}\\s*[.,;:]?\\s*$`);
/**
 * Trailing equation numbers that a sentence refers to: "given by Eq. (8)", "(70) and (71).",
 * "using Equation (4) [28]:".
 */
export const EQUATION_REFERENCE_END_RE = new RegExp(
    `\\b(?:eqs?|equations?|formulas?|formulae|expressions?|relations?|and|or|to|in|of|from|by|see)\\.?(?:\\s*,?\\s*${EQUATION_NUMBER_RE.source.slice(1, -1)})+\\s*[.,;:]?\\s*$`,
    "iu",
);

/** Fonts whose glyphs are mathematics (TeX math families, OpenType math, Symbol). */
const MATH_FONT_RE =
    /^(?:[A-Z]{6}\+)?(?:CM(?:MI|SY|EX|BSY|MIB)|MSAM|MSBM|EUFM|EUSM|EUEX|RSFS|STIX|XITS|LMMath|LatinModernMath|Asana|Euclid|MTMI|MTSY|MTEX|MathematicalPi|Mathematica|Symbol|.*Math|.*MT ?Extra|txsy|txex|pxsy|pxex|txmi|pxmi|NewCM.*Math)/i;

/** A relation sign: what separates the sides of an equation. */
const RELATION_CHAR_RE = /[=≤≥<>≈≡∝≠≃≅∼]/;
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
    /**
     * Largest type size of a relation sign (=, ≤, …) on the line, when it has one: a
     * relation set smaller than the line's text is in a script (a sum's limit "i=1").
     */
    relationSize?: number;
    /**
     * Horizontal spans of what takes limits on the line: a big operator (∑, ∫, …) or an
     * operator name ("lim sup", "arg max"). Limits are set centred under or over them.
     */
    limitSpans?: [number, number][];
    /**
     * Type size setting most of the line's inked characters (font runs; else `size`, which
     * is the size of the line's first character: an enlarged ∑ opening an equation).
     */
    inkSize?: number;
    /** Name of the font setting most of the line's characters, when known. */
    font?: string;
    /** Smallest and largest font size on the line (font runs; else `size`). */
    minSize: number;
    maxSize: number;
    /** The line is only an equation number. */
    eqNumber: boolean;
    /**
     * Text set at an angle (neither horizontal nor vertical, see `isSkewed`):
     * its box says nothing about the layout. A diagonal watermark's box spans
     * most of the page.
     */
    skewed?: true;
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
    /**
     * Gaps wider than a word space between inked characters of the piece, as [x0, x1]
     * (`wideGaps` adds those between joined pieces): where table cells that MuPDF set on
     * one line meet.
     */
    gaps?: [number, number][];
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
const ALPHA_WORD_RE = /^[\p{L}][\p{L}'’-]{2,}[.,;:!?)]*$/u;

/** A letter or digit. */
const TEXT_CHAR_RE = /[\p{L}\p{N}]/u;

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
function rangeMath(
    chars: readonly string[],
    runs: readonly FontRun[],
    a: number,
    b: number,
    textFont: string | undefined,
    size: number,
) {
    let math = 0;
    let ink = 0;
    let minSize = Infinity;
    let maxSize = 0;
    let relationSize = 0;
    // Ink per type size, for the size setting most of the range.
    const sizeInk = new Map<number, number>();
    // Ink per font name: a line can return to its font after an emphasized span.
    const fontInk = new Map<string, number>();
    for (let r = 0; r < runs.length; r++) {
        const s0 = Math.max(a, runs[r].start);
        const s1 = Math.min(b, r + 1 < runs.length ? runs[r + 1].start : chars.length);
        if (s0 >= s1) continue;
        const mathFont = runs[r].font.name !== textFont && isMathFont(runs[r].font.name);
        let runInk = 0;
        for (let i = s0; i < s1; i++) {
            const c = chars[i];
            if (c === undefined || /\s/.test(c)) continue;
            runInk++;
            if (mathFont || MATH_CHAR_RE.test(c)) math++;
            if (RELATION_CHAR_RE.test(c)) relationSize = Math.max(relationSize, runs[r].font.size > 0 ? runs[r].font.size : size);
        }
        ink += runInk;
        if (runInk > 0 && runs[r].font.name) fontInk.set(runs[r].font.name, (fontInk.get(runs[r].font.name) ?? 0) + runInk);
        if (runInk > 0) {
            const runSize = runs[r].font.size > 0 ? runs[r].font.size : size;
            sizeInk.set(runSize, (sizeInk.get(runSize) ?? 0) + runInk);
        }
        if (runInk > 0 && runs[r].font.size > 0) {
            minSize = Math.min(minSize, runs[r].font.size);
            maxSize = Math.max(maxSize, runs[r].font.size);
        }
    }
    let font: string | undefined;
    let best = 0;
    for (const [name, n] of fontInk) {
        if (n > best) {
            font = name;
            best = n;
        }
    }
    let inkSize = size;
    let inkBest = 0;
    for (const [s, n] of sizeInk) {
        if (n > inkBest || (n === inkBest && s > inkSize)) {
            inkSize = s;
            inkBest = n;
        }
    }
    return { math, ink, minSize, maxSize, font, relationSize, inkSize };
}

/** A big operator: its limits are set in script size under or over it. */
const BIG_OPERATOR_RE = /[∑∏∐∫∬∭∮⋀⋁⋂⋃⨀⨁⨂⨄⨆]/u;
/** An operator name that takes limits. */
const OPERATOR_NAME_RE = /^(?:lim|sup|inf|max|min|arg|limsup|liminf|argmax|argmin)$/u;
/** Operator names this many em apart or closer are one ("lim sup", "arg max"). */
const OPERATOR_GAP_EM = 0.6;

/** Spans of chars [a, b) of a horizontal line that take limits (`RegionLine.limitSpans`). */
function limitSpans(line: RawLineDetailed, chars: readonly string[], a: number, b: number, em: number): [number, number][] {
    const spans: [number, number][] = [];
    const add = (x0: number, x1: number) => {
        const last = spans[spans.length - 1];
        if (last && x0 - last[1] <= OPERATOR_GAP_EM * em) last[1] = Math.max(last[1], x1);
        else spans.push([x0, x1]);
    };
    let word = "";
    let start = -1;
    const endWord = (end: number) => {
        if (start >= 0 && OPERATOR_NAME_RE.test(word)) add(line.chars[start].bbox.l, line.chars[end - 1].bbox.r);
        word = "";
        start = -1;
    };
    for (let i = a; i < b; i++) {
        const c = chars[i] ?? " ";
        if (/\p{L}/u.test(c)) {
            if (start < 0) start = i;
            word += c;
            continue;
        }
        endWord(i);
        if (BIG_OPERATOR_RE.test(c)) add(line.chars[i].bbox.l, line.chars[i].bbox.r);
    }
    endWord(b);
    return spans;
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

/** Gaps of at least `min` between consecutive inked characters in [a, b) of a horizontal line. */
function innerGaps(line: RawLineDetailed, chars: readonly string[], a: number, b: number, min: number): [number, number][] {
    const gaps: [number, number][] = [];
    let prevRight = -Infinity;
    for (let i = a; i < b; i++) {
        if (/\s/.test(chars[i] ?? " ")) continue;
        const box = line.chars[i].bbox;
        if (prevRight !== -Infinity && box.l - prevRight >= min) gaps.push([prevRight, box.l]);
        prevRight = Math.max(prevRight === -Infinity ? box.r : prevRight, box.r);
    }
    return gaps;
}

/** A line's gaps wider than a word space: its pieces' own (`RegionLine.gaps`) and those between them. */
export function wideGaps(line: RegionLine): [number, number][] {
    if (!line.parts) return line.gaps ?? [];
    return line.parts.flatMap((p, k) => [...(k > 0 ? [[line.parts![k - 1].bbox[2], p.bbox[0]] as [number, number]] : []), ...(p.gaps ?? [])]);
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

/** Character centres drifting across the line by this many character heights: set at an angle. */
const SKEW_DRIFT = 1.5;
/** A step between characters drifts when it moves this many character heights across the line. */
const SKEW_STEP = 0.05;
/** Angled text drifts on at least this share of its steps between characters. */
const SKEW_STEADY = 0.8;
/** Without character boxes: a line's box this many times its type size across. */
const SKEW_RATIO = 3;

/**
 * Text set at an angle: from its first to its last inked character, the
 * character centres drift across the line's direction by more than a
 * character's height (horizontal text stays on its baseline, sub- and
 * superscripts aside), steadily from one character to the next while also
 * advancing along the line (a tall delimiter built from stacked glyph pieces
 * only drifts; a fraction set as one line jumps between levels). Font sizes
 * can be wrong (fonts scaled by the text matrix), so character boxes decide; a
 * line without them falls back to its box against its type size.
 */
function isSkewed(
    line: RawLineDetailed,
    chars: readonly string[],
    a: number,
    b: number,
    rot: 0 | 90 | 270,
    bbox: Rect,
    typeSize: number,
): boolean {
    if (b - a < 2) return false;
    if (line.chars?.length !== chars.length) {
        const across = rot ? bbox[2] - bbox[0] : bbox[3] - bbox[1];
        return across > SKEW_RATIO * typeSize;
    }
    // First and last inked characters.
    let first = a;
    while (first < b && /\s/.test(chars[first])) first++;
    let last = b - 1;
    while (last > first && /\s/.test(chars[last])) last--;
    if (first >= last) return false;
    const f = line.chars[first].bbox;
    const l = line.chars[last].bbox;
    const across = (c: typeof f) => (rot ? (c.l + c.r) / 2 : (c.t + c.b) / 2);
    const along = (c: typeof f) => (rot ? (c.t + c.b) / 2 : (c.l + c.r) / 2);
    const extent = (c: typeof f) => (rot ? c.r - c.l : c.b - c.t);
    // The smaller of the two: a superscript or a tall glyph at either end must not hide a drift.
    const height = Math.max(Math.min(extent(f), extent(l)), 1);
    const drift = across(l) - across(f);
    if (Math.abs(drift) <= SKEW_DRIFT * height) return false;
    // Text at an angle drifts steadily, each character moving both across and along the
    // line. Glyph pieces stacked into a tall delimiter (a matrix bracket) do not advance;
    // a fraction set as one line (numerator and denominator) jumps between two levels.
    const advance = Math.sign(along(l) - along(f));
    let steps = 0;
    let steady = 0;
    let prevAcross = across(f);
    let prevAlong = along(f);
    for (let i = first + 1; i <= last; i++) {
        if (/\s/.test(chars[i])) continue;
        const c = line.chars[i].bbox;
        steps++;
        // Each step moves across the line and along it, as rotated text does.
        if ((across(c) - prevAcross) * Math.sign(drift) > SKEW_STEP * height && (along(c) - prevAlong) * advance > SKEW_STEP * height) steady++;
        prevAcross = across(c);
        prevAlong = along(c);
    }
    return steady >= SKEW_STEADY * steps;
}

/** A word of at least three letters, for finding the page's text font. */
const TEXT_WORD_RE = /^\p{L}{3,}[.,;:!?)]*$/u;
/** Lines of prose are mostly such words. */
const TEXT_WORD_SHARE = 0.6;
/** A relation sign marks an equation, not prose. */
const PROSE_RELATION_RE = /[=≤≥<>≈≡≠]/;

/**
 * The font that sets most characters of the page's prose lines (lines mostly
 * of words, without relation signs): its text font. Fonts are listed as math by
 * name, and some text fonts share a name with a math family (STIX), so the
 * page's own text font is never math. A page of equations has no prose lines
 * and no text font.
 */
function pageTextFont(page: RawPageData): string | undefined {
    const chars = new Map<string, number>();
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            if (line.text.length < 15 || PROSE_RELATION_RE.test(line.text)) continue;
            // Prose: at least four words of letters, and mostly words (an equation's
            // variable names come between operators).
            const tokens = line.text.split(/\s+/).filter(Boolean);
            const words = tokens.filter((t) => TEXT_WORD_RE.test(t)).length;
            if (words < 4 || words < TEXT_WORD_SHARE * tokens.length) continue;
            const detailed = line as RawLineDetailed;
            const runs: FontRun[] = detailed.spans?.length ? detailed.spans : [{ start: 0, font: line.font }];
            const n = detailed.chars?.length ?? [...line.text].length;
            runs.forEach((run, r) => {
                const end = r + 1 < runs.length ? runs[r + 1].start : n;
                chars.set(run.font.name, (chars.get(run.font.name) ?? 0) + Math.max(0, end - run.start));
            });
        }
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [name, count] of chars) {
        if (count > bestCount) {
            best = name;
            bestCount = count;
        }
    }
    return best;
}

export function pageLines(page: RawPageData): RegionLine[] {
    const lines: RegionLine[] = [];
    const textFont = pageTextFont(page);
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
                const m = rangeMath(chars, runs, a, b, textFont, size);
                const operators = !rot && detailed.chars?.length === chars.length ? limitSpans(detailed, chars, a, b, Math.max(1, size)) : [];
                const maxSize = m.maxSize || size;
                const gaps = !rot && detailed.chars?.length === chars.length ? innerGaps(detailed, chars, a, b, WORD_GAP_EM * Math.max(1, size)) : [];
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
                    ...(m.relationSize ? { relationSize: m.relationSize } : {}),
                    inkSize: m.inkSize,
                    ...(operators.length ? { limitSpans: operators } : {}),
                    inkChars: m.ink,
                    ...(m.font ? { font: m.font } : {}),
                    minSize: m.minSize === Infinity ? size : m.minSize,
                    maxSize,
                    eqNumber: EQUATION_NUMBER_RE.test(text),
                    ...(isSkewed(detailed, chars, a, b, rot, bbox, Math.max(size, maxSize)) ? { skewed: true as const } : {}),
                    source,
                    pieces: pieces.length,
                    range: [a, b],
                    ...(gaps.length ? { gaps } : {}),
                });
            }
        }
    }
    return lines;
}

/** Type size setting most of the ink of these pieces (each counted at its own `inkSize`), the larger on a tie. */
export function inkSizeOf(pieces: readonly RegionLine[]): number {
    const bySize = new Map<number, number>();
    for (const p of pieces) {
        const size = p.inkSize ?? p.size;
        bySize.set(size, (bySize.get(size) ?? 0) + p.inkChars);
    }
    return [...bySize].reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && b[0] > a[0]) ? b : a))[0];
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
        // Justified spacing is judged against the row's other word spaces: a gap is never
        // its own evidence, so a column gutter on a row of two or three pieces (one of them
        // an accent overlapping its neighbour) does not pass for an even word space.
        const otherGap = (k: number): number => {
            const others = gaps.filter((g, j) => j !== k && g > 0).sort((a, b) => a - b);
            return others.length ? others[Math.floor(others.length / 2)] : -Infinity;
        };
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
                (wordRow && gap <= JUSTIFIED_GAP_EM * em && gap <= 1.5 * otherGap(i - 1) + 1);
            if (wordGap && gap >= -em && !cur.eqNumber && !next.eqNumber && !separated(cur, next)) {
                const text = `${cur.text} ${next.text}`;
                cur = {
                    ...cur,
                    bbox: [cur.bbox[0], Math.min(cur.bbox[1], next.bbox[1]), Math.max(cur.bbox[2], next.bbox[2]), Math.max(cur.bbox[3], next.bbox[3])],
                    text,
                    size: next.nchar > cur.nchar ? next.size : cur.size,
                    ...((next.nchar > cur.nchar ? next.font : cur.font) ? { font: next.nchar > cur.nchar ? next.font : cur.font } : {}),
                    words: cur.words + next.words,
                    nchar: cur.nchar + next.nchar + 1,
                    alphaWords: cur.alphaWords + next.alphaWords,
                    mathChars: cur.mathChars + next.mathChars,
                    ...(cur.relationSize || next.relationSize ? { relationSize: Math.max(cur.relationSize ?? 0, next.relationSize ?? 0) } : {}),
                    inkSize: inkSizeOf([...(cur.parts ?? [cur]), next]),
                    ...(cur.limitSpans || next.limitSpans ? { limitSpans: [...(cur.limitSpans ?? []), ...(next.limitSpans ?? [])] } : {}),
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

/** A manuscript line number: a bare integer. */
const LINE_NUMBER_RE = /^\d{1,5}$/;
/** A gutter numbers at least this many lines... */
const GUTTER_MIN_LINES = 8;
/** ...counting up by one from line to line for at least this share of them. */
const GUTTER_CONSECUTIVE = 0.7;
/** Its numbers line up on one edge, or on their centres, within this many points. */
const GUTTER_ALIGN = 3;
/** Lines of at least this many words set the page's text body. */
const BODY_WORDS = 4;

/** A table's number column has values (digits, no letters) on at least this share of its rows. */
const GUTTER_VALUE_ROWS = 0.5;
/** A heading over a number column stands at most this many line heights above its first number. */
const HEADING_GAP = 2;
/** An enumeration mark ("5.", "(5)", "[5]"): it numbers an item, it is no value. */
const ENUMERATION_RE = /^[([]?\d{1,4}[.)\]]$/u;

/**
 * A manuscript's line numbers: bare integers stacked in one column in the margin,
 * wholly outside the page's text body (left of the left edge of its lines of words,
 * or right of their right edge), counting up by one from line to line. They number
 * the lines of the page, whatever the lines hold, and are no column of a table: a
 * table's row numbers stand inside the text body, or, on a page the table fills,
 * share its rows with the table's values or stand under a heading of their own
 * (`numbersTable`).
 */
export function lineNumberGutter(lines: readonly RegionLine[]): Set<RegionLine> {
    const upright = lines.filter((l) => !l.rot && !l.skewed);
    const body = upright.filter((l) => l.alphaWords >= BODY_WORDS);
    const out = new Set<RegionLine>();
    if (body.length < 3) return out;
    const lefts = body.map((l) => l.bbox[0]).sort((a, b) => a - b);
    const rights = body.map((l) => l.bbox[2]).sort((a, b) => a - b);
    const bodyLeft = lefts[Math.floor(0.1 * lefts.length)];
    const bodyRight = rights[Math.min(rights.length - 1, Math.floor(0.9 * rights.length))];
    const numbers = upright.filter((l) => LINE_NUMBER_RE.test(l.text.trim()));
    const sides: { side: RegionLine[]; outer: [number, number] }[] = [
        { side: numbers.filter((l) => l.bbox[2] < bodyLeft), outer: [-Infinity, bodyLeft] },
        { side: numbers.filter((l) => l.bbox[0] > bodyRight), outer: [bodyRight, Infinity] },
    ];
    const stacked = sides.filter(({ side }) => {
        if (side.length < GUTTER_MIN_LINES) return false;
        // Flush left, flush right or centred: numbers of one and two digits differ in width.
        const aligned = (at: (b: Rect) => number) => {
            const xs = side.map((l) => at(l.bbox)).sort((a, b) => a - b);
            return xs[xs.length - 1 - Math.floor(0.1 * xs.length)] - xs[Math.floor(0.1 * xs.length)] <= GUTTER_ALIGN;
        };
        if (!aligned((b) => b[0]) && !aligned((b) => b[2]) && !aligned((b) => (b[0] + b[2]) / 2)) return false;
        const sorted = [...side].sort((a, b) => a.bbox[1] - b.bbox[1]);
        const values = sorted.map((l) => Number(l.text.trim()));
        const steps = values.slice(1).filter((v, k) => v === values[k] + 1).length;
        return steps >= GUTTER_CONSECUTIVE * (values.length - 1);
    });
    // Numbers in both margins number the same lines: neither is a value of the other's rows.
    const others = upright.filter((l) => !stacked.some(({ side }) => side.includes(l)));
    for (const { side, outer } of stacked) {
        if (!numbersTable(side, others, outer)) for (const l of side) out.add(l);
    }
    return out;
}

/**
 * Whether a column of consecutive numbers outside the page's lines of words is a
 * table's number column rather than a manuscript's line numbers. A gutter holds
 * nothing but its numbers, beside lines of text. A table's numbers share their rows
 * with the table's values (most rows hold a cell of digits without letters that
 * is no enumeration mark), or stand under a heading of their own ("No.") set within
 * the column: directly over the numbers (`HEADING_GAP`), or under other text of the
 * page such as a caption. Text alone at the top of the page, a gap above the
 * numbers, is page furniture.
 */
function numbersTable(
    numbers: readonly RegionLine[],
    others: readonly RegionLine[],
    [outerFrom, outerTo]: [number, number],
): boolean {
    const valueRows = numbers.filter((n) => {
        const cy = (n.bbox[1] + n.bbox[3]) / 2;
        return others.some(
            (l) => l.bbox[1] < cy && l.bbox[3] > cy && /\d/u.test(l.text) && !/\p{L}/u.test(l.text) && !ENUMERATION_RE.test(l.text.trim()),
        );
    }).length;
    if (valueRows >= GUTTER_VALUE_ROWS * numbers.length) return true;
    const em = Math.max(...numbers.map((n) => n.size));
    const left = Math.min(...numbers.map((n) => n.bbox[0])) - em;
    const right = Math.max(...numbers.map((n) => n.bbox[2])) + em;
    // The numbering starts at its smallest number; a page number can stand above it.
    const first = numbers.reduce((a, b) => (Number(b.text.trim()) < Number(a.text.trim()) ? b : a));
    const top = first.bbox[1];
    const h = first.bbox[3] - first.bbox[1];
    return others.some(
        (l) =>
            /\p{L}/u.test(l.text) &&
            l.bbox[0] >= Math.max(left, outerFrom) &&
            l.bbox[2] <= Math.min(right, outerTo) &&
            l.bbox[3] <= top &&
            (top - l.bbox[3] <= HEADING_GAP * h || others.some((o) => o !== l && o.bbox[3] <= l.bbox[1])),
    );
}

/**
 * The page's body text size: the character-weighted mode of horizontal line font sizes
 * (0.5pt bins) over lines of text. Lines without a letter or digit (a plot's markers or a heatmap set as rows of
 * glyphs, dashes, leader dots) can outnumber the page's text and say nothing about it.
 */
export function bodySize(lines: readonly RegionLine[]): number {
    const text = lines.filter((l) => !l.rot && TEXT_CHAR_RE.test(l.text));
    const counts = new Map<number, number>();
    for (const l of text.length ? text : lines) {
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
    const { strips, rasters } = rasterStrips(g, bs);
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
        // A hairline image (a pixel stretched along a table's rules or cell borders) is a rule,
        // and is described as the filled rectangle a path of that shape would be.
        const hairline =
            (kindCode === GS_KIND.image || (kindCode === GS_KIND.imageMask && !isWhite(rgb))) &&
            Math.min(w, h) <= 2 &&
            Math.max(w, h) > 3 * bs &&
            !strips.has(o);
        if (hairline) {
            kind = w >= h ? "hrule" : "vrule";
        } else if (kindCode === GS_KIND.image || kindCode === GS_KIND.imageMask) {
            if (w < 6 || h < 6) {
                continue;
            } else if (Math.max(w, h) >= 25 * Math.min(w, h) && (w >= 0.3 * pageWidth || h >= 0.3 * pageHeight)) {
                // A long, thin image is a rule drawn as a bitmap (column separators, header lines).
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
            // An image mask paints in its colour; an image's colour is unknown (black, as rules are).
            rgb: hairline ? (kindCode === GS_KIND.imageMask ? rgb : 0) : kindCode === GS_KIND.image || kindCode === GS_KIND.shade ? -1 : rgb,
            curve,
            stroked: kindCode === GS_KIND.strokePath,
            rect: hairline || isRect,
            imageHash: !hairline && (kindCode === GS_KIND.image || kindCode === GS_KIND.imageMask) ? r[o + GS_FIELD.imageHash] : 0,
        });
    }
    // A raster stored as strips is one image.
    for (const bbox of rasters) {
        if (bbox[2] - bbox[0] < 6 || bbox[3] - bbox[1] < 6) continue;
        out.push({ bbox, kind: "image", rgb: -1, curve: false, stroked: false, rect: false, imageHash: 0 });
    }
    if (g.grid) out.push(...overflowMarks(g));
    return out;
}

/** Parallel hairline images this close (in points) or overlapping touch. */
const STRIP_TOUCH = 0.5;

/**
 * Hairline images that touch a parallel one along most of its length: a raster stored as
 * thin strips (one per row of pixels), not rules. Returns their record offsets and one box
 * per raster (the union of its touching strips).
 */
function rasterStrips(g: GraphicsSummary, bs: number): { strips: Set<number>; rasters: Rect[] } {
    const r = g.records;
    const thin: { o: number; box: Rect; along: [number, number]; across: [number, number]; horizontal: boolean }[] = [];
    for (let o = 0; o < g.count * GRAPHICS_SUMMARY_STRIDE; o += GRAPHICS_SUMMARY_STRIDE) {
        const kindCode = r[o + GS_FIELD.kind];
        // A white mask paints nothing on a white page (a white path is no content either).
        if (kindCode !== GS_KIND.image && !(kindCode === GS_KIND.imageMask && !isWhite(r[o + GS_FIELD.rgb]))) continue;
        if (r[o + GS_FIELD.alpha] < MIN_VISIBLE_ALPHA) continue;
        const box: Rect = [r[o + GS_FIELD.x0], r[o + GS_FIELD.y0], r[o + GS_FIELD.x1], r[o + GS_FIELD.y1]];
        const w = box[2] - box[0];
        const h = box[3] - box[1];
        if (Math.min(w, h) > 2 || Math.max(w, h) <= 3 * bs) continue;
        const horizontal = w >= h;
        thin.push({ o, box, horizontal, along: horizontal ? [box[0], box[2]] : [box[1], box[3]], across: horizontal ? [box[1], box[3]] : [box[0], box[2]] });
    }
    const uf = new UnionFind(thin.length);
    const touching = new Set<number>();
    const order = thin.map((_, i) => i).sort((a, b) => thin[a].across[0] - thin[b].across[0]);
    for (let p = 0; p < order.length; p++) {
        const a = thin[order[p]];
        for (let q = p + 1; q < order.length && thin[order[q]].across[0] <= a.across[1] + STRIP_TOUCH; q++) {
            const b = thin[order[q]];
            if (a.horizontal !== b.horizontal) continue;
            const shared = Math.min(a.along[1], b.along[1]) - Math.max(a.along[0], b.along[0]);
            if (shared < 0.5 * Math.min(a.along[1] - a.along[0], b.along[1] - b.along[0])) continue;
            uf.union(order[p], order[q]);
            touching.add(order[p]).add(order[q]);
        }
    }
    const boxes = new Map<number, Rect>();
    for (const i of touching) {
        const root = uf.find(i);
        const b = boxes.get(root);
        boxes.set(root, b ? unionRect(b, thin[i].box) : thin[i].box);
    }
    return { strips: new Set([...touching].map((i) => thin[i].o)), rasters: [...boxes.values()] };
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
