/**
 * Item feature extraction for the Beaver Extract item classifier.
 *
 * Turns one page's detected items into fixed-length numeric vectors that
 * a small linear model can score. The function is pure, deterministic and
 * worker-legal: it reads only sibling modules and
 * `@beaver/agent-core/extract/*`, touches no host API, and never returns
 * a non-finite number.
 *
 * The vector layout is the contract between this module, the training
 * export and any shipped weights: {@link FEATURE_NAMES} defines the order
 * and {@link FEATURE_VERSION} is bumped whenever that order changes or a
 * feature's meaning changes. Appending a feature is still a version bump —
 * standardization statistics are positional.
 *
 * Coordinates: features are computed in whatever frame the paragraph
 * detector produced (the upright working frame on rotated pages). Every
 * geometric feature is a ratio against a threshold from the same frame, so
 * the values are frame-independent.
 */

import type { ContentItem, ColumnThresholds, PageThresholds } from "../ParagraphDetector";
import { looksLikeAuthorList, looksLikeJournalCitation } from "../ParagraphDetector";
import type { PageLine } from "../LineDetector";
import { resolveFontFlags } from "../StyleAnalyzer";
import {
    countInternalNumberedMarkers,
    hasReferenceStart,
    hasReferenceTail,
    isReferenceParagraph,
} from "../sentencePostprocess";
import {
    createDocContext,
    looksLikeReferenceHeader,
    updateDocContext,
    type DocContext,
} from "./docContext";
import type { StyleProfile } from "@beaver/agent-core/extract/types";
import { bboxHeight, bboxWidth, styleToKey } from "@beaver/agent-core/extract/types";

/**
 * Version of the feature contract. Bump on any change to
 * {@link FEATURE_NAMES}, to a feature's definition, or to the helpers a
 * feature is derived from.
 */
export const FEATURE_VERSION = 1;

/**
 * Feature names in vector order. `features[i]` is `FEATURE_NAMES[i]`.
 *
 * Naming conventions: `has*` / `is*` / `matches*` are 0/1 indicators,
 * `*Ratio` / `*Fraction` are bounded in roughly [0, 1], `*FontUnits` are
 * lengths divided by the item's font size, and `*Log` are `log1p` of a
 * count (so a single huge value cannot dominate a linear model).
 */
export const FEATURE_NAMES: readonly string[] = [
    // --- Geometry -----------------------------------------------------
    "lineCount",
    "isSingleLine",
    "hangingIndentFontUnits",
    "hasHangingIndent",
    "firstLineLeftOffsetFontUnits",
    "continuationLeftOffsetFontUnits",
    "itemWidthOverColumnWidth",
    "lastLineFillRatio",
    "raggedEndFontUnits",
    "minInteriorLineFillRatio",
    "gapAboveOverMedianGap",
    "gapBelowOverMedianGap",
    "gapAboveOverColumnThreshold",
    "gapBelowOverColumnThreshold",
    "internalLeadingOverMedianGap",
    "yCenterOnPage",
    "pageIndexRatio",
    "pagesFromDocEndLog",
    // --- Typography ---------------------------------------------------
    "fontSizeOverBodySize",
    "italicCharFraction",
    "boldCharFraction",
    "fontChangeCount",
    "matchesBodyStyle",
    "matchesPrimaryBodyStyle",
    "isHeaderItem",
    // --- Text ---------------------------------------------------------
    "hasReferenceStart",
    "hasReferenceTail",
    "isReferenceParagraph",
    "internalNumberedMarkerCountLog",
    "looksLikeAuthorList",
    "looksLikeJournalCitation",
    "yearTokenCountLog",
    "hasYearToken",
    "digitDensity",
    "commasPerToken",
    "periodsPerToken",
    "capitalizedTokenRatio",
    "initialsPatternCountLog",
    "hasEtAl",
    "hasPagesOrVolumeMarker",
    "hasPageRange",
    "hasDoiOrUrl",
    "hasPmidOrArxiv",
    "hasLeaderMarker",
    "quoteCountPer100Chars",
    "ampersandCountPer100Chars",
    "endsWithPeriod",
    "endsWithDigit",
    "startsLowercase",
    "charLengthLog",
    "tokenCountLog",
    // --- Context ------------------------------------------------------
    "prevItemRefScore",
    "prevItem2RefScore",
    "nextItemRefScore",
    "nextItem2RefScore",
    "hangingRunLengthLog",
    "hangingRunFraction",
    "pageRefLikeFraction",
    "refHeaderSeenBefore",
    "docRefLikeFraction",
];

/** Per-page input for {@link computeItemFeatures}. */
export interface ItemFeatureInput {
    /** Document page index (0-based) of the page being featurized. */
    pageIndex: number;
    /** Total pages in the source document. */
    pageCount: number;
    /** Page dimensions in the same frame as the item bboxes. */
    pageWidth: number;
    pageHeight: number;
    /** Detected items in reading order. */
    items: readonly ContentItem[];
    /** Constituent lines per item, aligned with `items` by index. */
    itemLines: ReadonlyArray<readonly PageLine[]>;
    /** Page-wide thresholds the paragraph detector used. */
    pageThresholds: PageThresholds;
    /** Per-column thresholds, keyed by `ContentItem.columnIndex`. */
    columnThresholds: Readonly<Record<number, ColumnThresholds>>;
    /** Document-wide typography profile. */
    styleProfile: StyleProfile;
    /** Context accumulated over the pages processed before this one. */
    docContext?: DocContext;
}

/** One item's feature vector plus the identity needed to join it to a label. */
export interface ItemFeatureRow {
    /** `ContentItem.id` — matches the emitted `DocItem.id` for this item. */
    itemId: string;
    /** Page-local item index, aligned with `ItemFeatureInput.items`. */
    index: number;
    /** Column the item was detected in. */
    columnIndex: number;
    /** Item text exactly as the text features saw it (heading marker removed). */
    text: string;
    /** Vector of length `FEATURE_NAMES.length`; every entry is finite. */
    features: number[];
    /** Ids of the neighbor items whose scores fed the context features. */
    neighborIds: { prev: string[]; next: string[] };
}

export interface ItemFeatureResult {
    rows: ItemFeatureRow[];
    /**
     * Document context advanced by this page. Pass it as the next page's
     * `docContext` to keep the running document features meaningful.
     */
    docContext: DocContext;
}

// ---------------------------------------------------------------------------
// Text patterns
// ---------------------------------------------------------------------------

const YEAR_RE = /\b(?:1[5-9]\d{2}|20\d{2})[a-z]?\b/g;
/** Standalone initial ("J.") or glued surname-initial group ("CM,"). */
const INITIALS_RE = /(?:^|[\s,(])(?:\p{Lu}\.(?=[\s,)]|$)|\p{Lu}{1,3},)/gu;
const ET_AL_RE = /\bet\s+al\b/i;
const PAGES_OR_VOLUME_RE = /\b(?:pp?\.\s*\d|vols?\.?\s*\d|nos?\.?\s*\d|ed(?:s|n)?\.\s)/i;
const PAGE_RANGE_RE = /\b\d{1,5}\s*[-–—]\s*\d{1,5}\b/;
const DOI_URL_RE = /(?:\bdoi\b|10\.\d{4,9}\/|https?:\/\/|\bwww\.)/i;
const PMID_ARXIV_RE = /\b(?:pmid|pmcid|arxiv|isbn|issn)\b/i;
const LEADER_MARKER_RE = /^\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)])\s/;
const QUOTE_RE = /["“”«»„]/g;
const AMPERSAND_RE = /&/g;
const DIGIT_RE = /\p{Nd}/gu;

// ---------------------------------------------------------------------------
// Numeric guards
// ---------------------------------------------------------------------------

/**
 * Hard bound on any feature value. Geometry ratios can blow up on
 * degenerate pages (a zero-width column, a zero median gap); clamping
 * keeps a single pathological page from dominating training.
 */
const FEATURE_LIMIT = 1e4;

function clampFeature(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value > FEATURE_LIMIT) return FEATURE_LIMIT;
    if (value < -FEATURE_LIMIT) return -FEATURE_LIMIT;
    return value;
}

/** Division that returns 0 rather than NaN/Infinity on a degenerate divisor. */
function safeRatio(numerator: number, denominator: number): number {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return 0;
    if (Math.abs(denominator) < 1e-6) return 0;
    return clampFeature(numerator / denominator);
}

function indicator(value: boolean): number {
    return value ? 1 : 0;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

function countMatches(text: string, pattern: RegExp): number {
    // Fresh RegExp per call: the module-level globals carry `lastIndex`
    // state that would otherwise leak between items.
    const re = new RegExp(pattern.source, pattern.flags);
    let count = 0;
    while (re.exec(text) !== null) {
        count++;
        if (re.lastIndex === 0) break;
    }
    return count;
}

// ---------------------------------------------------------------------------
// Per-item intermediates
// ---------------------------------------------------------------------------

/** Font-size in points for the item, with a body-style fallback. */
function resolveFontSize(lines: readonly PageLine[], bodySize: number): number {
    const sizes = lines
        .map((line) => line.fontSize)
        .filter((size): size is number => typeof size === "number" && size > 0);
    if (sizes.length > 0) return median(sizes);
    return bodySize > 0 ? bodySize : 12;
}

interface TypographySummary {
    italicCharFraction: number;
    boldCharFraction: number;
    fontChangeCount: number;
    dominantStyleKey: string | null;
    dominantStyleSize: number;
}

function summarizeTypography(
    lines: readonly PageLine[],
    fallbackSize: number,
): TypographySummary {
    let totalChars = 0;
    let italicChars = 0;
    let boldChars = 0;
    let fontChangeCount = 0;
    let previousFont: string | null = null;
    const styleChars = new Map<string, { chars: number; size: number }>();

    for (const line of lines) {
        for (const span of line.spans) {
            const chars = span.text.length;
            if (chars === 0) continue;
            const fontName = span.fontName || "unknown";
            const { bold, italic } = resolveFontFlags(
                fontName,
                span.fontWeight,
                span.fontStyle,
            );
            const size = Math.round(span.size ?? line.fontSize ?? fallbackSize);
            totalChars += chars;
            if (italic) italicChars += chars;
            if (bold) boldChars += chars;
            if (previousFont !== null && previousFont !== fontName) {
                fontChangeCount++;
            }
            previousFont = fontName;

            const key = styleToKey({ size, font: fontName, bold, italic });
            const entry = styleChars.get(key);
            if (entry) {
                entry.chars += chars;
            } else {
                styleChars.set(key, { chars, size });
            }
        }
    }

    let dominantStyleKey: string | null = null;
    let dominantStyleSize = fallbackSize;
    let dominantChars = 0;
    for (const [key, entry] of styleChars) {
        if (entry.chars > dominantChars) {
            dominantChars = entry.chars;
            dominantStyleKey = key;
            dominantStyleSize = entry.size;
        }
    }

    return {
        italicCharFraction: safeRatio(italicChars, totalChars),
        boldCharFraction: safeRatio(boldChars, totalChars),
        fontChangeCount,
        dominantStyleKey,
        dominantStyleSize,
    };
}

/** The reference-shape regex signals for one item's text, computed once. */
interface ReferenceTextSignals {
    start: boolean;
    tail: boolean;
    paragraph: boolean;
    internalMarkerCount: number;
}

function referenceTextSignals(text: string): ReferenceTextSignals {
    return {
        start: hasReferenceStart(text),
        tail: hasReferenceTail(text),
        paragraph: isReferenceParagraph(text),
        internalMarkerCount: countInternalNumberedMarkers(text),
    };
}

/**
 * Regex-only "how reference-shaped is this text" score in [0, 1]. Used for
 * the neighbor-context features so a neighbor contributes one number
 * rather than its whole vector.
 */
function referenceRegexScore(signals: ReferenceTextSignals): number {
    const full = signals.paragraph ? 0.5 : 0;
    const start = signals.start ? 0.25 : 0;
    const tail = signals.tail ? 0.25 : 0;
    return full + start + tail;
}

/** Multi-line items whose continuation lines are indented past the first. */
const HANGING_INDENT_MIN_FONT_UNITS = 0.4;

/**
 * The paragraph detector prefixes heading text with a markdown marker
 * (`## `). Text features must see the bare words, otherwise every
 * start-anchored signal (reference start, leader marker, lowercase start)
 * reads as absent for a heading-classified item — including the one-line
 * reference entries the detector sometimes promotes to headings.
 */
const HEADING_MARKER_RE = /^#{1,6}\s+/;

function itemFeatureText(item: ContentItem): string {
    const text = item.text.trim();
    return item.type === "header" ? text.replace(HEADING_MARKER_RE, "").trim() : text;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Compute one feature vector per item on a page.
 *
 * Returns the rows plus the document context advanced by this page, so a
 * multi-page driver can thread context forward without recomputing the
 * per-item regexes.
 */
export function computeItemFeatures(input: ItemFeatureInput): ItemFeatureResult {
    const docContext = input.docContext ?? createDocContext();
    const items = input.items;
    if (items.length === 0) {
        return { rows: [], docContext };
    }

    const bodySize = input.styleProfile.primaryBodyStyle?.size ?? 12;
    const bodyStyleKeys = new Set(
        input.styleProfile.bodyStyles.map((style) => styleToKey(style)),
    );
    const primaryStyleKey = input.styleProfile.primaryBodyStyle
        ? styleToKey(input.styleProfile.primaryBodyStyle)
        : null;

    // Pass 1: per-item text scores and geometric shape, needed before the
    // context features can be assembled.
    const trimmedTexts = items.map(itemFeatureText);
    const textSignals = trimmedTexts.map((text) => referenceTextSignals(text));
    const refScores = textSignals.map((signals) => referenceRegexScore(signals));
    const refLike = textSignals.map((signals) => signals.paragraph);
    const fontSizes = items.map((_, i) =>
        resolveFontSize(input.itemLines[i] ?? [], bodySize),
    );
    const hangingIndents = items.map((_item, i) => {
        const lines = input.itemLines[i] ?? [];
        if (lines.length < 2) return 0;
        const firstLeft = lines[0].bbox.l;
        let minContinuationLeft = Infinity;
        for (let k = 1; k < lines.length; k++) {
            if (lines[k].bbox.l < minContinuationLeft) {
                minContinuationLeft = lines[k].bbox.l;
            }
        }
        if (!Number.isFinite(minContinuationLeft)) return 0;
        return safeRatio(minContinuationLeft - firstLeft, fontSizes[i]);
    });
    const hasHanging = hangingIndents.map(
        (value, i) =>
            (input.itemLines[i]?.length ?? 0) >= 2 &&
            value >= HANGING_INDENT_MIN_FONT_UNITS,
    );

    // Run length of consecutive hanging-indent items within a column.
    // Single-line entries break a run — a limitation worth knowing when
    // reading the feature, but reference lists wrap often enough that the
    // signal still fires across a bibliography.
    const runLength = new Array<number>(items.length).fill(0);
    const columnSize = new Map<number, number>();
    const byColumn = new Map<number, number[]>();
    for (let i = 0; i < items.length; i++) {
        const column = items[i].columnIndex;
        const bucket = byColumn.get(column);
        if (bucket) bucket.push(i);
        else byColumn.set(column, [i]);
    }
    for (const [column, indices] of byColumn) {
        columnSize.set(column, indices.length);
        let start = 0;
        while (start < indices.length) {
            if (!hasHanging[indices[start]]) {
                start++;
                continue;
            }
            let end = start;
            while (end < indices.length && hasHanging[indices[end]]) end++;
            const length = end - start;
            for (let k = start; k < end; k++) runLength[indices[k]] = length;
            start = end;
        }
    }

    // Previous / next item in the same column, for gap measurements.
    const prevInColumn = new Array<number>(items.length).fill(-1);
    const nextInColumn = new Array<number>(items.length).fill(-1);
    for (const indices of byColumn.values()) {
        for (let k = 0; k < indices.length; k++) {
            if (k > 0) prevInColumn[indices[k]] = indices[k - 1];
            if (k < indices.length - 1) nextInColumn[indices[k]] = indices[k + 1];
        }
    }

    const pageRefLikeCount = refLike.reduce(
        (sum, value) => sum + (value ? 1 : 0),
        0,
    );
    const pageRefLikeFraction = safeRatio(pageRefLikeCount, items.length);
    const docRefLikeFraction = safeRatio(
        docContext.referenceLikeCount,
        docContext.itemCount,
    );

    // A reference heading earlier on THIS page counts too, so the first
    // entry under "References" already sees the flag.
    const headerSeenBefore = new Array<boolean>(items.length);
    let seen = docContext.referenceHeaderSeen;
    let pageHasReferenceHeader = false;
    for (let i = 0; i < items.length; i++) {
        headerSeenBefore[i] = seen;
        const isHeading = items[i].type === "header";
        if (looksLikeReferenceHeader(trimmedTexts[i], { isHeading })) {
            seen = true;
            pageHasReferenceHeader = true;
        }
    }

    const pageMedianGap = input.pageThresholds.medianGap;
    const rows: ItemFeatureRow[] = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const lines = input.itemLines[i] ?? [];
        const text = trimmedTexts[i];
        const fontSize = fontSizes[i];
        const column = input.columnThresholds[item.columnIndex];
        const columnWidth = column
            ? column.maxRightEdge - column.leftEdgeMode
            : input.pageWidth;
        const leftEdgeMode = column ? column.leftEdgeMode : item.bbox.l;
        const maxRightEdge = column ? column.maxRightEdge : item.bbox.r;
        const gapThreshold = column
            ? column.gapExcessThreshold
            : input.pageThresholds.gapExcessThreshold;

        const firstLine = lines[0];
        const lastLine = lines[lines.length - 1];
        const firstLeft = firstLine ? firstLine.bbox.l : item.bbox.l;
        const lastRight = lastLine ? lastLine.bbox.r : item.bbox.r;
        let minContinuationLeft = firstLeft;
        if (lines.length >= 2) {
            minContinuationLeft = Infinity;
            for (let k = 1; k < lines.length; k++) {
                if (lines[k].bbox.l < minContinuationLeft) {
                    minContinuationLeft = lines[k].bbox.l;
                }
            }
        }

        // How completely each non-final line reaches the column margin.
        // Reference entries and body paragraphs both fill their interior
        // lines; short stacked items (addresses, list labels) do not.
        let minInteriorFill = 1;
        for (let k = 0; k < lines.length - 1; k++) {
            const fill = safeRatio(lines[k].bbox.r - leftEdgeMode, columnWidth);
            if (fill < minInteriorFill) minInteriorFill = fill;
        }
        if (lines.length < 2) minInteriorFill = 0;

        const internalGaps: number[] = [];
        for (let k = 0; k < lines.length - 1; k++) {
            internalGaps.push(lines[k + 1].bbox.t - lines[k].bbox.b);
        }

        // Missing neighbor ⇒ stand in the page median gap, which reads as a
        // neutral 1.0 against `medianGap` instead of a spurious zero.
        const previous = prevInColumn[i];
        const next = nextInColumn[i];
        const gapAbove =
            previous >= 0 ? item.bbox.t - items[previous].bbox.b : pageMedianGap;
        const gapBelow =
            next >= 0 ? items[next].bbox.t - item.bbox.b : pageMedianGap;

        const typography = summarizeTypography(lines, bodySize);
        const tokens = text.length > 0 ? text.split(/\s+/).filter(Boolean) : [];
        const tokenCount = tokens.length;
        const capitalizedTokens = tokens.filter((token) =>
            /^\p{Lu}/u.test(token),
        ).length;
        const digitCount = countMatches(text, DIGIT_RE);
        const commaCount = (text.match(/,/g) || []).length;
        const periodCount = (text.match(/\./g) || []).length;
        const yearCount = countMatches(text, YEAR_RE);
        const initialsCount = countMatches(text, INITIALS_RE);
        const quoteCount = countMatches(text, QUOTE_RE);
        const ampersandCount = countMatches(text, AMPERSAND_RE);
        const lastChar = text.slice(-1);

        const features: number[] = [
            // --- Geometry -------------------------------------------------
            lines.length,
            indicator(lines.length <= 1),
            hangingIndents[i],
            indicator(hasHanging[i]),
            safeRatio(firstLeft - leftEdgeMode, fontSize),
            safeRatio(minContinuationLeft - leftEdgeMode, fontSize),
            safeRatio(bboxWidth(item.bbox), columnWidth),
            safeRatio(lastRight - leftEdgeMode, columnWidth),
            safeRatio(maxRightEdge - lastRight, fontSize),
            clampFeature(minInteriorFill),
            safeRatio(gapAbove, pageMedianGap),
            safeRatio(gapBelow, pageMedianGap),
            safeRatio(gapAbove, gapThreshold),
            safeRatio(gapBelow, gapThreshold),
            safeRatio(median(internalGaps), pageMedianGap),
            safeRatio(
                item.bbox.t + bboxHeight(item.bbox) / 2,
                input.pageHeight,
            ),
            safeRatio(input.pageIndex, Math.max(1, input.pageCount - 1)),
            clampFeature(
                Math.log1p(Math.max(0, input.pageCount - 1 - input.pageIndex)),
            ),
            // --- Typography -----------------------------------------------
            safeRatio(fontSize, bodySize),
            typography.italicCharFraction,
            typography.boldCharFraction,
            typography.fontChangeCount,
            indicator(
                typography.dominantStyleKey !== null &&
                    bodyStyleKeys.has(typography.dominantStyleKey),
            ),
            indicator(
                typography.dominantStyleKey !== null &&
                    typography.dominantStyleKey === primaryStyleKey,
            ),
            indicator(item.type === "header"),
            // --- Text ------------------------------------------------------
            indicator(textSignals[i].start),
            indicator(textSignals[i].tail),
            indicator(refLike[i]),
            clampFeature(Math.log1p(textSignals[i].internalMarkerCount)),
            indicator(looksLikeAuthorList(text)),
            indicator(looksLikeJournalCitation(text)),
            clampFeature(Math.log1p(yearCount)),
            indicator(yearCount > 0),
            safeRatio(digitCount, text.length),
            safeRatio(commaCount, tokenCount),
            safeRatio(periodCount, tokenCount),
            safeRatio(capitalizedTokens, tokenCount),
            clampFeature(Math.log1p(initialsCount)),
            indicator(ET_AL_RE.test(text)),
            indicator(PAGES_OR_VOLUME_RE.test(text)),
            indicator(PAGE_RANGE_RE.test(text)),
            indicator(DOI_URL_RE.test(text)),
            indicator(PMID_ARXIV_RE.test(text)),
            indicator(LEADER_MARKER_RE.test(text)),
            safeRatio(quoteCount * 100, text.length),
            safeRatio(ampersandCount * 100, text.length),
            indicator(lastChar === "."),
            indicator(/\p{Nd}/u.test(lastChar)),
            indicator(/^\p{Ll}/u.test(text)),
            clampFeature(Math.log1p(text.length)),
            clampFeature(Math.log1p(tokenCount)),
            // --- Context ---------------------------------------------------
            i - 1 >= 0 ? refScores[i - 1] : 0,
            i - 2 >= 0 ? refScores[i - 2] : 0,
            i + 1 < items.length ? refScores[i + 1] : 0,
            i + 2 < items.length ? refScores[i + 2] : 0,
            clampFeature(Math.log1p(runLength[i])),
            safeRatio(runLength[i], columnSize.get(item.columnIndex) ?? 0),
            pageRefLikeFraction,
            indicator(headerSeenBefore[i]),
            docRefLikeFraction,
        ];

        rows.push({
            itemId: item.id,
            index: i,
            columnIndex: item.columnIndex,
            text,
            features: features.map(clampFeature),
            neighborIds: {
                prev: [items[i - 1], items[i - 2]]
                    .filter((neighbor) => neighbor !== undefined)
                    .map((neighbor) => neighbor.id),
                next: [items[i + 1], items[i + 2]]
                    .filter((neighbor) => neighbor !== undefined)
                    .map((neighbor) => neighbor.id),
            },
        });
    }

    return {
        rows,
        docContext: updateDocContext(docContext, {
            itemCount: items.length,
            referenceLikeCount: pageRefLikeCount,
            referenceHeaderSeen: pageHasReferenceHeader,
        }),
    };
}
