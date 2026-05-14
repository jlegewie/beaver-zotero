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
    BoundingBox,
    DegradationNote,
    DegradationSummary,
    DocItem,
    ItemLine,
    RawLineDetailed,
    RawPageDataDetailed,
    SectionHeaderItem,
    SentenceItem,
    TextBearingItem,
    TextItem,
} from "./types";
import { bboxHeight, mergeBoxes } from "./types";
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
    inverseRotateBBox,
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

/** Result of running the full paragraph-scoped sentence pipeline on a page. */
export interface PageSentenceResult {
    pageIndex: number;
    width: number;
    height: number;
    items: DocItem[];
    sentences: SentenceItem[];
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
function bboxKey(b: BoundingBox): string {
    return `${b.l.toFixed(3)}|${b.t.toFixed(3)}|${b.r.toFixed(3)}|${b.b.toFixed(3)}|${b.origin}`;
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
        const height = bboxHeight(c.bbox);
        if (height > 0) heights.push(height);
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
                bboxHeight(ch.bbox) > 0 &&
                bboxHeight(ch.bbox) < superscriptThreshold;
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

function itemLinesFromDetailed(
    lines: RawLineDetailed[],
    fallbackText: string,
    fallbackBBox: BoundingBox,
): ItemLine[] {
    if (lines.length === 0) {
        return [{ text: fallbackText, bbox: fallbackBBox }];
    }
    return lines.map((line) => ({
        text: line.text,
        bbox: line.bbox,
        fontSize: line.font?.size,
    }));
}

function itemFromContentItem(
    item: ContentItem,
    pageIndex: number,
    index: number,
    lines: ItemLine[],
): TextItem | SectionHeaderItem {
    const base: Omit<TextBearingItem, "kind"> = {
        id: `p${pageIndex}:i${index}`,
        pageIndex,
        index,
        bbox: item.bbox,
        columnIndex: item.columnIndex,
        text: item.text,
        lines: lines.length > 0 ? lines : [{ text: item.text, bbox: item.bbox }],
    };
    if (item.type === "header") {
        return { ...base, kind: "section_header", level: 1 };
    }
    return { ...base, kind: "text" };
}

function fallbackSentenceFromItem(item: TextItem): SentenceItem {
    return {
        parentId: item.id,
        index: 0,
        text: item.text,
        bboxes: [item.bbox],
        fragments: [
            {
                lineIndex: 0,
                text: item.text,
                bbox: item.bbox,
            },
        ],
    };
}

/**
 * Resolve sentence ranges within a `ParagraphText` to `SentenceItem[]`.
 *
 * Uses the same `sentenceToBoxes` core that `SentenceMapper` uses page-wide,
 * but with a paragraph-local line array so the `lineIndex` values refer to
 * the paragraph's lines.
 */
function resolveSentencesInParagraph(
    paragraphText: ParagraphText,
    parentId: string,
    splitter: SentenceSplitter,
): SentenceItem[] {
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
    const out: SentenceItem[] = [];
    for (const range of ranges) {
        const s = sentenceToBoxes(
            pageTextView,
            range,
            0,
            out.length,
        );
        if (!s) continue;
        out.push({
            parentId,
            index: out.length,
            text: s.text,
            bboxes: s.bboxes,
            fragments: s.fragments,
        });
    }
    return out;
}

function itemSupportsSentences(item: DocItem): item is TextItem {
    return item.kind === "text";
}

function inverseRotateItem(
    item: DocItem,
    pageRotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): void {
    item.bbox = inverseRotateBBox(item.bbox, pageRotation, sourceWidth, sourceHeight);
    if ("lines" in item) {
        for (const line of item.lines) {
            line.bbox = inverseRotateBBox(line.bbox, pageRotation, sourceWidth, sourceHeight);
        }
    }
    if (itemSupportsSentences(item) && item.sentences) {
        for (const sentence of item.sentences) {
            for (let i = 0; i < sentence.bboxes.length; i++) {
                sentence.bboxes[i] = inverseRotateBBox(
                    sentence.bboxes[i],
                    pageRotation,
                    sourceWidth,
                    sourceHeight,
                );
            }
            for (const fragment of sentence.fragments ?? []) {
                fragment.bbox = inverseRotateBBox(
                    fragment.bbox,
                    pageRotation,
                    sourceWidth,
                    sourceHeight,
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Top-level: page → paragraph-scoped sentences
// ---------------------------------------------------------------------------

/**
 * Options for `extractPageSentences`.
 */
export interface PageSentenceOptions {
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
 * `SentenceMapper.extractPageWideSentences`. Either may be used; they do not
 * interfere with one another.
 */
export function extractPageSentences(
    detailedPageInput: RawPageDataDetailed,
    options: PageSentenceOptions = {},
): PageSentenceResult {
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

    const items: DocItem[] = [];
    const flatSentences: SentenceItem[] = [];
    let degradedCount = 0;
    const degradationNotes: DegradationNote[] = [];
    // Uncapped — `degradationNotes` itself is bounded by MAX_DEGRADATION_NOTES,
    // but the column-continuation pass needs to skip every degraded paragraph,
    // not just the first 50.
    const degradedItems = new Set<string>();
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
        // detailed line. We still want a usable SentenceItem for the
        // caller, so we emit a fallback covering the whole paragraph.
        if (detailedLines.length === 0) {
            const docItem = itemFromContentItem(
                item,
                detailedPage.pageIndex,
                i,
                [{ text: item.text, bbox: item.bbox }],
            );
            degradedCount++;
            degradedItems.add(docItem.id);
            addNote({ itemId: docItem.id, itemKind: docItem.kind, reason: "unmapped" });
            if (docItem.kind === "text") {
                const fallback = fallbackSentenceFromItem(docItem);
                docItem.sentences = [fallback];
                flatSentences.push(fallback);
            }
            items.push(docItem);
            continue;
        }

        // Degradation path 2: text/chars invariant failed on this paragraph.
        // Caught here so one bad line (ligature, astral-plane char) doesn't
        // crash the whole page.
        const built = tryBuildParagraphText(detailedLines);
        if (!built.ok) {
            const docItem = itemFromContentItem(
                item,
                detailedPage.pageIndex,
                i,
                [{ text: item.text, bbox: item.bbox }],
            );
            degradedCount++;
            degradedItems.add(docItem.id);
            addNote({
                itemId: docItem.id,
                itemKind: docItem.kind,
                reason: "invariant_violation",
                message: built.error,
            });
            if (docItem.kind === "text") {
                const fallback = fallbackSentenceFromItem(docItem);
                docItem.sentences = [fallback];
                flatSentences.push(fallback);
            }
            items.push(docItem);
            continue;
        }

        const paragraphText = built.paragraphText;
        const docItem = itemFromContentItem(
            item,
            detailedPage.pageIndex,
            i,
            itemLinesFromDetailed(detailedLines, item.text, item.bbox),
        );

        // Heading path: never split headings, and exclude them from the
        // flattened sentence view.
        if (docItem.kind === "section_header") {
            items.push(docItem);
            continue;
        }

        // Happy path (body paragraph).
        const sentences = resolveSentencesInParagraph(
            paragraphText,
            docItem.id,
            splitter,
        );

        // Degradation path 3: splitter returned no sentences for a paragraph
        // with real content. Emit one fallback so the paragraph is still
        // addressable, but mark it degraded so the caller can tell.
        if (sentences.length === 0 && paragraphText.text.trim().length > 0) {
            degradedCount++;
            degradedItems.add(docItem.id);
            addNote({ itemId: docItem.id, itemKind: docItem.kind, reason: "empty_split" });
            const fallback = fallbackSentenceFromItem(docItem);
            docItem.sentences = [fallback];
            flatSentences.push(fallback);
            items.push(docItem);
            continue;
        }

        docItem.sentences = sentences;
        flatSentences.push(...sentences);
        items.push(docItem);
    }

    // Mutates `joinWithNext` on last sentences of text items whose successor
    // is the start of a sentence that crosses a column boundary. `items`
    // and `flatSentences` share SentenceItem object identity, so the flag is
    // visible through both.
    //
    // Runs BEFORE the inverse-rotation step so the LTR geometric gate
    // in `nextStartsStrictlyRightOfPrev` (and similar geometric
    // heuristics) operates on upright bboxes — that's the frame those
    // gates were tuned for.
    annotateColumnContinuations(items, splitter, degradedItems);

    // Inverse-rotate every emitted bbox back to MuPDF frame so
    // downstream consumers see the same coord system regardless of whether
    // the pipeline normalized internally.
    if (pageRotation !== 0) {
        for (const item of items) {
            inverseRotateItem(item, pageRotation, sourceWidth, sourceHeight);
        }
    }

    return {
        pageIndex: detailedPage.pageIndex,
        // Report MuPDF-frame dims so downstream consumers (e.g. the
        // annotation layer's `applyRotationToBoundingBox`) get the
        // pre-normalization page geometry.
        width: sourceWidth,
        height: sourceHeight,
        items,
        sentences: flatSentences,
        degradation:
            degradedCount > 0
                ? { count: degradedCount, notes: degradationNotes }
                : undefined,
    };
}

// ---------------------------------------------------------------------------
// Column-continuation annotator (sets SentenceItem.joinWithNext)
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
    prev: SentenceItem,
    next: SentenceItem,
): boolean {
    if (prev.bboxes.length === 0 || next.bboxes.length === 0) return false;
    let prevMaxRight = -Infinity;
    for (const b of prev.bboxes) {
        if (b.r > prevMaxRight) prevMaxRight = b.r;
    }
    let nextMinLeft = Infinity;
    for (const b of next.bboxes) {
        if (b.l < nextMinLeft) nextMinLeft = b.l;
    }
    return nextMinLeft >= prevMaxRight;
}

/**
 * Decide whether a (last sentence, first sentence) pair across consecutive
 * columns should be joined. Pure heuristic — no I/O.
 */
function shouldJoinAcrossColumns(
    prev: SentenceItem,
    next: SentenceItem,
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
 * Set `SentenceItem.joinWithNext = true` on the last sentence of each text
 * item whose successor (in reading order) begins a sentence that continues
 * the previous one across a column boundary.
 *
 * Conservative: requires strictly consecutive columns (`col` → `col + 1`),
 * both sides text items, last sentence non-terminated, first sentence
 * lowercase-starting, and the splitter must agree the combined text is one
 * sentence. Only sets the flag — never writes `false` (omitted ≡ false per
 * `SentenceItem.joinWithNext` contract). Stale `true` values from prior calls
 * on the same array are cleared at evaluation time so the helper is
 * idempotent under repeated invocation.
 *
 * Mutates `items[i].sentences[last].joinWithNext` in place. Because the
 * caller's flat view shares SentenceItem object identity with
 * `items[i].sentences`, the flag is observable through both.
 *
 * @internal Public surface is `extractPageSentences`; this helper is
 * exported for direct unit testing.
 */
export function annotateColumnContinuations(
    items: DocItem[],
    splitter: SentenceSplitter,
    degradedItems: ReadonlySet<string>,
): void {
    for (let i = 0; i < items.length - 1; i++) {
        const cur = items[i];
        const next = items[i + 1];
        const curSentences = itemSupportsSentences(cur) ? cur.sentences ?? [] : [];
        const nextSentences = itemSupportsSentences(next) ? next.sentences ?? [] : [];
        const lastSentence = curSentences[curSentences.length - 1];

        // Always clear any stale flag before re-evaluating; only set on
        // success below. Prevents leftover `true` from a prior call on a
        // mutated test array.
        if (lastSentence) delete lastSentence.joinWithNext;

        if (!lastSentence) continue;
        if (cur.kind !== "text" || next.kind !== "text") {
            continue;
        }
        if (next.columnIndex !== cur.columnIndex + 1) continue;
        if (degradedItems.has(cur.id) || degradedItems.has(next.id)) continue;
        const firstSentence = nextSentences[0];
        if (!firstSentence) continue;

        if (shouldJoinAcrossColumns(lastSentence, firstSentence, splitter)) {
            lastSentence.joinWithNext = true;
        }
    }
}

// ---------------------------------------------------------------------------
// Feasibility report — mirrors SentenceMapper.buildFeasibilityReport
// ---------------------------------------------------------------------------

export interface PageSentenceFeasibilityReport {
    pageIndex: number;
    itemCount: number;
    itemsByKind: Partial<Record<DocItem["kind"], number>>;
    /**
     * Degradation summary copied from `extractPageSentences`. Omitted
     * when no items degraded.
     */
    degradation?: DegradationSummary;
    totalSentences: number;
    multiFragmentSentences: number;
    invariantHolds: boolean;
    allBBoxesInPage: boolean;
    /** First N items with their sentence summaries, for inspection. */
    items: Array<{
        index: number;
        itemKind: DocItem["kind"];
        numLines: number;
        text: string;
        numSentences: number;
        sentences: Array<{
            text: string;
            numBBoxes: number;
            unionBBox: BoundingBox;
        }>;
    }>;
}

function unionBBoxes(bboxes: BoundingBox[]): BoundingBox {
    return mergeBoxes(bboxes);
}

export function buildPageSentenceFeasibilityReport(
    detailedPage: RawPageDataDetailed,
    options: PageSentenceOptions = {},
    maxParagraphs = 10,
    maxSentencesPerParagraph = 5,
): PageSentenceFeasibilityReport {
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

    const result = extractPageSentences(detailedPage, options);

    let multi = 0;
    let allBBoxesInPage = true;
    const tolerance = 1.0;
    for (const s of result.sentences) {
        if (s.bboxes.length > 1) multi++;
        for (const b of s.bboxes) {
            if (
                b.l < -tolerance ||
                b.t < -tolerance ||
                b.r > detailedPage.width + tolerance ||
                b.b > detailedPage.height + tolerance
            ) {
                allBBoxesInPage = false;
                break;
            }
        }
        if (!allBBoxesInPage) break;
    }

    const itemsByKind: Partial<Record<DocItem["kind"], number>> = {};
    for (const item of result.items) {
        itemsByKind[item.kind] = (itemsByKind[item.kind] ?? 0) + 1;
    }

    const previews = result.items.slice(0, maxParagraphs).map((item, idx) => {
        const sentences = itemSupportsSentences(item) ? item.sentences ?? [] : [];
        return {
            index: idx,
            itemKind: item.kind,
            numLines: "lines" in item ? item.lines.length : 0,
            text:
                "text" in item && item.text.length > 120
                    ? item.text.slice(0, 120) + "…"
                    : "text" in item ? item.text : "",
            numSentences: sentences.length,
            sentences: sentences.slice(0, maxSentencesPerParagraph).map((s) => ({
                text: s.text.length > 80 ? s.text.slice(0, 80) + "…" : s.text,
                numBBoxes: s.bboxes.length,
                unionBBox: unionBBoxes(s.bboxes),
            })),
        };
    });

    return {
        pageIndex: detailedPage.pageIndex,
        itemCount: result.items.length,
        itemsByKind,
        degradation: result.degradation,
        totalSentences: result.sentences.length,
        multiFragmentSentences: multi,
        invariantHolds,
        allBBoxesInPage,
        items: previews,
    };
}
