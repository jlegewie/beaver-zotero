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
import type { BoundingBox, TextStyle, StyleProfile } from "./types";
import { bboxHeight, mergeBoxes } from "./types";
import type { Rect } from "./ColumnDetector";
import { pdfLog, isAnalyzerLoggingEnabled } from "./logging";

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
 *      Symbol-font private-use bullet that survives MuPDF extraction
 *            verbatim (the codepoint Symbol-bulleted PDFs typically emit).
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
 * The Symbol-font private-use bullet (U+F0B7) survives MuPDF extraction as
 * a single codepoint, so YDMSJ83R-style lines (`Teacher's aid: …` led by
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
    const colGaps: number[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
        const gap = lines[i + 1].bbox.t - lines[i].bbox.b;
        if (gap < 50 && gap > -5) colGaps.push(gap);
    }
    let gapExcessThreshold = pageThresholds.gapExcessThreshold;
    if (colGaps.length >= 3) {
        const colMedianGap = median(colGaps);
        const minMeaningfulIncrease = Math.max(1.0, 0.08 * pageThresholds.medianHeight);
        gapExcessThreshold = Math.max(
            settings.minGapPx,
            colMedianGap + minMeaningfulIncrease,
            colMedianGap * 1.25,
            0.4 * pageThresholds.medianHeight
        );
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

    const sameDims = bodyStyles.filter(bs =>
        Math.abs(bs.size - lineStyle.size) < 0.5 &&
        bs.bold === lineStyle.bold &&
        bs.italic === lineStyle.italic
    );
    const distinctFonts = new Set(sameDims.map(bs => bs.font));
    return distinctFonts.size >= 2;
}

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
    const fontIndistinctFromBody =
        !lineStyle.font ||
        lineStyle.font === "unknown" ||
        lineStyle.font === primaryBodyStyle.font ||
        baseFontName(lineStyle.font) === baseFontName(primaryBodyStyle.font);
    const capsWithoutFontCue =
        gapCheckPasses &&
        !bodyAllCaps &&
        fontIndistinctFromBody &&
        !lineStyle.italic &&
        lineStyle.size <= primaryBodyStyle.size + 0.5 &&
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
    if (getStyleDominance(line, lineStyle) < 0.9) {
        return false;
    }

    let isPotentialHeader = false;
    // True when the candidate carries an independent size cue (Rule 1).
    // Used to exempt size-cued headings from the heading-capitalization
    // guard below — a larger line is a heading regardless of its leading
    // character.
    const sizeIncreaseHeader = lineStyle.size > primaryBodyStyle.size;

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
        Math.abs(lineStyle.size - primaryBodyStyle.size) < 0.5 &&
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
        lineStyle.size <= primaryBodyStyle.size + 0.5 &&
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
        Math.abs(lineStyle.size - primaryBodyStyle.size) < 0.5 &&
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

    // Check for figure/table labels
    const prefixLabelRe =
        /^\s*(?:fig(?:ure)?|tab(?:le)?|eq(?:uation)?)\s*\.?\s+[A-Z]?\d{1,3}[a-z]?/i;
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
// Step 4: Start New Item Detection
// ============================================================================

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
    bodyAllCaps: boolean = false
): boolean {
    if (i === 0) return true;
    if (!prevLine) return true;

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

    // Combine signals
    const visualBreak =
        gapBreak ||
        indentBreak ||
        earlyEndBreak ||
        fontSizeBreak ||
        leaderAfterContinuationBreak;
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
    prevDocLine: PageLine | null = null
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
        const nextLine = i + 1 < lines.length ? lines[i + 1] : null;

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
                    columnThresholds,
                    lines.length,
                    bodyAllCaps,
                    items.length === 0 ? prevDocLine : null
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
            columnThresholds,
            lines.length,
            bodyAllCaps,
            items.length === 0 ? prevDocLine : null
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

    // Process each column. `prevDocLine` carries the previous column's last
    // line into the next column so single-line first items can detect
    // wrap-continuations of icon-font bullet lists across the column boundary.
    let prevDocLine: PageLine | null = null;
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
            bodyAllCaps,
            prevDocLine
        );

        pageContent = result.pageContent;
        allItems.push(...result.items);
        if (options.trackItemLines) {
            allItemLines.push(...result.itemLines);
        }
        totalParagraphs += result.paragraphCount;
        totalHeaders += result.headerCount;
        prevDocLine = colResult.lines[colResult.lines.length - 1];
    }

    allItems.forEach((item, index) => {
        item.id = `p${lineResult.pageIndex}:i${index}`;
    });

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
