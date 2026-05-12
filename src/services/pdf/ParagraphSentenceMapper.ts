/**
 * Paragraph-scoped sentence → bbox resolver.
 *
 * This is the second feasibility step that builds on `SentenceMapper.ts`.
 * Where `SentenceMapper` runs its splitter on the entire flattened page text,
 * this module scopes the splitter to **one paragraph at a time**. That gives
 * better sentence boundaries (no stitching across column gutters or
 * heading/body transitions) and makes sentence text match the reading order
 * the existing `ParagraphDetector` already computes.
 *
 * Design notes:
 *
 * - It **coexists** with the page-wide `SentenceMapper` path. Neither module
 *   replaces the other. Callers pick based on performance vs. accuracy:
 *     * `SentenceMapper` — single walk, single splitter call, no paragraph
 *       detection. Cheaper.
 *     * `ParagraphSentenceMapper` — full column + line + paragraph pipeline
 *       on top of the detailed walk. More expensive, but sentence bounds
 *       respect paragraph structure.
 *
 * - It does not duplicate paragraph-detection logic. Instead it asks
 *   `detectParagraphs` for its per-item line groups via the new
 *   `trackItemLines: true` option, then maps each paragraph's lines back to
 *   the source `RawLineDetailed` entries by bbox identity.
 *
 * - The text/chars lockstep invariant is preserved per-paragraph in exactly
 *   the same way as `SentenceMapper.flattenPageText` preserves it per-page.
 */

import type {
    RawBBox,
    RawLineDetailed,
    RawPageDataDetailed,
} from "./types";
import type { SentenceBBox } from "./types";
import type { PageLine } from "./LineDetector";
import type {
    ContentItem,
    PageParagraphResult,
    ParagraphDetectionSettings,
} from "./ParagraphDetector";
import { detectParagraphs } from "./ParagraphDetector";
import { detectColumns } from "./ColumnDetector";
import { detectLinesOnPage } from "./LineDetector";
import {
    hasSentenceFinalTerminator,
    simpleRegexSentenceSplit,
    sentenceToBoxes,
    type PageText,
    type SentenceRange,
    type SentenceSplitter,
} from "./SentenceMapper";
import {
    inverseRotateLineBBox,
    inverseRotateRawBBox,
    rotateRawPageDetailed,
    type RotationAngle,
} from "./PageRotationNormalizer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Plain-text rendering of a single paragraph with a source map pointing back
 * to the detailed chars that produced it.
 *
 * Mirrors `SentenceMapper.PageText` but scoped to a single paragraph. The
 * `lines` field is the paragraph's own line array (each entry from the
 * detailed walk), and `source[i]` refers to indices into that array — not
 * page-global line indices.
 */
export interface ParagraphText {
    /** Concatenated paragraph text, with single-space fillers between lines. */
    text: string;
    /**
     * Parallel source map. `text.length === source.length`. Real entries
     * point back to `(lineIndex, charIndex)` into `lines`; `null` marks
     * boundary filler (the inter-line space) that should be skipped when
     * resolving sentences.
     */
    source: Array<{ lineIndex: number; charIndex: number } | null>;
    /**
     * Detailed lines for this paragraph, in reading order.
     * `lines[source[i].lineIndex].chars[source[i].charIndex]` is the char
     * that contributed `text[i]`.
     */
    lines: RawLineDetailed[];
}

/**
 * Result of mapping a single `ContentItem` (paragraph or header) to the
 * sentences it contains with per-sentence line-fragment bboxes.
 */
export interface ParagraphWithSentences {
    item: ContentItem;
    paragraphText: ParagraphText;
    sentences: SentenceBBox[];
}

/**
 * Why a paragraph failed the precise mapping path and fell back to a
 * whole-paragraph bbox.
 */
export type DegradationReason =
    /** `ContentItem` had no PageLine group or none of its spans matched the detailed lookup. */
    | "unmapped"
    /** `buildParagraphText` threw — text/chars lockstep violated (ligatures, astral-plane chars, etc.). */
    | "invariant_violation"
    /** The splitter produced no sentences inside this paragraph. Unusual but possible. */
    | "empty_split";

/** A single note about a degraded paragraph, for surfacing to callers/logs. */
export interface DegradationNote {
    /** Index into `paragraphResult.items` for the offending paragraph. */
    itemIndex: number;
    /** Human-readable type from the underlying `ContentItem`. */
    itemType: "paragraph" | "header";
    /** What failed. */
    reason: DegradationReason;
    /** Error message when `reason === "invariant_violation"`. */
    message?: string;
}

/**
 * Summary of paragraphs on a page that fell back from precise sentence-level
 * mapping to a single whole-paragraph bbox. The producer omits the field
 * entirely when no paragraphs degraded — callers should use
 * `result.degradation?.count ?? 0` and `result.degradation?.notes ?? []`.
 *
 * The per-reason classification (`unmapped` / `invariant_violation` /
 * `empty_split`) lives on each `DegradationNote.reason`. `count` reflects
 * the total across all reasons; `notes` is bounded by
 * `MAX_DEGRADATION_NOTES` so per-reason histograms over `notes` may
 * undercount on pathological pages — `count` is always exact.
 */
export interface DegradationSummary {
    /** Total paragraphs that fell back to a whole-paragraph bbox. */
    count: number;
    /** Per-paragraph diagnostic notes (capped at `MAX_DEGRADATION_NOTES`). */
    notes: DegradationNote[];
}

/** Result of running the full paragraph-scoped sentence pipeline on a page. */
export interface PageSentenceBBoxResult {
    pageIndex: number;
    width: number;
    height: number;
    /** Detected paragraphs with their sentences. */
    paragraphs: ParagraphWithSentences[];
    /**
     * Flattened `SentenceBBox[]` across all paragraphs, in reading order.
     * Convenient for callers that don't care which paragraph a sentence
     * came from. Degraded paragraphs contribute a single whole-paragraph
     * fallback bbox to this list.
     */
    sentences: SentenceBBox[];
    /**
     * Paragraphs that fell back from precise sentence-level mapping to a
     * single whole-paragraph bbox (bbox-lookup miss, text/chars invariant
     * violation, or empty splitter result — distinguished by
     * `notes[i].reason`). Omitted when no paragraphs degraded; callers
     * should read it as `result.degradation?.count ?? 0` /
     * `result.degradation?.notes ?? []`.
     */
    degradation?: DegradationSummary;
}

/** Cap on diagnostic notes to avoid unbounded memory on pathological PDFs. */
const MAX_DEGRADATION_NOTES = 50;

// ---------------------------------------------------------------------------
// Detailed-line lookup
// ---------------------------------------------------------------------------

/**
 * Build a lookup from raw-line bbox to `RawLineDetailed`.
 *
 * The existing line/paragraph detectors keep `RawLine.bbox` verbatim on every
 * `DetectedSpan`, so spans can be traced back to the raw line they came from
 * by comparing bbox coordinates. Keys are rounded to avoid spurious
 * float-equality misses; the rounding granularity (3 decimals) is far below
 * any real bbox-distinct-enough-to-matter threshold.
 */
function bboxKey(b: RawBBox): string {
    return `${b.x.toFixed(3)}|${b.y.toFixed(3)}|${b.w.toFixed(3)}|${b.h.toFixed(3)}`;
}

export function buildDetailedLineLookup(
    page: RawPageDataDetailed,
): Map<string, RawLineDetailed> {
    const map = new Map<string, RawLineDetailed>();
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            map.set(bboxKey(line.bbox), line);
        }
    }
    return map;
}

// ---------------------------------------------------------------------------
// Paragraph → ParagraphText
// ---------------------------------------------------------------------------

/**
 * Collect the detailed lines that make up a single `PageLine[]` paragraph
 * group, in reading order.
 *
 * Each `PageLine.spans` has a `bbox` that was copied verbatim from the raw
 * line it was built from. We look that bbox up in `detailedLookup` to
 * recover the corresponding `RawLineDetailed`. Missing lookups are skipped
 * (and surfaced to the caller through `result.degradation`), which keeps the
 * pipeline resilient when a single span drifts.
 *
 * Span-level ordering: within a single `PageLine`, spans are sorted left-to
 * -right by the line detector. Across lines, the detector sorts top-to-
 * bottom. Concatenating in this order yields reading order.
 */
function collectDetailedLinesForParagraph(
    lineGroup: PageLine[],
    detailedLookup: Map<string, RawLineDetailed>,
): RawLineDetailed[] {
    const out: RawLineDetailed[] = [];
    const seen = new Set<string>();
    for (const pageLine of lineGroup) {
        for (const span of pageLine.spans) {
            const key = bboxKey(span.bbox);
            if (seen.has(key)) continue;
            const detailed = detailedLookup.get(key);
            if (!detailed) continue; // unmapped — counted downstream
            seen.add(key);
            out.push(detailed);
        }
    }
    return out;
}

/**
 * Canonical footnote-marker glyphs. A superscript run consisting of these
 * characters and following a sentence-ending punctuation is collapsed to a
 * single space so the splitter sees the underlying boundary.
 *
 * Restricted to digits and traditional footnote symbols on purpose — keeps
 * the transformation away from inline math, trademark glyphs, and raised
 * letters in ordinals like "1st".
 */
const FOOTNOTE_MARKER_CHARS = new Set([
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "*", "†", "‡", "§", "¶", "#",
]);

/**
 * Sentence-ending punctuation that, when immediately followed by a
 * superscript footnote marker, hides what would otherwise be a clean
 * sentence boundary (e.g. "factor.11 The").
 */
const SENTENCE_END_PUNCT = new Set([".", "!", "?"]);

/**
 * A char whose bbox height is below this fraction of the line's median
 * char height is treated as a superscript candidate. 0.85 is generous
 * enough to catch ~0.65× footnote glyphs without flagging punctuation
 * whose ink box happens to be slightly shorter than the median.
 */
const SUPERSCRIPT_HEIGHT_RATIO = 0.85;

function lineMedianCharHeight(line: RawLineDetailed): number {
    const heights: number[] = [];
    for (const c of line.chars) {
        if (c.bbox.h > 0) heights.push(c.bbox.h);
    }
    if (heights.length === 0) return 0;
    heights.sort((a, b) => a - b);
    return heights[Math.floor(heights.length / 2)];
}

/**
 * Build a `ParagraphText` (text + source map + lines) from a list of
 * detailed raw lines belonging to a single paragraph.
 *
 * Exactly mirrors `SentenceMapper.flattenPageText` but scoped to a single
 * paragraph:
 * - Every real char contributes to `text` and gets a `source` entry.
 * - A single `" "` filler (with a `null` source entry) separates adjacent
 *   lines so the splitter sees word boundaries.
 * - The invariant `line.text.length === line.chars.length` is checked
 *   loudly; a violation throws.
 *
 * Superscript footnote markers following a sentence-ending punctuation
 * (e.g. the "11" in "factor.11 The") are replaced with a single
 * inter-word space. Without this the splitter sees `.1` and keeps both
 * clauses in one sentence; with it the splitter sees `. ` and recovers
 * the boundary. The footnote chars contribute no source entry, so they
 * drop out of bbox mapping cleanly.
 */
export function buildParagraphText(
    lines: RawLineDetailed[],
): ParagraphText {
    const textParts: string[] = [];
    const source: ParagraphText["source"] = [];
    let lastEmittedNonWhitespaceRealChar: string | null = null;
    let inFootnoteRun = false;
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (line.text.length !== line.chars.length) {
            throw new Error(
                `[ParagraphSentenceMapper] text/chars length mismatch on line ${li}: ` +
                `text.length=${line.text.length}, chars.length=${line.chars.length}`,
            );
        }
        const median = lineMedianCharHeight(line);
        const superscriptThreshold =
            median > 0 ? median * SUPERSCRIPT_HEIGHT_RATIO : 0;
        for (let ci = 0; ci < line.chars.length; ci++) {
            const ch = line.chars[ci];
            const isSmall =
                superscriptThreshold > 0 &&
                ch.bbox.h > 0 &&
                ch.bbox.h < superscriptThreshold;
            const isFootnoteMarker =
                isSmall && FOOTNOTE_MARKER_CHARS.has(ch.c);
            if (
                isFootnoteMarker &&
                (inFootnoteRun ||
                    (lastEmittedNonWhitespaceRealChar !== null &&
                        SENTENCE_END_PUNCT.has(lastEmittedNonWhitespaceRealChar)))
            ) {
                if (!inFootnoteRun) {
                    textParts.push(" ");
                    source.push(null);
                    inFootnoteRun = true;
                }
                continue;
            }
            inFootnoteRun = false;
            if (!/\s/.test(ch.c)) {
                lastEmittedNonWhitespaceRealChar = ch.c;
            }
            textParts.push(ch.c);
            source.push({ lineIndex: li, charIndex: ci });
        }
        if (li < lines.length - 1) {
            textParts.push(" ");
            source.push(null);
        }
    }
    return { text: textParts.join(""), source, lines };
}

/**
 * Safe wrapper around `buildParagraphText` that catches invariant
 * violations and returns them as `{ error }` instead of throwing.
 * Used by the pipeline for graceful degradation — a single ligature /
 * astral-plane edge case on one paragraph should not nuke the whole page.
 */
export function tryBuildParagraphText(
    lines: RawLineDetailed[],
):
    | { ok: true; paragraphText: ParagraphText }
    | { ok: false; error: string } {
    try {
        return { ok: true, paragraphText: buildParagraphText(lines) };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

/**
 * Build a degraded fallback `SentenceBBox` for a `ContentItem` whose
 * precise char-level mapping failed (unmapped or invariant violation).
 *
 * Produces one whole-paragraph rectangle using the `ContentItem.bbox`
 * (already merged across all lines by the paragraph detector) and the
 * `ContentItem.text` as the sentence text. Callers can tell this apart
 * from a precise result by looking at `PageSentenceBBoxResult.degradation`
 * (count + per-paragraph notes).
 */
function fallbackSentenceFromItem(
    item: ContentItem,
    pageIndex: number,
    paragraphIndex: number,
): SentenceBBox {
    const bbox: RawBBox = {
        x: item.bbox.l,
        y: item.bbox.t,
        w: item.bbox.width,
        h: item.bbox.height,
    };
    const sentence: SentenceBBox = {
        pageIndex,
        paragraphIndex,
        sentenceIndex: 0,
        text: item.text,
        bboxes: [bbox],
        fragments: [
            {
                lineIndex: 0,
                text: item.text,
                bbox,
            },
        ],
    };
    if (item.type === "header") sentence.kind = "heading";
    return sentence;
}

/**
 * Build a single `SentenceBBox` for a heading paragraph, using one fragment
 * per detailed line so multi-line headings keep precise per-line geometry.
 *
 * Headings are intentionally never run through the sentence splitter — one
 * heading paragraph always produces exactly one sentence.
 */
function headingSentenceFromParagraph(
    paragraphText: ParagraphText,
    pageIndex: number,
    paragraphIndex: number,
): SentenceBBox {
    const fragments = paragraphText.lines.map((line, lineIndex) => ({
        lineIndex,
        text: line.text,
        bbox: line.bbox,
    }));
    return {
        pageIndex,
        paragraphIndex,
        sentenceIndex: 0,
        text: fragments.map((f) => f.text).join(" "),
        bboxes: fragments.map((f) => f.bbox),
        fragments,
        kind: "heading",
    };
}

/**
 * Resolve sentence ranges within a `ParagraphText` to `SentenceBBox[]`.
 *
 * Uses the same `sentenceToBoxes` core that `SentenceMapper` uses page-wide,
 * but with a paragraph-local line array so the `lineIndex` values refer to
 * the paragraph's lines.
 */
function resolveSentencesInParagraph(
    paragraphText: ParagraphText,
    pageIndex: number,
    paragraphIndex: number,
    splitter: SentenceSplitter,
): SentenceBBox[] {
    // Reuse the page-wide sentenceToBoxes by repackaging as a PageText view
    // of the paragraph. The line array is identical; the source indices are
    // already paragraph-local.
    const pageTextView: PageText = {
        text: paragraphText.text,
        source: paragraphText.source,
        lines: paragraphText.lines,
    };
    const ranges: SentenceRange[] = splitter(paragraphText.text, {
        source: paragraphText.source,
    });
    const out: SentenceBBox[] = [];
    for (const range of ranges) {
        const s = sentenceToBoxes(
            pageTextView,
            range,
            pageIndex,
            paragraphIndex,
            out.length,
        );
        if (s) out.push(s);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Top-level: page → paragraph-scoped sentences
// ---------------------------------------------------------------------------

/**
 * Options for `extractPageSentenceBBoxes`.
 */
export interface PageSentenceBBoxOptions {
    /**
     * Splitter callback. Defaults to `simpleRegexSentenceSplit` at this
     * layer. Worker callers resolve a sentencex-backed splitter from a
     * serializable config before invoking the mapper; tests and fixture
     * replay can still pass function-valued splitters directly. The
     * default is kept regex-only so the mapper module has no implicit WASM
     * dependency and stays trivially testable.
     */
    splitter?: SentenceSplitter;
    /**
     * BCP-47 / ISO 639-1 language code, used by callers higher up the
     * stack (e.g. `PDFExtractor.extract({ mode: "structured" })`) to
     * construct a language-tuned splitter. This field is informational
     * at the mapper layer — if `splitter` is set it takes precedence
     * and `language` is ignored.
     */
    language?: string;
    /** Forwarded to `detectParagraphs`. */
    paragraphSettings?: ParagraphDetectionSettings;
    /**
     * If provided, skip running columns + lines + paragraphs and reuse this
     * pre-computed result. Useful when the caller already ran the line /
     * paragraph pipeline for other reasons and wants to add sentence bboxes
     * without re-doing detection.
     *
     * Rotation handshake: when `pageRotation !== 0`, the supplied
     * `paragraphResult` is in the **upright working frame** (the
     * upstream `FilteredParagraphPipeline` rotated the raw page before
     * column/paragraph detection). The mapper normalizes the
     * `detailedPage` argument with the same rotation before
     * `buildDetailedLineLookup` so the bbox-key invariant holds, then
     * inverse-rotates every emitted bbox back to MuPDF frame using
     * `sourceWidth` / `sourceHeight`. Omitting these (or leaving
     * `pageRotation = 0`) preserves the existing un-rotated path.
     */
    precomputed?: {
        paragraphResult: PageParagraphResult;
        pageRotation?: RotationAngle;
        sourceWidth?: number;
        sourceHeight?: number;
    };
    /**
     * Cross-page analysis window for smart-removal and document-wide
     * style profiling. Currently informational at this layer (the
     * worker resolves the analysis page set upstream); kept here for
     * documentation parity with `PDFExtractor.extract({ mode:
     * "structured" })`.
     *   - 0 (default) = analyze only the target page
     *   - positive N  = ±N pages around the target page
     *   - Infinity    = whole document
     */
    analysisWindow?: number;
}

/**
 * Full pipeline: take a detailed page, run column + line + paragraph
 * detection, then produce paragraph-scoped sentence bboxes.
 *
 * This is the paragraph-scoped counterpart to
 * `SentenceMapper.extractSentenceBBoxes`. Either may be used; they do not
 * interfere with one another.
 */
export function extractPageSentenceBBoxes(
    detailedPageInput: RawPageDataDetailed,
    options: PageSentenceBBoxOptions = {},
): PageSentenceBBoxResult {
    const splitter = options.splitter ?? simpleRegexSentenceSplit;

    // Rotation handshake. When the caller pre-rotated their raw page
    // for column/paragraph detection, mirror the same rotation here so
    // the detailed lines used by `buildDetailedLineLookup` live in the
    // same frame as the precomputed paragraph lines they need to match
    // against. `sourceWidth` / `sourceHeight` are the original MuPDF
    // dims used to inverse-rotate every output bbox at the end.
    const pageRotation: RotationAngle = options.precomputed?.pageRotation ?? 0;
    const sourceWidth =
        options.precomputed?.sourceWidth ?? detailedPageInput.width;
    const sourceHeight =
        options.precomputed?.sourceHeight ?? detailedPageInput.height;
    const detailedPage =
        pageRotation === 0
            ? detailedPageInput
            : rotateRawPageDetailed(detailedPageInput, pageRotation).page;

    // 1. Column + line detection.
    //    `RawPageDataDetailed` is structurally a `RawPageData`, so the
    //    existing detectors accept it unchanged — they just ignore the
    //    extra `chars` field on each line.
    let paragraphResult: PageParagraphResult;
    if (options.precomputed?.paragraphResult) {
        paragraphResult = options.precomputed.paragraphResult;
        if (!paragraphResult.itemLines) {
            throw new Error(
                "[ParagraphSentenceMapper] precomputed.paragraphResult must " +
                "have itemLines set (call detectParagraphs with " +
                "{ trackItemLines: true })",
            );
        }
    } else {
        const columnResult = detectColumns(detailedPage);
        const lineResult = detectLinesOnPage(detailedPage, columnResult.columns);
        paragraphResult = detectParagraphs(
            lineResult,
            null,
            options.paragraphSettings ?? {},
            { paragraph: 0, header: 0 },
            { trackItemLines: true },
        );
    }

    const itemLines = paragraphResult.itemLines!;
    const detailedLookup = buildDetailedLineLookup(detailedPage);

    const paragraphs: ParagraphWithSentences[] = [];
    const flatSentences: SentenceBBox[] = [];
    let degradedCount = 0;
    const degradationNotes: DegradationNote[] = [];
    // Uncapped — `degradationNotes` itself is bounded by MAX_DEGRADATION_NOTES,
    // but the column-continuation pass needs to skip every degraded paragraph,
    // not just the first 50.
    const degradedItems = new Set<number>();
    const addNote = (note: DegradationNote) => {
        if (degradationNotes.length < MAX_DEGRADATION_NOTES) {
            degradationNotes.push(note);
        }
    };

    for (let i = 0; i < paragraphResult.items.length; i++) {
        const item = paragraphResult.items[i];
        const group = itemLines[i] ?? [];
        const detailedLines = collectDetailedLinesForParagraph(
            group,
            detailedLookup,
        );

        // Degradation path 1: paragraph could not be mapped back to any
        // detailed line. We still want a usable SentenceBBox for the
        // caller, so we emit a fallback covering the whole paragraph.
        if (detailedLines.length === 0) {
            degradedCount++;
            degradedItems.add(i);
            addNote({ itemIndex: i, itemType: item.type, reason: "unmapped" });
            const fallback = fallbackSentenceFromItem(item, detailedPage.pageIndex, i);
            paragraphs.push({
                item,
                paragraphText: {
                    text: item.text,
                    source: [],
                    lines: [],
                },
                sentences: [fallback],
            });
            flatSentences.push(fallback);
            continue;
        }

        // Degradation path 2: text/chars invariant failed on this paragraph.
        // Caught here so one bad line (ligature, astral-plane char) doesn't
        // crash the whole page.
        const built = tryBuildParagraphText(detailedLines);
        if (!built.ok) {
            degradedCount++;
            degradedItems.add(i);
            addNote({
                itemIndex: i,
                itemType: item.type,
                reason: "invariant_violation",
                message: built.error,
            });
            const fallback = fallbackSentenceFromItem(item, detailedPage.pageIndex, i);
            paragraphs.push({
                item,
                paragraphText: {
                    text: item.text,
                    source: [],
                    lines: detailedLines,
                },
                sentences: [fallback],
            });
            flatSentences.push(fallback);
            continue;
        }

        const paragraphText = built.paragraphText;

        // Heading path: never split a heading. One heading paragraph always
        // produces exactly one sentence, tagged kind: "heading".
        if (item.type === "header") {
            const heading = headingSentenceFromParagraph(
                paragraphText,
                detailedPage.pageIndex,
                i,
            );
            paragraphs.push({ item, paragraphText, sentences: [heading] });
            flatSentences.push(heading);
            continue;
        }

        // Happy path (body paragraph).
        const sentences = resolveSentencesInParagraph(
            paragraphText,
            detailedPage.pageIndex,
            i,
            splitter,
        );

        // Degradation path 3: splitter returned no sentences for a paragraph
        // with real content. Emit one fallback so the paragraph is still
        // addressable, but mark it degraded so the caller can tell.
        if (sentences.length === 0 && paragraphText.text.trim().length > 0) {
            degradedCount++;
            degradedItems.add(i);
            addNote({ itemIndex: i, itemType: item.type, reason: "empty_split" });
            const fallback = fallbackSentenceFromItem(item, detailedPage.pageIndex, i);
            paragraphs.push({ item, paragraphText, sentences: [fallback] });
            flatSentences.push(fallback);
            continue;
        }

        paragraphs.push({ item, paragraphText, sentences });
        flatSentences.push(...sentences);
    }

    // Mutates `joinWithNext` on last sentences of paragraphs whose successor
    // is the start of a sentence that crosses a column boundary. `paragraphs`
    // and `flatSentences` share SentenceBBox object identity, so the flag is
    // visible through both.
    //
    // Runs BEFORE the inverse-rotation step so the LTR geometric gate
    // in `nextStartsStrictlyRightOfPrev` (and similar geometric
    // heuristics) operates on upright bboxes — that's the frame those
    // gates were tuned for.
    annotateColumnContinuations(paragraphs, splitter, degradedItems);

    // Inverse-rotate every emitted bbox back to MuPDF frame so
    // downstream consumers (annotation rendering via
    // `applyRotationToBoundingBox`, search scoring, etc.) see the
    // same coord system regardless of whether the pipeline normalized
    // internally. `paragraphs` and `flatSentences` share SentenceBBox
    // identity — mutate once and both views update.
    if (pageRotation !== 0) {
        for (const p of paragraphs) {
            // ContentItem.bbox first: fallbackSentenceFromItem would
            // re-derive bboxes from it (already executed), but the
            // outward-facing `item.bbox` itself must also be MuPDF-frame.
            p.item.bbox = inverseRotateLineBBox(
                p.item.bbox,
                pageRotation,
                sourceWidth,
                sourceHeight,
            );
            for (const s of p.sentences) {
                for (let i = 0; i < s.bboxes.length; i++) {
                    s.bboxes[i] = inverseRotateRawBBox(
                        s.bboxes[i],
                        pageRotation,
                        sourceWidth,
                        sourceHeight,
                    );
                }
                if (s.fragments) {
                    for (const frag of s.fragments) {
                        frag.bbox = inverseRotateRawBBox(
                            frag.bbox,
                            pageRotation,
                            sourceWidth,
                            sourceHeight,
                        );
                    }
                }
            }
        }
    }

    return {
        pageIndex: detailedPage.pageIndex,
        // Report MuPDF-frame dims so downstream consumers (e.g. the
        // annotation layer's `applyRotationToBoundingBox`) get the
        // pre-normalization page geometry.
        width: sourceWidth,
        height: sourceHeight,
        paragraphs,
        sentences: flatSentences,
        degradation:
            degradedCount > 0
                ? { count: degradedCount, notes: degradationNotes }
                : undefined,
    };
}

// ---------------------------------------------------------------------------
// Column-continuation annotator (sets SentenceBBox.joinWithNext)
// ---------------------------------------------------------------------------

function startsWithLowercase(text: string): boolean {
    const trimmed = text.replace(/^\s+/u, "");
    if (!trimmed) return false;
    return /^\p{Ll}/u.test(trimmed);
}

/**
 * Returns true when `text` has more `(` than `)` — i.e. it ends inside an
 * unclosed parenthetical. Used as a structural continuation marker so the
 * column-boundary heuristic accepts mid-parenthetical splits whose right side
 * begins with a capitalized proper noun (e.g. "(for research on" / "NYC, see
 * Durán-Narucki 2008).") instead of being blocked by the lowercase-start gate.
 *
 * Square brackets and braces are intentionally not counted — the only
 * structurally common cross-column split shape we observe is round-paren
 * citations, and broadening the rule would invite false positives without
 * concrete fixture evidence.
 */
function hasUnclosedParen(text: string): boolean {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "(") depth++;
        else if (c === ")" && depth > 0) depth--;
    }
    return depth > 0;
}

/**
 * Geometric gate: in an LTR multi-column layout, a continuation paragraph in
 * column N+1 sits **entirely to the right** of column N's rightmost extent.
 * If `next`'s leftmost bbox starts to the left of (or overlaps with) `prev`'s
 * rightmost bbox edge, the two are not in a clean column-to-column relation
 * — typical false-positive shape is a full-width figure-caption / banner
 * paragraph (bbox spans both columns) followed by a left-column body
 * paragraph that resumes the previous page's text.
 *
 * Uses MAX(x+w) over `prev.bboxes` and MIN(x) over `next.bboxes` so multi-
 * fragment sentences (wrapped across several lines) are evaluated at their
 * widest extent, not just the last fragment.
 *
 * **LTR only.** The producer's other gates (lowercase-start in particular)
 * are already LTR-biased — RTL layouts and scripts without case never reach
 * here today. Documented as out of scope; revisit alongside RTL paragraph
 * detection.
 */
function nextStartsStrictlyRightOfPrev(
    prev: SentenceBBox,
    next: SentenceBBox,
): boolean {
    if (prev.bboxes.length === 0 || next.bboxes.length === 0) return false;
    let prevMaxRight = -Infinity;
    for (const b of prev.bboxes) {
        const right = b.x + b.w;
        if (right > prevMaxRight) prevMaxRight = right;
    }
    let nextMinLeft = Infinity;
    for (const b of next.bboxes) {
        if (b.x < nextMinLeft) nextMinLeft = b.x;
    }
    return nextMinLeft >= prevMaxRight;
}

/**
 * Decide whether a (last sentence, first sentence) pair across consecutive
 * columns should be joined. Pure heuristic — no I/O.
 */
function shouldJoinAcrossColumns(
    prev: SentenceBBox,
    next: SentenceBBox,
    splitter: SentenceSplitter,
): boolean {
    const lastText = prev.text;
    const firstText = next.text;

    // A trailing hyphen ("ge-" / "nomes") is a strong continuation indicator,
    // not a reason to skip — word-level rejoining is a downstream consumer
    // concern, not the producer's. Only sentence-final terminators block.
    if (hasSentenceFinalTerminator(lastText)) return false;
    // Gate 7: next must look like a continuation. Default test is "starts with
    // a lowercase letter". The unclosed-paren bypass covers the cross-column
    // parenthetical-citation case (see `hasUnclosedParen`); the splitter check
    // below still adjudicates either way.
    if (
        !startsWithLowercase(firstText) &&
        !hasUnclosedParen(lastText)
    ) {
        return false;
    }
    // Geometric gate: next paragraph must start strictly to the right of
    // prev's rightmost extent (LTR-only — see `nextStartsStrictlyRightOfPrev`).
    // Catches full-width figure-caption → left-column-body false positives.
    if (!nextStartsStrictlyRightOfPrev(prev, next)) return false;

    const left = lastText.replace(/\s+$/u, "");
    const right = firstText.replace(/^\s+/u, "");
    if (!left || !right) return false;
    const combined = `${left} ${right}`;

    const ranges = splitter(combined);
    if (ranges.length !== 1) return false;

    const r = ranges[0];
    // Splitter must cover the whole combined string (allowing trailing
    // whitespace, which `simpleRegexSentenceSplit` strips and sentencex may
    // also exclude). We accept a single range that starts at 0 and reaches
    // the trimmed end.
    if (r.start !== 0) return false;
    let end = combined.length;
    while (end > 0 && /\s/.test(combined[end - 1])) end--;
    return r.end >= end;
}

/**
 * Set `SentenceBBox.joinWithNext = true` on the last sentence of each
 * paragraph whose successor (in reading order) begins a sentence that
 * **continues** the previous one across a column boundary.
 *
 * Conservative: requires strictly consecutive columns (`col` → `col + 1`),
 * both sides body paragraphs, last sentence non-terminated, first sentence
 * lowercase-starting, and the splitter must agree the combined text is one
 * sentence. Only sets the flag — never writes `false` (omitted ≡ false per
 * `SentenceBBox.joinWithNext` contract). Stale `true` values from prior calls
 * on the same array are cleared at evaluation time so the helper is
 * idempotent under repeated invocation.
 *
 * Mutates `paragraphs[i].sentences[last].joinWithNext` in place. Because the
 * caller's `flatSentences` array shares SentenceBBox object identity with
 * `paragraphs[i].sentences`, the flag is observable through both.
 *
 * @internal Public surface is `extractPageSentenceBBoxes`; this helper is
 * exported for direct unit testing.
 */
export function annotateColumnContinuations(
    paragraphs: ParagraphWithSentences[],
    splitter: SentenceSplitter,
    degradedItems: ReadonlySet<number>,
): void {
    for (let i = 0; i < paragraphs.length - 1; i++) {
        const cur = paragraphs[i];
        const next = paragraphs[i + 1];
        const lastSentence = cur.sentences[cur.sentences.length - 1];

        // Always clear any stale flag before re-evaluating; only set on
        // success below. Prevents leftover `true` from a prior call on a
        // mutated test array.
        if (lastSentence) delete lastSentence.joinWithNext;

        if (!lastSentence) continue;
        if (cur.item.type !== "paragraph" || next.item.type !== "paragraph") {
            continue;
        }
        if (next.item.columnIndex !== cur.item.columnIndex + 1) continue;
        if (degradedItems.has(i) || degradedItems.has(i + 1)) continue;
        if (lastSentence.kind === "heading") continue;
        const firstSentence = next.sentences[0];
        if (!firstSentence) continue;
        if (firstSentence.kind === "heading") continue;

        if (shouldJoinAcrossColumns(lastSentence, firstSentence, splitter)) {
            lastSentence.joinWithNext = true;
        }
    }
}

// ---------------------------------------------------------------------------
// Feasibility report — mirrors SentenceMapper.buildFeasibilityReport
// ---------------------------------------------------------------------------

export interface ParagraphFeasibilityReport {
    pageIndex: number;
    totalParagraphs: number;
    totalHeaders: number;
    mappedParagraphs: number;
    /**
     * Degradation summary copied from `extractPageSentenceBBoxes`. Omitted
     * when no paragraphs degraded.
     */
    degradation?: DegradationSummary;
    totalSentences: number;
    multiFragmentSentences: number;
    invariantHolds: boolean;
    allBBoxesInPage: boolean;
    /** First N paragraphs with their sentence summaries, for inspection. */
    paragraphs: Array<{
        index: number;
        itemType: "paragraph" | "header";
        numLines: number;
        paragraphText: string;
        numSentences: number;
        sentences: Array<{
            text: string;
            numBBoxes: number;
            unionBBox: RawBBox;
        }>;
    }>;
}

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

export function buildParagraphFeasibilityReport(
    detailedPage: RawPageDataDetailed,
    options: PageSentenceBBoxOptions = {},
    maxParagraphs = 10,
    maxSentencesPerParagraph = 5,
): ParagraphFeasibilityReport {
    let invariantHolds = true;
    try {
        // Proactively validate text/chars lockstep — buildParagraphText will
        // throw if broken, but we also want a clean boolean for the report.
        for (const block of detailedPage.blocks) {
            if (block.type !== "text" || !block.lines) continue;
            for (const line of block.lines) {
                if (line.text.length !== line.chars.length) {
                    invariantHolds = false;
                    break;
                }
            }
            if (!invariantHolds) break;
        }
    } catch {
        invariantHolds = false;
    }

    const result = extractPageSentenceBBoxes(detailedPage, options);

    let multi = 0;
    let allBBoxesInPage = true;
    const tolerance = 1.0;
    for (const s of result.sentences) {
        if (s.bboxes.length > 1) multi++;
        for (const b of s.bboxes) {
            if (
                b.x < -tolerance ||
                b.y < -tolerance ||
                b.x + b.w > detailedPage.width + tolerance ||
                b.y + b.h > detailedPage.height + tolerance
            ) {
                allBBoxesInPage = false;
                break;
            }
        }
        if (!allBBoxesInPage) break;
    }

    const totalHeaders = result.paragraphs.filter((p) => p.item.type === "header").length;
    const totalParagraphs = result.paragraphs.length - totalHeaders;

    const previews = result.paragraphs.slice(0, maxParagraphs).map((p, idx) => ({
        index: idx,
        itemType: p.item.type,
        numLines: p.paragraphText.lines.length,
        paragraphText:
            p.paragraphText.text.length > 120
                ? p.paragraphText.text.slice(0, 120) + "…"
                : p.paragraphText.text,
        numSentences: p.sentences.length,
        sentences: p.sentences.slice(0, maxSentencesPerParagraph).map((s) => ({
            text: s.text.length > 80 ? s.text.slice(0, 80) + "…" : s.text,
            numBBoxes: s.bboxes.length,
            unionBBox: unionBBoxes(s.bboxes),
        })),
    }));

    return {
        pageIndex: detailedPage.pageIndex,
        totalParagraphs,
        totalHeaders,
        mappedParagraphs: result.paragraphs.length,
        degradation: result.degradation,
        totalSentences: result.sentences.length,
        multiFragmentSentences: multi,
        invariantHolds,
        allBBoxesInPage,
        paragraphs: previews,
    };
}
