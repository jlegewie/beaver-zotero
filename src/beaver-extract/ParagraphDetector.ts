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

import type { PageLine, PageLineResult, ColumnLineResult } from "./LineDetector";
import type { BoundingBox, RawStyleRun, TextStyle, StyleProfile } from "@beaver/agent-core/extract/types";
import { bboxHeight, mergeBoxes } from "@beaver/agent-core/extract/types";
import type { Rect } from "./ColumnDetector";
import { pdfLog, isAnalyzerLoggingEnabled } from "./logging";
import { START_SIGNALS, START_VETOES, type StartTrace } from "./boundaries/rules";
import { boundaryLine, type BoundaryBlock, type BoundaryPage, type LineDecision } from "./boundaries/input";

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
    /**
     * Read hanging-indent blocks (reference lists, footnotes, lists whose
     * wrapped lines sit at an inner edge) as entries with continuations; see
     * `detectHangingRoles` (default: false). Also starts a new item at the
     * next number of a numbered list (`isNextNumberedEntry`). Enabled by the
     * PDF schema preset.
     */
    hangingIndentBlocks?: boolean;
    /**
     * Whether heading detection demotes run-in label items ("Keywords: …",
     * "Received: …", a structured-abstract label followed by prose), display
     * equations, bare web addresses and supplementary / extended-data figure
     * and table captions (default: true).
     * PDF schema 4 turns it off so its document-wide ids keep resolving.
     */
    headingLabelFilters?: boolean;
    /**
     * Treat a run of at most `ISOLATED_HEADING_LINES` heading-styled lines as
     * an isolated heading: its gaps are section spacing, left out of a short
     * column's leading, and two same-style headings stacked a paragraph gap
     * apart are separate headings (default: false). Enabled by the PDF schema
     * preset.
     */
    isolatedHeadings?: boolean;
    /**
     * A page whose text is mostly set in a style other than the document's
     * body styles (an appended or cover page in another face) adds that style
     * to the page's body styles (`pageBodyStyle`), so its lines are not
     * headings (default: false). Enabled by the PDF schema preset.
     */
    pageBodyStyles?: boolean;
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
    hangingIndentBlocks: false,
    headingLabelFilters: true,
    isolatedHeadings: false,
    pageBodyStyles: false,
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
    /**
     * Widest text extent in the column — the rightmost edge of any line.
     * Unlike `rightEdgeMode` (which a column full of short links / list
     * entries drags to a small value), this marks the body text margin a
     * wrapped line reaches. Used to tell a wrapped continuation line from
     * a short standalone one-line item.
     */
    maxRightEdge: number;
    indentExcessThreshold: number;
    earlyEndExcessThreshold: number;
    /**
     * Per-column gap threshold above which the gap counts as a paragraph
     * break. Falls back to the page-wide value when the column has too
     * few gaps to estimate locally. Per-column matters when a single page
     * mixes content with very different leading (e.g. body text at ~13pt
     * gap and a references list with ~4pt continuation gaps) — using only
     * the page-wide median lets the dense list drag the threshold below
     * the body's normal gap and split every body line into its own
     * paragraph.
     */
    gapExcessThreshold: number;
    /**
     * The column's normal line gap (median), or the page-wide value when the
     * column has too few gaps to estimate locally.
     */
    medianGap: number;
    /** Per column line: part of an isolated heading (see `isolatedHeadingLines`). */
    isolatedHeading: boolean[];
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
    bbox: BoundingBox;
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
    /**
     * Hanging-indent role of each line in `itemLines` (see
     * `detectHangingRoles`), aligned with it. Populated with `itemLines`;
     * all `null` unless `hangingIndentBlocks` is on.
     */
    itemLineRoles?: HangingRole[][];
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
 * CJK content predicate. Returns true when the line text is predominantly
 * Chinese / Japanese / Korean. Used as a script-specificity gate on the
 * CJK-subset body fallback in `isHeaderStyle`.
 *
 * Threshold of 0.5 (CJK chars / total Unicode letters) keeps the predicate
 * true for full CJK prose with embedded Latin tokens like "VOCs" or
 * measurement units, and false for Latin prose with one or two incidental
 * CJK glyphs.
 */
function hasCJKContent(text: string, threshold: number = 0.5): boolean {
    // CJK Unified Ideographs (incl. extension-A), Compatibility Ideographs,
    // Hiragana, Katakana, Hangul Syllables.
    const cjkCount = (text.match(
        /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu
    ) || []).length;
    const letterCount = (text.match(/\p{L}/gu) || []).length;
    if (letterCount === 0) return false;
    return cjkCount / letterCount >= threshold;
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
 * Author-byline detector for the all-caps heading rule. Cover/title pages and
 * reference lists set author names in the same face used for section titles, so
 * an all-caps author list ("STOLLE, D., S. SOROKA, & R. JOHNSTON") matches the
 * all-caps heading signal but is not a heading.
 *
 * The signal is **two or more** standalone single-letter initials. A single
 * initial-shaped token is deliberately NOT enough: section headings routinely
 * carry one ("APPENDIX A. METHODS", "PART B. RESULTS"), and treating that lone
 * enumerator as an author initial would demote a legitimate heading to body.
 * Author lists, by contrast, almost always stack multiple initials.
 *
 * A standalone initial is an uppercase letter + period bounded by a separator
 * (start / space / comma) before and (space / comma / close-paren / end) after,
 * so a glued abbreviation ("U.S.") does not count.
 */
function looksLikeByline(text: string): boolean {
    const initials = text.match(/(?:^|[\s,])\p{Lu}\.(?=[\s,)]|$)/gu);
    return !!initials && initials.length >= 2;
}

/**
 * Reference-list citation-tail detector. Reference lists routinely italicize
 * the journal name (and trailing volume/pages/year) in a different italic face
 * from the body, which fits Rule 3 of header detection ("same size, italic,
 * different font") exactly. The line is structurally a citation tail, not a
 * section heading. Distinguish by numeric citation cues that real italic
 * subsection titles don't carry:
 *
 *   - year in parens at end ("(2017).", "(1993b)")
 *   - "pp." / "p." followed by digits ("pp. 385-409")
 *   - page range with en-dash / em-dash ("631–643", "175–187")
 *   - volume-issue pair ("96(1)", "101(3)")
 *   - trailing ", NN." (volume-only tail like
 *     "Industrial and Labor relations review, pp.175-187." or
 *     "The Quarterly Journal of Economics, 116.")
 *
 * En-dash/em-dash specifically (not the plain hyphen) so headings like
 * "State-of-the-art" don't get caught.
 */
function looksLikeJournalCitation(text: string): boolean {
    const t = text.trim();
    if (/\(\s*(?:18|19|20)\d{2}[a-z]?\s*\)\.?$/.test(t)) return true;
    if (/\bpp?\.\s*\d/i.test(t)) return true;
    if (/\d+\s*[–—]\s*\d+/.test(t)) return true;
    if (/\b\d{1,4}\s*\(\s*\d{1,3}\s*\)/.test(t)) return true;
    if (/,\s*\d{1,4}\.?\s*$/.test(t)) return true;
    return false;
}

/**
 * Stricter all-caps check used to gate the same-size-different-font header
 * rule. Accepts two shapes that real section headings carry but figure/chart
 * labels typically don't:
 *
 *   - Multi-word phrase: ≥ 2 pure-letter tokens (each ≥ 2 letters). Catches
 *     "THE MALIGNANCY OF SOCIAL FRONTIERS", "DATA AND METHODS".
 *   - Single long word: 1 pure-letter token ≥ 6 letters. Catches standalone
 *     section names ("REFERENCES", "INTRODUCTION", "DISCUSSION",
 *     "CONCLUSION", "ABSTRACT", "METHODS", "RESULTS"). 6-letter floor keeps
 *     short labels ("IBS", "UMAP3", "VIII") out.
 *
 * Tokens with digits/symbols are excluded so figure labels like "UMAP3" or
 * roman-numeral indices like "VIII" can't qualify.
 */
function isAllCapsHeaderPhrase(text: string): boolean {
    if (!isAllCapsText(text)) return false;
    const tokens = text.split(/\s+/).filter(t => t.length > 0);
    let pureLetterTokens = 0;
    let longestPureLetterToken = 0;
    for (const tok of tokens) {
        if (tok.length < 2) continue;
        if (!/^\p{L}+$/u.test(tok)) continue;
        pureLetterTokens++;
        if (tok.length > longestPureLetterToken) longestPureLetterToken = tok.length;
    }
    if (pureLetterTokens >= 2) return true;
    if (pureLetterTokens === 1 && longestPureLetterToken >= 6) return true;
    return false;
}

/**
 * Section-number outline detector. Matches numeric section prefixes that
 * lead real headings — "2. BACKGROUND", "2.1 Race, Neighborhoods, and Police
 * Stops", "3.1 “Stop and Frisk” in New York City", "3.4.5 Some Subsection" —
 * followed by a capitalized word. Used to promote sans-on-serif (or
 * vice-versa) section titles that carry no other style cue (no bold, no
 * italic, same size as body).
 *
 * Constraints:
 *   - Number with up to 3 dotted parts ("3", "3.4", "3.4.5"), optional
 *     trailing period, then whitespace, then optionally an opening quote /
 *     paren, then a Unicode capital. The 3-level cap avoids false hits on
 *     dotted version strings; the optional quote allows titles that begin
 *     with an emphasized phrase ("3.1 “Stop and Frisk”…").
 */
const SECTION_PREFIX_RE =
    /^\s*\d+(?:\.\d+){0,3}\.?\s+["'“‘«(]?\p{Lu}/u;

/**
 * CJK-aware numeric outline prefix. Same shape as `SECTION_PREFIX_RE` but
 * accepts a CJK ideograph (`\p{Lo}`) after the prefix in addition to a
 * Latin uppercase letter (`\p{Lu}`), and admits CJK opening brackets.
 *
 * Used by `looksLikeFragmentedCJKBody` so the fallback does not swallow
 * CJK numbered headings like "2. 概述", "2.1 冷凝法", "3.4 膜分离机理"
 * — the canonical `SECTION_PREFIX_RE` rejects these because Chinese
 * characters are `\p{Lo}` (other letter, no case), not `\p{Lu}`.
 *
 * The guard sits AFTER `hasCJKContent`, so this regex only sees lines
 * already gated to predominantly-CJK prose; broadening to `\p{Lo}` does
 * not affect Latin-only documents.
 */
const NUMERIC_OUTLINE_PREFIX_CJK_RE =
    /^\s*\d+(?:\.\d+){0,3}\.?\s+["'“‘«(「『（]?[\p{Lu}\p{Lo}]/u;

/**
 * Icon / dingbat fonts that MuPDF's per-line font aggregation reports for
 * bullet-led list items. When a line begins with a bullet glyph (e.g.
 * U+F0B7 from `Symbol`) followed by body text in a real font, MuPDF's JSON
 * walk reports the line font as the bullet font for the entire line — so
 * the line "looks like" a header by font/size compared to body. Real
 * headings don't use these fonts.
 *
 * Matches the base name with no trailing word-boundary because real PDFs
 * routinely append a brand initialism (`ZapfDingbatsITC`, `ZapfDingbatsBT`,
 * `Wingdings2`, `SymbolMT`, …). The `(?:^|\+)` anchor scopes the match to
 * the font-name proper, not to the random subset prefix MuPDF prepends.
 */
const ICON_FONT_RE =
    /(?:^|\+)(?:Symbol|Wingdings|ZapfDingbats|Webdings|Marlett|AdvPi)/i;

/**
 * Dingbat-only fonts where the extracted leading character is often a
 * glyph-substituted codepoint rather than the visual bullet. Symbol stays out
 * of this permissive set because it is also used for equations and Greek
 * symbols.
 */
const PERMISSIVE_ICON_FONT_RE =
    /(?:^|\+)(?:Wingdings|ZapfDingbats|Webdings|Marlett|AdvPi)/i;

/**
 * Math-symbol fonts (MathTime upright `MTSYN` / italic `MTSY`). These are
 * used for both bulleted list glyphs and inline / standalone equations, so
 * font-name alone is ambiguous — gate on a leading bullet character (see
 * `isIconBulletLine`) before treating an MT* line as a list item.
 */
const MATH_SYMBOL_FONT_RE = /(?:^|\+)MTSYN?\b/i;

/**
 * Synthetic OCR text-layer fonts. OCRmyPDF / Tesseract render the invisible
 * text layer of a scanned PDF in a single placeholder font ("GlyphLessFont")
 * and size each line from the scanned glyph heights, so per-line font size is
 * estimation noise rather than a typographic choice. Used to gate heading
 * heuristics that would otherwise trust the size cue. The `(?:^|\+)` anchor
 * tolerates the random subset prefix MuPDF prepends to embedded fonts.
 */
const OCR_TEXT_LAYER_FONT_RE = /(?:^|\+)Glyph\s*Less\s*Font/i;

/** True when `font` is a synthetic OCR text-layer placeholder font. */
function isOcrTextLayerFont(font: string | undefined | null): boolean {
    return !!font && OCR_TEXT_LAYER_FONT_RE.test(font);
}

/**
 * Recognized leading bullet glyphs (after optional whitespace). Covers the
 * common Unicode bullets that survive MuPDF extraction:
 *   • U+2022 BULLET                 ◦ U+25E6 WHITE BULLET
 *   ▪ U+25AA BLACK SMALL SQUARE     ▫ U+25AB WHITE SMALL SQUARE
 *   ‣ U+2023 TRIANGULAR BULLET      ⁃ U+2043 HYPHEN BULLET
 *   ● U+25CF / ○ U+25CB / ◆ U+25C6 / ◇ U+25C7 / ■ U+25A0 / □ U+25A1
 *   ∙ U+2219 BULLET OPERATOR
 *   ◗ U+25D7 RIGHT HALF BLACK CIRCLE — design-heavy bullet glyph
 *           (e.g. ZapfDingbatsITC, common in marketing/report PDFs).
 *   ▶ U+25B6 / ► U+25BA / ➤ U+27A4 — right-pointing arrow bullets.
 *      U+F0B7, the Symbol-font private-use bullet Symbol-bulleted PDFs
 *            typically emit. Schema-4 extraction keeps it verbatim; schema 5
 *            maps it to • (`map-symbol-private-use`).
 */
const BULLET_LEAD_CHAR_RE = /^\s*[•◦▪▫‣⁃●○◆◇■□∙◗▶►➤]/u;

/**
 * Standard Unicode bullet glyphs that are unambiguous list markers in any
 * font. Math/operator-like and font-private bullets remain in
 * `BULLET_LEAD_CHAR_RE` for font-gated detection only.
 */
const STANDALONE_BULLET_LEAD_CHAR_RE =
    /^\s*[•◦▪▫‣⁃●○◆◇■□▶►➤]\s+\S/u;

/**
 * Permissive dingbat-font leader: the font identifies the marker and the
 * extracted codepoint may be a substituted letter, digit, or punctuation mark.
 */
const ICON_FONT_ANY_LEAD_RE = /^\s*\S\s+\S/u;

/**
 * Decide whether a line is a dingbat-led bullet item. Dingbat-only fonts can
 * use substituted leading codepoints; dual-use symbol/math fonts require an
 * explicit bullet glyph.
 *
 * The Symbol-font private-use bullet (U+F0B7, kept by schema-4 extraction)
 * is a single codepoint, so YDMSJ83R-style lines (`Teacher's aid: …` led by
 * U+F0B7 in Symbol) are still recognized.
 */
function isIconBulletLine(line: PageLine): boolean {
    const style = extractLineStyle(line);
    if (!style) return false;
    if (PERMISSIVE_ICON_FONT_RE.test(style.font)) {
        return (
            BULLET_LEAD_CHAR_RE.test(line.text) ||
            ICON_FONT_ANY_LEAD_RE.test(line.text)
        );
    }
    if (ICON_FONT_RE.test(style.font) || MATH_SYMBOL_FONT_RE.test(style.font)) {
        return BULLET_LEAD_CHAR_RE.test(line.text);
    }
    return false;
}

/**
 * Numeric leader for hanging-indent items (footnotes, numbered lists). Three
 * shapes, all anchored at the start of the line:
 *   - Bracketed / parenthesised:  `[1]`, `(1)`  (1-3 digits, trailing space)
 *   - Period/paren-suffixed:       `1.`, `1)`   (1-3 digits, trailing space)
 *   - Bare footnote leader:        `6  David`   (1-3 digits, two-or-more
 *                                  spaces, then a capital letter)
 *
 * Whitespace is required after every explicit-marker form so we don't match
 * intra-token shapes like `2.1 Methods` (section numbers), `[12]Smith` (no
 * space), or `1.23` (decimal). Two-space gap on the bare form discriminates
 * footnote markers from single-space numeric headings (`2 Methods`).
 *
 * 1-3 digits avoids matching 4-digit years at the start of a line.
 */
const NUMERIC_LEADER_RE =
    /^\s*(?:[([]\d{1,3}[)\]]\s+|\d{1,3}[.)]\s+|\d{1,3}\s{2,}\p{Lu})/u;

/**
 * Lettered leader for hanging-indent list items. Deliberately narrow to keep
 * the false-positive surface tight — common abbreviations (`Dr.`, `Prof.`,
 * `Fig.`, `et al.`) and section headings (`A. Methods`, `I. Introduction`)
 * would all match a permissive 1-4 letter pattern.
 *
 *   - Bracketed / parenthesised single letter (both cases):  `(a)`, `[A]`
 *   - Period/paren-suffixed lowercase single letter:          `a.`, `a)`
 *     (uppercase forms `A.` / `B.` excluded — heading shapes)
 *   - Lowercase Roman numerals i-x with separator:            `i.`, `ii)`,
 *     `iv.`, `viii.`  (uppercase Roman excluded for the same reason)
 *
 * Whitespace required after the marker.
 */
const LETTERED_LEADER_RE =
    /^\s*(?:[([][a-zA-Z][)\]]\s+|[a-z][.)]\s+|(?:i{1,3}|iv|v|vi{0,3}|ix|x)[.)]\s+)/u;

/**
 * Footnote / reference symbol marker — the traditional non-numeric footnote
 * glyphs used when a paper exhausts the digit pool or prefers symbols.
 */
const SYMBOL_LEADER_RE = /^\s*[*†‡§¶#]\s+\S/u;

/**
 * Decide whether a line begins with a text-pattern hanging-indent leader —
 * a numeric, lettered, or symbol marker that introduces a footnote or list
 * item whose continuation lines are typically indented further right than
 * the leader line itself. Used by the indent-break suppression in
 * `startNewItem` to avoid splitting a single leader-led item across two
 * paragraphs.
 *
 * Pure text-pattern check (no font signal) — the structural gates around the
 * suppression block (hanging-range geometry, sentence-terminator on prev,
 * style equality with prev's dominant span) carry the load against false
 * positives.
 *
 * Control characters (`\p{Cc}`) are replaced with a single space before
 * matching. PDF extraction occasionally emits non-printing codepoints (e.g.
 * BELL `\x07`) between a footnote marker and its body text — observed on
 * WZVA5ZF2 page 10 footnote 6 as `"6 \x07David Silver…"`. The
 * normalization keeps the bare-numeric branch matching despite that noise
 * without loosening the regex itself.
 */
function isTextHangingIndentLeader(line: PageLine): boolean {
    const t = line.text.replace(/\p{Cc}/gu, " ");
    return (
        NUMERIC_LEADER_RE.test(t) ||
        LETTERED_LEADER_RE.test(t) ||
        SYMBOL_LEADER_RE.test(t) ||
        STANDALONE_BULLET_LEAD_CHAR_RE.test(t)
    );
}

/** Numbered entry leader: "12.", "12)", "[12]" or "(12)", then a word. */
const NUMBERED_ENTRY_RE = /^\s*([([]?)(\d{1,3})([.)\]])\s+[^\s\d]/u;

/**
 * Whether `line` opens the entry numbered right after the one `opener`
 * opens: "48." after an item opened by "47.", with the same marker
 * punctuation. Numbered references and list entries that fill their last
 * line give no layout cue for the break; the count does.
 */
function isNextNumberedEntry(opener: PageLine, line: PageLine): boolean {
    const a = NUMBERED_ENTRY_RE.exec(opener.text);
    if (!a) return false;
    const b = NUMBERED_ENTRY_RE.exec(line.text);
    if (!b || a[1] !== b[1] || a[3] !== b[3]) return false;
    // "[12]" and "(12)" close their bracket; a bare number ends in "." or ")".
    if (a[1] === "[" ? a[3] !== "]" : a[1] === "(" ? a[3] !== ")" : a[3] === "]") return false;
    return Number(b[2]) === Number(a[2]) + 1;
}

/**
 * Inline footnote / endnote / affiliation marker glued to the body text — the
 * shape MuPDF commonly emits with NO separating space, which the
 * hanging-indent leader regexes above deliberately reject (they require a
 * space/period after the marker). Three forms, anchored at line start:
 *   - footnote symbol: `* † ‡ § ¶ #`, the asterisk-operator `∗` / low asterisk
 *     `⁎`, or a superscript digit (`¹²³…`);
 *   - 1-3 leading digits glued DIRECTLY to a letter ("12Body", "1Wellcome",
 *     "10Traditional"). The trailing `\p{L}` is what makes this a glued marker
 *     rather than "any 1-3 digit prefix": it excludes numbered section
 *     headings and list items ("1. Background", "2) Methods", "1 Introduction")
 *     and 4-digit years ("2020 was…"), whose digit is followed by a separator,
 *     space, or further digit — not by body text. This matters because the
 *     suppression below clears the font-size break, so matching a numbered
 *     heading here would merge it into the following body line and demote the
 *     heading to a paragraph;
 *   - a single lowercase letter immediately followed by a capital — a
 *     superscript letter marker glued to a capitalised word ("aHere").
 *
 * Used only to gate the marker-artifact font-size-break suppression in
 * `startNewItem`, so it fires for marker-led lines and not for the rare
 * non-marker small line that happens to trip the same geometry.
 */
const INLINE_MARKER_LEAD_RE =
    /^\s*(?:[*†‡§¶#∗⁎⁰¹²³⁴⁵⁶⁷⁸⁹]|\d{1,3}\p{L}|\p{Ll}(?=\p{Lu}))/u;

function startsWithInlineMarker(line: PageLine): boolean {
    return INLINE_MARKER_LEAD_RE.test(line.text.replace(/\p{Cc}/gu, " "));
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
export function joinLines(lines: string[], removeHyphenation: boolean = true): string {
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

// Heavier-than-regular weight tokens that PostScript / OpenType names carry as
// a trailing `-Token` or `.Token` (e.g. `HelveticaNeueLTStd-Md`,
// `MyriadPro-Semibold`, `Futura-Demi`).
const HEAVY_WEIGHT_SUFFIX_RE =
    /[-.](?:Medium|Med|Md|SemiBold|Semibold|SemiBd|Semi|Sb|DemiBold|Demibold|Demi|Db|Black|Blk|Heavy|Hv)(?:Italic|It|Obl|Oblique)?$/i;

/**
 * True when a font name carries a Medium / Semibold / Demibold (or heavier)
 * weight token that MuPDF does not surface as the Bold style flag. Used as a
 * heading-weight cue for display-font section titles.
 */
function hasHeavyWeightToken(font: string | undefined | null): boolean {
    return !!font && HEAVY_WEIGHT_SUFFIX_RE.test(font);
}

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
 * Style of the line's longest span by trimmed character count. Footnote
 * markers are typically short superscript spans at the start of the line
 * ("6 " in size 4 before "David Silver…" in size 8); the first-span style
 * therefore reflects the marker, not the body text. The hanging-indent
 * suppression compares the continuation line against this dominant style so
 * a leader line dominated by its body text matches its wrapped continuation
 * even when the marker itself is in a different (smaller / italic / bold)
 * style.
 *
 * Counts visible-text length (trimmed) rather than raw `span.text.length`
 * so a long whitespace-only run can't beat a shorter body-text span. Falls
 * back to `extractLineStyle` when every span is whitespace-only.
 */
function dominantSpanStyleByCharCount(line: PageLine): TextStyle | null {
    if (line.spans.length === 0) return null;
    let best: TextStyle | null = null;
    let bestChars = 0;
    for (const span of line.spans) {
        const len = (span.text || "").trim().length;
        if (len === 0) continue;
        if (len > bestChars) {
            bestChars = len;
            best = extractSpanStyle(
                span.fontName || "unknown",
                span.fontWeight,
                span.fontStyle,
                span.size
            );
        }
    }
    return best ?? extractLineStyle(line);
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
 * Whether two lines are set in the same typeface: same font, weight and
 * slant at the same size. Reported sizes are truncated (9.96 → 9, 10.0 →
 * 10), so lines in one face can read as two sizes; the opening runs' exact
 * sizes settle it when style runs are recorded (within 0.5pt), otherwise
 * truncated sizes within 1pt count as the same. A numbered title is judged
 * by its title's face, not its section number's (see `openingLineStyle`).
 */
function sameTypeface(a: PageLine, b: PageLine): boolean {
    const sa = openingLineStyle(a);
    const sb = openingLineStyle(b);
    if (!sa || !sb) return false;
    if (sa.font !== sb.font || sa.bold !== sb.bold || sa.italic !== sb.italic) return false;
    const exactA = openingExactSize(a);
    const exactB = openingExactSize(b);
    if (exactA !== null && exactB !== null) return Math.abs(exactA - exactB) < 0.5;
    return Math.abs(sa.size - sb.size) <= 1;
}

/** Exact size of the line's opening style run (after a section number), when recorded. */
function openingExactSize(line: PageLine): number | null {
    let skip = numberedTitleStyle(line)?.numberRuns ?? 0;
    for (const span of line.spans) {
        for (const run of span.styleRuns ?? []) {
            if (run.chars === 0) continue;
            if (skip > 0) {
                skip--;
                continue;
            }
            return run.exactSize ?? null;
        }
    }
    return null;
}

/**
 * Exact size of the line's glyphs set in `style` (its font at its size),
 * when style runs are recorded. The largest such run wins, matching how
 * `majorityLineStyle` sizes a font.
 */
function styleExactSize(line: PageLine, style: TextStyle): number | null {
    let size: number | null = null;
    for (const span of line.spans) {
        for (const run of span.styleRuns ?? []) {
            if (run.chars === 0 || run.exactSize === undefined) continue;
            if (run.font.name !== style.font || Math.round(run.font.size) !== style.size) continue;
            if (size === null || run.exactSize > size) size = run.exactSize;
        }
    }
    return size;
}

/** Body glyphs a page needs before `pageBodyExactSize` measures it. */
const MIN_BODY_EXACT_SIZE_CHARS = 100;

/**
 * Untruncated body text size on the page: the glyph-weighted median exact
 * size of style runs set in the primary body face at its reported size.
 * Null without style runs or with too little body text, such as on a page
 * whose text in the body face is set at another size (a table of contents).
 *
 * Reported sizes are truncated, so one face can read as two sizes. Under
 * LaTeX `microtype` font expansion each line is scaled by up to about 2%,
 * so 10pt body lines read as 9 (9.96pt) or 10 (10.04pt) at random; only the
 * exact sizes show that they are the same size.
 */
function pageBodyExactSize(
    columnResults: ColumnLineResult[],
    bodyStyles: TextStyle[] | null
): number | null {
    if (!bodyStyles || bodyStyles.length === 0) return null;
    const primary = bodyStyles[0];
    const face = baseFontName(primary.font);
    if (!face || face === "unknown") return null;
    const samples: { size: number; chars: number }[] = [];
    let total = 0;
    for (const col of columnResults) {
        for (const line of col.lines) {
            for (const span of line.spans) {
                for (const run of span.styleRuns ?? []) {
                    if (run.chars === 0 || run.exactSize === undefined) continue;
                    if (baseFontName(run.font.name) !== face) continue;
                    if (Math.round(run.font.size) !== primary.size) continue;
                    samples.push({ size: run.exactSize, chars: run.chars });
                    total += run.chars;
                }
            }
        }
    }
    if (total < MIN_BODY_EXACT_SIZE_CHARS) return null;
    samples.sort((a, b) => a.size - b.size);
    let seen = 0;
    for (const sample of samples) {
        seen += sample.chars;
        if (seen * 2 >= total) return sample.size;
    }
    return samples[samples.length - 1].size;
}

/** Visible glyphs a page needs before `pageBodyStyle` reads its body style. */
const PAGE_BODY_MIN_CHARS = 600;
/** Share of a page's visible glyphs its own body style must cover. */
const PAGE_BODY_MIN_SHARE = 0.6;
/** Largest share of a page's glyphs in the document's body styles for the page to have its own. */
const PAGE_BODY_MAX_DOC_SHARE = 0.15;

/**
 * The page's own body style, when it differs from the document's: the style
 * (font, size, weight, slant, by majority per line) that covers most of the
 * page's text. A page appended in another face ("This article has been cited
 * by: 1. …" in Times under a New Caledonia article) is all "different font"
 * to the document-wide heading rules; on its own page that face is the body.
 * A heading has to stand out on its page too. Only a page that is nearly
 * all in another face has its own body style: where the document's body
 * text sets more than `PAGE_BODY_MAX_DOC_SHARE` of the page, the page's
 * headings are judged against it as everywhere else, however much of the
 * page a block quote or a list in a heading face takes up. Null also when
 * the page has little text or no style covers `PAGE_BODY_MIN_SHARE` of it.
 */
function pageBodyStyle(columnResults: ColumnLineResult[], bodyStyles: TextStyle[]): TextStyle | null {
    if (bodyStyles.length === 0) return null;
    const styles: { style: TextStyle; chars: number }[] = [];
    let total = 0;
    let docBody = 0;
    for (const col of columnResults) {
        for (const line of col.lines) {
            const reported = extractLineStyle(line);
            if (!reported) continue;
            const style = majorityLineStyle(line, reported);
            const chars = line.text.replace(/\s/gu, "").length;
            if (chars === 0) continue;
            total += chars;
            if (matchesBodyStyle(style, bodyStyles)) {
                docBody += chars;
                continue;
            }
            const known = styles.find(entry => matchesBodyStyle(style, [entry.style]));
            if (known) known.chars += chars;
            else styles.push({ style, chars });
        }
    }
    if (total < PAGE_BODY_MIN_CHARS || docBody > PAGE_BODY_MAX_DOC_SHARE * total) return null;
    let best: { style: TextStyle; chars: number } | null = null;
    for (const entry of styles) if (!best || entry.chars > best.chars) best = entry;
    return best && best.chars >= PAGE_BODY_MIN_SHARE * total ? { ...best.style, pageLocal: true } : null;
}

/**
 * Largest exact-size difference from the body, as a share of the body size,
 * that font expansion produces. LaTeX `microtype` scales glyphs by up to 2%
 * by default.
 */
const FONT_EXPANSION_SHARE = 0.025;

/**
 * Whether two fonts belong to one family: the names before their style
 * suffix agree ("URWPalladioL-Roma" / "URWPalladioL-Ital",
 * "TimesNewRomanPSMT" / "TimesNewRomanPS-ItalicMT").
 */
function sameFontFamily(a: string, b: string): boolean {
    const ka = baseFontName(a).split(/[-,]/)[0];
    const kb = baseFontName(b).split(/[-,]/)[0];
    return ka.length > 0 && kb.length > 0 && (ka.startsWith(kb) || kb.startsWith(ka));
}

/**
 * Compare a line's size in `lineStyle` with the primary body style: 1 when
 * larger, 0 when the same, -1 when smaller, by the reported (truncated)
 * sizes. A line in the body's font family that reads larger is the same
 * size when both exact sizes are known (see `pageBodyExactSize`) and differ
 * by no more than font expansion does: truncation only split one size in
 * two. Exact sizes only take a size cue away, never add one: sizes the
 * reported ones call equal stay equal, the page's body measure can come from
 * little text, and a heading set a little larger in another face (9pt over
 * an 8.8pt body) keeps its cue.
 */
function compareToBodySize(
    line: PageLine,
    lineStyle: TextStyle,
    primaryBodyStyle: TextStyle
): -1 | 0 | 1 {
    const delta = lineStyle.size - primaryBodyStyle.size;
    if (Math.abs(delta) < 0.5) return 0;
    if (delta < 0) return -1;
    const bodyExact = primaryBodyStyle.exactSize;
    if (bodyExact !== undefined && sameFontFamily(lineStyle.font, primaryBodyStyle.font)) {
        const exact = styleExactSize(line, lineStyle);
        if (exact !== null && exact - bodyExact <= FONT_EXPANSION_SHARE * bodyExact) return 0;
    }
    return 1;
}

/**
 * Whether two heading lines open in the same style: equal reported opening
 * styles, or the same face at exact opening sizes no further apart than font
 * expansion puts them, so size-truncation jitter is not a style change. Two
 * heading levels set half a point apart (10.5pt over 10pt) stay distinct.
 */
function sameOpeningStyle(a: PageLine, b: PageLine): boolean {
    const sa = openingLineStyle(a);
    const sb = openingLineStyle(b);
    if (stylesEqual(sa, sb)) return true;
    if (!sa || !sb || sa.font !== sb.font || sa.bold !== sb.bold || sa.italic !== sb.italic) return false;
    const exactA = openingExactSize(a);
    const exactB = openingExactSize(b);
    return (
        exactA !== null &&
        exactB !== null &&
        Math.abs(exactA - exactB) <= FONT_EXPANSION_SHARE * Math.max(exactA, exactB)
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
        if (!line.font || line.font === "unknown" ||
            !bs.font || bs.font === "unknown") {
            return true;
        }
        // Subset-tag-insensitive match. A PDF producer routinely splits one
        // logical font into several embedded subsets, each with its own random
        // 6-letter tag (`WHFMUD+CMR12`, `FSAPEC+CMR12`). Appendix / proof /
        // figure regions frequently get a different subset than the body even
        // though it is the same visual face — without this the body font's
        // alternate subset reads as "non-body" and the bare-font-difference
        // heading rule promotes ordinary body lines. Comparing base names
        // (tag stripped) treats those as body. Genuine heading faces carry a
        // different base name, so they stay distinguishable.
        const a = baseFontName(line.font);
        const b = baseFontName(bs.font);
        return a !== "" && a === b;
    });
}

// PDF font subset tag: exactly six uppercase letters followed by '+'
// (e.g. `WHFMUD+CMR12`). Stripped to compare the underlying face.
const SUBSET_TAG_RE = /^[A-Z]{6}\+/;
function baseFontName(font: string | undefined | null): string {
    if (!font) return "";
    return font.replace(SUBSET_TAG_RE, "");
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
        .map(line => bboxHeight(line.bbox))
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
 * A run of heading-styled lines up to this long is an isolated heading: one
 * heading, or two stacked (a section over a subsection that may wrap).
 */
const ISOLATED_HEADING_LINES = 3;

/**
 * Per line: it belongs to a run of at most `ISOLATED_HEADING_LINES`
 * heading-styled lines. Each line is judged as a heading item of its own
 * text, so the item-level guards apply: a line opening in lowercase (a body
 * line that starts with an inline italic or math term) or a run-in label is
 * not heading-styled.
 */
function isolatedHeadingLines(
    lines: PageLine[],
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    bodyAllCaps: boolean
): boolean[] {
    const styled = lines.map(line => isHeaderStyle(line, bodyStyles, settings, null, bodyAllCaps, line.text.trim()));
    const isolated = new Array<boolean>(lines.length).fill(false);
    for (let i = 0; i < lines.length; ) {
        if (!styled[i]) {
            i++;
            continue;
        }
        let j = i;
        while (j < lines.length && styled[j]) j++;
        if (j - i <= ISOLATED_HEADING_LINES) isolated.fill(true, i, j);
        i = j;
    }
    return isolated;
}

/** Whether the middle gap(s) of a column's sorted gaps all border an isolated heading. */
function medianIsSectionGap(gaps: { gap: number; section: boolean }[]): boolean {
    const sorted = [...gaps].sort((a, b) => a.gap - b.gap);
    const mid = Math.floor(sorted.length / 2);
    const middle = sorted.length % 2 === 1 ? [sorted[mid]] : [sorted[mid - 1], sorted[mid]];
    return middle.every(g => g.section);
}

/**
 * Calculate column-specific thresholds
 */
function calculateColumnThresholds(
    lines: PageLine[],
    pageThresholds: PageThresholds,
    settings: Required<ParagraphDetectionSettings>,
    bodyStyles: TextStyle[] | null,
    bodyAllCaps: boolean
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
    const maxRightEdge = rightValues.length > 0 ? Math.max(...rightValues) : 0;

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

    // Per-column gap threshold. Compute over THIS column's line gaps only,
    // so a dense neighbour column (e.g. references list with tight
    // continuation spacing) doesn't drag the cutoff below this column's
    // own normal leading. Fall back to the page-wide value when the
    // column has fewer than 3 gaps to keep the estimate stable.
    //
    // Gaps above or below an isolated heading (a run of at most
    // `ISOLATED_HEADING_LINES` heading-styled lines) are section spacing, not
    // leading. When the column's median gap is such a gap, the median does not
    // measure leading and the column takes the page-wide value where that is
    // lower (section gaps only ever inflate the median): the column
    // detector can cut a page into short stacked pieces at its headings, and
    // in a piece holding a paragraph's last lines and two stacked headings the
    // heading gaps are the median and lift the threshold over the gaps that set
    // the headings off. Anywhere else the column keeps its own median: a few
    // section gaps leave it alone, and the gaps left in a short piece once
    // they are set aside are too few and too mixed (a caption's tight leading
    // with the body's) to replace it.
    const sectionLine = settings.isolatedHeadings
        ? isolatedHeadingLines(lines, bodyStyles, settings, bodyAllCaps)
        : new Array<boolean>(lines.length).fill(false);
    const colGaps: { gap: number; section: boolean }[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
        const gap = lines[i + 1].bbox.t - lines[i].bbox.b;
        if (gap < 50 && gap > -5) colGaps.push({ gap, section: sectionLine[i] || sectionLine[i + 1] });
    }
    let gapExcessThreshold = pageThresholds.gapExcessThreshold;
    let medianGap = pageThresholds.medianGap;
    if (colGaps.length >= 3) {
        medianGap = median(colGaps.map(g => g.gap));
        const minMeaningfulIncrease = Math.max(1.0, 0.08 * pageThresholds.medianHeight);
        gapExcessThreshold = Math.max(
            settings.minGapPx,
            medianGap + minMeaningfulIncrease,
            medianGap * 1.25,
            0.4 * pageThresholds.medianHeight
        );
        // Section gaps can only inflate the median: never raise it to the page's.
        if (medianIsSectionGap(colGaps)) {
            medianGap = Math.min(medianGap, pageThresholds.medianGap);
            gapExcessThreshold = Math.min(gapExcessThreshold, pageThresholds.gapExcessThreshold);
        }
    }

    return {
        leftEdgeMode,
        rightEdgeMode,
        leftEdgeMad,
        rightEdgeMad,
        maxRightEdge,
        indentExcessThreshold,
        earlyEndExcessThreshold,
        gapExcessThreshold,
        medianGap,
        isolatedHeading: sectionLine,
    };
}

// ============================================================================
// Step 3: Header Detection
// ============================================================================

/**
 * Detect the CJK CID-subset fragmentation case in `isHeaderStyle`.
 *
 * PDFs produced from East-Asian typesetting sometimes fragment a single
 * logical body font across many PDF font dictionaries that differ only in
 * subset name (e.g. `FZSSK--GBK1-00+ZHNJFM-7`, `+ZHNJFO-12`, `+ZHNJFP-20`
 * — same typeface, opaque CID-subset suffix). Lower-volume subsets fall
 * below the analyzer's 15%-of-primary threshold and are excluded from
 * bodyStyles, so a body-sized line in one of those subsets fails strict
 * matching and gets misclassified as a heading by Rule 1.
 *
 * Three guards keep this narrow:
 *   - CJK content. Latin / other-script lines never enter the fallback.
 *   - No numeric outline prefix. Numbered section titles
 *     ("2. BACKGROUND", "2.1 冷凝法") must still be allowed to reach the
 *     header rules. Uses `NUMERIC_OUTLINE_PREFIX_CJK_RE` (CJK-aware)
 *     instead of `SECTION_PREFIX_RE`, since Chinese characters are
 *     `\p{Lo}` and would otherwise slip past the Latin-only guard.
 *   - Fragmentation evidence. `bodyStyles` itself contains 2+ distinct
 *     fonts at the line's exact (size, bold, italic) — i.e. the document
 *     ALREADY shows subset fragmentation at this style class.
 *
 * Returning true means "treat as body" — the caller short-circuits before
 * any Rule 1-6 evaluation.
 */
// Exported for unit tests only. Not part of the production API.
export function looksLikeFragmentedCJKBody(
    line: PageLine,
    lineStyle: TextStyle,
    bodyStyles: TextStyle[]
): boolean {
    const text = line.text.trim();
    if (!hasCJKContent(text)) return false;
    if (NUMERIC_OUTLINE_PREFIX_CJK_RE.test(text)) return false;

    // A page's own body style (`pageBodyStyle`) is another face, not a subset
    // of the document's: it is no evidence of fragmentation.
    const sameDims = bodyStyles.filter(bs =>
        !bs.pageLocal &&
        Math.abs(bs.size - lineStyle.size) < 0.5 &&
        bs.bold === lineStyle.bold &&
        bs.italic === lineStyle.italic
    );
    const distinctFonts = new Set(sameDims.map(bs => bs.font));
    return distinctFonts.size >= 2;
}

/**
 * Share of a line's visible glyphs that bold, italic or a size must reach to
 * describe the line in `majorityLineStyle`.
 */
const MAJORITY_STYLE_SHARE = 0.75;

/**
 * Math fonts (TeX Computer Modern math, AMS, MathTime, txfonts, Cambria/STIX
 * Math, Symbol). Glyphs set in them don't vote in `majorityLineStyle`: an
 * italic variable inside a heading ("… for the k = const case") says
 * nothing about the heading's own styling.
 */
const MATH_FONT_RE =
    /^(?:CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|EUFM|EUSM|RSFS|MTMI|MTSY|MTEX|RMTMI|RBLMI|rtxmi|rtxsy|txmi|txsy|txex|Symbol|MT-Extra|Euclid|ESint|wasy|stmary|TeX_CM_Maths|[^,]*Math)/i;

/**
 * A line's per-glyph style runs (see `RawLine.styleRuns`) in reading order
 * across its spans, each with its text. Runs count non-whitespace glyphs in
 * order; empty runs are dropped.
 */
function lineStyleRuns(line: PageLine): { run: RawStyleRun; text: string }[] {
    const runs: { run: RawStyleRun; text: string }[] = [];
    for (const span of line.spans) {
        const glyphs = Array.from(span.text).filter(c => /\S/u.test(c));
        let offset = 0;
        for (const run of span.styleRuns ?? []) {
            if (run.chars === 0) continue;
            runs.push({ run, text: glyphs.slice(offset, offset + run.chars).join("") });
            offset += run.chars;
        }
    }
    return runs;
}

/**
 * Size a style run counts at in `majorityLineStyle`: the largest size its font
 * reaches on the line (`fontMax`) when the run is smaller only as fake small
 * caps or superscripts are, or by size-truncation jitter; its own size
 * otherwise.
 *
 * Fake small caps hold no lowercase letters, and superscripts and subscripts
 * are a few glyphs long. A longer smaller run of lowercase text is text in
 * its own right: the body text after a run-in label that the producer set
 * larger in the same font ("Speed: Translation by…") rather than in a bold
 * face, or the prose around a larger operator ("if x = ab"). Lifting it
 * would make the whole line read larger than the body.
 */
function liftedRunSize(run: RawStyleRun, text: string, fontMax: RawStyleRun): number {
    const max = fontMax.font.size;
    if (run.font.size === max || run.chars <= 3 || !/\p{Ll}/u.test(text)) return max;
    if (run.exactSize === undefined || fontMax.exactSize === undefined) return max;
    return fontMax.exactSize - run.exactSize <= FONT_EXPANSION_SHARE * fontMax.exactSize ? max : run.font.size;
}

/**
 * Majority styling of a line, from its per-glyph style runs.
 *
 * MuPDF reports a line's font from its first glyph, so a body line that
 * opens with a bold run-in label ("Abstract: A growing literature…") or an
 * italic word reads as bold or italic throughout. This describes the line by
 * the styling most of its glyphs carry instead: bold / italic only when at
 * least `MAJORITY_STYLE_SHARE` of the visible glyphs are, the size reached by
 * that share, and the font with the most glyphs.
 *
 * Not every glyph votes:
 *   - short letterless runs at either end (bullets, footnote and affiliation
 *     markers, trailing punctuation) and a leading section number
 *     (`numberedTitleStyle`);
 *   - math-font glyphs (`MATH_FONT_RE`);
 *   - some size differences within one font (`liftedRunSize`), so fake small
 *     caps ("I. I" + "NTRODUCTION" set smaller) and superscripts don't
 *     shrink the line.
 *
 * Returns `lineStyle` itself when the line has no style runs or its majority
 * styling agrees with it.
 */
function majorityLineStyle(line: PageLine, lineStyle: TextStyle): TextStyle {
    const runs = lineStyleRuns(line);
    if (runs.length === 0) return lineStyle;

    let start = numberedTitleStyle(line)?.numberRuns ?? 0;
    let end = runs.length;
    while (end - start > 1 && runs[start].run.letters === 0 && runs[start].run.chars <= 3) start++;
    while (end - start > 1 && runs[end - 1].run.letters === 0 && runs[end - 1].run.chars <= 3) end--;
    const voters = runs
        .slice(start, end)
        .filter(({ run }) => !MATH_FONT_RE.test(baseFontName(run.font.name)));
    if (voters.length === 0) return lineStyle;

    const fontMax = new Map<string, RawStyleRun>();
    for (const { run } of voters) {
        const max = fontMax.get(run.font.name);
        if (!max || run.font.size > max.font.size) fontMax.set(run.font.name, run);
    }

    let total = 0;
    let boldChars = 0;
    let italicChars = 0;
    let heavyChars = 0;
    const charsBySize = new Map<number, number>();
    const charsByFont = new Map<string, number>();
    const fontFaces = new Map<string, TextStyle>();
    for (const { run, text } of voters) {
        const style = extractSpanStyle(
            run.font.name || "unknown",
            run.font.weight,
            run.font.style,
            liftedRunSize(run, text, fontMax.get(run.font.name)!)
        );
        total += run.chars;
        if (style.bold) boldChars += run.chars;
        if (style.italic) italicChars += run.chars;
        if (hasHeavyWeightToken(style.font)) heavyChars += run.chars;
        charsBySize.set(style.size, (charsBySize.get(style.size) ?? 0) + run.chars);
        charsByFont.set(style.font, (charsByFont.get(style.font) ?? 0) + run.chars);
        fontFaces.set(style.font, style);
    }

    // Largest size that at least MAJORITY_STYLE_SHARE of the glyphs reach.
    const sizes = [...charsBySize.keys()].sort((a, b) => b - a);
    let size = sizes[sizes.length - 1];
    let reached = 0;
    for (const s of sizes) {
        reached += charsBySize.get(s)!;
        if (reached / total >= MAJORITY_STYLE_SHARE) {
            size = s;
            break;
        }
    }
    // The font with the most glyphs, among the faces whose styling the line
    // carries. A bold, italic, Medium or Semibold face must cover
    // MAJORITY_STYLE_SHARE of the glyphs to describe the line, like the bold
    // and italic flags: a semibold run-in label ahead of plain text ("Peer
    // review information Nature Medicine thanks…") or an italic question
    // ahead of its roman gloss can outnumber each plain face without making
    // the line a heading face.
    const bold = boldChars / total >= MAJORITY_STYLE_SHARE;
    const italic = italicChars / total >= MAJORITY_STYLE_SHARE;
    const heavyMajority = heavyChars / total >= MAJORITY_STYLE_SHARE;
    let font = lineStyle.font;
    let fontChars = -1;
    for (const [name, chars] of charsByFont) {
        const face = fontFaces.get(name)!;
        if ((!bold && face.bold) || (!italic && face.italic) || (!heavyMajority && hasHeavyWeightToken(name))) continue;
        if (chars > fontChars) {
            fontChars = chars;
            font = name;
        }
    }

    const majority: TextStyle = { size, font, bold, italic };
    return stylesEqual(majority, lineStyle) ? lineStyle : majority;
}

/**
 * Section number opening a line, as its own style runs: "2.4", "3.", "1.2.3".
 * A dotted number of at most two leading digits: a bare integer in another
 * face than the text after it is a page number in a running head ("90 Aoife
 * O'Donoghue and Adam Rowe"), a superscript, or part of an equation.
 */
const SECTION_NUMBER_RE = /^\d{1,2}(?:(?:\.\d{1,3}){1,3}\.?|\.)$/;

/**
 * Style of a numbered heading's title when its section number is set in
 * another style: "2.4 *Freeing Up Women's Time*", the number in the body face
 * and the title in italic, or "2.1.1 **Levels of…**" with the number in the
 * title's face at a slightly different size, which truncation reports as
 * 11 against the title's 12. MuPDF reports the line's style from the number's
 * first glyph, so the line reads as body text or as two styles. The title's
 * opening style describes the line instead, the way an unnumbered heading is
 * described by its first glyph.
 *
 * Needs per-glyph style runs: the line must open with runs that hold exactly
 * a section number (`SECTION_NUMBER_RE`), set plain (not bold or italic) or
 * in the title's own face, followed by a run in a different style at the
 * number's size (a smaller number is an affiliation or footnote marker). The
 * number may be a span of its own, as when a wide space separates it from
 * the title. Contents entries with dot leaders are excluded. Returns null
 * otherwise.
 */
function numberedTitleStyle(line: PageLine): { style: TextStyle; numberRuns: number } | null {
    if (!SECTION_PREFIX_RE.test(line.text) || /(?:\.\s?){4}/.test(line.text)) return null;
    const runs = lineStyleRuns(line);
    if (runs.length < 2) return null;

    let number = "";
    let numberRuns = 0;
    while (numberRuns < runs.length - 1 && /^[\d.]+$/.test(runs[numberRuns].text)) {
        number += runs[numberRuns].text;
        numberRuns++;
    }
    if (numberRuns === 0 || !SECTION_NUMBER_RE.test(number)) return null;

    const title = runs[numberRuns].run;
    const style = extractSpanStyle(title.font.name || "unknown", title.font.weight, title.font.style, title.font.size);
    // A bold or italic number in a face of its own carries the heading cue
    // itself (see `isCJKNumberedHeading`); a plain number, or one in the
    // title's face, defers to its title.
    for (const { run } of runs.slice(0, numberRuns)) {
        const numberStyle = extractSpanStyle(run.font.name || "unknown", run.font.weight, run.font.style, run.font.size);
        const titleFace =
            baseFontName(numberStyle.font) === baseFontName(style.font) &&
            numberStyle.bold === style.bold &&
            numberStyle.italic === style.italic;
        if (!titleFace && (numberStyle.bold || numberStyle.italic || hasHeavyWeightToken(numberStyle.font))) {
            return null;
        }
    }
    const sizeOf = (run: RawStyleRun) => run.exactSize ?? run.font.size;
    if (runs.slice(0, numberRuns).some(({ run }) => Math.abs(sizeOf(run) - sizeOf(title)) > 1)) return null;
    // Another subset of the line's own font (`WHFMUD+Calibri` after
    // `FSAPEC+Calibri`) is not another style.
    const lineStyle = extractLineStyle(line);
    const sameStyle = !!lineStyle && stylesEqual(
        { ...style, font: baseFontName(style.font) },
        { ...lineStyle, font: baseFontName(lineStyle.font) }
    );
    return sameStyle ? null : { style, numberRuns };
}

/** The line's opening style: a numbered title's style, else its first glyph's. */
function openingLineStyle(line: PageLine): TextStyle | null {
    return numberedTitleStyle(line)?.style ?? extractLineStyle(line);
}

/**
 * Check if a line should be classified as a header.
 *
 * The heading rules run on the line's reported (first-glyph) style. When the
 * line's majority styling differs (see `majorityLineStyle`), the rules must
 * also hold for that styling: a cue carried by the opening word alone — a
 * bold "Keywords:", an italic "Note:" — does not make the line a heading.
 * The majority styling only ever vetoes; it never promotes a line the
 * first-glyph style rejects.
 */
function isHeaderStyle(
    line: PageLine,
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    precededByGap: boolean | null = null,
    bodyAllCaps: boolean = false,
    phraseTextOverride: string | null = null
): boolean {
    // A numbered title's style stands in for the section number's (see
    // `numberedTitleStyle`). A numbered title set smaller than the body is an
    // entry in a numbered reference or note list, not a section heading.
    let numbered = numberedTitleStyle(line);
    if (numbered && bodyStyles && bodyStyles.length > 0 && numbered.style.size < bodyStyles[0].size - 0.5) {
        numbered = null;
    }
    // The span-dominance check still applies to the spans after the first,
    // which holds the number: in a table row ("1. Placebo treatment | 40 |
    // 50") the other cells are spans in another style. Math-font spans don't
    // count, as in `majorityLineStyle` ("2. Case |Ψ⟩").
    const titleSpans = line.spans
        .slice(1)
        .filter(span => !MATH_FONT_RE.test(baseFontName(span.fontName || "")));
    if (
        numbered &&
        titleSpans.length > 0 &&
        getStyleDominance({ ...line, spans: titleSpans }, numbered.style) < 0.9
    ) {
        numbered = null;
    }
    const lineStyle = numbered?.style ?? extractLineStyle(line);
    if (!lineStyle) return false;
    // Item-level only (the joined item text): boundaries are decided per line
    // and stay as they are; a run-in label, equation or link item just isn't
    // labelled a heading.
    if (
        settings.headingLabelFilters &&
        phraseTextOverride !== null &&
        (looksLikeRunInLabel(phraseTextOverride) ||
            looksLikeEquation(phraseTextOverride) ||
            looksLikeWebAddresses(phraseTextOverride) ||
            looksLikeIdentifier(phraseTextOverride))
    ) {
        return false;
    }
    if (!matchesHeaderRules(
        line, lineStyle, !numbered, bodyStyles, settings, precededByGap, bodyAllCaps, phraseTextOverride
    )) {
        return false;
    }
    const majority = majorityLineStyle(line, lineStyle);
    if (majority === lineStyle) return true;
    if (matchesHeaderRules(
        line, majority, false, bodyStyles, settings, precededByGap, bodyAllCaps, phraseTextOverride
    )) {
        return true;
    }
    return isCJKNumberedHeading(line, bodyStyles);
}

/**
 * Front-matter and back-matter labels that open a run-in line: "Keywords: …",
 * "Received: 5 May 2020", "Conflict of interest: None", "To cite this
 * article: …". Set as a bold or italic label followed by plain text, or
 * entirely in a heading face, they read as headings to the style rules.
 */
const RUN_IN_LABELS = [
    "abstract",
    "e?-?issn",
    "doi",
    "received",
    "accepted",
    "revised",
    "published(?:\\s+online)?",
    "available\\s+online",
    "article\\s+history",
    "(?:handling\\s+|academic\\s+)?editors?(?:\\s*\\(s\\))?",
    "copyright",
    "citation",
    "(?:to\\s+)?cite\\s+this\\s+article",
    "suggested\\s+citation",
    "correspondence",
    "corresponding\\s+authors?",
    "e-?mail(?:\\s+address(?:es)?)?",
    "funding(?:\\s+information)?",
    "conflicts?\\s+of\\s+interests?",
    "competing\\s+interests?",
    "declarations?\\s+of\\s+(?:competing|conflicting)\\s+interests?",
    "abbreviations",
    "highlights",
    "data\\s+availability(?:\\s+statement)?",
    "level\\s+of\\s+evidence",
    "ethics\\s+approval",
    "jel(?:\\s+(?:classifications?|codes?))?",
    "notes?",
    "sources?",
];
const RUN_IN_LABEL_RE = new RegExp(`^(?:${RUN_IN_LABELS.join("|")})\\s*[:.：]\\s*\\S`, "iu");

/** Keyword labels, which also appear without a colon ("Keywords Peer influence · …"). */
const KEYWORDS_LABEL_RE =
    /^(?:key\s*-?\s*words?|index\s+terms|palabras\s+clave|mots[-\s]cl[ée]s|schl[üu]sselw[öo]rter)\s*[:.：]?\s+\S/iu;

/**
 * Structured-abstract section words. As headings they are common
 * ("Results", "Conclusion: Future Directions"), so they count as run-in
 * labels only when prose follows them.
 */
const STRUCTURED_ABSTRACT_LABEL_RE =
    /^(?:background|objectives?|aims?|purpose|methods?|methodology|results?|conclusions?|discussion|introduction|motivation|findings|design|setting|participants|limitations|implications|summary|context|interpretation|originality\/value)\s*[:.：]\s+(\S[\s\S]*)$/iu;

/**
 * Words that mark a clause rather than a noun-phrase title: auxiliaries,
 * pronouns and relatives ("We found…", "…were completed", "…which…").
 */
const PROSE_WORD_RE =
    /\b(?:is|are|was|were|be|been|being|has|have|had|can|could|may|might|will|would|should|must|does|did|we|our|us|i|it|its|this|these|they|their|there|which|who|that)\b/iu;

/**
 * A sentence ending followed by the next sentence: a word of two or more
 * lowercase letters or digits, terminal punctuation, then a capital. The
 * two-character floor skips initialisms ("the U.S. and Europe").
 */
const SENTENCE_BREAK_RE = /[\p{Ll}\d)%]{2}[.!?]["'”’)\]]*\s+["“'‘(]?[\p{Lu}\d]/u;

/** A line that wraps mid-phrase ends on a function word ("…in", "…of the"). */
const FUNCTION_WORD_END_RE =
    /\b(?:a|an|the|of|in|on|to|for|with|by|from|at|as|and|or|but|that|which|than|is|are|was|were|be|can|our|their|its|between|into|using|while|whether)\W*$/iu;

/**
 * Whether text after a structured-abstract label reads as prose rather than a
 * subtitle. A heading subtitle can be long and sentence-case ("Effects of the
 * intervention on the quality of life in older adults"), so length and case
 * alone are not enough: prose also ends a sentence, breaks a word across the
 * line, or carries a verb, pronoun or dangling function word. Numbers are no
 * evidence either way ("Effects of the COVID-19 pandemic on …").
 * A subtitle that is a single question is never prose — question headings
 * are common.
 */
function isProseTail(tail: string): boolean {
    const trimmed = tail.trimEnd();
    const words = trimmed.match(/[^\W\d_][\w'’-]*/gu) ?? [];
    if (words.length < 6) return false;
    // A single question is a heading subtitle, however many auxiliaries it
    // carries ("are there viable alternatives to …?").
    if (/\?["'”’)\]]*$/u.test(trimmed) && !SENTENCE_BREAK_RE.test(trimmed)) return false;
    if (/[-\u00AD]$/u.test(trimmed)) return true;
    if (/[.!]["'”’)\]]*$/u.test(trimmed) || SENTENCE_BREAK_RE.test(trimmed)) return true;
    if (words.length < 10) return false;
    return PROSE_WORD_RE.test(trimmed) || FUNCTION_WORD_END_RE.test(trimmed) || /[,;:]$/u.test(trimmed);
}

/** A run-in label item: a known label followed by text on the same line. */
function looksLikeRunInLabel(text: string): boolean {
    const t = text.trim();
    if (RUN_IN_LABEL_RE.test(t) || KEYWORDS_LABEL_RE.test(t)) return true;
    const m = STRUCTURED_ABSTRACT_LABEL_RE.exec(t);
    return !!m && isProseTail(m[1]);
}

/**
 * Share of an equation's visible characters, at most, that words of three or
 * more letters make up (see `looksLikeEquation`).
 */
const EQUATION_WORD_SHARE = 0.4;

/** A complete bracketed group: a function's arguments, a set, an index. */
const BRACKETED_GROUP_RE = /\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}/gu;

/**
 * A display equation: text that states a relation ("=") and is mostly
 * symbols, with less than `EQUATION_WORD_SHARE` of its visible characters in
 * words of three or more letters ("Σ* = {0, a, b, aa, ab, …}", "P(A, B) =
 * P(A)P(B)"). An equation set in a larger or italic face, or centered with
 * space around it, passes the style rules.
 *
 * An equation's left-hand side is a symbol expression, whose words, if any,
 * sit inside function arguments ("P(can | N) = 0.9"). A heading that states a
 * relation names its subject in words before it, however short the heading
 * is ("2.1.1 Case n = 1", "3. Case 1: x = y", "3. Proof: a² + b² = c²").
 */
function looksLikeEquation(text: string): boolean {
    const relation = text.indexOf("=");
    if (relation < 0) return false;
    let lhs = text.slice(0, relation);
    for (let prev = ""; prev !== lhs; ) {
        prev = lhs;
        lhs = lhs.replace(BRACKETED_GROUP_RE, "");
    }
    if (/\p{L}{3,}/u.test(lhs)) return false;
    const visible = text.replace(/\s/gu, "").length;
    const wordChars = (text.match(/\p{L}{3,}/gu) ?? []).join("").length;
    return wordChars < EQUATION_WORD_SHARE * visible;
}

/**
 * One web address or DOI: a URL with a scheme, a "www." host, a host with a
 * path ("babel.uoregon.edu/guides.html"), or a DOI. A bare host without
 * "www." ("Booking.com") can be a name, so it doesn't count.
 */
const WEB_ADDRESS_RE =
    /^(?:[a-z][a-z+.-]*:\/\/\S+|www\d?\.\S+|[\w-]+(?:\.[\w-]+)*\.\p{L}{2,}\/\S*|10\.\d{4,9}\/\S+)$/iu;

/**
 * Text that is only web addresses: a link line on a cover page or in a list
 * of resources, set in a larger or distinct face. A heading names its
 * section in words. A path wrapped after a slash ("…/ doc/cjk.inf") counts
 * as part of its address.
 */
function looksLikeWebAddresses(text: string): boolean {
    const tokens = text.trim().split(/\s+/u);
    let address = false;
    for (const token of tokens) {
        if (WEB_ADDRESS_RE.test(token)) address = true;
        else if (!(address && /^[\w.~%-]*\/\S*$|^[\w~%-]+\.\p{L}{2,4}$/u.test(token))) return false;
    }
    return address;
}

/**
 * A lone identifier rather than words: an e-mail address, or a long token
 * without spaces in an identifier's shape — code punctuation ("_", "%",
 * "#", "=", "@"), a file name ending, or a hash (a lowercase run of eight or
 * more hex digits, or a UUID) — such as a link wrapped onto its own line
 * ("071d4a94-28a8-11e4-8593-da634b334390_story.html") or a rule of
 * underscores. Hyphenated scientific names with digits
 * ("Phosphatidylinositol-3-Kinase", "ABCC10-Mediated-Chemoresistance"),
 * words joined by slashes and CJK headings are not identifiers.
 */
function looksLikeIdentifier(text: string): boolean {
    const token = text.trim();
    if (/[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) return false;
    if (/^[^@\s]+@[^@\s]+\.\p{L}{2,}$/u.test(token)) return true;
    if (token.length < 20) return false;
    return (
        /[_%#=@\\]/u.test(token) ||
        /\.(?:html?|pdf|php|aspx?|jsp|xml|txt|docx?|xlsx?|csv|zip)\b/iu.test(token) ||
        /(?:^|[^0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}(?![0-9a-z])/u.test(token) ||
        /(?:^|[^0-9a-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}(?![0-9a-z])/iu.test(token)
    );
}

/**
 * Numbered CJK / Korean section headings whose number alone carries the
 * heading styling: a bold or larger "２．２" / "5" / "(6)" before heading text
 * set in a face MuPDF doesn't flag as bold ("２．２ 明确对党忠诚的…"). The
 * majority-style veto would demote them; keep them when the text after the
 * number is CJK, at least body size (numbered footnotes and running heads are
 * set smaller) and doesn't end like a sentence.
 */
function isCJKNumberedHeading(line: PageLine, bodyStyles: TextStyle[] | null): boolean {
    if (!bodyStyles || bodyStyles.length === 0) return false;
    const span = line.spans[0];
    const runs = (span?.styleRuns ?? []).filter(run => run.chars > 0);
    if (runs.length < 2) return false;

    // Text of each run: runs count non-whitespace glyphs in order.
    const glyphs = Array.from(span.text).filter(c => /\S/u.test(c));
    let offset = 0;
    const runTexts = runs.map(run => {
        const text = glyphs.slice(offset, offset + run.chars).join("");
        offset += run.chars;
        return text;
    });

    let prefixRuns = 0;
    while (prefixRuns < runs.length && /^[\p{Nd}.．、()（）]+$/u.test(runTexts[prefixRuns])) prefixRuns++;
    if (prefixRuns === 0 || prefixRuns === runs.length) return false;
    const prefix = runTexts.slice(0, prefixRuns).join("");
    if (!/^[(（]?\p{Nd}{1,3}(?:[.．]\p{Nd}{1,3}){0,3}[.．、)）]?$/u.test(prefix)) return false;

    const rest = runTexts.slice(prefixRuns).join("");
    // Sentence-final punctuation, possibly followed by closing quotes or brackets.
    if (!hasCJKContent(rest) || /[。！？.!?]["'”’」』）)\]】]*$/u.test(rest)) return false;

    const bodySize = bodyStyles[0].size;
    let restChars = 0;
    let bodySizedChars = 0;
    for (const run of runs.slice(prefixRuns)) {
        restChars += run.chars;
        if (run.font.size >= bodySize - 0.5) bodySizedChars += run.chars;
    }
    return bodySizedChars / restChars >= MAJORITY_STYLE_SHARE;
}

/**
 * Whether the line's reported (first-glyph) style alone satisfies the heading
 * rules, i.e. `isHeaderStyle` without the majority-style veto.
 */
function opensWithHeaderStyle(
    line: PageLine,
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    precededByGap: boolean | null,
    bodyAllCaps: boolean
): boolean {
    const lineStyle = extractLineStyle(line);
    return !!lineStyle && matchesHeaderRules(
        line, lineStyle, true, bodyStyles, settings, precededByGap, bodyAllCaps, null
    );
}

/**
 * Heading rules for `line` judged as set in `lineStyle`.
 * `checkSpanDominance` requires `lineStyle` to cover 90% of the line's
 * spans; it only applies to the line's reported (first-span) style.
 */
function matchesHeaderRules(
    line: PageLine,
    lineStyle: TextStyle,
    checkSpanDominance: boolean,
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    precededByGap: boolean | null,
    bodyAllCaps: boolean,
    phraseTextOverride: string | null
): boolean {
    if (!bodyStyles || bodyStyles.length === 0) return false;

    // Bullet-led list items and math-symbol lines: MuPDF's JSON walk
    // aggregates the leading glyph's font over the whole line, so the line
    // reads as "different font, possibly larger size" vs. body. Math-symbol
    // fonts (MTSY/MTSYN) cover both bullet-led list items (`• ...` set in
    // MathTime) and equation lines — neither belongs in the heading
    // classifier. Always reject — real headings don't use these fonts.
    if (
        ICON_FONT_RE.test(lineStyle.font) ||
        MATH_SYMBOL_FONT_RE.test(lineStyle.font)
    ) {
        return false;
    }

    const primaryBodyStyle = bodyStyles[0];
    const sizeVsBody = compareToBodySize(line, lineStyle, primaryBodyStyle);
    const gapCheckPasses = precededByGap === null || precededByGap;
    const text = line.text.trim();
    // `phraseTextOverride` lets the multi-line item evaluator pass the joined
    // item text so Rules 5/6 (and the all-caps body-style bypass below) see
    // the full heading even when it wraps across lines; per-line evaluation in
    // `startNewItem` leaves it null so the first line is tested on its own.
    const phraseText = phraseTextOverride ?? text;

    // All-caps heading with no usable font cue. When the heading's font is
    // unresolved ("unknown"/"") or identical to the body font, the
    // font-difference heading rules (2-6) can never fire: an all-caps line in
    // an indistinct font reports the same style class as body and is treated
    // as body text by `matchesBodyStyle` below. This is the dominant shape on
    // PDFs whose embedded fonts MuPDF cannot resolve (every line reports font
    // "unknown"), where section titles are visually bold/caps yet carry no
    // size/weight/font signal. The all-caps multi-word phrase is the
    // independent heading cue; the body must not itself be all-caps (whole-
    // document caps rendering is not a heading signal), the line must be
    // same-or-smaller size, non-italic, and preceded by a gap. Resolved,
    // distinct-font docs keep using Rule 5 (this bypass requires an indistinct
    // font, so it never changes their behavior).
    //
    // A page set in its own body face (`pageBodyStyle`) is the same case on
    // that page: an all-caps heading in the page's face ("APPENDIX METHODS"
    // on an appendix page in another font) matches the page's body style. It
    // qualifies by the page's body as well as by the document's: not larger
    // than either body in that body's face.
    const fontIndistinctFromBody =
        !lineStyle.font ||
        lineStyle.font === "unknown" ||
        lineStyle.font === primaryBodyStyle.font ||
        baseFontName(lineStyle.font) === baseFontName(primaryBodyStyle.font);
    const indistinctFromPageBody = bodyStyles.some(
        style =>
            style.pageLocal &&
            baseFontName(style.font) === baseFontName(lineStyle.font) &&
            lineStyle.size - style.size < 0.5
    );
    const capsWithoutFontCue =
        gapCheckPasses &&
        !bodyAllCaps &&
        ((fontIndistinctFromBody && sizeVsBody <= 0) || indistinctFromPageBody) &&
        !lineStyle.italic &&
        isAllCapsHeaderPhrase(phraseText) &&
        // All-caps reference-list entries (uppercased author names + year)
        // share the body face and would otherwise be promoted; the byline /
        // citation shapes separate them from genuine all-caps section titles.
        !looksLikeByline(phraseText) &&
        !looksLikeJournalCitation(phraseText);

    // Not a header if it's a known body style. The all-caps-without-font-cue
    // candidate is exempt: under an indistinct font it matches body style by
    // construction, so the all-caps cue is the only thing separating it from
    // body text.
    if (matchesBodyStyle(lineStyle, bodyStyles) && !capsWithoutFontCue) {
        return false;
    }

    // CJK CID-subset body fallback: the line uses a body-sized style class
    // that bodyStyles already shows fragmented across 2+ fonts. The "new"
    // font here is almost certainly another subset of the same logical
    // body font, not a real heading. Narrow text guards (CJK content,
    // no section prefix) keep this off Latin docs and preserve Rule 6.
    if (looksLikeFragmentedCJKBody(line, lineStyle, bodyStyles)) {
        return false;
    }

    // Must be highly consistent (90%+ same style)
    if (checkSpanDominance && getStyleDominance(line, lineStyle) < 0.9) {
        return false;
    }

    let isPotentialHeader = false;
    // True when the candidate carries an independent size cue (Rule 1).
    // Used to exempt size-cued headings from the heading-capitalization
    // guard below — a larger line is a heading regardless of its leading
    // character.
    const sizeIncreaseHeader = sizeVsBody === 1;

    // Rule 1: Larger font size
    if (sizeIncreaseHeader) {
        isPotentialHeader = true;
    }

    // Rule 2: Same size, bold, different font (requires gap)
    if (
        !isPotentialHeader &&
        gapCheckPasses &&
        sizeVsBody === 0 &&
        lineStyle.bold &&
        !primaryBodyStyle.bold &&
        lineStyle.font !== primaryBodyStyle.font
    ) {
        isPotentialHeader = true;
    }

    // Rule 2b: Same size, different font, heading-weight token (requires gap).
    // Section titles set in a Medium / Semibold / Demibold display weight that
    // MuPDF reports as `weight: "normal"` (so Rule 2's bold flag never fires)
    // — e.g. a sans "Variables" subheading in `HelveticaNeueLTStd-Md` over a
    // serif Regular body. Gated exactly like Rule 2 (different font, same
    // size, gap), with the weight token replacing the bold flag. The body
    // must not itself carry the heading weight, so a document whose body is a
    // Medium face does not promote every line.
    if (
        !isPotentialHeader &&
        gapCheckPasses &&
        sizeVsBody === 0 &&
        hasHeavyWeightToken(lineStyle.font) &&
        !hasHeavyWeightToken(primaryBodyStyle.font) &&
        lineStyle.font !== primaryBodyStyle.font
    ) {
        isPotentialHeader = true;
    }

    // Rule 3: Same size, italic, different font (requires gap)
    if (
        !isPotentialHeader &&
        gapCheckPasses &&
        sizeVsBody === 0 &&
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
        sizeVsBody === -1 &&
        lineStyle.bold &&
        !primaryBodyStyle.bold &&
        lineStyle.font !== primaryBodyStyle.font
    ) {
        isPotentialHeader = true;
    }

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
    if (
        !isPotentialHeader &&
        gapCheckPasses &&
        !bodyAllCaps &&
        sizeVsBody <= 0 &&
        lineStyle.font !== primaryBodyStyle.font &&
        isAllCapsHeaderPhrase(phraseText)
    ) {
        isPotentialHeader = true;
    }

    // Rule 6: Same size, different font, section-number prefix (requires gap).
    // Catches sans-on-serif (or serif-on-sans) section titles that carry no
    // bold/italic/size cue — e.g. "2. BACKGROUND", "2.1 Race, Neighborhoods,
    // and Police Stops", "3.1 Stop and Frisk in New York City". The numeric
    // outline prefix is what makes the rule safe: body lines that happen to
    // be in a different font (inline code, embedded glyphs) almost never
    // start with a "N." or "N.M" outline.
    //
    // Tested against `phraseText`, not the per-line `text`: a section
    // heading long enough to wrap carries its numeric outline only on the
    // first line ("3.3. Key success factors for successful\nproject
    // management"). Per-line evaluation in `startNewItem` leaves
    // `phraseTextOverride` null so the first line still triggers correctly;
    // the multi-line item evaluator passes the joined text so every wrapped
    // line of the same heading is recognised. Mirrors Rule 5.
    if (
        !isPotentialHeader &&
        gapCheckPasses &&
        sizeVsBody === 0 &&
        lineStyle.font !== primaryBodyStyle.font &&
        SECTION_PREFIX_RE.test(phraseText)
    ) {
        isPotentialHeader = true;
    }

    // All-caps promotion with no usable font cue (see `capsWithoutFontCue`
    // above). Kept last so the font-based rules win when they apply.
    //
    // A bare font-difference rule (same size, distinct font, heading-cased,
    // gap — no bold/italic/all-caps/section-number cue) was evaluated and
    // deliberately rejected: the signal is too weak. Across real documents it
    // fires throughout figure axis labels, equation lead-ins, table headers,
    // and author bylines (all set in a distinct face at body size), with no
    // text-only guard that separates them from genuine title-case subheadings.
    // Missing a heading is preferred to mislabelling body/figure/table text.
    if (!isPotentialHeader && capsWithoutFontCue) {
        isPotentialHeader = true;
    }

    if (!isPotentialHeader) return false;

    // Apply disqualifying heuristics

    // Heading-capitalization guard. Rules 2-6 promote a candidate on a
    // same-or-smaller-size font difference alone — a signal that is
    // unreliable in two recurring situations:
    //   - MuPDF's JSON walk reports a single font per line, taken from the
    //     line's leading run. A body paragraph line that merely begins with
    //     an italic/bold word (e.g. the tail of a hyphenated italicised
    //     term continued onto the next line) is reported entirely in that
    //     emphasis font and reads as "different font, same size" vs. body.
    //   - Inline equation fragments set in a math-italic font (variables,
    //     function notation like "n(unemp | soc, s, t)") are a different
    //     font at body size.
    // Both produce a lowercase-leading line. Real section headings begin
    // with a capital letter, a digit, or an opening quote/bracket — so a
    // lowercase-leading candidate carrying no size cue is body prose or an
    // equation, not a heading. Size-cued headings (Rule 1) keep their
    // independent signal and are exempt.
    //
    // This is an item-level disqualifier: it runs only when an explicit
    // `phraseTextOverride` is supplied, i.e. from the multi-line item
    // evaluator, where `phraseText` is the joined item text and therefore
    // begins with the item's FIRST line. The per-line boundary checks in
    // `startNewItem` pass no override and are skipped — otherwise a genuine
    // multi-line heading whose wrapped continuation starts with a lowercase
    // word ("...stage distribution\nand relatedness between strains...")
    // would have that continuation demoted, breaking the merge that keeps
    // the heading intact.
    if (
        phraseTextOverride !== null &&
        !sizeIncreaseHeader &&
        /^["'“‘«([]?\p{Ll}/u.test(phraseText)
    ) {
        return false;
    }

    // Author block on a paper's cover page commonly uses the same bold-encoded
    // subset font as section titles. Use the merged `phraseText` so multi-line
    // author lists are evaluated as a whole.
    if (looksLikeAuthorList(phraseText)) {
        return false;
    }

    // Reference-list citation tails: italicized journal names with trailing
    // volume/pages/year fit Rule 3 ("same size, italic, different font")
    // perfectly but aren't headings. Gated on `lineStyle.italic` so the
    // disqualifier only touches the italic-rule path and leaves Rule 1
    // (larger size) / Rule 2 (bold) decisions alone.
    if (lineStyle.italic && looksLikeJournalCitation(phraseText)) {
        return false;
    }

    // Check for figure/table labels, including "Extended Data Fig. 1" and
    // "Supplementary Table S2" (those only with `headingLabelFilters`)
    const prefixLabelRe = settings.headingLabelFilters
        ? /^\s*(?:(?:extended\s+data|supplementary|supporting(?:\s+information)?)\s+)?(?:fig(?:ure)?|tab(?:le)?|eq(?:uation)?)\s*\.?\s+[A-Z]?\d{1,3}[a-z]?/i
        : /^\s*(?:fig(?:ure)?|tab(?:le)?|eq(?:uation)?)\s*\.?\s+[A-Z]?\d{1,3}[a-z]?/i;
    if (prefixLabelRe.test(text)) {
        return false;
    }

    // Too short. `minHeaderLength` is a character count calibrated for Latin
    // scripts, where a 1-2 character "heading" is almost always noise. CJK
    // headings are routinely a single two-character word ("前言", "引言",
    // "结论", "摘要", "致谢"). Allow a 2-character floor when the text is predominantly
    // CJK; the candidate still has to clear a heading rule above to get here.
    const minLen = hasCJKContent(text)
        ? Math.min(settings.minHeaderLength, 2)
        : settings.minHeaderLength;
    if (text.length < minLen) {
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
// Hanging-Indent Blocks
// ============================================================================

/**
 * Role of a line inside a hanging-indent block: `entry` opens an entry at
 * the outer edge after a continuation at the inner edge; `continuation` is a
 * wrapped line at the inner edge.
 */
export type HangingRole = "entry" | "continuation" | null;

/** Indent step between the outer and inner edge, in median line heights. */
const HANGING_MIN_INDENT_EM = 0.5;
const HANGING_MAX_INDENT_EM = 4.5;

/**
 * Find hanging-indent blocks in a column and label their lines.
 *
 * A candidate block is a run of consecutive rows whose left edges take
 * exactly two levels, an outer edge O and an inner edge I = O + 0.5–4.5 em
 * (see `labelHangingRun` for when a run counts as hanging). Inside a block,
 * an inner row that continues a wrapped row is a `continuation` and an outer
 * row after an inner row opens an `entry`.
 *
 * The column's left-edge mode cannot tell these blocks apart from indented
 * prose: it lands on O or I depending on the share of multi-line entries on
 * the page, so either every continuation reads as a first-line indent or no
 * entry start produces a break.
 */
function detectHangingRoles(lines: PageLine[], medianHeight: number): HangingRole[] {
    const roles: HangingRole[] = new Array(lines.length).fill(null);
    const mh = medianHeight > 0 ? medianHeight : 10;
    const tol = Math.max(1.6, 0.2 * mh);
    const rows = groupRows(lines, mh);

    let start = 0;
    while (start < rows.length) {
        const levels = [rows[start].l];
        let end = start + 1;
        let brokeOnLevel = false;
        for (; end < rows.length; end++) {
            if (rows[end].t - rows[end - 1].b > 2.5 * mh) break;
            const x = rows[end].l;
            if (levels.some(lv => Math.abs(x - lv) <= tol)) continue;
            if (levels.length === 1) {
                const d = Math.abs(x - levels[0]);
                if (d >= HANGING_MIN_INDENT_EM * mh && d <= HANGING_MAX_INDENT_EM * mh) {
                    levels.push(x);
                    continue;
                }
            }
            brokeOnLevel = levels.length === 2;
            break;
        }
        if (levels.length === 2) {
            labelHangingRun(rows, start, end, Math.min(...levels), Math.max(...levels), mh, tol, roles);
        }
        start = brokeOnLevel && end - 1 > start ? end - 1 : end;
    }
    return roles;
}

/** One visual text row: consecutive lines sharing a baseline band. */
interface TextRow {
    /** Index of the row's first line in the column. */
    first: number;
    head: PageLine;
    l: number;
    r: number;
    t: number;
    b: number;
    text: string;
}

/**
 * Group consecutive column lines into rows. The line detector splits a row
 * at a wide gap — a bullet glyph set apart from its text, a bold author name,
 * a justified word gap — and the left edge of such a fragment is not a line
 * start.
 */
function groupRows(lines: PageLine[], mh: number): TextRow[] {
    const rows: TextRow[] = [];
    lines.forEach((line, k) => {
        const row = rows[rows.length - 1];
        const center = (line.bbox.t + line.bbox.b) / 2;
        const prev = lines[k - 1];
        if (
            row &&
            line.bbox.l > prev.bbox.l &&
            Math.abs(center - (prev.bbox.t + prev.bbox.b) / 2) < 0.3 * mh
        ) {
            row.r = Math.max(row.r, line.bbox.r);
            row.b = Math.max(row.b, line.bbox.b);
            row.text += " " + line.text;
            return;
        }
        rows.push({
            first: k, head: line, l: line.bbox.l, r: line.bbox.r,
            t: line.bbox.t, b: line.bbox.b, text: line.text,
        });
    });
    return rows;
}

/**
 * An author-year reference opening: a surname, a comma and initials or a
 * given name with a middle initial, then a year within the next 100
 * characters, in parentheses ("Stone-Romero, E. F., Alvarez, K., & Thompson,
 * L. F. (2009).") or set off by punctuation ("Harris, Douglas N., and Tim R.
 * Sass. 2007.", "Kao, G. 2000."). Prose such as "However, Smith (2009)
 * found" lacks the initials.
 */
const AUTHOR_YEAR_ENTRY_RE =
    /^\s*(?:\p{L}[\p{L}'’.-]*\s+){0,2}\p{Lu}[\p{L}'’-]+,\s+(?:\p{Lu}\.(?:\s?-?\p{Lu}\.)*|\p{Lu}\p{Ll}+(?:\s\p{Lu}\.)+)[^]{0,100}?(?:\(\s*(?:1[89]|20)\d{2}[a-z]?\s*[),;]|(?:[,.]\s*|\s)(?:1[89]|20)\d{2}[a-z]?[.,;:])/u;

/** The end of a reference entry without terminal punctuation: a URL, DOI or page range. */
const ENTRY_TAIL_RE = /(?:https?:\/\/|www\.|doi:)\S*$|\d+\s*[–-]\s*\d+$/iu;

/** A bracketed list enumerator opening a line: "[5]", "(a)", "（3）", "(iv)". */
const BRACKETED_ENUMERATOR_RE =
    /^\s*[(（[［]\s*(?:\d{1,3}|[a-zA-Z]|[ivxlc]{1,5})\s*[)）\]］]/u;

/**
 * Sentence end, optionally followed by a citation marker ("….[17,26]",
 * "…. [17]", "….12", "….298,299", "….¹²"). Includes CJK full-width
 * terminators. Only a bracketed marker may follow a space: a bare number
 * after one is text ("pp. 12").
 */
const SENTENCE_END_RE =
    /[.!?。！？]["'”’)\]」』）]?(?:\s*\[[\d,;\s–-]+\]|\d{1,3}(?:[,–-]\d{1,3})*|[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:[,–-][⁰¹²³⁴⁵⁶⁷⁸⁹]+)*)?$/u;

/**
 * Label the rows of one two-level run when it reads as a hanging block.
 *
 * What separates a hanging block from first-line-indented prose is the outer
 * row before each O→I step. In a hanging block it is an entry's first line:
 * it wraps to the right margin mid-sentence, and the indented row continues
 * it. In indented prose it ends a paragraph body. The run is hanging when it
 * has at least two steps, at least 80% of them follow a wrapped row, and at
 * least half of those follow an entry's first line.
 *
 * `wraps` allows a ragged right edge: a row wraps when it ends within 1.5 em
 * or 10% of the block width of the block's right margin.
 */
function labelHangingRun(
    rows: TextRow[],
    start: number,
    end: number,
    outer: number,
    inner: number,
    mh: number,
    tol: number,
    roles: HangingRole[]
): void {
    const maxStepGap = 1.2 * mh;
    let right = -Infinity;
    for (let k = start; k < end; k++) right = Math.max(right, rows[k].r);
    const width = right - outer;
    const wraps = (row: TextRow) => right - row.r <= Math.max(1.5 * mh, 0.1 * width);
    const isInner = (row: TextRow) => Math.abs(row.l - inner) <= tol;
    const endsSentence = (row: TextRow) => SENTENCE_END_RE.test(row.text.trimEnd());
    const follows = (row: TextRow, prev: TextRow) => row.t - prev.b <= maxStepGap;
    const opensListItem = (row: TextRow) =>
        isIconBulletLine(row.head) || isTextHangingIndentLeader({ ...row.head, text: row.text });

    /** Row k steps from the outer to the inner edge right below its predecessor. */
    const isStep = (k: number) =>
        k > start && isInner(rows[k]) && !isInner(rows[k - 1]) && follows(rows[k], rows[k - 1]);

    /**
     * Whether the outer row before step k is an entry's first line: it wraps
     * mid-sentence and does not itself continue a wrapped outer row. In
     * first-line-indented prose that row ends a paragraph body instead.
     */
    const isEntryStep = (k: number) => {
        const prev = rows[k - 1];
        if (!wraps(prev) || endsSentence(prev)) return false;
        const beforePrev = k - 2 >= start ? rows[k - 2] : null;
        const continuesOuterRow =
            beforePrev !== null &&
            !isInner(beforePrev) &&
            follows(prev, beforePrev) &&
            wraps(beforePrev) &&
            !endsSentence(beforePrev);
        return !continuesOuterRow;
    };

    /**
     * Whether step k opens an indented paragraph: the row before the step is
     * finished, and the inner row wraps mid-sentence into an outer row that
     * continues the paragraph, where a wrapped entry would continue at the
     * inner edge. The outer row shows it continues the paragraph either
     *   - by opening in lowercase, which an entry never does — the row
     *     before may then also end like an entry (a URL, DOI or page range)
     *     rather than a sentence; or
     *   - after a finished sentence, by wrapping mid-sentence into yet
     *     another outer row (a paragraph body runs on at the outer edge, a
     *     wrapped entry's first line continues at the inner edge). An
     *     unpunctuated one-line entry has the same shape, so an entry-like
     *     ending does not count here.
     * An inner row that opens with a URL or DOI continues a reference.
     * An outer row that opens with a list marker ("26. Snyder …") is the
     * next numbered entry, not paragraph text. An inner row after an
     * unfinished row is a continuation, however it is indented.
     *
     * Not caught, and left to the hanging reading: an indented paragraph
     * whose second line opens with a capital and either is its last line or
     * ends a sentence at the margin. Both have the shape of an entry whose
     * last line wraps into the next entry (a one-line entry, in the second
     * case), which is the more common reading in reference lists.
     */
    const opensIndentedParagraph = (k: number) => {
        const row = rows[k];
        const next = k + 1 < end ? rows[k + 1] : null;
        const before = rows[k - 1];
        const beforeEndsSentence = endsSentence(before);
        if (
            !(beforeEndsSentence || ENTRY_TAIL_RE.test(before.text.trimEnd())) ||
            /^\s*(?:https?:|www\.|doi:)/iu.test(row.text) ||
            !wraps(row) ||
            endsSentence(row) ||
            next === null ||
            isInner(next) ||
            !follows(next, row) ||
            opensListItem(next)
        ) {
            return false;
        }
        if (/^\s*\p{Ll}/u.test(next.text)) return true;
        const afterNext = k + 2 < end ? rows[k + 2] : null;
        return (
            beforeEndsSentence &&
            afterNext !== null &&
            !isInner(afterNext) &&
            follows(afterNext, next) &&
            wraps(next) &&
            !endsSentence(next)
        );
    };

    // An opening bracket whose glyph box includes blank space (a full-width
    // "（", a protruding "(") shifts its line left by about half an em. Rows
    // offset only by that are one level, not a hanging indent. A bracketed
    // enumerator ("[5]", "(a)", "（3）") is a list marker, so such rows stay
    // evidence for a hanging block. The em is the run's own line height:
    // smaller text elsewhere on the page can pull the page-wide median below
    // it.
    const rowEm = Math.max(mh, median(rows.slice(start, end).map(row => row.b - row.t)));
    if (inner - outer < 0.6 * rowEm) {
        let outerRows = 0;
        let punctuationLed = 0;
        for (let k = start; k < end; k++) {
            if (isInner(rows[k])) continue;
            outerRows++;
            const text = rows[k].text;
            if (/^\s*[（「『【〔［〈《([]/u.test(text) && !BRACKETED_ENUMERATOR_RE.test(text)) {
                punctuationLed++;
            }
        }
        if (punctuationLed >= 0.5 * outerRows) return;
    }

    let steps = 0;
    let wrappedSteps = 0;
    let entrySteps = 0;
    for (let k = start + 1; k < end; k++) {
        if (!isStep(k)) continue;
        steps++;
        if (!wraps(rows[k - 1])) continue;
        wrappedSteps++;
        if (isEntryStep(k)) entrySteps++;
    }
    if (
        steps < 2 ||
        wrappedSteps < 0.8 * steps ||
        entrySteps < Math.max(1, 0.5 * wrappedSteps)
    ) {
        return;
    }

    // The vote covers the run as a whole, but a run can also hold ordinary
    // prose before or after the block. Labelling pauses at an indented
    // paragraph and resumes at the next entry-like step.
    let inProse = false;
    for (let k = start + 1; k < end; k++) {
        const prev = rows[k - 1];
        const row = rows[k];
        if (isStep(k)) {
            if (opensIndentedParagraph(k)) inProse = true;
            else if (inProse && isEntryStep(k)) inProse = false;
        }
        if (inProse || !follows(row, prev)) continue;
        if (isInner(row)) {
            // A list marker or nested outline number ("2.1.1 …") opens a
            // sub-entry, and a row ending in dot leaders and a page number is
            // a finished table-of-contents entry; none of them is wrapped.
            if (
                wraps(prev) &&
                !opensListItem(row) &&
                !/^\s*\d+(?:\.\d+)+\.?\s+\p{L}/u.test(row.text) &&
                !/(?:\.\s?){3,}\s*[\divxlcIVXLC]{1,6}\s*$/u.test(prev.text)
            ) {
                roles[row.first] = "continuation";
            }
        } else if (isInner(prev)) {
            if (!/^\s*(?:\p{Ll}|https?:|www\.)/u.test(row.text)) roles[row.first] = "entry";
        } else if (AUTHOR_YEAR_ENTRY_RE.test(row.text)) {
            // An outer row after an outer row follows a one-line entry that
            // filled its line, so no layout cue marks the break. An
            // author-year opening does.
            roles[row.first] = "entry";
        }
    }
}

// ============================================================================
// Step 4: Start New Item Detection
// ============================================================================

/** Whether the line carries per-glyph style runs (see `RawLine.styleRuns`). */
function hasStyleRuns(line: PageLine): boolean {
    return line.spans.some(span => (span.styleRuns?.length ?? 0) > 0);
}

/** Gaps between a line's spans wider than 1.5 em: the column gaps of a table row. */
function countWideGaps(line: PageLine): number {
    const boxes = [...line.bboxes].sort((a, b) => a.l - b.l);
    const em = line.fontSize ?? 10;
    let count = 0;
    for (let k = 1; k < boxes.length; k++) {
        if (boxes[k].l - boxes[k - 1].r > 1.5 * em) count++;
    }
    return count;
}

/**
 * Whether `line`, a body line, ends the heading item `currentLines` although
 * nothing visual separates them.
 *
 * Many journals set the first paragraph after a heading flush left at normal
 * leading, so the gap, indent and font-size signals stay silent. Short
 * headings still break on the early line end, but a heading that runs most of
 * the way across the column ("Neighborhood racial boundaries versus other
 * forms of spatial interdependence") merges into its paragraph, which is then
 * no longer a heading. The change of style is the boundary instead.
 *
 * Lines that read as headings line by line are common outside headings —
 * table header rows, labels in author and contact blocks, italic titles in
 * reference entries — and stay harmless only while they merge into the text
 * after them. The boundary therefore requires all of:
 *
 *   - Per-glyph style runs on the heading and the line. MuPDF reports a
 *     line's font from its first glyph; without the runs, a prose line that
 *     opens with a bold phrase reads as a heading line.
 *   - Every heading line passing the heading rules on the item's joined text
 *     (the test `processCurrentLinesAsItem` applies), and the line passing
 *     the body-style test on its majority styling.
 *   - The heading's last line ending clearly short of the column's right
 *     edge. A line filling the measure wraps into the next one, e.g. a run-in
 *     heading set mostly in bold ("Applications of single-cell
 *     transcriptomics. One major / …").
 *   - The line not continuing the heading: joined to it, the heading rules
 *     fail (an all-caps heading whose single-word last line,
 *     "PREFIGURATION?", fails the multi-word caps test on its own).
 *   - When the line opens in the heading's own face, more than the column's
 *     normal line spacing between them. At normal leading that shape is a run-in heading
 *     wrapping onto the line before its paragraph text starts ("Generation
 *     of Constructs for Expression in / Mammalian Cells. We cloned…"); a
 *     heading followed by a paragraph with its own run-in lead ("A.5.2
 *     Effect of k" / "Accuracy. Small k…") sits slightly apart. A heading in
 *     the body face (all caps) has no such ambiguity.
 *   - For an italic heading, no journal citation across the heading and the
 *     line (an italic journal name over its "21, 1234–1248 (2024)." tail),
 *     the test `isHeaderStyle` applies to a single italic line.
 *   - The line not opening in lowercase or with a parenthesis. That continues
 *     the sentence or the entry above ("Dr. Jean Kim has / worked to…",
 *     "S1 Appendix. Search strategy. / (DOCX)").
 *   - The heading not ending in a colon. That is a label introducing what
 *     follows ("Contact:", "The PDF file includes:").
 *   - No table row: no wide gap in the line, and at most one in a heading
 *     line (after a section number, "4.2   Power absorption…").
 *   - Horizontal heading lines. A diagonal watermark ("For Peer Review") has
 *     a box far taller than its type.
 *   - Real fonts, not an OCR text layer, whose sizes are too noisy to mark
 *     headings (see `processCurrentLinesAsItem`).
 */
function headingEndsBeforeBodyLine(
    line: PageLine,
    prevLine: PageLine,
    currentLines: PageLine[],
    columnThresholds: ColumnThresholds,
    pageThresholds: PageThresholds,
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    bodyAllCaps: boolean
): boolean {
    if (!bodyStyles || bodyStyles.length === 0 || currentLines.length === 0) return false;
    if (isOcrTextLayerFont(bodyStyles[0].font)) return false;
    if (!hasStyleRuns(line) || !currentLines.every(hasStyleRuns)) return false;
    if (!currentLines.every(l => !l.fontSize || bboxHeight(l.bbox) <= 2.5 * l.fontSize)) return false;
    if (countWideGaps(line) > 0 || currentLines.some(l => countWideGaps(l) >= 2)) return false;
    if (/^[\p{Ll}([]/u.test(line.text.trim())) return false;

    const lineStyle = extractLineStyle(line);
    if (!lineStyle || !matchesBodyStyle(majorityLineStyle(line, lineStyle), bodyStyles)) return false;
    const normalGap = columnThresholds.medianGap + Math.max(1, 0.1 * pageThresholds.medianHeight);
    if (
        sameTypeface(line, prevLine) &&
        !matchesBodyStyle(lineStyle, bodyStyles) &&
        line.bbox.t - prevLine.bbox.b <= normalGap
    ) {
        return false;
    }

    const measure = columnThresholds.rightEdgeMode - columnThresholds.leftEdgeMode;
    const shortfall = columnThresholds.rightEdgeMode - prevLine.bbox.r;
    if (shortfall <= Math.max(pageThresholds.medianHeight, 0.03 * measure)) return false;

    const headingText = joinLines(currentLines.map(l => l.text), settings.removeHyphenation);
    if (headingText.length >= settings.maxHeaderLength || /[:：]\s*$/u.test(headingText)) return false;
    if (!currentLines.every(l => isHeaderStyle(l, bodyStyles, settings, null, bodyAllCaps, headingText))) {
        return false;
    }
    const joinedText = joinLines([...currentLines, line].map(l => l.text), settings.removeHyphenation);
    if (openingLineStyle(currentLines[0])?.italic && looksLikeJournalCitation(joinedText)) return false;
    return !isHeaderStyle(line, bodyStyles, settings, null, bodyAllCaps, joinedText);
}

/** Stacked headings are at least this many line heights apart. */
const STACKED_HEADING_GAP = 0.75;

/** A line that wraps on: it ends on joining punctuation (a word that continues on the next line). */
const JOINING_END_RE = /[,;:&/\-–—]$/u;

/**
 * Whether two heading-styled lines are separate stacked headings rather than
 * one heading wrapped over two lines: they are more than the column's
 * paragraph-break threshold and `STACKED_HEADING_GAP` of the smaller line
 * height apart (display titles can be loosely leaded in points, but not
 * relative to their own height), and the pair does not read as one wrapped
 * line. Loosely leaded titles reach that gap too, so any sign of a wrap keeps
 * them together: the second line opens in lowercase, the first ends on a
 * function word or joining punctuation, or the first runs to the column's
 * right edge. A closing single capital is a label ("APPENDIX A"), not the
 * article "a".
 */
function stackedHeadingGap(
    line: PageLine,
    prevLine: PageLine,
    columnThresholds: ColumnThresholds,
    pageThresholds: PageThresholds
): boolean {
    const gap = line.bbox.t - prevLine.bbox.b;
    const height = Math.min(bboxHeight(line.bbox), bboxHeight(prevLine.bbox));
    if (gap <= columnThresholds.gapExcessThreshold || gap <= STACKED_HEADING_GAP * height) return false;

    const prevText = prevLine.text.trim();
    if (/^["'“‘«([]?\p{Ll}/u.test(line.text.trim())) return false;
    if (JOINING_END_RE.test(prevText)) return false;
    if (FUNCTION_WORD_END_RE.test(prevText) && !/(?:^|\s)\p{Lu}$/u.test(prevText)) return false;
    const measure = columnThresholds.maxRightEdge - columnThresholds.leftEdgeMode;
    const shortfall = columnThresholds.maxRightEdge - prevLine.bbox.r;
    return shortfall > Math.max(pageThresholds.medianHeight, 0.03 * measure);
}

/**
 * Determine if current line should start a new item
 */
function startNewItem(
    line: PageLine,
    i: number,
    prevLine: PageLine | null,
    nextLine: PageLine | null,
    currentLines: PageLine[],
    columnThresholds: ColumnThresholds,
    pageThresholds: PageThresholds,
    bodyStyles: TextStyle[] | null,
    settings: Required<ParagraphDetectionSettings>,
    bodyAllCaps: boolean = false,
    hangingRole: HangingRole = null,
    trace: StartTrace | null = null
): boolean {
    if (trace) {
        trace.rule = "forced";
        trace.signals = 0;
        trace.vetoes = 0;
    }
    if (i === 0) return true;
    if (!prevLine) return true;

    // The next number in a numbered list starts a new entry.
    if (
        settings.hangingIndentBlocks &&
        currentLines.length > 0 &&
        isNextNumberedEntry(currentLines[0], line)
    ) {
        if (trace) trace.rule = "numbered";
        return true;
    }

    // (a) Vertical gap signal. Use the column-local threshold so a dense
    // neighbour column (e.g. references list) can't drag the cutoff below
    // this column's own normal leading and split every line into its own
    // paragraph (UCZSE63I p28 body shape).
    const spacingTop = line.bbox.t - prevLine.bbox.b;
    let gapBreak = spacingTop > columnThresholds.gapExcessThreshold;
    const itemLeaderLine = currentLines[0] ?? null;
    const itemStartsWithLeader =
        !!itemLeaderLine &&
        (isIconBulletLine(itemLeaderLine) ||
            isTextHangingIndentLeader(itemLeaderLine));
    if (gapBreak) {
        const currentIsLeader =
            isIconBulletLine(line) || isTextHangingIndentLeader(line);
        const hangingIndentFloor =
            columnThresholds.indentExcessThreshold / 2;
        let sameContinuationIndent = false;
        if (itemStartsWithLeader && itemLeaderLine) {
            const currentIndentFromLeader = line.bbox.l - itemLeaderLine.bbox.l;
            const prevIndentFromLeader = prevLine.bbox.l - itemLeaderLine.bbox.l;
            sameContinuationIndent =
                currentIndentFromLeader + 0.5 >= hangingIndentFloor &&
                prevIndentFromLeader + 0.5 >= hangingIndentFloor &&
                Math.abs(line.bbox.l - prevLine.bbox.l) <=
                    hangingIndentFloor + 0.5;
        }
        const sameStyle = stylesEqual(
            extractLineStyle(line),
            extractLineStyle(prevLine)
        );
        const prevText = prevLine.text.trimEnd();
        const prevEndsSentence = /[.!?]["'”’)]?$/u.test(prevText);
        if (
            itemStartsWithLeader &&
            !currentIsLeader &&
            sameContinuationIndent &&
            sameStyle &&
            !prevEndsSentence
        ) {
            gapBreak = false;
            if (trace) trace.vetoes |= START_VETOES.leader_continuation;
        }
    }

    // Uniform-leading run protection. A single detected column can stack
    // two blocks with different line leading — most commonly a single-
    // spaced figure caption above a double-spaced body paragraph. The
    // per-column gap threshold is a single median, so on a page where the
    // loosely-leaded block is the minority the threshold lands at the
    // denser block's leading and every line of the looser block is split
    // into its own paragraph. A genuine paragraph break is a gap *larger*
    // than the surrounding leading; a run of near-equal gaps is uniform
    // intra-paragraph leading whatever its absolute size. Clear the gap
    // break when this gap does not notably exceed the leading already
    // established inside the current item (or, while the item still has a
    // single line, the leading to the following line).
    //
    // Three guards keep this narrowly targeted at over-split wrapped prose:
    //
    //   1. The surrounding leading must itself *exceed the column gap
    //      threshold* — i.e. the threshold is demonstrably miscalibrated
    //      for this block, since it would split every one of its
    //      uniformly-leaded lines. On a well-calibrated page the threshold
    //      already sits above body leading, so a gap that clears it is a
    //      real break and this branch never fires.
    //   2. The previous line must reach near the column's right edge. A
    //      wrapped line is full-width *by definition*; a line that ends
    //      early is the last line of its paragraph or a standalone
    //      one-line item — a short list entry, a heading, the last line of
    //      a caption — so the gap after it is a real boundary, not
    //      intra-paragraph leading. This also shields genuine headers,
    //      which are typically short: their gap survives for the header
    //      rules below.
    //   3. The previous line must not end with sentence-final punctuation.
    //      Suppressing a gap only when the sentence visibly continues
    //      across the line break keeps separate-but-uniformly-spaced
    //      paragraphs (and list entries that happen to be full-width)
    //      apart — they end with `.`/`!`/`?`. Wrapped prose lines end
    //      mid-sentence (or with a hyphen).
    //
    // This must run *before* header detection. The header rules (2-6)
    // promote a font-different line only when it is "preceded by a gap";
    // on a miscalibrated page every uniformly-leaded body line clears the
    // threshold, so that condition rubber-stamps mid-paragraph lines as
    // headers (notably body lines that merely begin with an inline italic
    // word). Clearing the spurious gap here restores the gap condition's
    // meaning. The check is deliberately style-agnostic — running prose
    // carries inline italic/bold emphasis whose spans make per-line style
    // comparisons unreliable.
    if (gapBreak && spacingTop > 0 && spacingTop < 50) {
        let referenceLeading: number | null = null;
        if (currentLines.length >= 2) {
            // Leading already established by the accumulated item.
            const internalGaps: number[] = [];
            for (let j = 1; j < currentLines.length; j++) {
                const g = currentLines[j].bbox.t - currentLines[j - 1].bbox.b;
                if (g < 50 && g > -5) internalGaps.push(g);
            }
            if (internalGaps.length > 0) {
                referenceLeading = median(internalGaps);
            }
        } else if (nextLine) {
            // Item still has one line — confirm uniformity by looking
            // ahead one line: a current gap no larger than the next gap
            // cannot itself be the bigger-than-leading paragraph break.
            const nextGap = nextLine.bbox.t - line.bbox.b;
            if (nextGap > 0 && nextGap < 50) {
                referenceLeading = nextGap;
            }
        }
        // The previous line counts as a wrapped (full-width) line when it
        // ends within ~20% of the column width of the widest text extent.
        // `maxRightEdge` is used rather than `rightEdgeMode` because a
        // column full of short links / list entries drags the mode to a
        // small value, which would mis-read every short line as full-width.
        const columnTextWidth =
            columnThresholds.maxRightEdge - columnThresholds.leftEdgeMode;
        const prevReachesRightEdge =
            columnThresholds.maxRightEdge - prevLine.bbox.r <=
            0.2 * columnTextWidth;
        // A wrapped prose line ends mid-sentence; a finished paragraph or
        // a standalone one-line item ends with sentence-final punctuation.
        const prevEndsSentenceFinal = /[.!?]["'”’)\]]?$/u.test(
            prevLine.text.trimEnd()
        );
        if (
            referenceLeading !== null &&
            referenceLeading > columnThresholds.gapExcessThreshold &&
            prevReachesRightEdge &&
            !prevEndsSentenceFinal
        ) {
            const uniformTol = Math.max(1.5, 0.3 * referenceLeading);
            if (spacingTop <= referenceLeading + uniformTol) {
                gapBreak = false;
                if (trace) trace.vetoes |= START_VETOES.uniform_leading;
            }
        }
    }

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
    // A hanging continuation wraps the line above it, so it cannot open a
    // heading — e.g. an italic title line that the body-size rule would
    // otherwise promote mid-entry, or a URL set in a larger face. It can
    // still continue a heading. A heading after the last entry keeps its
    // boundary only when spacing above it ends the continuation: one set at
    // the inner edge with no more than normal leading merges into that
    // entry. Font size cannot rescue it, since larger-set continuation lines
    // are common in reference lists.
    const isLocalHeader =
        !(hangingRole === "continuation" && !prevIsLocalHeader) &&
        isHeaderStyle(line, bodyStyles, settings, headerGapPasses, bodyAllCaps);

    if (isLocalHeader && !prevIsLocalHeader) {
        if (trace) trace.rule = "heading_after_body";
        return true; // Header after non-header
    }

    if (isLocalHeader && prevIsLocalHeader) {
        // Different header style. A hanging continuation stays with the
        // heading-styled line it wraps (a bold list label, an italic title).
        if (!sameOpeningStyle(line, prevLine) && hangingRole !== "continuation") {
            if (trace) trace.rule = "heading_style_change";
            return true;
        }
        // Same style, but a paragraph-sized gap apart: two stacked headings
        // ("RESULTS" over "Summary Statistics" in one face), not one heading
        // wrapped over two lines. Only within an isolated heading: a longer
        // run of lines in a heading face is a block (a bold list, cover-page
        // notes) whose lines stay together as before.
        if (
            hangingRole !== "continuation" &&
            columnThresholds.isolatedHeading[i] &&
            columnThresholds.isolatedHeading[i - 1] &&
            stackedHeadingGap(line, prevLine, columnThresholds, pageThresholds)
        ) {
            if (trace) trace.rule = "heading_stacked";
            return true;
        }
        if (trace) trace.rule = "heading_continues";
        return false; // Same header style continues
    }

    // A heading followed by a line that only opens like one, e.g. a paragraph
    // starting with a bold run-in phrase. The majority-style veto makes the
    // line body text, but its opening style still differs from the
    // heading's, which ends the heading. Size-truncation jitter alone is not
    // a style change (see `sameTypeface`).
    //
    // A same-style opening is deliberately not a boundary: with no gap,
    // indent or early line end in between, that shape is a run-in heading
    // wrapping onto its second line ("Generation of Constructs for
    // Expression in / Mammalian Cells. We cloned…"), which belongs to one
    // paragraph. Splitting it would leave a truncated pseudo-heading.
    if (
        prevIsLocalHeader &&
        !sameTypeface(line, prevLine) &&
        opensWithHeaderStyle(line, bodyStyles, settings, headerGapPasses, bodyAllCaps)
    ) {
        if (trace) trace.rule = "heading_opening_style";
        return true;
    }

    // A heading followed by a body line with no gap, indent or early line end
    // between them (see `headingEndsBeforeBodyLine`).
    if (
        prevIsLocalHeader &&
        !isLocalHeader &&
        headingEndsBeforeBodyLine(
            line, prevLine, currentLines, columnThresholds, pageThresholds, bodyStyles, settings, bodyAllCaps
        )
    ) {
        if (trace) trace.rule = "heading_ends_before_body";
        return true;
    }

    // (b) Indent signal
    let indentBreak = false;
    const indentExcess = line.bbox.l - columnThresholds.leftEdgeMode;
    const indentExcessPrevLine = line.bbox.l - prevLine.bbox.l;
    indentBreak =
        indentExcess > columnThresholds.indentExcessThreshold &&
        indentExcessPrevLine > columnThresholds.indentExcessThreshold / 2;

    // Leader hanging-indent suppression. The column's leftEdgeMode picks the
    // most common indent; when leader-led lines (icon bullets, numbered
    // footnotes, numbered/lettered list items) share a column with body
    // paragraphs, their wrapped continuations look "indented" relative to the
    // mode and trigger a false indent break. Suppress only when the geometry,
    // style, and textual cues all say "this is a hanging continuation, not a
    // new paragraph": indent magnitude in the typical hanging range, prev is
    // a recognized leader, current line's style matches prev's dominant span
    // style (or — for icon bullets only — matches a body style), and prev did
    // not end with a sentence-final terminator. Mid-clause separators like
    // `:` and `;` are kept allowed because leader items routinely wrap
    // mid-clause (e.g. "• Slashing occurred at Canal street; person fit
    // description;" continues on the next line).
    //
    // The style gate forks by leader type. Icon bullets sit in a bullet font
    // (Symbol/Wingdings/…) while their body continuation is in a real body
    // font, so they use the body-style fallback. Text-pattern leaders
    // (numeric/lettered/symbol) share font and size with their continuation,
    // so they require same-style match against prev's dominant span — which
    // blocks heading-style false positives like "2. Methods" followed by an
    // indented body paragraph (different size + bold). The marker-
    // aggregation safety net below catches the degenerate single-span case
    // without re-opening the heading false-positive surface.
    //
    // Prev is compared via its dominant span (largest by character count),
    // not its first span, because footnote markers are short superscript
    // spans whose style does not represent the body text of the leader line.
    if (indentBreak && !gapBreak) {
        const isHangingIndent =
            indentExcessPrevLine > 0 && indentExcessPrevLine <= 30;
        if (isHangingIndent) {
            const prevIsIconBullet = isIconBulletLine(prevLine);
            const prevIsTextLeader =
                !prevIsIconBullet && isTextHangingIndentLeader(prevLine);
            if (prevIsIconBullet || prevIsTextLeader) {
                const currStyle = extractLineStyle(line);
                const prevDominant = dominantSpanStyleByCharCount(prevLine);
                const sameStyle = stylesEqual(currStyle, prevDominant);
                const bodyStyleFallback =
                    !!currStyle &&
                    !!bodyStyles &&
                    bodyStyles.length > 0 &&
                    matchesBodyStyle(currStyle, bodyStyles);
                // Marker-aggregation artifact compensation: MuPDF can emit a
                // footnote leader line ("6  David Silver…") as a SINGLE span
                // and report the small superscript marker's size for the
                // whole span. The dominant-by-char-count span style then
                // reflects the marker (size ~4), not the body text (size ~8),
                // and `sameStyle` against the body-styled continuation
                // fails.
                //
                // Restrict the compensation to the structural shape of that
                // artifact so it doesn't quietly re-open the style gate for
                // legitimate small-text leaders followed by larger indented
                // body. Required signals:
                //   - prev has exactly ONE span (= MuPDF aggregated whatever
                //     marker + body text spans existed into one);
                //   - prev's bbox height matches the continuation's bbox
                //     height (= the visual line height tracks the body
                //     glyphs, not the misreported marker size);
                //   - fonts / bold / italic agree;
                //   - prev's reported size is significantly smaller than
                //     the continuation (heading leaders read larger, not
                //     smaller, so this never matches a heading false
                //     positive).
                const fontAndModMatch =
                    !!currStyle &&
                    !!prevDominant &&
                    currStyle.font === prevDominant.font &&
                    currStyle.bold === prevDominant.bold &&
                    currStyle.italic === prevDominant.italic;
                const lineHeightsMatch =
                    Math.abs(bboxHeight(line.bbox) - bboxHeight(prevLine.bbox)) < 1.0;
                const markerSizeDiscrepancy =
                    prevLine.spans.length === 1 &&
                    lineHeightsMatch &&
                    fontAndModMatch &&
                    !!currStyle &&
                    !!prevDominant &&
                    prevDominant.size < currStyle.size - 0.5;
                const styleCompatible = prevIsIconBullet
                    ? sameStyle || bodyStyleFallback
                    : sameStyle || markerSizeDiscrepancy;
                if (styleCompatible) {
                    const prevText = prevLine.text.trimEnd();
                    const prevEndsSentence = /[.!?]["'”’)]?$/u.test(prevText);
                    if (!prevEndsSentence) {
                        indentBreak = false;
                        if (trace) trace.vetoes |= START_VETOES.indent_suppression;
                    }
                }
            }
        }
    }

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
        const lineHeightDiff = Math.abs(bboxHeight(line.bbox) - bboxHeight(prevLine.bbox));
        fontSizeBreak =
            fontSizeDiff > settings.fontSizeTolerance &&
            lineHeightDiff > settings.fontSizeTolerance;

        // Superscript-marker artifact suppression. MuPDF's JSON walk reports
        // a single font/size per line, taken from the line's LEADING glyph.
        // A footnote/endnote line that begins with a superscript marker
        // ("12Body text…", "∗Body text…") therefore reports the small marker
        // size for the entire line, while its bbox height still tracks the
        // taller body glyphs. The result: the first line of a footnote reads
        // as *smaller font but taller* than its wrapped continuation, so the
        // raw font-size break splits the marker line off from the body it
        // introduces.
        //
        // Three constraints keep this targeted at the marker artifact:
        //   1. Marker shape. The previous line must actually open with an
        //      inline footnote/endnote/affiliation marker. The geometry below
        //      is the leading-small-glyph signature, but it is also tripped by
        //      the rare non-marker line made tall by brackets / sub- or
        //      superscripts / accents; without this gate the suppression could
        //      merge a small standalone caption / callout / display line into
        //      the following paragraph.
        //   2. Direction. Only the *previous* line may be the artifact (marker
        //      line → its larger continuation merges, keeping the footnote
        //      whole). A *current* line that opens with a fresh marker starts
        //      the next footnote and must still break — `prevReportsSmaller`
        //      enforces this asymmetry, so consecutive footnotes stay apart.
        //   3. Comparable height. The marker line is not shorter than its
        //      continuation (a genuinely smaller-font line is also shorter)
        //      and taller by no more than one body em (a superscript raises
        //      the top only a fraction of an em; a dramatically taller line is
        //      a different element, e.g. a misread heading, not a marker).
        if (fontSizeBreak && startsWithInlineMarker(prevLine)) {
            const prevReportsSmaller = prevLine.fontSize < line.fontSize;
            const heightExcess =
                bboxHeight(prevLine.bbox) - bboxHeight(line.bbox);
            const prevHeightComparable =
                heightExcess + settings.fontSizeTolerance >= 0 &&
                heightExcess <= line.fontSize;
            if (prevReportsSmaller && prevHeightComparable) {
                fontSizeBreak = false;
                if (trace) trace.vetoes |= START_VETOES.superscript_marker;
            }
        }
    }

    // Drop-cap wraparound: when the previous line's bbox extends well below
    // the current line's bottom, the current line is wrapping around a tall
    // element (drop cap, large inline figure). Indent / early-end / font-size
    // breaks in that case are geometric artefacts of the wraparound, not real
    // paragraph boundaries — suppress them so the paragraph stays whole.
    const prevExtendsBelow =
        prevLine.bbox.b > line.bbox.b + bboxHeight(line.bbox);
    if (prevExtendsBelow) {
        if (trace && (indentBreak || earlyEndBreak || fontSizeBreak)) trace.vetoes |= START_VETOES.drop_cap;
        indentBreak = false;
        earlyEndBreak = false;
        fontSizeBreak = false;
    }

    // Same-indent continuation within a hanging item. Once an item has
    // started with a recognized leader, subsequent wrapped lines can remain
    // at the hanging indent. Keep those continuations together even when a
    // slightly larger intra-item gap would otherwise look like a paragraph
    // boundary; the next leader is handled by the outdent rule below.
    if (!prevExtendsBelow) {
        const currentIsLeader =
            isIconBulletLine(line) || isTextHangingIndentLeader(line);
        const hangingIndentFloor = columnThresholds.indentExcessThreshold / 2;
        let sameContinuationIndent = false;
        if (itemStartsWithLeader && itemLeaderLine) {
            const currentIndentFromLeader = line.bbox.l - itemLeaderLine.bbox.l;
            const prevIndentFromLeader = prevLine.bbox.l - itemLeaderLine.bbox.l;
            sameContinuationIndent =
                currentIndentFromLeader + 0.5 >= hangingIndentFloor &&
                prevIndentFromLeader + 0.5 >= hangingIndentFloor &&
                Math.abs(line.bbox.l - prevLine.bbox.l) <=
                    hangingIndentFloor + 0.5;
        }
        const sameStyle = stylesEqual(
            extractLineStyle(line),
            extractLineStyle(prevLine)
        );
        const prevText = prevLine.text.trimEnd();
        const prevEndsSentence = /[.!?]["'”’)]?$/u.test(prevText);
        if (
            itemStartsWithLeader &&
            !currentIsLeader &&
            sameContinuationIndent &&
            sameStyle &&
            !prevEndsSentence
        ) {
            if (trace && (gapBreak || earlyEndBreak || fontSizeBreak)) trace.vetoes |= START_VETOES.same_indent_hanging;
            gapBreak = false;
            earlyEndBreak = false;
            fontSizeBreak = false;
        }
    }

    // (e) New leader after hanging continuation. The positive indent break
    // above handles leader-to-continuation, but the next leader outdents back
    // to the marker column and otherwise has no visual break signal.
    let leaderAfterContinuationBreak = false;
    if (!prevExtendsBelow) {
        const indentDelta = prevLine.bbox.l - line.bbox.l;
        if (indentDelta >= columnThresholds.indentExcessThreshold / 2) {
            const currentIsLeader =
                isIconBulletLine(line) || isTextHangingIndentLeader(line);
            if (currentIsLeader) {
                leaderAfterContinuationBreak = true;
            }
        }
    }

    // Hanging-indent block roles (see `detectHangingRoles`). A continuation's
    // inner-edge indent is not a paragraph indent, and the line it wraps
    // reaches the margin; an entry starts at the outer edge with no other
    // visual break.
    let hangingEntryBreak = false;
    if (hangingRole === "continuation") {
        if (trace && (indentBreak || earlyEndBreak)) trace.vetoes |= START_VETOES.hanging_continuation;
        indentBreak = false;
        earlyEndBreak = false;
    } else if (hangingRole === "entry") {
        hangingEntryBreak = true;
    }

    // Combine signals
    const visualBreak =
        gapBreak ||
        indentBreak ||
        earlyEndBreak ||
        fontSizeBreak ||
        leaderAfterContinuationBreak ||
        hangingEntryBreak;
    if (trace) {
        const s = START_SIGNALS;
        trace.signals =
            (gapBreak ? s.gap : 0) |
            (indentBreak ? s.indent : 0) |
            (earlyEndBreak ? s.early_end : 0) |
            (fontSizeBreak ? s.font_size : 0) |
            (leaderAfterContinuationBreak ? s.leader_after_continuation : 0) |
            (hangingEntryBreak ? s.hanging_entry : 0);
        trace.rule = gapBreak ? "gap"
            : indentBreak ? "indent"
            : earlyEndBreak ? "early_end"
            : fontSizeBreak ? "font_size"
            : leaderAfterContinuationBreak ? "leader_after_continuation"
            : hangingEntryBreak ? "hanging_entry"
            : "none";
    }
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
    columnThresholds: ColumnThresholds,
    columnLineCount: number,
    bodyAllCaps: boolean = false,
    prevDocLine: PageLine | null = null
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
    let isPotentialHeader = currentLines.every(l =>
        isHeaderStyle(l, bodyStyles, settings, null, bodyAllCaps, rawItemText)
    );

    // Bulleted-list wrap-continuation demotion: a single-line italic-only
    // item that immediately follows an icon/dingbat-font line ending without
    // terminal punctuation is almost always the wrapped continuation of the
    // last bullet item, not a real subsection title. The column detector
    // splits such lines into their own column when the wrap indents
    // slightly. Real italic subsection titles appear after body text that
    // ends a sentence, not after an icon-font line ending mid-phrase.
    //
    // Guarded against explicit heading cues — section-number prefix
    // ("2.1 Methods") or all-caps phrase — which carry independent signal
    // strong enough to override the suspicion. Without these guards, a real
    // italic subsection title at the top of a two-column page that follows
    // a wrapped bullet list in the previous column would be demoted.
    if (
        isPotentialHeader &&
        currentLines.length === 1 &&
        prevDocLine &&
        bodyStyles && bodyStyles.length > 0
    ) {
        const lineStyle = extractLineStyle(currentLines[0]);
        const primaryBodyStyle = bodyStyles[0];
        const prevText = prevDocLine.text.trimEnd();
        const prevEndsTerminator = /[.!?:;]["'”’)]?$/u.test(prevText);
        const hasExplicitHeadingCue =
            SECTION_PREFIX_RE.test(rawItemText) ||
            isAllCapsHeaderPhrase(rawItemText);
        if (
            !hasExplicitHeadingCue &&
            lineStyle &&
            lineStyle.italic &&
            !lineStyle.bold &&
            Math.abs(lineStyle.size - primaryBodyStyle.size) < 0.5 &&
            lineStyle.font !== primaryBodyStyle.font &&
            isIconBulletLine(prevDocLine) &&
            !prevEndsTerminator
        ) {
            isPotentialHeader = false;
        }
    }

    // OCR-layer full-measure demotion: on PDFs whose only text is a
    // synthetic OCR layer, font size carries no reliable heading signal.
    // OCRmyPDF / Tesseract render the invisible text in a single fixed font
    // ("GlyphLessFont") and size each line from the scanned glyph heights,
    // so a stray body line routinely lands 1-3pt above the body size and
    // trips the larger-font heading rule. Because every glyph shares one
    // font, the font-difference heading rules (bold / italic / all-caps /
    // section-number) can never fire — Rule 1's noisy size cue is the only
    // signal, and it is unchecked.
    //
    // A heading is set short — it does not run to the full width of the body
    // text column. So on an OCR-layer document, demote a size-cued candidate
    // whose every line spans essentially the whole column measure: that is a
    // wrapped line of body prose the OCR layer happened to size above the
    // body, not a real title. A genuine wrapped heading keeps a short last
    // line and survives. The guard is gated to OCR-layer documents because
    // on a normal digital PDF font sizes are exact and a larger-size line
    // genuinely is a heading.
    //
    // The column must hold enough lines for its measure to be meaningful:
    // the column detector often isolates a heading into its own narrow
    // column, where `rightEdgeMode - leftEdgeMode` collapses onto the
    // heading's own width and every heading would trivially "fill" it.
    if (
        isPotentialHeader &&
        bodyStyles &&
        bodyStyles.length > 0 &&
        columnLineCount >= 5 &&
        isOcrTextLayerFont(bodyStyles[0].font)
    ) {
        const firstStyle = extractLineStyle(currentLines[0]);
        const primaryBodyStyle = bodyStyles[0];
        const columnMeasure =
            columnThresholds.rightEdgeMode - columnThresholds.leftEdgeMode;
        const sizeCued =
            !!firstStyle && firstStyle.size > primaryBodyStyle.size;
        const fillsColumnMeasure =
            columnMeasure > 0 &&
            currentLines.every(
                l => l.bbox.r - l.bbox.l >= 0.9 * columnMeasure
            );
        if (sizeCued && fillsColumnMeasure) {
            isPotentialHeader = false;
        }
    }

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
    const mergedBbox = mergeBoxes(allBboxes);

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
        id: "",
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
    bodyAllCaps: boolean = false,
    prevDocLine: PageLine | null = null,
    decisions: LineDecision[] | null = null
): {
    pageContent: string;
    items: ContentItem[];
    itemLines: PageLine[][];
    itemLineRoles: HangingRole[][];
    paragraphCount: number;
    headerCount: number;
} {
    let pageContent = initialPageContent;
    const items: ContentItem[] = [];
    const itemLines: PageLine[][] = [];
    const itemLineRoles: HangingRole[][] = [];
    let paragraphIndex = 0;
    let headerIndex = 0;

    let currentLines: PageLine[] = [];
    let currentRoles: HangingRole[] = [];
    const hangingRoles: HangingRole[] = settings.hangingIndentBlocks
        ? detectHangingRoles(lines, pageThresholds.medianHeight)
        : new Array(lines.length).fill(null);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const prevLine = i > 0 ? lines[i - 1] : null;
        const nextLine = i + 1 < lines.length ? lines[i + 1] : null;
        const trace: StartTrace | null = decisions ? { rule: "forced", signals: 0, vetoes: 0 } : null;

        const shouldStartNew =
            currentLines.length === 0 ||
            startNewItem(
                line,
                i,
                prevLine,
                nextLine,
                currentLines,
                columnThresholds,
                pageThresholds,
                bodyStyles,
                settings,
                bodyAllCaps,
                hangingRoles[i],
                trace
            );
        if (decisions && trace) {
            decisions.push({
                start: shouldStartNew,
                trace,
                role: hangingRoles[i],
                headerStyle: isHeaderStyle(line, bodyStyles, settings, null, bodyAllCaps),
                isolatedHeading: columnThresholds.isolatedHeading[i],
            });
        }

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
                    columnThresholds,
                    lines.length,
                    bodyAllCaps,
                    items.length === 0 ? prevDocLine : null
                );

                pageContent = result.pageContent;
                items.push(result.item);
                itemLines.push(currentLines);
                itemLineRoles.push(currentRoles);

                if (result.item.type === "header") {
                    headerIndex++;
                } else {
                    paragraphIndex++;
                }
            }

            currentLines = [line];
            currentRoles = [hangingRoles[i]];
        } else {
            currentLines.push(line);
            currentRoles.push(hangingRoles[i]);
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
            columnThresholds,
            lines.length,
            bodyAllCaps,
            items.length === 0 ? prevDocLine : null
        );

        pageContent = result.pageContent;
        items.push(result.item);
        itemLines.push(currentLines);
        itemLineRoles.push(currentRoles);

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
        itemLineRoles,
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
    /**
     * Receives the page's blocks as the item-boundary features read them
     * (`boundaries/input.ts`), with the flow lines in the same order. Only
     * the training export passes it.
     */
    boundaries?: BoundaryCapture;
}

/** Captures the item-boundary input of a page (`DetectParagraphsOptions.boundaries`). */
export interface BoundaryCapture {
    /** Region items of the page in the detector's frame, as [l, t, r, b]. */
    regions: [number, number, number, number][];
    /** Called once per page: the input, and its lines in flow order (blocks in reading order). */
    page(input: BoundaryPage, flow: PageLine[]): void;
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

    // The heading rules compare sizes exactly when the page's body size can
    // be measured (see `pageBodyExactSize`).
    const bodyExactSize = pageBodyExactSize(lineResult.columnResults, bodyStyles);
    if (bodyStyles && bodyExactSize !== null) {
        bodyStyles = [{ ...bodyStyles[0], exactSize: bodyExactSize }, ...bodyStyles.slice(1)];
    }

    if (opts.pageBodyStyles && bodyStyles) {
        const pageStyle = pageBodyStyle(lineResult.columnResults, bodyStyles);
        if (pageStyle) bodyStyles = [...bodyStyles, pageStyle];
    }

    let pageContent = "";
    const allItems: ContentItem[] = [];
    const allItemLines: PageLine[][] = [];
    const allItemLineRoles: HangingRole[][] = [];
    let totalParagraphs = 0;
    let totalHeaders = 0;

    // Process each column. `prevDocLine` carries the previous column's last
    // line into the next column so single-line first items can detect
    // wrap-continuations of icon-font bullet lists across the column boundary.
    let prevDocLine: PageLine | null = null;
    const boundaryBlocks: BoundaryBlock[] | null = options.boundaries ? [] : null;
    const flow: PageLine[] = [];
    for (const colResult of lineResult.columnResults) {
        if (colResult.lines.length === 0) continue;

        // Step 2: Calculate column-specific thresholds
        const columnThresholds = calculateColumnThresholds(
            colResult.lines,
            pageThresholds,
            opts,
            bodyStyles,
            bodyAllCaps
        );

        // Steps 3-6: Process lines into items
        const decisions: LineDecision[] | null = boundaryBlocks ? [] : null;
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
            bodyAllCaps,
            prevDocLine,
            decisions
        );
        if (boundaryBlocks && decisions) {
            const t = columnThresholds;
            boundaryBlocks.push({
                index: colResult.columnIndex,
                lines: colResult.lines.map((line, k) => boundaryLine(line, decisions[k])),
                thresholds: {
                    leftEdgeMode: t.leftEdgeMode,
                    rightEdgeMode: t.rightEdgeMode,
                    leftEdgeMad: t.leftEdgeMad,
                    rightEdgeMad: t.rightEdgeMad,
                    maxRightEdge: t.maxRightEdge,
                    indentExcessThreshold: t.indentExcessThreshold,
                    earlyEndExcessThreshold: t.earlyEndExcessThreshold,
                    gapExcessThreshold: t.gapExcessThreshold,
                    medianGap: t.medianGap,
                },
            });
            flow.push(...colResult.lines);
        }

        pageContent = result.pageContent;
        allItems.push(...result.items);
        if (options.trackItemLines) {
            allItemLines.push(...result.itemLines);
            allItemLineRoles.push(...result.itemLineRoles);
        }
        totalParagraphs += result.paragraphCount;
        totalHeaders += result.headerCount;
        prevDocLine = colResult.lines[colResult.lines.length - 1];
    }

    allItems.forEach((item, index) => {
        item.id = `p${lineResult.pageIndex}:i${index}`;
    });

    if (options.boundaries && boundaryBlocks) {
        const body = bodyStyles?.[0];
        options.boundaries.page(
            {
                pageIndex: lineResult.pageIndex,
                width: lineResult.width,
                height: lineResult.height,
                body: body
                    ? { size: body.exactSize ?? body.size, font: body.font, bold: body.bold, italic: body.italic }
                    : null,
                medianHeight: pageThresholds.medianHeight,
                gapExcessThreshold: pageThresholds.gapExcessThreshold,
                regions: options.boundaries.regions,
                blocks: boundaryBlocks,
            },
            flow,
        );
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
        baseResult.itemLineRoles = allItemLineRoles;
    }

    return baseResult;
}

/**
 * Log paragraph detection results when {@link ExtractionSettings.analyzerLogging} is enabled.
 */
export function logParagraphDetection(result: PageParagraphResult): void {
    if (!isAnalyzerLoggingEnabled()) return;

    pdfLog(
        `[ParagraphDetector] Page ${result.pageIndex}: ` +
            `${result.items.length} items (${result.paragraphCount} paragraphs, ${result.headerCount} headers)`,
        3,
    );

    // Log first few items as preview
    const previewCount = Math.min(5, result.items.length);
    for (let i = 0; i < previewCount; i++) {
        const item = result.items[i];
        const typeLabel = item.type === "header" ? "H" : "P";
        const textPreview =
            item.text.length > 60 ? item.text.slice(0, 60) + "..." : item.text;
        pdfLog(
            `    [${typeLabel}${item.idx}] Col ${item.columnIndex + 1}: "${textPreview}"`,
            3,
        );
    }

    if (result.items.length > previewCount) {
        pdfLog(`    ... and ${result.items.length - previewCount} more items`, 3);
    }
}
