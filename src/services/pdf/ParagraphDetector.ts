/**
 * Paragraph Detector
 *
 * Detects paragraphs and headers from detected lines.
 * This is the second step in the item detection pipeline:
 *   1. Line Detection (LineDetector.ts)
 *   2. Paragraph Detection (this module)
 *   3. Item Classification (future)
 *
 * The algorithm:
 *   1. Calculate page-wide thresholds (median height, gap, etc.)
 *   2. Calculate column-specific thresholds (indent, early end, etc.)
 *   3. For each line, determine if it starts a new item
 *   4. Classify items as headers or paragraphs
 *   5. Build output with text content and bounding boxes
 */

import type { PageLine, LineBBox, PageLineResult, ColumnLineResult } from "./LineDetector";
import type { TextStyle, StyleProfile } from "./types";
import type { Rect } from "./ColumnDetector";

// ============================================================================
// Types
// ============================================================================

/**
 * Settings for paragraph detection
 */
export interface ParagraphDetectionSettings {
    /** Minimum gap in pixels to consider a paragraph break (default: 5) */
    minGapPx?: number;
    /** Minimum indent in pixels to consider a paragraph break (default: 5) */
    minIndentPx?: number;
    /** Minimum excess in pixels for early line end (default: 5) */
    minExcessPx?: number;
    /** Sigma multiplier for indent threshold (default: 2.0) */
    indentSigma?: number;
    /** Sigma multiplier for early end threshold (default: 2.0) */
    earlyEndSigma?: number;
    /** Font size tolerance for break detection (default: 1.0) */
    fontSizeTolerance?: number;
    /** Minimum header length in characters (default: 3) */
    minHeaderLength?: number;
    /** Maximum header length in characters (default: 200) */
    maxHeaderLength?: number;
    /** Whether to remove hyphenation when joining lines (default: true) */
    removeHyphenation?: boolean;
}

const DEFAULT_SETTINGS: Required<ParagraphDetectionSettings> = {
    minGapPx: 5,
    minIndentPx: 5,
    minExcessPx: 5,
    indentSigma: 2.0,
    earlyEndSigma: 2.0,
    fontSizeTolerance: 1.0,
    minHeaderLength: 3,
    maxHeaderLength: 200,
    removeHyphenation: true,
};

/**
 * Page-wide thresholds for paragraph detection
 */
interface PageThresholds {
    medianHeight: number;
    medianGap: number;
    gapExcessThreshold: number;
    binPx: number;
}

/**
 * Column-specific thresholds for paragraph detection
 */
interface ColumnThresholds {
    leftEdgeMode: number;
    rightEdgeMode: number;
    leftEdgeMad: number;
    rightEdgeMad: number;
    indentExcessThreshold: number;
    earlyEndExcessThreshold: number;
}

/**
 * A detected content item (paragraph or header)
 */
export interface ContentItem {
    /** Item type */
    type: "paragraph" | "header";
    /** Page-local index */
    idx: number;
    /** Document-wide index */
    docIdx: number;
    /** Start position in page content */
    start: number;
    /** End position in page content */
    end: number;
    /** Text content */
    text: string;
    /** Unique ID for the item */
    id: string;
    /** Bounding box for the item */
    bbox: LineBBox;
    /** Column index this item belongs to */
    columnIndex: number;
}

/**
 * Result of paragraph detection for a page
 */
export interface PageParagraphResult {
    /** Page index (0-based) */
    pageIndex: number;
    /** Page dimensions */
    width: number;
    height: number;
    /** Full page content with headers prefixed by "##" */
    pageContent: string;
    /** All detected items (paragraphs and headers) */
    items: ContentItem[];
    /** Count of paragraphs */
    paragraphCount: number;
    /** Count of headers */
    headerCount: number;
    /**
     * Per-item constituent `PageLine[]`, in reading order, aligned with
     * `items` by index. Only populated when `detectParagraphs` is called
     * with `options.trackItemLines === true`. This lets downstream code
     * (e.g. sentence-bbox mapping) recover the source lines that were
     * grouped into each paragraph without re-running detection.
     */
    itemLines?: PageLine[][];
}

/**
 * Counters for document-wide indexing
 */
export interface ItemCounters {
    paragraph: number;
    header: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate median of an array of numbers
 */
function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

/**
 * Calculate MAD (Median Absolute Deviation)
 */
function mad(values: number[]): number {
    if (values.length === 0) return 0.0;
    const m = median(values);
    const deviations = values.map(v => Math.abs(v - m));
    return median(deviations) || 0.0;
}

/**
 * Find mode of left/right edges using binning
 */
function modeLeftEdge(values: number[], binPx: number): number {
    if (values.length === 0) return 0.0;

    // Group values into bins
    const bins = new Map<number, number>();
    for (const value of values) {
        const binKey = Math.round(value / binPx);
        bins.set(binKey, (bins.get(binKey) || 0) + 1);
    }

    // Find most common bin
    let maxCount = 0;
    let modeKey = 0;
    for (const [key, count] of bins.entries()) {
        if (count > maxCount) {
            maxCount = count;
            modeKey = key;
        }
    }

    // Return median of values in that bin
    const inBin = values.filter(v => Math.round(v / binPx) === modeKey);
    return inBin.length > 0 ? median(inBin) : modeKey * binPx;
}

/**
 * Merge multiple bounding boxes into one
 */
function mergeBoundingBoxes(bboxes: LineBBox[]): LineBBox {
    if (bboxes.length === 0) {
        return { l: 0, t: 0, r: 0, b: 0, width: 0, height: 0 };
    }

    const l = Math.min(...bboxes.map(b => b.l));
    const t = Math.min(...bboxes.map(b => b.t));
    const r = Math.max(...bboxes.map(b => b.r));
    const b = Math.max(...bboxes.map(b => b.b));

    return {
        l,
        t,
        r,
        b,
        width: r - l,
        height: b - t,
    };
}

/**
 * Check if text is mostly numeric.
 *
 * Unicode-aware: counts letters from any script (Latin, Cyrillic, Greek,
 * Arabic, CJK, ...) so a line like "Глава 1" or "第1章" is not mis-classified
 * as "mostly numeric" just because it lacks Latin letters.
 */
function isMostlyNumeric(text: string, threshold: number = 0.8): boolean {
    const alphaCount = (text.match(/\p{L}/gu) || []).length;
    const digitCount = (text.match(/\p{N}/gu) || []).length;
    const total = alphaCount + digitCount;

    if (total === 0) return false;
    return digitCount / total >= threshold;
}

/**
 * Check if text is all uppercase.
 *
 * Unicode-aware: a letter "counts" as cased only if `toUpper(c) !== toLower(c)`,
 * so scripts without case (CJK, Arabic, Hebrew) cannot make a line "all caps"
 * by themselves. Requires at least `minLetters` cased letters to avoid false
 * positives on short tokens like "USA" or "I".
 */
function isAllCapsText(text: string, minLetters: number = 3): boolean {
    const letters = text.match(/\p{L}/gu) || [];
    let cased = 0;
    for (const c of letters) {
        if (c.toLowerCase() === c.toUpperCase()) continue; // uncased script
        cased++;
        if (c !== c.toUpperCase()) return false;
    }
    return cased >= minLetters;
}

/**
 * Author-list shape detector. Bold subset fonts on cover pages frequently
 * encode the author block in the same `.B` face used for section titles, so
 * structural rules alone (same size, bold, gap, different font, < 200 chars)
 * can't tell them apart. Author lists, though, almost always carry one of
 * two distinctive token shapes that real section headings don't:
 *
 *   - 2+ tokens shaped `LettersMarker` — a name immediately followed by a
 *     dagger/double-dagger/section/pilcrow/asterisk with no space between
 *     (e.g. `Dogga†`, `Lawniczak*`). The "no space" requirement is the key
 *     distinction from legal/policy headings like "§ 1983 and § 1985 Claims"
 *     where the markers stand alone.
 *   - 3+ "≥3-letter word immediately followed by digits" patterns
 *     (e.g. `Dogga1, Cudini1, Farr1, Dara3`). Threshold is 3 so genetics
 *     headings like "BRCA1 and BRCA2" (2 hits) stay clean.
 */
function looksLikeAuthorList(text: string): boolean {
    const tightMarkers = (text.match(/\p{L}+[†‡§¶*]/gu) || []).length;
    if (tightMarkers >= 2) return true;
    const namePlusDigit = (text.match(/\p{L}{3,}\d+(?=[,\s)*†‡§¶]|$)/gu) || []).length;
    return namePlusDigit >= 3;
}

/**
 * Stricter all-caps check used to gate the same-size-different-font header
 * rule. Requires multi-word phrasing so isolated all-caps tokens like
 * figure/chart labels ("MALARIA", "IBS", "UMAP3", "MSC1 MSC3 MSC13 MSC14",
 * "VIII") don't get promoted to headers — those have ≤ 1 pure-letter word.
 *
 * Heuristic: needs ≥ 2 whitespace-separated tokens that are pure letters
 * (no digits, no symbols), each at least 2 letters long, and all letters
 * are uppercase by `isAllCapsText`'s definition.
 */
function isAllCapsHeaderPhrase(text: string): boolean {
    if (!isAllCapsText(text)) return false;
    const tokens = text.split(/\s+/).filter(t => t.length > 0);
    let pureLetterTokens = 0;
    for (const tok of tokens) {
        if (tok.length < 2) continue;
        if (!/^\p{L}+$/u.test(tok)) continue;
        pureLetterTokens++;
    }
    return pureLetterTokens >= 2;
}

/**
 * Decide whether the body text on this page is itself all-caps. Sampled from
 * lines that match a known body style. Used to gate the all-caps header
 * rule — without this, an all-caps document would promote every line.
 *
 * Conservative threshold: at least 5 body-style sample lines AND ≥80% of
 * them must be all-caps. Returns false if the sample is too small (we'd
 * rather miss the gate on a thin page than falsely disable the rule).
 */
function computeBodyAllCaps(
    columnResults: ColumnLineResult[],
    bodyStyles: TextStyle[] | null
): boolean {
    if (!bodyStyles || bodyStyles.length === 0) return false;
    let total = 0;
    let allCaps = 0;
    for (const col of columnResults) {
        for (const line of col.lines) {
            const style = extractLineStyle(line);
            if (!style || !matchesBodyStyle(style, bodyStyles)) continue;
            total++;
            if (isAllCapsText(line.text.trim())) allCaps++;
        }
    }
    if (total < 5) return false;
    return allCaps / total >= 0.8;
}

/**
 * Join lines with optional hyphenation removal
 */
function joinLines(lines: string[], removeHyphenation: boolean = true): string {
    let text = lines.join("\n");

    if (removeHyphenation) {
        // Remove hyphens between letters across newlines. Unicode-aware so
        // hyphenated words in Cyrillic/Greek/etc. are joined, not just Latin.
        text = text.replace(/(\p{L})-\n+(\p{L})/gu, "$1$2");
    }

    // Replace multiple newlines with single newline
    text = text.replace(/\n\n+/g, "\n");
    // Replace single newlines with spaces
    text = text.replace(/\n/g, " ");
    // Clean up multiple spaces
    text = text.replace(/ +/g, " ");

    return text.trim();
}

/**
 * Extract TextStyle from a PageLine
 */
// Subset font names often encode weight/style as a suffix that the substring
// checks miss — e.g. `AJHJCE+AdvTT56ea2c23.B` (bold), `BPEJCI+AdvTTa15c7c65.I`
// (italic), `XXX.BI` / `.IB` (bold-italic). Match these explicitly.
const BOLD_SUFFIX_RE = /\.(B|Bd|Bld|Bold|Black|Heavy|BI|IB)$/i;
const ITALIC_SUFFIX_RE = /\.(I|It|Italic|Obl|Oblique|BI|IB)$/i;

function extractSpanStyle(
    fontName: string,
    fontWeight: string | undefined,
    fontStyle: string | undefined,
    size: number | undefined
): TextStyle {
    const lower = fontName.toLowerCase();
    return {
        size: Math.round(size || 12),
        font: fontName,
        bold: fontWeight === "bold" ||
              lower.includes("bold") ||
              BOLD_SUFFIX_RE.test(fontName),
        italic: fontStyle === "italic" ||
                lower.includes("italic") ||
                ITALIC_SUFFIX_RE.test(fontName),
    };
}

function extractLineStyle(line: PageLine): TextStyle | null {
    if (line.spans.length === 0) return null;
    const firstSpan = line.spans[0];
    return extractSpanStyle(
        firstSpan.fontName || "unknown",
        firstSpan.fontWeight,
        firstSpan.fontStyle,
        firstSpan.size
    );
}

/**
 * Check if two styles are equal
 */
function stylesEqual(a: TextStyle | null, b: TextStyle | null): boolean {
    if (!a || !b) return false;
    return (
        a.font === b.font &&
        Math.abs(a.size - b.size) < 0.5 &&
        a.bold === b.bold &&
        a.italic === b.italic
    );
}

/**
 * Check if a line's style matches one of the document's body styles.
 *
 * Wider than `stylesEqual` because the detailed mupdf walk does not always
 * populate `font.name` (the wasm `_wasm_stext_char_get_font` pointer doesn't
 * expose `getName()`, so the worker falls back to ""). Lines on the
 * detailed-walk target page therefore arrive with `font: "unknown"` and would
 * fail an exact font-name comparison against bodyStyles harvested from the
 * JSON-walk pages of the analysis window. When either side is unknown we
 * accept the match if size + bold + italic agree.
 */
function matchesBodyStyle(line: TextStyle, bodyStyles: TextStyle[]): boolean {
    return bodyStyles.some(bs => {
        if (Math.abs(bs.size - line.size) >= 0.5) return false;
        if (bs.bold !== line.bold) return false;
        if (bs.italic !== line.italic) return false;
        if (bs.font === line.font) return true;
        return !line.font || line.font === "unknown" ||
               !bs.font || bs.font === "unknown";
    });
}

/**
 * Get style dominance (fraction of spans with the given style)
 */
function getStyleDominance(line: PageLine, style: TextStyle): number {
    if (line.spans.length === 0) return 0;

    const matchingSpans = line.spans.filter(s => {
        const spanStyle = extractSpanStyle(
            s.fontName || "unknown",
            s.fontWeight,
            s.fontStyle,
            s.size
        );
        return stylesEqual(spanStyle, style);
    });

    return matchingSpans.length / line.spans.length;
}

// ============================================================================
// Step 1: Calculate Page-Wide Thresholds
// ============================================================================

/**
 * Calculate page-wide thresholds for paragraph detection
 */
function calculatePageThresholds(
    columnResults: ColumnLineResult[],
    settings: Required<ParagraphDetectionSettings>
): PageThresholds {
    // Collect all lines from all columns
    const allLines: PageLine[] = [];
    for (const colResult of columnResults) {
        allLines.push(...colResult.lines);
    }

    // 1a. Median line height
    const heights = allLines
        .map(line => line.bbox.height)
        .filter(h => h > 0);
    const medianHeight = heights.length > 0 ? median(heights) : 12.0;
    const binPx = Math.max(2.0, 0.15 * medianHeight);

    // 1b. Median vertical gap
    const gaps: number[] = [];
    for (const colResult of columnResults) {
        const lines = colResult.lines;
        for (let i = 0; i < lines.length - 1; i++) {
            const gap = lines[i + 1].bbox.t - lines[i].bbox.b;
            if (gap < 50 && gap > -5) {
                // Ignore abnormally large gaps and overlapping lines
                gaps.push(gap);
            }
        }
    }
    const medianGap = gaps.length > 0 ? median(gaps) : 0.0;

    // 1c. Gap excess threshold
    let gapExcessThreshold = Math.max(settings.minGapPx, 0.6 * medianHeight);

    if (gaps.length > 0) {
        const minMeaningfulIncrease = Math.max(1.0, 0.08 * medianHeight);

        gapExcessThreshold = Math.max(
            settings.minGapPx,
            medianGap + minMeaningfulIncrease,
            medianGap * 1.25,
            0.4 * medianHeight
        );
    }

    return {
        medianHeight,
        medianGap,
        gapExcessThreshold,
        binPx,
    };
}

// ============================================================================
// Step 2: Calculate Column-Specific Thresholds
// ============================================================================

/**
 * Calculate column-specific thresholds
 */
function calculateColumnThresholds(
    lines: PageLine[],
    pageThresholds: PageThresholds,
    settings: Required<ParagraphDetectionSettings>
): ColumnThresholds {
    const bboxes = lines.map(line => line.bbox);

    // Collect left and right edges
    const leftValues = bboxes.map(b => b.l);
    const rightValues = bboxes.map(b => b.r);

    // Calculate mode and MAD
    const leftEdgeMode = modeLeftEdge(leftValues, pageThresholds.binPx);
    const rightEdgeMode = modeLeftEdge(rightValues, pageThresholds.binPx);
    const leftEdgeMad = mad(leftValues);
    const rightEdgeMad = mad(rightValues);

    // Calculate thresholds
    const indentExcessThreshold = Math.max(
        settings.minIndentPx,
        settings.indentSigma * leftEdgeMad,
        0.35 * pageThresholds.medianHeight
    );

    const columnWidth = rightEdgeMode - leftEdgeMode;
    const earlyEndExcessThreshold = Math.max(
        settings.minExcessPx,
        settings.earlyEndSigma * rightEdgeMad,
        0.2 * columnWidth
    );

    return {
        leftEdgeMode,
        rightEdgeMode,
        leftEdgeMad,
        rightEdgeMad,
        indentExcessThreshold,
        earlyEndExcessThreshold,
    };
}

// ============================================================================
// Step 3: Header Detection
// ============================================================================

/**
 * Check if a line should be classified as a header
 */
function isHeaderStyle(
    line: PageLine,
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    precededByGap: boolean | null = null,
    bodyAllCaps: boolean = false,
    phraseTextOverride: string | null = null
): boolean {
    if (!bodyStyles || bodyStyles.length === 0) return false;

    const lineStyle = extractLineStyle(line);
    if (!lineStyle) return false;

    // Not a header if it's a known body style
    if (matchesBodyStyle(lineStyle, bodyStyles)) {
        return false;
    }

    // Must be highly consistent (90%+ same style)
    if (getStyleDominance(line, lineStyle) < 0.9) {
        return false;
    }

    const primaryBodyStyle = bodyStyles[0];
    let isPotentialHeader = false;
    const gapCheckPasses = precededByGap === null || precededByGap;

    // Rule 1: Larger font size
    if (lineStyle.size > primaryBodyStyle.size) {
        isPotentialHeader = true;
    }

    // Rule 2: Same size, bold, different font (requires gap)
    if (
        !isPotentialHeader &&
        gapCheckPasses &&
        Math.abs(lineStyle.size - primaryBodyStyle.size) < 0.5 &&
        lineStyle.bold &&
        !primaryBodyStyle.bold &&
        lineStyle.font !== primaryBodyStyle.font
    ) {
        isPotentialHeader = true;
    }

    // Rule 3: Same size, italic, different font (requires gap)
    if (
        !isPotentialHeader &&
        gapCheckPasses &&
        Math.abs(lineStyle.size - primaryBodyStyle.size) < 0.5 &&
        lineStyle.italic &&
        !primaryBodyStyle.italic &&
        lineStyle.font !== primaryBodyStyle.font
    ) {
        isPotentialHeader = true;
    }

    // Rule 4: Smaller size, bold, different font (requires gap)
    if (
        !isPotentialHeader &&
        gapCheckPasses &&
        lineStyle.size < primaryBodyStyle.size &&
        lineStyle.bold &&
        !primaryBodyStyle.bold &&
        lineStyle.font !== primaryBodyStyle.font
    ) {
        isPotentialHeader = true;
    }

    const text = line.text.trim();

    // Rule 5: Same-or-smaller size, all-caps phrase, different font (requires
    // gap). Catches all-caps headers in display fonts that report
    // `weight: 'normal'` — e.g. "THE MALIGNANCY OF SOCIAL FRONTIERS" set in a
    // separate heading face that MuPDF doesn't flag as bold. Requires a
    // multi-word phrase so isolated all-caps labels in figures/charts
    // ("MALARIA", "UMAP3", "IBS", "VIII") aren't promoted. Skipped when the
    // body itself is all-caps (document-wide rendering, not a heading signal).
    //
    // `phraseTextOverride` lets the multi-line item evaluator pass the joined
    // text — e.g. "THE MALIGNANCY OF SOCIAL\nFRONTIERS" wraps to two lines, and
    // the second line ("FRONTIERS") on its own would fail the multi-word phrase
    // test. Per-line evaluation in `startNewItem` leaves this null, so the
    // first line still triggers the header break correctly.
    const phraseText = phraseTextOverride ?? text;
    if (
        !isPotentialHeader &&
        gapCheckPasses &&
        !bodyAllCaps &&
        lineStyle.size <= primaryBodyStyle.size + 0.5 &&
        lineStyle.font !== primaryBodyStyle.font &&
        isAllCapsHeaderPhrase(phraseText)
    ) {
        isPotentialHeader = true;
    }

    if (!isPotentialHeader) return false;

    // Apply disqualifying heuristics

    // Author block on a paper's cover page commonly uses the same bold-encoded
    // subset font as section titles. Use the merged `phraseText` so multi-line
    // author lists are evaluated as a whole.
    if (looksLikeAuthorList(phraseText)) {
        return false;
    }

    // Check for figure/table labels
    const prefixLabelRe =
        /^\s*(?:fig(?:ure)?|tab(?:le)?|eq(?:uation)?)\s*\.?\s+[A-Z]?\d{1,3}[a-z]?/i;
    if (prefixLabelRe.test(text)) {
        return false;
    }

    // Too short
    if (text.length < settings.minHeaderLength) {
        return false;
    }

    // Equation number
    if (text.startsWith("(") && text.endsWith(")") && /\d/.test(text)) {
        return false;
    }

    // Mostly numeric
    if (isMostlyNumeric(text)) {
        return false;
    }

    return true;
}

// ============================================================================
// Step 4: Start New Item Detection
// ============================================================================

/**
 * Determine if current line should start a new item
 */
function startNewItem(
    line: PageLine,
    i: number,
    prevLine: PageLine | null,
    columnThresholds: ColumnThresholds,
    pageThresholds: PageThresholds,
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    bodyAllCaps: boolean = false
): boolean {
    if (i === 0) return true;
    if (!prevLine) return true;

    // (a) Vertical gap signal
    const spacingTop = line.bbox.t - prevLine.bbox.b;
    const gapBreak = spacingTop > pageThresholds.gapExcessThreshold;

    // Header detection. Compute prev first so we can relax the gap
    // requirement when the current line follows a header — handles
    // consecutive section/subsection lines like
    //   "3. Results"
    //   "3.1. Educational Data Analysis"
    // where the line spacing between them is the same as body leading
    // but the styles differ. Without this relaxation `isLocalHeader`
    // for the second line returns false (rules 2/3/4 require gap), the
    // two lines merge into one paragraph, and the subsection title is
    // lost as a distinct heading.
    const prevIsLocalHeader = isHeaderStyle(prevLine, bodyStyles, settings, null, bodyAllCaps);
    const headerGapPasses = gapBreak || prevIsLocalHeader;
    const isLocalHeader = isHeaderStyle(line, bodyStyles, settings, headerGapPasses, bodyAllCaps);

    if (isLocalHeader && !prevIsLocalHeader) {
        return true; // Header after non-header
    }

    if (isLocalHeader && prevIsLocalHeader) {
        // Different header style
        const lineStyle = extractLineStyle(line);
        const prevStyle = extractLineStyle(prevLine);
        if (!stylesEqual(lineStyle, prevStyle)) {
            return true;
        }
        return false; // Same header style continues
    }

    // (b) Indent signal
    let indentBreak = false;
    const indentExcess = line.bbox.l - columnThresholds.leftEdgeMode;
    const indentExcessPrevLine = line.bbox.l - prevLine.bbox.l;
    indentBreak =
        indentExcess > columnThresholds.indentExcessThreshold &&
        indentExcessPrevLine > columnThresholds.indentExcessThreshold / 2;

    // (c) Early line end signal
    let earlyEndBreak = false;
    const prevEarlyEndExcess = columnThresholds.rightEdgeMode - prevLine.bbox.r;
    const currentEarlyEndExcess = columnThresholds.rightEdgeMode - line.bbox.r;
    earlyEndBreak =
        prevEarlyEndExcess > columnThresholds.earlyEndExcessThreshold &&
        currentEarlyEndExcess <= columnThresholds.earlyEndExcessThreshold;

    // (d) Font size signal
    let fontSizeBreak = false;
    if (line.fontSize && prevLine.fontSize) {
        const fontSizeDiff = Math.abs(line.fontSize - prevLine.fontSize);
        const lineHeightDiff = Math.abs(line.bbox.height - prevLine.bbox.height);
        fontSizeBreak =
            fontSizeDiff > settings.fontSizeTolerance &&
            lineHeightDiff > settings.fontSizeTolerance;
    }

    // Drop-cap wraparound: when the previous line's bbox extends well below
    // the current line's bottom, the current line is wrapping around a tall
    // element (drop cap, large inline figure). Indent / early-end / font-size
    // breaks in that case are geometric artefacts of the wraparound, not real
    // paragraph boundaries — suppress them so the paragraph stays whole.
    const prevExtendsBelow =
        prevLine.bbox.b > line.bbox.b + line.bbox.height;
    if (prevExtendsBelow) {
        indentBreak = false;
        earlyEndBreak = false;
        fontSizeBreak = false;
    }

    // Combine signals
    const visualBreak = gapBreak || indentBreak || earlyEndBreak || fontSizeBreak;
    return visualBreak;
}

// ============================================================================
// Step 5 & 6: Process Lines Into Items
// ============================================================================

/**
 * Process accumulated lines into a content item
 */
function processCurrentLinesAsItem(
    currentLines: PageLine[],
    currentPageContent: string,
    paragraphIndex: number,
    headerIndex: number,
    itemCounters: ItemCounters,
    columnIndex: number,
    pageIndex: number,
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    bodyAllCaps: boolean = false
): {
    pageContent: string;
    item: ContentItem;
} {
    // b. Build text content (needed by header check below for Rule 5's
    // phrase test on multi-line headers)
    const itemLines = currentLines.map(l => l.text);
    const rawItemText = joinLines(itemLines, settings.removeHyphenation);

    // a. Check if all lines are headers. Pass the joined text so Rule 5's
    // multi-word all-caps phrase check sees the full heading even when it
    // wraps across lines (e.g. "THE MALIGNANCY OF SOCIAL\nFRONTIERS").
    const isPotentialHeader = currentLines.every(l =>
        isHeaderStyle(l, bodyStyles, settings, null, bodyAllCaps, rawItemText)
    );

    // c. Finalize header decision
    let isHeader = false;
    if (isPotentialHeader && rawItemText.length < settings.maxHeaderLength) {
        isHeader = true;
    }

    // d. Build final item text
    const itemText = isHeader ? `## ${rawItemText}` : rawItemText;

    let pageContent = currentPageContent;
    if (pageContent.length > 0) {
        pageContent += "\n\n";
    }

    const itemStart = pageContent.length;
    pageContent += itemText;
    const itemEnd = pageContent.length;

    // e. Create bounding box
    const allBboxes = currentLines.map(l => l.bbox);
    const mergedBbox = mergeBoundingBoxes(allBboxes);

    // f. Create item
    const idx = isHeader ? headerIndex : paragraphIndex;
    const docIdx = isHeader
        ? headerIndex + itemCounters.header
        : paragraphIndex + itemCounters.paragraph;

    const item: ContentItem = {
        type: isHeader ? "header" : "paragraph",
        idx,
        docIdx,
        start: itemStart,
        end: itemEnd,
        text: itemText,
        id: `${isHeader ? "header" : "para"}_p${pageIndex}_${idx}`,
        bbox: mergedBbox,
        columnIndex,
    };

    return { pageContent, item };
}

/**
 * Process lines in a column into items
 */
function processColumnLines(
    lines: PageLine[],
    columnIndex: number,
    pageIndex: number,
    columnThresholds: ColumnThresholds,
    pageThresholds: PageThresholds,
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    itemCounters: ItemCounters,
    initialPageContent: string,
    bodyAllCaps: boolean = false
): {
    pageContent: string;
    items: ContentItem[];
    itemLines: PageLine[][];
    paragraphCount: number;
    headerCount: number;
} {
    let pageContent = initialPageContent;
    const items: ContentItem[] = [];
    const itemLines: PageLine[][] = [];
    let paragraphIndex = 0;
    let headerIndex = 0;

    let currentLines: PageLine[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const prevLine = i > 0 ? lines[i - 1] : null;

        const shouldStartNew =
            currentLines.length === 0 ||
            startNewItem(
                line,
                i,
                prevLine,
                columnThresholds,
                pageThresholds,
                bodyStyles,
                settings,
                bodyAllCaps
            );

        if (shouldStartNew) {
            if (currentLines.length > 0) {
                const result = processCurrentLinesAsItem(
                    currentLines,
                    pageContent,
                    paragraphIndex,
                    headerIndex,
                    itemCounters,
                    columnIndex,
                    pageIndex,
                    bodyStyles,
                    settings,
                    bodyAllCaps
                );

                pageContent = result.pageContent;
                items.push(result.item);
                itemLines.push(currentLines);

                if (result.item.type === "header") {
                    headerIndex++;
                } else {
                    paragraphIndex++;
                }
            }

            currentLines = [line];
        } else {
            currentLines.push(line);
        }
    }

    // Process final item
    if (currentLines.length > 0) {
        const result = processCurrentLinesAsItem(
            currentLines,
            pageContent,
            paragraphIndex,
            headerIndex,
            itemCounters,
            columnIndex,
            pageIndex,
            bodyStyles,
            settings,
            bodyAllCaps
        );

        pageContent = result.pageContent;
        items.push(result.item);
        itemLines.push(currentLines);

        if (result.item.type === "header") {
            headerIndex++;
        } else {
            paragraphIndex++;
        }
    }

    return {
        pageContent,
        items,
        itemLines,
        paragraphCount: paragraphIndex,
        headerCount: headerIndex,
    };
}

// ============================================================================
// Main Detection Function
// ============================================================================

/**
 * Options for `detectParagraphs`.
 */
export interface DetectParagraphsOptions {
    /**
     * When true, the returned `PageParagraphResult` will include an
     * `itemLines` array aligned with `items`: one `PageLine[]` per
     * content item, in reading order. Defaults to false so existing
     * callers pay nothing.
     */
    trackItemLines?: boolean;
}

/**
 * Detect paragraphs and headers from line detection results
 */
export function detectParagraphs(
    lineResult: PageLineResult,
    bodyStyles: TextStyle[] | null,
    settings: ParagraphDetectionSettings = {},
    itemCounters: ItemCounters = { paragraph: 0, header: 0 },
    options: DetectParagraphsOptions = {}
): PageParagraphResult {
    const opts = { ...DEFAULT_SETTINGS, ...settings };

    // Step 1: Calculate page-wide thresholds
    const pageThresholds = calculatePageThresholds(lineResult.columnResults, opts);

    // Sample body-styled lines to decide whether body text is itself
    // all-caps. Used to gate the all-caps header rule so all-caps
    // documents don't promote every line to a header.
    const bodyAllCaps = computeBodyAllCaps(lineResult.columnResults, bodyStyles);

    let pageContent = "";
    const allItems: ContentItem[] = [];
    const allItemLines: PageLine[][] = [];
    let totalParagraphs = 0;
    let totalHeaders = 0;

    // Process each column
    for (const colResult of lineResult.columnResults) {
        if (colResult.lines.length === 0) continue;

        // Step 2: Calculate column-specific thresholds
        const columnThresholds = calculateColumnThresholds(
            colResult.lines,
            pageThresholds,
            opts
        );

        // Steps 3-6: Process lines into items
        const result = processColumnLines(
            colResult.lines,
            colResult.columnIndex,
            lineResult.pageIndex,
            columnThresholds,
            pageThresholds,
            bodyStyles,
            opts,
            itemCounters,
            pageContent,
            bodyAllCaps
        );

        pageContent = result.pageContent;
        allItems.push(...result.items);
        if (options.trackItemLines) {
            allItemLines.push(...result.itemLines);
        }
        totalParagraphs += result.paragraphCount;
        totalHeaders += result.headerCount;
    }

    const baseResult: PageParagraphResult = {
        pageIndex: lineResult.pageIndex,
        width: lineResult.width,
        height: lineResult.height,
        pageContent,
        items: allItems,
        paragraphCount: totalParagraphs,
        headerCount: totalHeaders,
    };

    if (options.trackItemLines) {
        baseResult.itemLines = allItemLines;
    }

    return baseResult;
}

/**
 * Log paragraph detection results for debugging.
 * Only logs in development mode.
 */
export function logParagraphDetection(result: PageParagraphResult): void {
    if (process.env.NODE_ENV !== "development") return;

    console.log(
        `[ParagraphDetector] Page ${result.pageIndex}: ` +
            `${result.items.length} items (${result.paragraphCount} paragraphs, ${result.headerCount} headers)`
    );

    // Log first few items as preview
    const previewCount = Math.min(5, result.items.length);
    for (let i = 0; i < previewCount; i++) {
        const item = result.items[i];
        const typeLabel = item.type === "header" ? "H" : "P";
        const textPreview =
            item.text.length > 60 ? item.text.slice(0, 60) + "..." : item.text;
        console.log(
            `    [${typeLabel}${item.idx}] Col ${item.columnIndex + 1}: "${textPreview}"`
        );
    }

    if (result.items.length > previewCount) {
        console.log(`    ... and ${result.items.length - previewCount} more items`);
    }
}

