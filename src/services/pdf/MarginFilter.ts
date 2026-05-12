/**
 * Margin Filter
 *
 * Handles margin-based filtering of text content:
 * 1. Simple filtering: Exclude content entirely within margin thresholds
 * 2. Smart filtering: Identify and remove repeating elements in margin zones
 */

import type {
    RawPageData,
    RawLine,
    RawBBox,
    MarginSettings,
    MarginPosition,
    MarginElement,
    MarginAnalysis,
    OffMarginPageNumberLine,
    RemovalCandidate,
    MarginRemovalResult,
    TextStyle,
} from "./types";
import { pdfLog } from "./logging";
import { StyleAnalyzer } from "./StyleAnalyzer";
import { rotateBBox, type RotationAngle } from "./PageRotationNormalizer";

// ============================================================================
// Page Number Detection — multilingual prefixes, anchored parser
// ============================================================================

/** Lowercase prefix words for "page" across major languages. */
const PAGE_WORDS = [
    "page", "página", "pagina", "seite", "strona",
    "страница", "sayfa", "صفحة", "ページ", "페이지",
];

/** Pre-escaped abbreviations (already regex fragments — note `\.`). */
const PAGE_ABBREVS = ["p\\.", "pp\\.", "pág\\.", "pag\\.", "str\\.", "стр\\."];

/**
 * Bare-connector list: word connectors ("of", "de", "von", "di", "van", "из")
 * and "/". NO hyphens — those would parse "2024-05" / "2025-06" as page
 * numbers and form a strictly increasing sequence, causing date and
 * ISO-range strings in margins to be falsely flagged.
 */
const BARE_CONNECTOR_WORDS = ["of", "de", "von", "di", "van", "из", "/"];

/**
 * Prefix-anchored connector list: allows hyphens because the prefix word
 * (page/seite/p./...) is the strong signal that disambiguates from dates.
 */
const PREFIX_CONNECTOR_WORDS = [...BARE_CONNECTOR_WORDS, "-", "—", "–"];

const PAGE_PREFIX_RE = [...PAGE_WORDS, ...PAGE_ABBREVS].join("|");
const BARE_CONNECTOR_RE = BARE_CONNECTOR_WORDS
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
const PREFIX_CONNECTOR_RE = PREFIX_CONNECTOR_WORDS
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

/**
 * Middle-dot characters that wrap page numbers in Chinese journals
 * (e.g. `·2466·`, `・100・`, `‧42‧`). Single source of truth for the
 * matcher and the parser below.
 *
 * - U+00B7 MIDDLE DOT (Latin / common in Chinese typesetting)
 * - U+30FB KATAKANA MIDDLE DOT
 * - U+2027 HYPHENATION POINT
 */
const MIDDOT_CHARS = "·・‧";
const MIDDOT_WRAPPED_RE = new RegExp(
    `^[${MIDDOT_CHARS}]\\s*\\d+\\s*[${MIDDOT_CHARS}]$`,
    "u",
);
const PARSE_MIDDOT_WRAPPED = new RegExp(
    `^[${MIDDOT_CHARS}]\\s*(\\d+)\\s*[${MIDDOT_CHARS}]$`,
    "u",
);

/**
 * Bare-Roman gatekeeper pattern. Permissive (accepts e.g. "iiii", "vx"); the
 * strict Roman validator (`ROMAN_RE` below) rejects malformed strings inside
 * `parseRoman`, so anything that survives both into `pageNumberElements` is
 * a real Roman page number. Reused by `isBareRoman` so script-bucketing in
 * `identifyElementsToRemove` matches the same shape the gatekeeper recognized.
 */
const BARE_ROMAN_RE = /^[ivxlcdm]+$/iu;

/** Patterns the gatekeeper accepts. Always run on digit-normalized text. */
const PAGE_NUMBER_PATTERNS: RegExp[] = [
    /^\d+$/u,
    new RegExp(`^(?:${PAGE_PREFIX_RE})\\s*\\d+$`, "iu"),
    new RegExp(`^\\d+\\s*(?:${BARE_CONNECTOR_RE})\\s*\\d+$`, "iu"),
    new RegExp(
        `^(?:${PAGE_PREFIX_RE})\\s*\\d+\\s*(?:${PREFIX_CONNECTOR_RE})\\s*\\d+$`,
        "iu",
    ),
    /^第\s*\d+\s*(?:页|頁)$/u,
    /^\d+\s*(?:页|頁|쪽|ページ)$/u,
    MIDDOT_WRAPPED_RE,
    BARE_ROMAN_RE,
];

// Parser-specific regexes (anchored, with capture groups). Same source of
// truth (PAGE_PREFIX_RE / *_CONNECTOR_RE), so patterns and parser stay in
// lockstep.
const PARSE_PREFIX_RANGE_RE = new RegExp(
    `^(?:${PAGE_PREFIX_RE})\\s*(\\d+)\\s*(?:${PREFIX_CONNECTOR_RE})\\s*\\d+$`,
    "iu",
);
const PARSE_PREFIX_RE = new RegExp(`^(?:${PAGE_PREFIX_RE})\\s*(\\d+)$`, "iu");
const PARSE_RANGE_RE = new RegExp(
    `^(\\d+)\\s*(?:${BARE_CONNECTOR_RE})\\s*\\d+$`,
    "iu",
);
const PARSE_CJK_WRAPPED = /^第\s*(\d+)\s*(?:页|頁)$/u;
const PARSE_CJK_SUFFIX = /^(\d+)\s*(?:页|頁|쪽|ページ)$/u;

// Roman numerals — bounded to a practical preface range. A full parser up to
// 3999 would let stray single-letter glyphs (C, D, M) become valid page
// numbers.
const ROMAN_RE = /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i;
const ROMAN_VALUES: Record<string, number> = {
    M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1,
};
const ROMAN_MAX = 50;

function parseRoman(text: string): number | null {
    const upper = text.toUpperCase();
    if (!upper || !ROMAN_RE.test(upper)) return null;
    let total = 0;
    for (let i = 0; i < upper.length; i++) {
        const cur = ROMAN_VALUES[upper[i]];
        const next = ROMAN_VALUES[upper[i + 1]];
        total += next && next > cur ? -cur : cur;
    }
    return total > ROMAN_MAX ? null : total;
}

/**
 * Fold full-width / superscript / compatibility digits via NFKC, then map
 * common non-Latin script digits to ASCII. NOT a full \p{Nd} fold — only
 * the scripts listed here.
 */
const DIGIT_ZERO_BASES = [
    0x0660, // Arabic-Indic
    0x06F0, // Extended Arabic-Indic (Persian)
    0x0966, // Devanagari
    0x09E6, // Bengali
    0x0E50, // Thai
];

function normalizeDigits(text: string): string {
    const nfkc = text.normalize("NFKC");
    return nfkc.replace(/[٠-٩۰-۹०-९০-৯๐-๙]/g,
        (ch) => {
            const code = ch.codePointAt(0)!;
            for (const base of DIGIT_ZERO_BASES) {
                if (code >= base && code <= base + 9) return String(code - base);
            }
            return ch;
        });
}

function isPageNumberPattern(text: string): boolean {
    const cleaned = normalizeDigits(text).trim().toLowerCase();
    if (!cleaned) return false;
    return PAGE_NUMBER_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function parsePageNumber(text: string): number | null {
    const cleaned = normalizeDigits(text).trim().toLowerCase();
    if (!cleaned) return null;

    if (/^\d+$/u.test(cleaned)) return parseInt(cleaned, 10);

    // Prefix + range first (more specific), so the prefix branch doesn't
    // anchor on "page 3" of a "page 3 of 13" string.
    const prefixRange = cleaned.match(PARSE_PREFIX_RANGE_RE);
    if (prefixRange) return parseInt(prefixRange[1], 10);

    const prefix = cleaned.match(PARSE_PREFIX_RE);
    if (prefix) return parseInt(prefix[1], 10);

    // Bare range: "X of Y" / "X/Y" — return X (the changing component).
    const range = cleaned.match(PARSE_RANGE_RE);
    if (range) return parseInt(range[1], 10);

    const cjkWrapped = cleaned.match(PARSE_CJK_WRAPPED);
    if (cjkWrapped) return parseInt(cjkWrapped[1], 10);

    const cjkSuffix = cleaned.match(PARSE_CJK_SUFFIX);
    if (cjkSuffix) return parseInt(cjkSuffix[1], 10);

    const middot = cleaned.match(PARSE_MIDDOT_WRAPPED);
    if (middot) return parseInt(middot[1], 10);

    return parseRoman(cleaned);
}

/**
 * True when the cleaned text is a bare Roman page number (e.g. "iii", "iv").
 * Uses the same digit-normalization + trim + lowercase pipeline as the rest
 * of the page-number classifiers so callers can pass raw element text.
 *
 * Used to split parser-only page-number candidates by numeral system before
 * the increasing-sequence check, so a Roman preface followed by an Arabic
 * body (the standard dissertation / book layout) is recognized as two
 * sequences instead of one non-monotone list.
 */
function isBareRoman(text: string): boolean {
    const cleaned = normalizeDigits(text).trim().toLowerCase();
    if (!cleaned) return false;
    return BARE_ROMAN_RE.test(cleaned);
}

/**
 * Templating gate: true only for forms with a non-numeric structural anchor
 * (a page word or CJK page marker). Bare digits, bare romans, and bare
 * connector forms are excluded — they rely on the sequence-detection path
 * (which checks values strictly increase across pages).
 */
function isStructuredPageNumber(text: string): boolean {
    const cleaned = normalizeDigits(text).trim().toLowerCase();
    if (!cleaned) return false;
    if (PARSE_PREFIX_RANGE_RE.test(cleaned)) return true;
    if (PARSE_PREFIX_RE.test(cleaned)) return true;
    if (PARSE_CJK_WRAPPED.test(cleaned)) return true;
    if (PARSE_CJK_SUFFIX.test(cleaned)) return true;
    if (PARSE_MIDDOT_WRAPPED.test(cleaned)) return true;
    return false;
}

/**
 * Replace digit runs with a sentinel so paginated headers ("Page 1",
 * "Page 2", …) collapse to a single template key. Operates on
 * digit-normalized text so "page １" and "page 1" share a template.
 */
function templateKey(text: string): string {
    return normalizeDigits(text).trim().toLowerCase().replace(/\d+/gu, "§N");
}

function isIncreasingSequence(numbers: number[]): boolean {
    if (numbers.length < 2) return false;
    for (let i = 1; i < numbers.length; i++) {
        if (numbers[i] <= numbers[i - 1]) {
            return false;
        }
    }
    return true;
}

// ============================================================================
// Margin Zone Detection
// ============================================================================

/**
 * Check if a bounding box is ENTIRELY within a specific margin zone.
 */
function isEntirelyInMarginZone(
    bbox: RawBBox,
    pageWidth: number,
    pageHeight: number,
    margins: MarginSettings,
    position?: MarginPosition
): boolean {
    const x0 = bbox.x;
    const y0 = bbox.y;
    const x1 = bbox.x + bbox.w;
    const y1 = bbox.y + bbox.h;

    const inTop = y1 <= margins.top;
    const inBottom = y0 >= pageHeight - margins.bottom;
    const inLeft = x1 <= margins.left;
    const inRight = x0 >= pageWidth - margins.right;

    if (position) {
        switch (position) {
            case "top": return inTop;
            case "bottom": return inBottom;
            case "left": return inLeft;
            case "right": return inRight;
        }
    }

    return inTop || inBottom || inLeft || inRight;
}

/**
 * Determine which margin zone an element is ENTIRELY within.
 */
function getMarginPosition(
    bbox: RawBBox,
    pageWidth: number,
    pageHeight: number,
    margins: MarginSettings
): MarginPosition | null {
    const y0 = bbox.y;
    const y1 = bbox.y + bbox.h;
    const x0 = bbox.x;
    const x1 = bbox.x + bbox.w;

    if (y1 <= margins.top) return "top";
    if (y0 >= pageHeight - margins.bottom) return "bottom";
    if (x1 <= margins.left) return "left";
    if (x0 >= pageWidth - margins.right) return "right";

    return null;
}

/** Normalize text for exact-match comparison (does NOT fold digits). */
function normalizeText(text: string): string {
    return text.trim().toLowerCase();
}

/**
 * Floating-point bbox equality used by the off-margin page-number drop
 * to match a detected line back to its bbox at filter time. 1.5pt
 * absorbs the JSON-walker / detailed-walker drift: the structured
 * extract path runs cross-page margin analysis on JSON-walk pages
 * (int-truncated bboxes) but the per-page filter sees the detailed
 * walk's float bboxes for the target page, so the same physical line
 * has up to ~1pt of per-coordinate drift between the two frames.
 * Mirrors `RawFontBridge.Y_TOLERANCE_PT` (which absorbs the same
 * drift). Line spacing in body text is typically 9–12pt — well
 * outside 1.5pt — so the only bboxes that match are the same physical
 * line the analysis identified.
 */
const BBOX_EQ_TOL_PT = 1.5;
function bboxesApproxEqual(a: RawBBox, b: RawBBox): boolean {
    return (
        Math.abs(a.x - b.x) <= BBOX_EQ_TOL_PT
        && Math.abs(a.y - b.y) <= BBOX_EQ_TOL_PT
        && Math.abs(a.w - b.w) <= BBOX_EQ_TOL_PT
        && Math.abs(a.h - b.h) <= BBOX_EQ_TOL_PT
    );
}

// ============================================================================
// Effective repeat-threshold helper
// ============================================================================

export interface RepeatThresholdInput {
    /** Caller-supplied threshold (or undefined when not specified). */
    requested?: number;
    /**
     * Total number of pages in the **source document** — what determines
     * whether the document itself is short. Pass this when known so a
     * caller extracting a 5-page subset of a 100-page paper does NOT
     * relax the threshold.
     *
     * If both `totalPageCount` and `analysisPageCount` are omitted, no
     * relaxation is applied. If only `analysisPageCount` is provided (no
     * total), it is used as a best-effort proxy — acceptable when the
     * caller's analysis window IS the whole document (typical), but it
     * will incorrectly relax for short subsets of long documents. Prefer
     * passing `totalPageCount` whenever the value is available.
     */
    totalPageCount?: number;
    /**
     * Pages in the current analysis window. Used as a fallback when
     * `totalPageCount` is unknown. Required so the caller declares its
     * intent — passing 0 disables relaxation.
     */
    analysisPageCount: number;
}

/**
 * Per-position repeat threshold for `identifyElementsToRemove`.
 *
 * Short academic papers (≤6 pages) frequently use **alternating** verso/recto
 * running headers (e.g. journal title on even pages, author/article title on
 * odd pages) so a given header text appears on at most ⌈N/2⌉ pages. The
 * conservative default of 3 means short documents miss the header entirely.
 * For top/bottom positions on short docs we relax to 2; left/right (vertical
 * watermarks, side stripes) keep the conservative default.
 *
 * The relaxation only applies when the caller did NOT pass an explicit
 * threshold — explicit values win for both positions, so debug endpoints
 * with `repeat_threshold: 3` keep deterministic behavior.
 *
 * `requested` is sanitized: only a positive integer counts as explicit. 0,
 * negative, NaN, non-integer (and undefined) all fall back to the adaptive
 * default. Call sites can hand us `ctx.repeatThreshold` without their own
 * validation.
 */
export function getEffectiveRepeatThreshold(
    input: RepeatThresholdInput,
): { topBottom: number; leftRight: number } {
    const SHORT_DOC_PAGE_LIMIT = 6;
    const DEFAULT_THRESHOLD = 3;
    const explicit =
        input.requested !== undefined &&
        Number.isInteger(input.requested) &&
        input.requested > 0
            ? input.requested
            : undefined;
    if (explicit !== undefined) {
        return { topBottom: explicit, leftRight: explicit };
    }
    // "Short document" check uses total page count when provided, falling
    // back to the analysis window size only when total is unknown. This
    // prevents relaxing for a 5-page subset of a 100-page paper.
    const docPages =
        input.totalPageCount !== undefined && input.totalPageCount > 0
            ? input.totalPageCount
            : input.analysisPageCount;
    const relaxed =
        docPages > 0 && docPages <= SHORT_DOC_PAGE_LIMIT
            ? 2
            : DEFAULT_THRESHOLD;
    return { topBottom: relaxed, leftRight: DEFAULT_THRESHOLD };
}

// ============================================================================
// MarginFilter Class
// ============================================================================

/**
 * MarginFilter class for handling margin-based content filtering.
 */
export class MarginFilter {
    /**
     * Simple filter: Check if a line is inside the content area.
     */
    static isInsideContentArea(
        line: RawLine,
        pageWidth: number,
        pageHeight: number,
        margins: MarginSettings
    ): boolean {
        return !isEntirelyInMarginZone(line.bbox, pageWidth, pageHeight, margins);
    }

    /**
     * Classify a bbox by which margin zone it falls *entirely* within, or
     * `null` if it overlaps the content area.
     *
     * Public surface for debug/agent endpoints — same logic the simple
     * filter uses, exposed without forcing callers to instantiate a Line.
     */
    static getMarginPosition(
        bbox: RawBBox,
        pageWidth: number,
        pageHeight: number,
        margins: MarginSettings
    ): MarginPosition | null {
        return getMarginPosition(bbox, pageWidth, pageHeight, margins);
    }

    /**
     * Simple filter: Filter a page's lines to exclude those entirely in margins.
     *
     * `bodyStyles` (optional) spares lines whose font matches the document's
     * body styles even when their bbox is entirely within the simple-margin
     * band.
     */
    static filterPageByMargins(
        page: RawPageData,
        margins: MarginSettings,
        bodyStyles?: TextStyle[]
    ): RawPageData {
        const filteredBlocks = page.blocks.map(block => {
            if (block.type !== "text" || !block.lines) {
                return block;
            }

            const filteredLines = block.lines.filter(line =>
                this.isInsideContentArea(line, page.width, page.height, margins)
                || (bodyStyles && StyleAnalyzer.looksLikeBodyContent(line, bodyStyles))
            );

            return {
                ...block,
                lines: filteredLines,
            };
        }).filter(block => {
            if (block.type === "text") {
                return block.lines && block.lines.length > 0;
            }
            return true;
        });

        return {
            ...page,
            blocks: filteredBlocks,
        };
    }

    /**
     * Smart filter: Collect all elements in margin zones for analysis.
     *
     * Also collects `offMarginPageNumberCandidates` — short
     * `isPageNumberPattern` lines that fell outside every margin zone.
     * These feed an additional sequence-detection pass in
     * `identifyElementsToRemove` so page numbers placed at a "natural
     * footer" position the smart zone misses (e.g. JSTOR scans where a
     * watermark sits below the original page number) still get caught.
     */
    static collectMarginElements(
        pages: RawPageData[],
        marginZone: MarginSettings
    ): MarginAnalysis {
        const elements = new Map<MarginPosition, MarginElement[]>([
            ["top", []],
            ["bottom", []],
            ["left", []],
            ["right", []],
        ]);
        const offMarginPageNumberCandidates: MarginElement[] = [];

        for (const page of pages) {
            for (const block of page.blocks) {
                if (block.type !== "text" || !block.lines) continue;

                for (const line of block.lines) {
                    const trimmedText = (line.text || "").trim();
                    if (!trimmedText) continue;

                    const position = getMarginPosition(
                        line.bbox,
                        page.width,
                        page.height,
                        marginZone
                    );

                    if (position) {
                        elements.get(position)!.push({
                            text: trimmedText,
                            position,
                            bbox: line.bbox,
                            pageIndex: page.pageIndex,
                            line,
                        });
                    } else if (isPageNumberPattern(trimmedText)) {
                        // Synthesize a top/bottom position from the page
                        // midline so the cross-position bucketing in
                        // identifyElementsToRemove has a side to group
                        // against. The whole-line bbox is what we own;
                        // pick top half / bottom half by y center.
                        const yCenter = line.bbox.y + line.bbox.h / 2;
                        const synthesizedPosition: MarginPosition =
                            yCenter < page.height / 2 ? "top" : "bottom";
                        offMarginPageNumberCandidates.push({
                            text: trimmedText,
                            position: synthesizedPosition,
                            bbox: line.bbox,
                            pageIndex: page.pageIndex,
                            line,
                        });
                    }
                }
            }
        }

        const counts: Record<MarginPosition, number> = {
            top: elements.get("top")!.length,
            bottom: elements.get("bottom")!.length,
            left: elements.get("left")!.length,
            right: elements.get("right")!.length,
        };

        return { elements, counts, offMarginPageNumberCandidates };
    }

    /**
     * Identify elements to remove based on frequency and page number detection.
     *
     * @param analysis - Margin analysis results
     * @param requiredCount - Minimum pages for text to be considered repeating.
     *   Pass a number for a uniform threshold (back-compat) or an object
     *   `{ topBottom, leftRight }` for per-position thresholds (used by the
     *   short-doc relaxation in `getEffectiveRepeatThreshold`).
     * @param detectPageSequences - Whether to detect page number sequences
     * @returns Removal result with candidates and lookup structures
     */
    static identifyElementsToRemove(
        analysis: MarginAnalysis,
        requiredCount:
            | number
            | { topBottom: number; leftRight: number } = 3,
        detectPageSequences: boolean = true
    ): MarginRemovalResult {
        const candidates: RemovalCandidate[] = [];
        const textsToRemove = new Set<string>();
        const removalsByPage = new Map<number, Set<string>>();
        const offMarginPageNumberRemovals = new Map<number, OffMarginPageNumberLine[]>();

        // Process each margin position
        for (const [position, elements] of analysis.elements) {
            const requiredForPosition =
                typeof requiredCount === "number"
                    ? requiredCount
                    : position === "top" || position === "bottom"
                        ? requiredCount.topBottom
                        : requiredCount.leftRight;

            // Group elements by structural template if structured, else by
            // normalized exact text. The bucket tracks each variant's own
            // page set so removalsByPage only receives variants that
            // actually appeared on that page (not the whole template family).
            type Bucket = {
                firstNormalized: string;
                firstOriginal: string;
                variantPages: Map<string, Set<number>>;
                pageIndices: Set<number>;
            };
            const buckets = new Map<string, Bucket>();

            for (const el of elements) {
                const normalized = normalizeText(el.text);
                const key = isStructuredPageNumber(el.text)
                    ? `tpl:${templateKey(el.text)}`
                    : `txt:${normalized}`;
                let bucket = buckets.get(key);
                if (!bucket) {
                    bucket = {
                        firstNormalized: normalized,
                        firstOriginal: el.text,
                        variantPages: new Map(),
                        pageIndices: new Set(),
                    };
                    buckets.set(key, bucket);
                }
                let pagesForVariant = bucket.variantPages.get(normalized);
                if (!pagesForVariant) {
                    pagesForVariant = new Set();
                    bucket.variantPages.set(normalized, pagesForVariant);
                }
                pagesForVariant.add(el.pageIndex);
                bucket.pageIndices.add(el.pageIndex);
            }

            for (const bucket of buckets.values()) {
                if (bucket.pageIndices.size < requiredForPosition) continue;
                const pages = Array.from(bucket.pageIndices).sort((a, b) => a - b);

                // candidate.text stays as exact normalized text — external
                // consumers (testPdfHandlers, extractionOverlay) match
                // candidate.text against line text. Internal Map/Set keys
                // (tpl:/txt:) are scoped to this function only.
                candidates.push({
                    text: bucket.firstNormalized,
                    originalText: bucket.firstOriginal,
                    pageIndices: pages,
                    reason: "repeat",
                    position,
                });

                for (const [variant, variantPages] of bucket.variantPages) {
                    textsToRemove.add(variant);
                    for (const p of variantPages) {
                        if (!removalsByPage.has(p)) {
                            removalsByPage.set(p, new Set());
                        }
                        removalsByPage.get(p)!.add(variant);
                    }
                }
            }

            // Detect page number sequences
            if (detectPageSequences) {
                // Collect elements that match page number patterns. Skip
                // elements already covered by the repeat/templating pass
                // for this position — otherwise a co-located "Page K"
                // family (already removed) and a "K of 13" family would
                // interleave into [1,1,2,2,3,3,...], breaking strict
                // increase and silently dropping the second family.
                const pageNumberElements: { el: MarginElement; value: number }[] = [];

                for (const el of elements) {
                    const normalized = normalizeText(el.text);
                    if (textsToRemove.has(normalized)) continue;
                    if (isPageNumberPattern(el.text)) {
                        const value = parsePageNumber(el.text);
                        if (value !== null) {
                            pageNumberElements.push({ el, value });
                        }
                    }
                }

                // Partition into bare-Roman vs non-Roman buckets so a
                // document with a Roman preface (iii, iv, …) followed by
                // an Arabic body (1, 2, …) — the standard dissertation,
                // thesis, and book layout — isn't rejected because the
                // concatenated value list resets at the script boundary
                // (e.g. [3,4,5,…,11,1,2,3,…] never strictly increases).
                // Each bucket runs the existing per-page collapse +
                // distinct-page guard + isIncreasingSequence + marking
                // pass independently. When only one bucket is non-empty
                // (the overwhelmingly common single-script case), the
                // surviving bucket runs the same code path it always did.
                const romanBucket: typeof pageNumberElements = [];
                const nonRomanBucket: typeof pageNumberElements = [];
                for (const entry of pageNumberElements) {
                    if (isBareRoman(entry.el.text)) {
                        romanBucket.push(entry);
                    } else {
                        nonRomanBucket.push(entry);
                    }
                }

                for (const bucketElements of [romanBucket, nonRomanBucket]) {
                    if (bucketElements.length === 0) continue;

                    // Collapse to one candidate per page BEFORE the
                    // increasing-sequence check. If a page emits two
                    // numeric margin elements (e.g. `1` in left header +
                    // `1` in right header), the raw value list
                    // `[1, 1, 2, 2, 3, 3, …]` never strictly increases
                    // and a real page sequence is missed. Pick the lowest
                    // value per page — for the typical failure shape
                    // (two slots showing the same page number) the choice
                    // doesn't matter; for the rarer case of two
                    // legitimately-different numbers per page, the lowest
                    // is the better proxy for "the page label."
                    const perPage = new Map<number, { el: MarginElement; value: number }>();
                    for (const entry of bucketElements) {
                        const existing = perPage.get(entry.el.pageIndex);
                        if (!existing || entry.value < existing.value) {
                            perPage.set(entry.el.pageIndex, entry);
                        }
                    }
                    const oneCandidatePerPage = Array.from(perPage.values());

                    // Distinct-page guard: count distinct pages, not raw
                    // element count. With the relaxed threshold of 2, a
                    // single page that emits two numeric-looking margin
                    // elements would otherwise pass the gate and be
                    // classified as a "sequence" of length 1.
                    if (oneCandidatePerPage.length < requiredForPosition) continue;

                    // Sort by page index
                    oneCandidatePerPage.sort((a, b) => a.el.pageIndex - b.el.pageIndex);

                    // Check if values form an increasing sequence (one per page)
                    const values = oneCandidatePerPage.map((p) => p.value);
                    if (!isIncreasingSequence(values)) continue;

                    // These are page numbers - mark all bucket-local
                    // elements on the matched pages. Iterating the
                    // bucket (not the combined `pageNumberElements`)
                    // keeps cross-bucket text from being marked when a
                    // page legitimately carries both scripts.
                    const matchedPageIndices = new Set(
                        oneCandidatePerPage.map((p) => p.el.pageIndex),
                    );
                    const seenTexts = new Set<string>();
                    for (const { el } of bucketElements) {
                        if (!matchedPageIndices.has(el.pageIndex)) continue;
                        const normalized = normalizeText(el.text);

                        if (!seenTexts.has(normalized) && !textsToRemove.has(normalized)) {
                            seenTexts.add(normalized);

                            candidates.push({
                                text: normalized,
                                originalText: el.text,
                                pageIndices: [el.pageIndex],
                                reason: "page_number",
                                position,
                            });
                        }

                        textsToRemove.add(normalized);

                        if (!removalsByPage.has(el.pageIndex)) {
                            removalsByPage.set(el.pageIndex, new Set());
                        }
                        removalsByPage.get(el.pageIndex)!.add(normalized);
                    }

                    // Log the page number sequence detection (development only)
                    if (process.env.NODE_ENV === "development") {
                        pdfLog(`[MarginFilter] Detected page number sequence in ${position} zone: ${values.slice(0, 5).join(", ")}...`, 3);
                    }
                }
            }
        }

        // Off-margin page-number sequence pass.
        //
        // Lines that fall outside every margin zone but match a
        // page-number pattern (collected in
        // `analysis.offMarginPageNumberCandidates`) are checked for a
        // cross-page monotone increasing sequence clustered at a
        // consistent y position. The "consistent y" requirement is the
        // key safeguard against false positives: a bare number that
        // happens to appear in body text on multiple pages almost never
        // also lands at the same y position as a true page-number
        // footer line.
        //
        // Matched texts are written to `offMarginPageNumberRemovals`
        // so the per-page filter can drop them without consulting the
        // margin-zone check (which is exactly the gate that missed
        // them upstream).
        if (detectPageSequences && analysis.offMarginPageNumberCandidates.length > 0) {
            const requiredForPosition =
                typeof requiredCount === "number"
                    ? requiredCount
                    : requiredCount.topBottom;
            // y bucket resolution. 10pt is wide enough to absorb
            // minor per-page jitter (descender/ascender drift) and
            // narrow enough that body-text bare-numerics with even a
            // line of vertical drift won't cluster.
            const Y_BUCKET_PT = 10;

            type Bucket = { side: MarginPosition; entries: MarginElement[] };
            const yBuckets = new Map<string, Bucket>();
            for (const el of analysis.offMarginPageNumberCandidates) {
                const yKey = Math.round(el.bbox.y / Y_BUCKET_PT);
                const sideKey = `${el.position}:${yKey}`;
                let bucket = yBuckets.get(sideKey);
                if (!bucket) {
                    bucket = { side: el.position, entries: [] };
                    yBuckets.set(sideKey, bucket);
                }
                bucket.entries.push(el);
            }

            for (const { side, entries } of yBuckets.values()) {
                if (entries.length < requiredForPosition) continue;

                const pageNumberElements: { el: MarginElement; value: number }[] = [];
                for (const el of entries) {
                    const value = parsePageNumber(el.text);
                    if (value !== null) {
                        pageNumberElements.push({ el, value });
                    }
                }
                if (pageNumberElements.length === 0) continue;

                // Mirror the in-zone path: partition Roman vs non-Roman
                // so a Roman preface + Arabic body isn't rejected by a
                // single concatenated value list.
                const romanBucket: typeof pageNumberElements = [];
                const nonRomanBucket: typeof pageNumberElements = [];
                for (const entry of pageNumberElements) {
                    if (isBareRoman(entry.el.text)) {
                        romanBucket.push(entry);
                    } else {
                        nonRomanBucket.push(entry);
                    }
                }

                for (const bucketElements of [romanBucket, nonRomanBucket]) {
                    if (bucketElements.length === 0) continue;

                    // Collapse to one entry per page (lowest value) so
                    // a page that emits two numeric off-margin lines
                    // doesn't break the strict-increase check.
                    const perPage = new Map<number, { el: MarginElement; value: number }>();
                    for (const entry of bucketElements) {
                        const existing = perPage.get(entry.el.pageIndex);
                        if (!existing || entry.value < existing.value) {
                            perPage.set(entry.el.pageIndex, entry);
                        }
                    }
                    const oneCandidatePerPage = Array.from(perPage.values());
                    if (oneCandidatePerPage.length < requiredForPosition) continue;
                    oneCandidatePerPage.sort((a, b) => a.el.pageIndex - b.el.pageIndex);
                    const values = oneCandidatePerPage.map((p) => p.value);
                    if (!isIncreasingSequence(values)) continue;

                    const matchedPageIndices = new Set(
                        oneCandidatePerPage.map((p) => p.el.pageIndex),
                    );
                    const seenTexts = new Set<string>();
                    for (const { el } of bucketElements) {
                        if (!matchedPageIndices.has(el.pageIndex)) continue;
                        const normalized = normalizeText(el.text);

                        if (!seenTexts.has(normalized)) {
                            seenTexts.add(normalized);
                            candidates.push({
                                text: normalized,
                                originalText: el.text,
                                pageIndices: [el.pageIndex],
                                reason: "page_number",
                                position: side,
                            });
                        }

                        textsToRemove.add(normalized);

                        // Track the exact bbox of each matched line so
                        // `filterPageWithSmartRemoval` drops only that
                        // specific line — text-only matching would also
                        // remove body / table / list lines on the same
                        // page that happen to share the page number
                        // (e.g. a standalone numbered item "12" on a
                        // page whose page number is also "12").
                        let entries = offMarginPageNumberRemovals.get(el.pageIndex);
                        if (!entries) {
                            entries = [];
                            offMarginPageNumberRemovals.set(el.pageIndex, entries);
                        }
                        entries.push({ text: normalized, bbox: el.bbox });
                    }

                    if (process.env.NODE_ENV === "development") {
                        pdfLog(`[MarginFilter] Detected off-margin page number sequence (${side}): ${values.slice(0, 5).join(", ")}...`, 3);
                    }
                }
            }
        }

        return {
            candidates,
            textsToRemove,
            removalsByPage,
            offMarginPageNumberRemovals,
        };
    }

    /**
     * Filter a page using smart removal results.
     * Removes lines that match identified repeating/page-number elements.
     *
     * `bodyStyles` (optional) spares the simple-margin drop for lines whose
     * font matches a document body style, so tight-margin layouts
     * keep body text packed near the page edge.
     *
     * `pageFrame` (optional) carries the per-target-page rotation the
     * pipeline applied before calling this filter. Off-margin
     * page-number bboxes are stored in the analysis (raw) frame; when
     * the target page was rotated, the stored bbox must be transformed
     * into the current working frame before the bbox-equality check —
     * otherwise the detected page-number line on a rotated page (e.g.
     * a full-page rotated figure) won't match and the page number
     * leaks back into output. Default `{ rotation: 0 }` leaves the
     * bbox untouched (identity transform).
     */
    static filterPageWithSmartRemoval(
        page: RawPageData,
        margins: MarginSettings,
        marginZone: MarginSettings,
        removalResult: MarginRemovalResult,
        bodyStyles?: TextStyle[],
        pageFrame?: { rotation: RotationAngle; sourceWidth: number; sourceHeight: number },
    ): RawPageData {
        const pageRemovals = removalResult.removalsByPage.get(page.pageIndex);
        const offMarginPageNumbers =
            removalResult.offMarginPageNumberRemovals.get(page.pageIndex);
        // Transform stored bboxes from the analysis (raw) frame to the
        // current working frame ONCE per call. Identity transform when
        // rotation is 0 or no frame is supplied.
        const offMarginEntriesInFrame =
            offMarginPageNumbers && offMarginPageNumbers.length > 0
                && pageFrame && pageFrame.rotation !== 0
                ? offMarginPageNumbers.map((e) => ({
                    text: e.text,
                    bbox: rotateBBox(
                        e.bbox,
                        pageFrame.rotation,
                        pageFrame.sourceWidth,
                        pageFrame.sourceHeight,
                    ),
                }))
                : offMarginPageNumbers;

        const filteredBlocks = page.blocks.map(block => {
            if (block.type !== "text" || !block.lines) {
                return block;
            }

            const filteredLines = block.lines.filter(line => {
                // Drop if entirely in simple margins UNLESS the line looks
                // like body content packed near the page edge: same font
                // as a body style AND substantive multi-word text. Single-
                // token strings in the body font (page numbers, short
                // labels) are still treated as marginalia.
                if (!this.isInsideContentArea(line, page.width, page.height, margins)) {
                    if (!bodyStyles || !StyleAnalyzer.looksLikeBodyContent(line, bodyStyles)) {
                        return false;
                    }
                }

                // Check if line is in margin zone and matches removal candidate.
                // Smart-removal still applies to body-styled lines.
                if (pageRemovals && pageRemovals.size > 0) {
                    const position = getMarginPosition(
                        line.bbox,
                        page.width,
                        page.height,
                        marginZone
                    );

                    if (position) {
                        const normalized = normalizeText(line.text || "");
                        if (pageRemovals.has(normalized)) {
                            return false;
                        }
                    }
                }

                // Off-margin page-number drops bypass the zone gate
                // but keep a line-level location check: a line is
                // dropped only when **both** its normalized text AND
                // its bbox (within a small floating-point tolerance)
                // match an entry tracked by the cross-page monotone
                // detector. Without the bbox check, a body / table /
                // list line that happens to share the page number's
                // text would also be dropped.
                if (offMarginEntriesInFrame && offMarginEntriesInFrame.length > 0) {
                    const normalized = normalizeText(line.text || "");
                    for (const entry of offMarginEntriesInFrame) {
                        if (
                            entry.text === normalized
                            && bboxesApproxEqual(entry.bbox, line.bbox)
                        ) {
                            return false;
                        }
                    }
                }

                return true;
            });

            return {
                ...block,
                lines: filteredLines,
            };
        }).filter(block => {
            if (block.type === "text") {
                return block.lines && block.lines.length > 0;
            }
            return true;
        });

        return {
            ...page,
            blocks: filteredBlocks,
        };
    }

    /**
     * Log what elements will be removed.
     * Only logs in development mode.
     */
    static logRemovalCandidates(result: MarginRemovalResult): void {
        if (process.env.NODE_ENV !== "development") return;

        if (result.candidates.length === 0) {
            pdfLog("[MarginFilter] No margin elements identified for removal", 3);
            return;
        }

        pdfLog(`[MarginFilter] Identified ${result.candidates.length} elements for removal:`, 3);

        // Group by position for cleaner output
        const byPosition = new Map<MarginPosition, RemovalCandidate[]>();
        for (const candidate of result.candidates) {
            if (!byPosition.has(candidate.position)) {
                byPosition.set(candidate.position, []);
            }
            byPosition.get(candidate.position)!.push(candidate);
        }

        for (const [position, candidates] of byPosition) {
            pdfLog(`\n  ${position.toUpperCase()} zone:`, 3);

            for (const candidate of candidates) {
                const pages = candidate.pageIndices;
                const pageStr = pages.length > 10
                    ? `pages ${pages.slice(0, 5).join(", ")}... (${pages.length} total)`
                    : `pages ${pages.join(", ")}`;

                const reasonTag = candidate.reason === "page_number" ? " [PAGE#]" : "";
                const displayText = candidate.originalText.slice(0, 50);

                pdfLog(`    "${displayText}"${reasonTag} (${pageStr})`, 3);
            }
        }
    }
}
