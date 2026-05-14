/**
 * Figure-text detection — classifies detected columns that look like
 * figure-internal text (axis labels, tick marks, panel labels, in-
 * figure annotations) on pages that show a figure-heavy signature.
 *
 * **Dormant.** This module produces detection metadata only: it
 * identifies *candidate* figure-internal columns and a per-page
 * `figurePage` flag. It does NOT remove anything from the extraction
 * pipeline — line / paragraph / sentence detection still runs over
 * the full column set. The candidate list is reserved for future
 * `NonStandardContentRegion` integration; today it is exposed solely
 * as a debugging signal via the column-detector wrapper and the
 * `pdf-extract-trace` endpoint.
 *
 * Intent of the heuristic (preserved here for future activation):
 * candidates are columns that, on a page exhibiting clustered tiny
 * non-body columns or a stacked rotated tick column, lack body-
 * content evidence (caption marker, sentence terminator, substantial
 * prose, multi-word title-case). The figure-heavy precondition
 * keeps the detector quiet on ordinary 1- and 2-column body pages.
 *
 * Worker-safe: imports only sibling PDF modules and `Rect` from
 * `ColumnDetector`. No barrel imports.
 */
import type { Rect } from "./ColumnDetector";
import type { RawLine, RawPageData } from "./types";
import { bboxHeight, bboxWidth } from "./types";

export interface FigureTextDetectionOptions {
    /** Minimum tiny columns lacking body content needed for figure-heavy mode. */
    minTinyColumnsForFigurePage?: number;
    /** Width fraction (relative to page content width) below which a column counts as tiny. */
    tinyColumnWidthFraction?: number;
    /** Max alnum chars in the entire column for the tiny-column shape. */
    tinyColumnMaxAlnumChars?: number;
    /** Or every line ≤ this many words for the tiny-column shape. */
    tinyColumnMaxWordsPerLine?: number;
    /** h/w ratio threshold above which a line is treated as rotated/vertical. */
    rotatedAspectRatio?: number;
    /** Minimum alnum chars in a rotated line before it triggers the rotated rule. */
    rotatedMinAlnumChars?: number;
}

const DEFAULTS: Required<FigureTextDetectionOptions> = {
    minTinyColumnsForFigurePage: 3,
    tinyColumnWidthFraction: 0.35,
    tinyColumnMaxAlnumChars: 30,
    tinyColumnMaxWordsPerLine: 4,
    rotatedAspectRatio: 2,
    rotatedMinAlnumChars: 3,
};

export type FigureTextReason = "tiny_cluster" | "rotated";

export interface FigureTextDetectionResult {
    /**
     * Columns classified as figure-internal candidates. **Not removed
     * from the pipeline** — these are detection metadata only,
     * reserved for future NonStandardContentRegion integration.
     */
    candidates: Rect[];
    /** Reason per candidate column. */
    reasons: Map<Rect, FigureTextReason>;
    /** True iff the page met the figure-heavy precondition. */
    figurePage: boolean;
}

/**
 * Classify a page's detected columns and return the figure-text
 * candidate set. The input `columns` array is not modified; callers
 * receive only metadata (candidates + figurePage flag).
 *
 * Pure function — no I/O, no side effects.
 */
export function detectFigureTextColumns(
    columns: Rect[],
    page: RawPageData,
    pageContentWidth: number,
    opts: FigureTextDetectionOptions = {},
): FigureTextDetectionResult {
    const o = { ...DEFAULTS, ...opts };

    if (columns.length === 0) {
        return { candidates: [], reasons: new Map(), figurePage: false };
    }

    // Collect the lines that overlap each column. We use the same
    // overlap rule the line detector uses (centerline of the line
    // falls inside the column rect) so the detector sees the same
    // content the downstream line/paragraph stages would see.
    const linesPerColumn = columns.map((col) => collectLinesInColumn(col, page));

    const shapes = columns.map((col, i) => describeColumn(col, linesPerColumn[i], pageContentWidth, o));

    // Figure-heavy precondition. Fires when EITHER:
    //   (a) ≥ minTinyColumnsForFigurePage tiny non-body columns
    //       cluster spatially — share a ~100pt vertical band
    //       (horizontal cluster: X-axis ticks, panel labels) or a
    //       ~30pt horizontal band (vertical cluster: Y-axis ticks at
    //       the same X). Rejects equation pages where fragments
    //       are spread vertically across body text.
    //   (b) Some single column contains ≥ minTinyColumnsForFigurePage
    //       rotated lines and lacks body content. The MuPDF JSON walk
    //       sometimes merges a stacked column of rotated tick numbers
    //       (e.g. "0 / 200000 / 400000 / 600000 / …" on a y-axis)
    //       into a single column with N rotated lines. Clause (a)
    //       can't see the cluster — we recover it via the per-column
    //       rotated-line count.
    const tinyIdx: number[] = [];
    for (let i = 0; i < shapes.length; i++) {
        if (shapes[i].tiny && !shapes[i].bodyContent) tinyIdx.push(i);
    }
    const horizontalCluster = maxColumnsInBand(tinyIdx, columns, "y", 100);
    const verticalCluster = maxColumnsInBand(tinyIdx, columns, "x", 30);
    const stackedRotatedCol = shapes.some(
        (s) =>
            !s.bodyContent &&
            s.rotatedLineCount >= o.minTinyColumnsForFigurePage,
    );
    const figurePage =
        (tinyIdx.length >= o.minTinyColumnsForFigurePage &&
            Math.max(horizontalCluster, verticalCluster) >=
                o.minTinyColumnsForFigurePage) ||
        stackedRotatedCol;

    if (!figurePage) {
        return { candidates: [], reasons: new Map(), figurePage: false };
    }

    const candidates: Rect[] = [];
    const reasons = new Map<Rect, FigureTextReason>();

    for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const s = shapes[i];

        if (s.bodyContent) continue;
        if (s.tiny) {
            candidates.push(col);
            reasons.set(col, "tiny_cluster");
            continue;
        }
        if (s.rotated) {
            candidates.push(col);
            reasons.set(col, "rotated");
            continue;
        }
    }

    return { candidates, reasons, figurePage: true };
}

// ---------------------------------------------------------------------------
// Per-column shape analysis
// ---------------------------------------------------------------------------

interface ColumnShape {
    tiny: boolean;
    rotated: boolean;
    /** Number of lines in the column whose bbox is rotated/vertical. */
    rotatedLineCount: number;
    bodyContent: boolean;
}

function describeColumn(
    col: Rect,
    lines: RawLine[],
    pageContentWidth: number,
    o: Required<FigureTextDetectionOptions>,
): ColumnShape {
    const totalAlnum = lines.reduce((sum, l) => sum + countAlnum(l.text), 0);
    const everyLineShort =
        lines.length > 0 && lines.every((l) => wordCount(l.text) <= o.tinyColumnMaxWordsPerLine);
    const widthFrac = pageContentWidth > 0 ? col.w / pageContentWidth : 1;
    const tiny =
        widthFrac < o.tinyColumnWidthFraction &&
        (totalAlnum <= o.tinyColumnMaxAlnumChars || everyLineShort);

    let rotatedLineCount = 0;
    for (const l of lines) {
        const width = bboxWidth(l.bbox);
        if (width <= 0) continue;
        const ratio = bboxHeight(l.bbox) / width;
        if (ratio >= o.rotatedAspectRatio && countAlnum(l.text) >= o.rotatedMinAlnumChars) {
            rotatedLineCount++;
        }
    }
    const rotated = rotatedLineCount > 0;

    // Rotated columns lose access to the multi-word-title-case escape
    // hatch: an axis label like "Number of Genes" is title-case but
    // still axis text, not a panel title. Caption markers, sentence
    // terminators, and substantial prose still preserve a rotated
    // column.
    const bodyContent = hasBodyContentEvidence(lines, { allowTitleCase: !rotated });

    return { tiny, rotated, rotatedLineCount, bodyContent };
}

// ---------------------------------------------------------------------------
// Body-content evidence
// ---------------------------------------------------------------------------

const CAPTION_PREFIX = /^(?:Fig\.?|Figure|Tab\.?|Table|Eq\.?|Equation|Scheme|Supplementary)\b/;
// Sentence terminator (`. ! ?`) preceded by a word of ≥ 3 letters and
// optional closing punctuation. Excludes things like "Fig." (only 3
// letters but followed by a digit/colon usually) and "(P = 0.51)".
const SENTENCE_TERMINATOR = /[A-Za-z]{3,}[)\]"']*[.!?][)\]"']*\s*$/;

function hasBodyContentEvidence(
    lines: RawLine[],
    opts: { allowTitleCase: boolean } = { allowTitleCase: true },
): boolean {
    if (lines.length === 0) return false;

    let alphaWordTotal = 0;
    for (const l of lines) {
        const text = l.text.trim();
        if (!text) continue;

        if (CAPTION_PREFIX.test(text)) return true;
        if (SENTENCE_TERMINATOR.test(text)) return true;
        if (opts.allowTitleCase && isMultiWordTitleCase(text)) return true;

        alphaWordTotal += countAlphaWords(text);
        if (alphaWordTotal >= 6) return true;
    }
    return false;
}

/**
 * "Multi-word title-like label" — accepts both true title-case
 * ("Dehejia Wahba Sample", "Lalonde Sample", "Number of Reads") and
 * longer sentence-case article titles ("Putting the pieces together").
 * Rejects in-figure annotations like "fresh used", "no overlay with
 * overlay", "10 µL".
 *
 * Two acceptance shapes:
 *   - title-case: ≥ 2 alpha words, ≥ 2 start with a capital letter,
 *     total alpha length ≥ 6.
 *   - sentence-case title: ≥ 4 alpha words AND the first alpha word
 *     starts with a capital letter, total alpha length ≥ 12.
 */
function isMultiWordTitleCase(text: string): boolean {
    const tokens = text.split(/\s+/).filter(Boolean);
    const alphaTokens = tokens.filter((t) => /^[A-Za-z]+$/.test(t));
    if (alphaTokens.length < 2) return false;
    const alphaLen = alphaTokens.reduce((s, t) => s + t.length, 0);
    const capitalized = alphaTokens.filter((t) => /^[A-Z]/.test(t)).length;
    if (capitalized >= 2 && alphaLen >= 6) return true;
    if (
        alphaTokens.length >= 4 &&
        /^[A-Z]/.test(alphaTokens[0]) &&
        alphaLen >= 12
    ) {
        return true;
    }
    return false;
}

function countAlphaWords(text: string): number {
    const tokens = text.split(/\s+/).filter(Boolean);
    let n = 0;
    for (const t of tokens) {
        if (/^[A-Za-z]{2,}$/.test(t)) n++;
    }
    return n;
}

function countAlnum(text: string): number {
    const m = text.match(/[\p{L}\p{N}]/gu);
    return m ? m.length : 0;
}

function wordCount(text: string): number {
    const m = text.trim().match(/\S+/g);
    return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Spatial clustering helpers
// ---------------------------------------------------------------------------

/**
 * Maximum number of selected columns whose centers (along the
 * requested axis) fall within any sliding window of `bandPt` points.
 * Used to require spatial clustering of figure-text columns: a Y band
 * captures rows of X-axis ticks; an X band captures columns of Y-axis
 * ticks.
 */
function maxColumnsInBand(
    selectedIdx: number[],
    columns: Rect[],
    axis: "x" | "y",
    bandPt: number,
): number {
    if (selectedIdx.length === 0) return 0;
    const centers = selectedIdx
        .map((i) => {
            const c = columns[i];
            return axis === "y" ? c.y + c.h / 2 : c.x + c.w / 2;
        })
        .sort((a, b) => a - b);
    let best = 1;
    let lo = 0;
    for (let hi = 0; hi < centers.length; hi++) {
        while (centers[hi] - centers[lo] > bandPt) lo++;
        const span = hi - lo + 1;
        if (span > best) best = span;
    }
    return best;
}

// ---------------------------------------------------------------------------
// Column ↔ line membership
// ---------------------------------------------------------------------------

/**
 * A line belongs to a column when its centerline falls inside the
 * column rect (with a small slack for edge rounding). This mirrors the
 * convention used by `LineDetector.detectLinesInColumn` in spirit
 * without depending on it: the detector must reason about the same
 * lines the downstream stages will see.
 */
function collectLinesInColumn(col: Rect, page: RawPageData): RawLine[] {
    const out: RawLine[] = [];
    const colLeft = col.x;
    const colRight = col.x + col.w;
    const colTop = col.y;
    const colBottom = col.y + col.h;
    const SLACK = 1; // pt — accommodates float drift in column rects

    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            const cx = line.bbox.l + bboxWidth(line.bbox) / 2;
            const cy = line.bbox.t + bboxHeight(line.bbox) / 2;
            if (
                cx >= colLeft - SLACK &&
                cx <= colRight + SLACK &&
                cy >= colTop - SLACK &&
                cy <= colBottom + SLACK
            ) {
                out.push(line);
            }
        }
    }
    return out;
}
