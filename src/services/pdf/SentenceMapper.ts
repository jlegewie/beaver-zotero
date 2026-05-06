/**
 * Sentence → bounding box resolver.
 *
 * **Feasibility prototype** for the design in
 * `docs-zotero/research-sentence-level-bbox.md` (Approach C).
 *
 * Given a page with per-character detail (RawPageDataDetailed), this module:
 *   1. Flattens all detailed lines on the page in document order.
 *   2. Builds a single concatenated text string plus a parallel `source` map
 *      from text offsets back to (lineIndex, charIndex).
 *   3. Runs a pluggable sentence splitter (default: a trivial regex one) on
 *      that text.
 *   4. Maps each sentence's `[start, end)` text range back to one bbox per
 *      contiguous line-fragment.
 *
 * Scope: this is intentionally minimal. Paragraph detection is NOT applied
 * here — a production version would run this per paragraph so splitter
 * context stays clean and column gutters never get stitched together. Using
 * whole-page concatenation is fine for a feasibility check on a well-behaved
 * single-column PDF.
 */

import type {
    RawBBox,
    RawLineDetailed,
    RawPageDataDetailed,
    SentenceBBox,
} from "./types";

// ---------------------------------------------------------------------------
// Sentence splitter contract
// ---------------------------------------------------------------------------

/** A sentence as offsets `[start, end)` into the concatenated page text. */
export interface SentenceRange {
    start: number;
    end: number;
}

/**
 * A callback that, given the full concatenated text, returns sentence
 * ranges. Must return half-open intervals `[start, end)` in offset order.
 * Overlapping ranges are not supported.
 */
export type SentenceSplitter = (
    text: string,
    context?: import("./sentencePostprocess").PostProcessContext,
) => SentenceRange[];

// ---------------------------------------------------------------------------
// Very simple regex-based splitter (feasibility only)
// ---------------------------------------------------------------------------

/**
 * Split text into sentences using a trivial regex.
 *
 * Rules:
 *   - A sentence ends at an ASCII terminator (`.`, `!`, `?`) followed by
 *     whitespace (or end-of-string).
 *   - A sentence also ends at an unambiguous non-Latin terminator — `。`,
 *     `！`, `？` (CJK full/wide), `؟` (Arabic), `।` (Devanagari danda),
 *     `።` (Ethiopic) — regardless of what follows, since those characters
 *     are not used inside words, abbreviations, or numbers.
 *   - Leading whitespace between sentences is skipped; the returned range
 *     starts at the first non-whitespace character.
 *   - No handling of abbreviations, quotations, decimals, ellipses, etc.
 *     This is intentional — the research doc puts splitter quality out of
 *     scope for this prototype.
 *
 * Returned ranges are half-open offsets `[start, end)` into `text` and are
 * non-overlapping, in order.
 */
const UNAMBIGUOUS_SENTENCE_TERMINATORS = new Set([
    "。", // 。 CJK full stop
    "！", // ！ fullwidth exclamation
    "？", // ？ fullwidth question
    "؟", // ؟ Arabic question mark
    "।", // । Devanagari danda
    "॥", // ॥ Devanagari double danda
    "።", // ። Ethiopic full stop
]);

export function simpleRegexSentenceSplit(text: string): SentenceRange[] {
    const ranges: SentenceRange[] = [];
    if (!text) return ranges;

    const n = text.length;
    let i = 0;

    while (i < n) {
        // Skip leading whitespace.
        while (i < n && /\s/.test(text[i])) i++;
        if (i >= n) break;

        const start = i;
        let end = n;

        for (let j = i; j < n; j++) {
            const c = text[j];
            if (c === "." || c === "!" || c === "?") {
                const next = j + 1 < n ? text[j + 1] : "";
                if (next === "" || /\s/.test(next)) {
                    end = j + 1; // include the terminator
                    break;
                }
            } else if (UNAMBIGUOUS_SENTENCE_TERMINATORS.has(c)) {
                end = j + 1;
                break;
            }
        }

        if (end > start) ranges.push({ start, end });
        i = end;
    }

    return ranges;
}

// ---------------------------------------------------------------------------
// Terminal-punctuation check (used by the column-continuation hint producer)
// ---------------------------------------------------------------------------

/**
 * Trailing closers walked back over before checking the terminal char, so
 * `…the report.")` and `…見た。」` count as terminated. Conservative list:
 * straight + curly quotes, ASCII brackets, French guillemets, CJK brackets.
 * Extend only with concrete fixture evidence.
 */
export const SENTENCE_FINAL_CLOSERS: ReadonlySet<string> = new Set([
    ")", "]", "}",
    '"', "'",   // straight ASCII quotes
    "”", "’",   // ” curly double, ’ curly single
    "»", "›",   // » guillemet, › single guillemet
    "」", "』",   // 」 」 CJK closing brackets
]);

/**
 * Sentence-ending check used by `annotateColumnContinuations`.
 *
 * Returns `true` iff the trimmed end of `text` (after walking back through
 * SENTENCE_FINAL_CLOSERS) is one of:
 *   - ASCII `.`, `!`, `?`
 *   - Ellipsis `…` (U+2026) or the literal three-character `...`
 *   - Myanmar `။` (U+104B)
 *   - Any member of `UNAMBIGUOUS_SENTENCE_TERMINATORS`
 *
 * Whitespace at the end is ignored. The check looks only at the trailing
 * position — a terminator buried mid-string with non-closer text after it
 * does not count.
 */
export function hasSentenceFinalTerminator(text: string): boolean {
    if (!text) return false;

    // Walk back past trailing whitespace, then any stack of closers, then
    // any further trailing whitespace between closers and the terminator.
    let end = text.length;
    while (end > 0 && /\s/.test(text[end - 1])) end--;
    while (end > 0 && SENTENCE_FINAL_CLOSERS.has(text[end - 1])) {
        end--;
        while (end > 0 && /\s/.test(text[end - 1])) end--;
    }
    if (end <= 0) return false;

    const last = text[end - 1];
    // ASCII `.` covers the literal three-dot ellipsis (`...`) automatically.
    if (last === "." || last === "!" || last === "?") return true;
    if (last === "…") return true;   // … ellipsis
    if (last === "။") return true;   // ။ Myanmar full stop
    if (UNAMBIGUOUS_SENTENCE_TERMINATORS.has(last)) return true;

    return false;
}

// ---------------------------------------------------------------------------
// Page text concatenation with source map
// ---------------------------------------------------------------------------

/**
 * Concatenated page text with a parallel source map.
 *
 * `text.length === source.length`. Each entry in `source` is either:
 *   - `{ lineIndex, charIndex }` — this text offset came from a real
 *     `RawChar` on the given line, OR
 *   - `null` — this offset is boundary filler (the space we inject between
 *     consecutive lines). Sentence mapping skips nulls so bboxes are only
 *     built from real characters.
 */
export interface PageText {
    text: string;
    source: Array<{ lineIndex: number; charIndex: number } | null>;
    /** The flattened line array used as the coordinate system for `source`. */
    lines: RawLineDetailed[];
}

/**
 * Flatten a detailed page's text blocks into a single line array in document
 * order, build the concatenated text, and emit the source map.
 *
 * Between consecutive lines we inject a single `" "` with a `null` source
 * entry so the splitter sees word boundaries. Between blocks we inject
 * `"\n\n"` (two nulls) so sentence boundaries naturally land at paragraph
 * breaks. Neither filler character maps to a real char, so sentence-to-bbox
 * resolution ignores them.
 */
export function flattenPageText(page: RawPageDataDetailed): PageText {
    const lines: RawLineDetailed[] = [];
    const textParts: string[] = [];
    const source: PageText["source"] = [];

    for (let blockIdx = 0; blockIdx < page.blocks.length; blockIdx++) {
        const block = page.blocks[blockIdx];
        if (block.type !== "text" || !block.lines) continue;

        for (let lineIdxInBlock = 0; lineIdxInBlock < block.lines.length; lineIdxInBlock++) {
            const line = block.lines[lineIdxInBlock];
            const lineIndex = lines.length;
            lines.push(line);

            // Invariant check — the prototype must fail loudly if text and
            // chars ever get out of sync.
            if (line.text.length !== line.chars.length) {
                throw new Error(
                    `[SentenceMapper] text/chars length mismatch on line ${lineIndex}: ` +
                    `text.length=${line.text.length}, chars.length=${line.chars.length}`,
                );
            }

            for (let ci = 0; ci < line.chars.length; ci++) {
                textParts.push(line.chars[ci].c);
                source.push({ lineIndex, charIndex: ci });
            }

            const isLastLineInBlock = lineIdxInBlock === block.lines.length - 1;
            if (!isLastLineInBlock) {
                // Line break inside a block: soft space.
                textParts.push(" ");
                source.push(null);
            }
        }

        const isLastBlock = blockIdx === page.blocks.length - 1;
        if (!isLastBlock) {
            // Hard break between blocks — two nulls so even naive sentence
            // splitters reset context.
            textParts.push("\n\n");
            source.push(null);
            source.push(null);
        }
    }

    return { text: textParts.join(""), source, lines };
}

// ---------------------------------------------------------------------------
// Sentence → bboxes
// ---------------------------------------------------------------------------

/** Compute the axis-aligned union of a set of RawBBoxes. */
function unionBBoxes(bboxes: RawBBox[]): RawBBox {
    if (bboxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const b of bboxes) {
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Tolerances used to decide whether two consecutive fragments share a
 * single visual line. MuPDF sometimes emits one visual line as multiple
 * `RawLineDetailed` entries when a wider-than-normal horizontal gap
 * (justified spacing, manual extra spaces) appears mid-line — those
 * pieces have effectively identical y / h, well below the ~12 pt line
 * spacing of typical body text. 1 pt absolute is comfortably above
 * MuPDF rounding noise and well below normal line spacing.
 *
 * `MAX_GAP_RATIO` caps the horizontal gap (left edge of next fragment
 * minus right edge of previous fragment) we'll bridge, expressed as a
 * multiple of the fragment height. ~3× covers extra-space / justified
 * intra-line splits comfortably while staying well under any realistic
 * column gutter or table cell separation, so unrelated same-y fragments
 * (table cells, column-order edge cases on the page-wide path) never
 * collapse into one rectangle.
 */
const SAME_LINE_Y_TOL_PT = 1.0;
const SAME_LINE_H_TOL_PT = 1.0;
const SAME_LINE_MAX_GAP_RATIO = 3.0;

/**
 * Merge consecutive fragments that share a visual line into one fragment.
 *
 * Why: MuPDF's structured-text walker can split a single visual line into
 * multiple `RawLineDetailed` entries when there's an unusually wide
 * horizontal gap (extra spaces, justified-text spacing). Without this
 * pass, a sentence highlight on one visual line renders as multiple
 * disjoint rectangles with a blank gap between them. Same-line is
 * detected by near-equal y and h; subscripts / superscripts have a
 * smaller h and won't merge.
 *
 * Guards:
 * - Fragments must be nearly co-linear (y, h within ~1 pt).
 * - The next fragment must lie to the right of the previous one
 *   (`frag.x >= last.right - tol`), so we never bridge backwards
 *   (e.g. a column-order fallback that emits a same-y fragment from
 *   another column).
 * - The horizontal gap between them must be at most a few line heights
 *   (`SAME_LINE_MAX_GAP_RATIO`). Anything wider is treated as a real
 *   layout boundary (column gutter, table cell separation) and left
 *   alone — preserving per-fragment precision.
 *
 * Fragments are merged in document order — `sentenceToBoxes` already
 * walks the source map linearly, so same-line pieces always appear
 * consecutively.
 */
function mergeSameLineFragments(
    fragments: NonNullable<SentenceBBox["fragments"]>,
): NonNullable<SentenceBBox["fragments"]> {
    if (fragments.length < 2) return fragments;
    const out: NonNullable<SentenceBBox["fragments"]> = [];
    for (const frag of fragments) {
        const last = out.length > 0 ? out[out.length - 1] : null;
        const sameLine =
            !!last &&
            Math.abs(last.bbox.y - frag.bbox.y) <= SAME_LINE_Y_TOL_PT &&
            Math.abs(last.bbox.h - frag.bbox.h) <= SAME_LINE_H_TOL_PT;
        if (last && sameLine) {
            const lastRight = last.bbox.x + last.bbox.w;
            const gap = frag.bbox.x - lastRight;
            // Allow a tiny negative slop for sub-pt overlaps (kerning,
            // rounding); reject real backwards jumps and oversized gaps.
            const refHeight = Math.max(last.bbox.h, frag.bbox.h, 1);
            const maxGap = refHeight * SAME_LINE_MAX_GAP_RATIO;
            if (gap >= -SAME_LINE_Y_TOL_PT && gap <= maxGap) {
                const minX = Math.min(last.bbox.x, frag.bbox.x);
                const maxX = Math.max(
                    last.bbox.x + last.bbox.w,
                    frag.bbox.x + frag.bbox.w,
                );
                const minY = Math.min(last.bbox.y, frag.bbox.y);
                const maxY = Math.max(
                    last.bbox.y + last.bbox.h,
                    frag.bbox.y + frag.bbox.h,
                );
                last.bbox = {
                    x: minX,
                    y: minY,
                    w: maxX - minX,
                    h: maxY - minY,
                };
                last.text = last.text + " " + frag.text;
                continue;
            }
        }
        out.push({ ...frag, bbox: { ...frag.bbox } });
    }
    return out;
}

/**
 * Resolve a sentence range `[start, end)` into one bbox per line-fragment.
 *
 * Walks the source map once, groups real-char entries by their `lineIndex`
 * into contiguous runs, then unions the per-char bboxes of each run.
 *
 * Returns `null` if the range contains no real characters (e.g. it landed
 * entirely inside filler whitespace).
 */
export function sentenceToBoxes(
    pageText: PageText,
    range: SentenceRange,
    pageIndex: number,
    paragraphIndex: number,
    sentenceIndex: number,
): SentenceBBox | null {
    const { source, lines } = pageText;
    const clampedStart = Math.max(0, range.start);
    const clampedEnd = Math.min(source.length, range.end);
    if (clampedEnd <= clampedStart) return null;

    type Run = { lineIndex: number; charStart: number; charEnd: number };
    const runs: Run[] = [];

    for (let i = clampedStart; i < clampedEnd; i++) {
        const src = source[i];
        if (!src) continue;
        const last = runs.length > 0 ? runs[runs.length - 1] : null;
        // Extend a run only if we're still on the same line AND the char
        // index advanced by exactly one (contiguous). Anything else starts a
        // new run — this handles out-of-order mapping defensively, though in
        // practice runs are always contiguous here.
        if (
            last &&
            last.lineIndex === src.lineIndex &&
            src.charIndex === last.charEnd + 1
        ) {
            last.charEnd = src.charIndex;
        } else {
            runs.push({
                lineIndex: src.lineIndex,
                charStart: src.charIndex,
                charEnd: src.charIndex,
            });
        }
    }

    if (runs.length === 0) return null;

    const rawFragments: NonNullable<SentenceBBox["fragments"]> = [];

    for (const run of runs) {
        const line = lines[run.lineIndex];
        const slice = line.chars.slice(run.charStart, run.charEnd + 1);
        const fragText = slice.map((c) => c.c).join("");
        const fragBBox = unionBBoxes(slice.map((c) => c.bbox));
        rawFragments.push({
            lineIndex: run.lineIndex,
            text: fragText,
            bbox: fragBBox,
        });
    }

    const fragments = mergeSameLineFragments(rawFragments);
    const bboxes = fragments.map((f) => f.bbox);
    const text = fragments.map((f) => f.text).join(" ");
    return {
        pageIndex,
        paragraphIndex,
        sentenceIndex,
        text,
        bboxes,
        fragments,
    };
}

// ---------------------------------------------------------------------------
// Top-level convenience
// ---------------------------------------------------------------------------

/**
 * Produce `SentenceBBox[]` for a detailed page.
 *
 * @param page     - Output of `MuPDFService.extractRawPageDetailed`.
 * @param splitter - Sentence splitter callback. Defaults to
 *                   `simpleRegexSentenceSplit` for feasibility testing.
 */
export function extractSentenceBBoxes(
    page: RawPageDataDetailed,
    splitter: SentenceSplitter = simpleRegexSentenceSplit,
): SentenceBBox[] {
    // Page-wide path treats the whole page as a single virtual paragraph,
    // since paragraph detection is intentionally out of scope here. Callers
    // that need true paragraph addressing should use ParagraphSentenceMapper.
    const pageText = flattenPageText(page);
    const ranges = splitter(pageText.text);
    const result: SentenceBBox[] = [];
    for (const range of ranges) {
        const sentence = sentenceToBoxes(
            pageText,
            range,
            page.pageIndex,
            0,
            result.length,
        );
        if (sentence) result.push(sentence);
    }
    return result;
}

/**
 * Self-check helpers — useful inside an integration test to validate the
 * invariants the research note lists as "correctness traps".
 */
export interface FeasibilityReport {
    pageIndex: number;
    /** Total code points walked on the page. */
    totalChars: number;
    /** Number of detailed lines on the page. */
    totalLines: number;
    /** Sentences recovered by the splitter. */
    totalSentences: number;
    /** Sentences that span more than one line-fragment. */
    multiFragmentSentences: number;
    /** Length of the concatenated page text (chars + filler). */
    pageTextLength: number;
    /** True if every line satisfies text.length === chars.length. */
    invariantHolds: boolean;
    /**
     * Per-sentence: total bbox count, covered text for sanity display.
     * Limited to first 20 entries to keep payloads small.
     */
    sentences: Array<{
        index: number;
        text: string;
        numBBoxes: number;
        unionBBox: RawBBox;
    }>;
    /**
     * True if every sentence bbox lies fully within the page CropBox
     * (with a small tolerance for PDF rounding).
     */
    allBBoxesInPage: boolean;
}

export function buildFeasibilityReport(
    page: RawPageDataDetailed,
    splitter: SentenceSplitter = simpleRegexSentenceSplit,
    maxSentences = 20,
): FeasibilityReport {
    const pageText = flattenPageText(page);

    let totalChars = 0;
    let totalLines = 0;
    let invariantHolds = true;
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            totalLines++;
            totalChars += line.chars.length;
            if (line.text.length !== line.chars.length) invariantHolds = false;
        }
    }

    const ranges = splitter(pageText.text);
    const sentencesFull: SentenceBBox[] = [];
    for (const r of ranges) {
        const s = sentenceToBoxes(
            pageText,
            r,
            page.pageIndex,
            0,
            sentencesFull.length,
        );
        if (s) sentencesFull.push(s);
    }

    const multi = sentencesFull.filter((s) => s.bboxes.length > 1).length;

    const tolerance = 1.0;
    const pageW = page.width;
    const pageH = page.height;
    let allBBoxesInPage = true;
    for (const s of sentencesFull) {
        for (const b of s.bboxes) {
            if (
                b.x < -tolerance ||
                b.y < -tolerance ||
                b.x + b.w > pageW + tolerance ||
                b.y + b.h > pageH + tolerance
            ) {
                allBBoxesInPage = false;
                break;
            }
        }
        if (!allBBoxesInPage) break;
    }

    const sentencesPreview = sentencesFull.slice(0, maxSentences).map((s, idx) => ({
        index: idx,
        text: s.text,
        numBBoxes: s.bboxes.length,
        unionBBox: unionBBoxes(s.bboxes),
    }));

    return {
        pageIndex: page.pageIndex,
        totalChars,
        totalLines,
        totalSentences: sentencesFull.length,
        multiFragmentSentences: multi,
        pageTextLength: pageText.text.length,
        invariantHolds,
        sentences: sentencesPreview,
        allBBoxesInPage,
    };
}
