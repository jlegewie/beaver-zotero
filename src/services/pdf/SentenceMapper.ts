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
export type SentenceSplitter = (text: string) => SentenceRange[];

// ---------------------------------------------------------------------------
// Very simple regex-based splitter (feasibility only)
// ---------------------------------------------------------------------------

/**
 * Split text into sentences using a trivial regex.
 *
 * Rules:
 *   - A sentence ends at the first `.`, `!`, or `?` followed by whitespace
 *     (or end-of-string).
 *   - Leading whitespace between sentences is skipped; the returned range
 *     starts at the first non-whitespace character.
 *   - No handling of abbreviations, quotations, decimals, ellipses, etc.
 *     This is intentional — the research doc puts splitter quality out of
 *     scope for this prototype.
 *
 * Returned ranges are half-open offsets `[start, end)` into `text` and are
 * non-overlapping, in order.
 */
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
            }
        }

        if (end > start) ranges.push({ start, end });
        i = end;
    }

    return ranges;
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

    const fragments: NonNullable<SentenceBBox["fragments"]> = [];
    const bboxes: RawBBox[] = [];

    for (const run of runs) {
        const line = lines[run.lineIndex];
        const slice = line.chars.slice(run.charStart, run.charEnd + 1);
        const fragText = slice.map((c) => c.c).join("");
        const fragBBox = unionBBoxes(slice.map((c) => c.bbox));
        fragments.push({
            lineIndex: run.lineIndex,
            text: fragText,
            bbox: fragBBox,
        });
        bboxes.push(fragBBox);
    }

    const text = fragments.map((f) => f.text).join(" ");
    return {
        pageIndex,
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
    const pageText = flattenPageText(page);
    const ranges = splitter(pageText.text);
    const result: SentenceBBox[] = [];
    for (const range of ranges) {
        const sentence = sentenceToBoxes(pageText, range, page.pageIndex);
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
        const s = sentenceToBoxes(pageText, r, page.pageIndex);
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
