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
    simpleRegexSentenceSplit,
    sentenceToBoxes,
    type PageText,
    type SentenceRange,
    type SentenceSplitter,
} from "./SentenceMapper";

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
     * Paragraphs the mapper could not resolve to detailed lines.
     * Non-zero values here usually indicate bbox-matching drift between the
     * JSON pass and the walk pass (see `buildDetailedLineLookup`).
     * These paragraphs contribute a fallback sentence instead of being dropped.
     */
    unmappedParagraphs: number;
    /**
     * Paragraphs that hit a text/chars invariant violation (ligature or
     * astral-plane edge case). These paragraphs contribute a fallback
     * whole-paragraph bbox using the `ContentItem.text` as the sentence text.
     */
    degradedParagraphs: number;
    /**
     * Per-degradation notes for logging / diagnostics. Bounded; see
     * `MAX_DEGRADATION_NOTES`.
     */
    degradationNotes: DegradationNote[];
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
 * (and surfaced to the caller through `unmappedParagraphs`), which keeps the
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
 */
export function buildParagraphText(
    lines: RawLineDetailed[],
): ParagraphText {
    const textParts: string[] = [];
    const source: ParagraphText["source"] = [];
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (line.text.length !== line.chars.length) {
            throw new Error(
                `[ParagraphSentenceMapper] text/chars length mismatch on line ${li}: ` +
                `text.length=${line.text.length}, chars.length=${line.chars.length}`,
            );
        }
        for (let ci = 0; ci < line.chars.length; ci++) {
            textParts.push(line.chars[ci].c);
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
 * from a precise result by looking at `PageSentenceBBoxResult.degradedParagraphs`
 * or `.degradationNotes`.
 */
function fallbackSentenceFromItem(
    item: ContentItem,
    pageIndex: number,
): SentenceBBox {
    const bbox: RawBBox = {
        x: item.bbox.l,
        y: item.bbox.t,
        w: item.bbox.width,
        h: item.bbox.height,
    };
    return {
        pageIndex,
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
    const ranges: SentenceRange[] = splitter(paragraphText.text);
    const out: SentenceBBox[] = [];
    for (const range of ranges) {
        const s = sentenceToBoxes(pageTextView, range, pageIndex);
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
     * layer; production callers should construct a sentencex-backed
     * splitter via `getSentenceSplitterWithFallback(language)` and pass
     * it in. The default is kept regex-only so the mapper module has no
     * implicit WASM dependency and stays trivially testable.
     */
    splitter?: SentenceSplitter;
    /**
     * BCP-47 / ISO 639-1 language code, used by callers higher up the
     * stack (e.g. `PDFExtractor.extractSentenceBBoxes`) to construct a
     * language-tuned splitter. This field is informational at the
     * mapper layer — if `splitter` is set it takes precedence and
     * `language` is ignored.
     */
    language?: string;
    /** Forwarded to `detectParagraphs`. */
    paragraphSettings?: ParagraphDetectionSettings;
    /**
     * If provided, skip running columns + lines + paragraphs and reuse this
     * pre-computed result. Useful when the caller already ran the line /
     * paragraph pipeline for other reasons and wants to add sentence bboxes
     * without re-doing detection.
     */
    precomputed?: {
        paragraphResult: PageParagraphResult;
    };
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
    detailedPage: RawPageDataDetailed,
    options: PageSentenceBBoxOptions = {},
): PageSentenceBBoxResult {
    const splitter = options.splitter ?? simpleRegexSentenceSplit;

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
    let unmappedParagraphs = 0;
    let degradedParagraphs = 0;
    const degradationNotes: DegradationNote[] = [];
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
            unmappedParagraphs++;
            addNote({ itemIndex: i, itemType: item.type, reason: "unmapped" });
            const fallback = fallbackSentenceFromItem(item, detailedPage.pageIndex);
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
            degradedParagraphs++;
            addNote({
                itemIndex: i,
                itemType: item.type,
                reason: "invariant_violation",
                message: built.error,
            });
            const fallback = fallbackSentenceFromItem(item, detailedPage.pageIndex);
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

        // Happy path.
        const paragraphText = built.paragraphText;
        const sentences = resolveSentencesInParagraph(
            paragraphText,
            detailedPage.pageIndex,
            splitter,
        );

        // Degradation path 3: splitter returned no sentences for a paragraph
        // with real content. Emit one fallback so the paragraph is still
        // addressable, but mark it degraded so the caller can tell.
        if (sentences.length === 0 && paragraphText.text.trim().length > 0) {
            degradedParagraphs++;
            addNote({ itemIndex: i, itemType: item.type, reason: "empty_split" });
            const fallback = fallbackSentenceFromItem(item, detailedPage.pageIndex);
            paragraphs.push({ item, paragraphText, sentences: [fallback] });
            flatSentences.push(fallback);
            continue;
        }

        paragraphs.push({ item, paragraphText, sentences });
        flatSentences.push(...sentences);
    }

    return {
        pageIndex: detailedPage.pageIndex,
        width: detailedPage.width,
        height: detailedPage.height,
        paragraphs,
        sentences: flatSentences,
        unmappedParagraphs,
        degradedParagraphs,
        degradationNotes,
    };
}

// ---------------------------------------------------------------------------
// Feasibility report — mirrors SentenceMapper.buildFeasibilityReport
// ---------------------------------------------------------------------------

export interface ParagraphFeasibilityReport {
    pageIndex: number;
    totalParagraphs: number;
    totalHeaders: number;
    mappedParagraphs: number;
    unmappedParagraphs: number;
    degradedParagraphs: number;
    totalSentences: number;
    multiFragmentSentences: number;
    invariantHolds: boolean;
    allBBoxesInPage: boolean;
    /** Diagnostic notes for degraded paragraphs (capped). */
    degradationNotes: DegradationNote[];
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
        unmappedParagraphs: result.unmappedParagraphs,
        degradedParagraphs: result.degradedParagraphs,
        totalSentences: result.sentences.length,
        multiFragmentSentences: multi,
        invariantHolds,
        allBBoxesInPage,
        degradationNotes: result.degradationNotes,
        paragraphs: previews,
    };
}
