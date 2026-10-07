/**
 * Margin Filter
 *
 * Handles margin-based filtering of text content:
 * 1. Simple filtering: Exclude content entirely within margin thresholds
 * 2. Smart filtering: Identify and remove repeating elements in margin zones
 */

import type {
    BoundingBox,
    RawPageData,
    RawLine,
    MarginSettings,
    MarginPosition,
    MarginElement,
    MarginAnalysis,
    RemovalCandidate,
    MarginRemovalResult,
    TextStyle,
} from "@beaver/agent-core/extract/types";
import { pdfLog, isAnalyzerLoggingEnabled } from "./logging";
import { StyleAnalyzer } from "./StyleAnalyzer";

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
/**
 * Key for matching joined rows with their digits aside: rows that carry
 * text, and a single number with its ornaments ("-119 -", "— 5 —"). Rows of
 * several bare numbers (table values, figure ticks) would all share one
 * template, so they keep exact matching and are left to page-number
 * detection.
 */
function rowTemplateKey(text: string): string {
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    const numbers = normalizeDigits(text).match(/\d+/gu)?.length ?? 0;
    return letters >= 3 || numbers <= 1
        ? `tpl:${templateKey(text)}`
        : `txt:${normalizeText(text)}`;
}

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
    bbox: BoundingBox,
    pageWidth: number,
    pageHeight: number,
    margins: MarginSettings,
    position?: MarginPosition
): boolean {
    const x0 = bbox.l;
    const y0 = bbox.t;
    const x1 = bbox.r;
    const y1 = bbox.b;

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
    bbox: BoundingBox,
    pageWidth: number,
    pageHeight: number,
    margins: MarginSettings
): MarginPosition | null {
    const y0 = bbox.t;
    const y1 = bbox.b;
    const x0 = bbox.l;
    const x1 = bbox.r;

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

const STANDALONE_URL_RE =
    /^(?:(?:https?:\/\/|www\.)\S+|\S+\.(?:edu|gov|org|com|net|io|ac|uk)(?:\/\S*)?)$/iu;
const STANDALONE_DOI_RE =
    /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/iu;
const STANDALONE_ARXIV_RE =
    /^arxiv:\s*\d{4}\.\d{4,5}(?:v\d+)?(?:\s+\[[^\]]+\])?(?:\s+\d{1,2}\s+\p{L}{3}\s+\d{4})?$/iu;

function isStandaloneExternalIdentifier(text: string): boolean {
    const cleaned = text.trim();
    if (!cleaned) return false;
    return (
        STANDALONE_URL_RE.test(cleaned) ||
        STANDALONE_DOI_RE.test(cleaned) ||
        STANDALONE_ARXIV_RE.test(cleaned)
    );
}

/**
 * Substance gate for left/right repeating-margin candidates.
 *
 * A line is "substantial enough" to be genuine side marginalia when it has
 * ≥ 2 word tokens OR ≥ 8 alphanumeric characters. Single short words fail.
 *
 * In justified multi-column layouts MuPDF often emits each word as its own
 * line. The trailing/leading words of a body column poke into the wide
 * margin *zone*, and because common function words ("the", "of", "and", …)
 * recur on most pages, the cross-page repeat detector would otherwise flag
 * them as repeating side-margin elements and delete real body text. Genuine
 * repeating left/right marginalia (vertical journal watermarks, "Downloaded
 * from …" stripes, side identifiers) are essentially always multi-word or a
 * long token, so this bar lets them through while sparing body edge words.
 *
 * Scoped to left/right only — top/bottom running headers are legitimately
 * short (e.g. an author surname), and page numbers / standalone identifiers
 * are handled by their own classification paths, not the repeat path.
 */
function isSubstantialSideMarginText(text: string): boolean {
    const trimmed = text.trim();
    const alnumMatches = trimmed.match(/[\p{L}\p{N}]/gu);
    if (alnumMatches && alnumMatches.length >= 8) return true;
    const tokens = trimmed
        .split(/\s+/)
        .filter((t) => /[\p{L}\p{N}]/u.test(t));
    return tokens.length >= 2;
}

// ============================================================================
// Text rows
// ============================================================================

/** Lines MuPDF emitted separately on one baseline, read as one line. */
interface TextRow {
    /** Row text: the line's own trimmed text, or the lines' joined text. */
    text: string;
    bbox: BoundingBox;
    lines: RawLine[];
}

function unionBBox(lines: RawLine[]): BoundingBox {
    return {
        l: Math.min(...lines.map(line => line.bbox.l)),
        t: Math.min(...lines.map(line => line.bbox.t)),
        r: Math.max(...lines.map(line => line.bbox.r)),
        b: Math.max(...lines.map(line => line.bbox.b)),
        origin: lines[0].bbox.origin,
    };
}

function joinRowText(lines: RawLine[]): string {
    return lines.map(line => line.text).join(" ").replace(/\s+/gu, " ").trim();
}

/**
 * Group a page's text lines into rows, the unit of smart margin removal.
 *
 * Some PDFs draw text word by word or out of reading order, and MuPDF then
 * emits each word, or a line's opening word, as a line of its own. Judged
 * word by word, common words of body rows that reach into a margin zone
 * repeat across pages like a running head does, and a body word that also
 * appears in a running head is removed with it. Joining such lines back
 * into the row they belong to restores the unit MuPDF produces for
 * ordinary PDFs: a running head still repeats as a whole, a body row does
 * not, and a body row that leaves the margin zone is not margin text.
 *
 * Upright lines join when they overlap vertically by at least half the
 * shorter line, neither is more than twice as tall as the other, and the
 * gap between them is at most 0.3 em of the smaller font. Word-split lines
 * carry their word space, so they nearly touch. MuPDF itself splits a line
 * only at a wider gap, so lines it split for that reason (a running head
 * and its page number or separator dots, columns) stay apart. Lines that
 * overlap horizontally by more than a quarter em are text printed over
 * other text (a download stamp across a footer), not one row. The em comes
 * from the reported font size rather than the line box, whose height
 * differs between extraction passes. Rows keep the order of their first
 * line.
 */
function collectTextRows(page: RawPageData, joinLines: boolean): TextRow[] {
    const lines: RawLine[] = [];
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            if ((line.text || "").trim()) lines.push(line);
        }
    }

    const n = lines.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    const upright = lines.map(line => joinLines && line.wmode !== 1 && (line.rotation ?? 0) === 0);
    const em = lines.map(line =>
        line.font?.size > 0 ? line.font.size : 0.7 * (line.bbox.b - line.bbox.t),
    );
    const order = lines.map((_, i) => i)
        .filter(i => upright[i])
        .sort((a, b) => lines[a].bbox.t - lines[b].bbox.t);
    for (let x = 0; x < order.length; x++) {
        const a = lines[order[x]].bbox;
        const ha = a.b - a.t;
        if (!(ha > 0)) continue;
        for (let y = x + 1; y < order.length; y++) {
            const b = lines[order[y]].bbox;
            if (b.t >= a.b) break;
            const hb = b.b - b.t;
            if (!(hb > 0)) continue;
            const minH = Math.min(ha, hb);
            if (Math.max(ha, hb) > 2 * minH) continue;
            if (Math.min(a.b, b.b) - b.t < 0.5 * minH) continue;
            const minEm = Math.min(em[order[x]], em[order[y]]);
            const gap = Math.max(b.l - a.r, a.l - b.r);
            if (gap > 0.3 * minEm || gap < -0.25 * minEm) continue;
            const ra = find(order[x]);
            const rb = find(order[y]);
            if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
        }
    }

    const groups = new Map<number, RawLine[]>();
    for (let i = 0; i < n; i++) {
        const root = find(i);
        let group = groups.get(root);
        if (!group) {
            group = [];
            groups.set(root, group);
        }
        group.push(lines[i]);
    }
    return Array.from(groups.values(), (group): TextRow => {
        if (group.length === 1) {
            return { text: group[0].text.trim(), bbox: group[0].bbox, lines: group };
        }
        group.sort((a, b) => a.bbox.l - b.bbox.l);
        return {
            text: joinRowText(group),
            bbox: unionBBox(group),
            lines: group,
        };
    });
}

/**
 * Most page-number-like lines a page may have in one margin zone for a
 * standalone one to support a page-number run found beside running heads.
 */
const MAX_PAGE_NUMBER_CANDIDATES = 3;

/** Smallest reported font size of a page number in such a run. */
const MIN_PAGE_NUMBER_FONT_SIZE = 5;

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
        bbox: BoundingBox,
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
     * With `textRows` off, every line is its own row (PDF schema 4).
     */
    static collectMarginElements(
        pages: RawPageData[],
        marginZone: MarginSettings,
        textRows: boolean = true
    ): MarginAnalysis {
        const elements = new Map<MarginPosition, MarginElement[]>([
            ["top", []],
            ["bottom", []],
            ["left", []],
            ["right", []],
        ]);

        // One element per text row (see `collectTextRows`); `line` is the
        // row's first line. A row that spans two zones without reaching the
        // content area, such as a running head with its page number in the
        // corner, contributes its lines one by one.
        for (const page of pages) {
            const positionOf = (bbox: BoundingBox) =>
                getMarginPosition(bbox, page.width, page.height, marginZone);
            const push = (
                text: string,
                position: MarginPosition,
                bbox: BoundingBox,
                lines: RawLine[],
                rowEndNumber = false,
            ) => {
                elements.get(position)!.push({
                    text,
                    position,
                    bbox,
                    pageIndex: page.pageIndex,
                    line: lines[0],
                    ...(lines.length > 1 ? { lineCount: lines.length } : {}),
                    ...(rowEndNumber ? { rowEndNumber } : {}),
                });
            };
            for (const row of collectTextRows(page, textRows)) {
                const position = positionOf(row.bbox);
                if (position) {
                    push(row.text, position, row.bbox, row.lines);
                    // A page number set beside a running head that changes
                    // from page to page ("1 Introduction", "2 Methods") is
                    // only found by the page-number sequence, so a leading
                    // or trailing page number is also collected on its own
                    // (see `rowEndNumber`).
                    const ends = row.lines.length > 1
                        ? [row.lines[0], row.lines[row.lines.length - 1]]
                        : [];
                    for (const line of ends) {
                        const linePosition = positionOf(line.bbox);
                        if (linePosition && isPageNumberPattern(line.text.trim())) {
                            push(line.text.trim(), linePosition, line.bbox, [line], true);
                        }
                    }
                    continue;
                }
                if (row.lines.length < 2 || !row.lines.every(line => positionOf(line.bbox))) continue;
                for (const line of row.lines) {
                    push(line.text.trim(), positionOf(line.bbox)!, line.bbox, [line]);
                }
            }
        }

        const counts: Record<MarginPosition, number> = {
            top: elements.get("top")!.length,
            bottom: elements.get("bottom")!.length,
            left: elements.get("left")!.length,
            right: elements.get("right")!.length,
        };

        return { elements, counts };
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

        // Process each margin position
        for (const [position, positionElements] of analysis.elements) {
            const elements = positionElements.filter(el => !el.rowEndNumber);
            const rowEndNumbers = positionElements.filter(el => el.rowEndNumber);
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

            // A joined row often carries the page number next to the running
            // head ("166 | Elegies of Diaspora"), so its digits don't count
            // (see `rowTemplateKey`); a single line keeps exact text matching. MuPDF can emit the same
            // running head as one line on some pages and as several on
            // others, so a single line whose text a joined row also has counts
            // with that row.
            const rowKey = (el: MarginElement, normalized: string) =>
                isStructuredPageNumber(el.text) ? null : `row:${rowTemplateKey(normalized)}`;
            const rowKeyByText = new Map<string, string>();
            for (const el of elements) {
                if (!el.lineCount) continue;
                const normalized = normalizeText(el.text);
                const key = rowKey(el, normalized);
                if (key) rowKeyByText.set(normalized, key);
            }

            for (const el of elements) {
                const normalized = normalizeText(el.text);
                const key = isStructuredPageNumber(el.text)
                    ? `tpl:${templateKey(el.text)}`
                    : el.lineCount
                        ? rowKey(el, normalized)!
                        : rowKeyByText.get(normalized) ?? `txt:${normalized}`;
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

            for (const [key, bucket] of buckets) {
                if (bucket.pageIndices.size < requiredForPosition) continue;

                // Left/right repeats must clear a substance bar so common
                // body edge words (the, of, and, …) that recur in the wide
                // side-margin zone of justified multi-column layouts are not
                // mistaken for repeating side marginalia. See
                // `isSubstantialSideMarginText`.
                if (
                    (position === "left" || position === "right")
                    && !isSubstantialSideMarginText(bucket.firstNormalized)
                ) {
                    continue;
                }

                const pages = Array.from(bucket.pageIndices).sort((a, b) => a - b);

                // candidate.text stays as exact normalized text — external
                // consumers (testPdfHandlers, extractionOverlay) match
                // candidate.text against line text. Internal Map/Set keys
                // (tpl:/row:/txt:) are scoped to this function only. A
                // joined-row bucket lists every variant, so the smart filter
                // finds each one's reason (and spares heading-sized ones).
                if (key.startsWith("row:")) {
                    for (const [variant, variantPages] of bucket.variantPages) {
                        candidates.push({
                            text: variant,
                            originalText: variant === bucket.firstNormalized ? bucket.firstOriginal : variant,
                            pageIndices: Array.from(variantPages).sort((a, b) => a - b),
                            reason: "repeat",
                            position,
                        });
                    }
                } else {
                    candidates.push({
                        text: bucket.firstNormalized,
                        originalText: bucket.firstOriginal,
                        pageIndices: pages,
                        reason: "repeat",
                        position,
                    });
                }

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

            // Single-page margin links / repository identifiers are usually
            // publisher chrome, preprint side labels, or footer link-outs.
            // Unlike running heads, they often appear only once, so the
            // repeat threshold cannot catch them. Keep this anchored to
            // standalone identifiers; prose lines that merely contain a URL
            // or email remain eligible for extraction.
            const identifierBuckets = new Map<string, {
                originalText: string;
                pageIndices: Set<number>;
            }>();
            for (const el of elements) {
                const normalized = normalizeText(el.text);
                if (textsToRemove.has(normalized)) continue;
                if (!isStandaloneExternalIdentifier(el.text)) continue;

                let bucket = identifierBuckets.get(normalized);
                if (!bucket) {
                    bucket = {
                        originalText: el.text,
                        pageIndices: new Set(),
                    };
                    identifierBuckets.set(normalized, bucket);
                }
                bucket.pageIndices.add(el.pageIndex);

                textsToRemove.add(normalized);
                if (!removalsByPage.has(el.pageIndex)) {
                    removalsByPage.set(el.pageIndex, new Set());
                }
                removalsByPage.get(el.pageIndex)!.add(normalized);
            }

            for (const [text, bucket] of identifierBuckets) {
                candidates.push({
                    text,
                    originalText: bucket.originalText,
                    pageIndices: Array.from(bucket.pageIndices).sort(
                        (a, b) => a - b,
                    ),
                    reason: "identifier",
                    position,
                });
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

                    if (isAnalyzerLoggingEnabled()) {
                        pdfLog(`[MarginFilter] Detected page number sequence in ${position} zone: ${values.slice(0, 5).join(", ")}...`, 3);
                    }
                }

                // Page numbers at the end of joined rows (see
                // `rowEndNumber`). Joined rows also hold running text, whose
                // numbers (subscripts, years, table values) can increase by
                // chance, so these count only when value minus page index
                // stays the same on enough pages: they step with the pages.
                // Page numbers that stand apart on other pages (where the
                // running head sat further away) count toward the same run,
                // so changing header spacing does not split the evidence; a
                // run needs joined-row numbers on two pages. A standalone
                // number counts only on a page with few numbers in this zone:
                // pages of formulas or tables offer so many that one steps
                // with the pages by chance.
                // Numbers this zone already removes (the sequence above found
                // them) are evidence too, whatever the page around them.
                const isRemoved = (el: MarginElement) =>
                    removalsByPage.get(el.pageIndex)?.has(normalizeText(el.text)) ?? false;
                const byOffset = new Map<number, MarginElement[]>();
                if (rowEndNumbers.length > 0) {
                    const numberLike = [...rowEndNumbers, ...elements.filter(
                        el => !el.lineCount && isPageNumberPattern(el.text),
                    )];
                    const numbersOnPage = new Map<number, number>();
                    for (const el of numberLike) {
                        numbersOnPage.set(el.pageIndex, (numbersOnPage.get(el.pageIndex) ?? 0) + 1);
                    }
                    const standaloneNumbers = numberLike.filter(
                        el => !el.rowEndNumber
                            && (isRemoved(el) || numbersOnPage.get(el.pageIndex)! <= MAX_PAGE_NUMBER_CANDIDATES),
                    );
                    for (const el of [...rowEndNumbers, ...standaloneNumbers]) {
                        // Figure tick labels and exponents are set tiny.
                        if (!isRemoved(el) && !(el.line.font?.size >= MIN_PAGE_NUMBER_FONT_SIZE)) continue;
                        const value = parsePageNumber(el.text);
                        if (value === null) continue;
                        const offset = value - el.pageIndex;
                        let group = byOffset.get(offset);
                        if (!group) {
                            group = [];
                            byOffset.set(offset, group);
                        }
                        group.push(el);
                    }
                }
                for (const group of byOffset.values()) {
                    if (new Set(group.filter(el => el.rowEndNumber).map(el => el.pageIndex)).size < 2) continue;
                    if (new Set(group.map(el => el.pageIndex)).size < Math.max(2, requiredForPosition)) continue;
                    for (const el of group) {
                        if (isRemoved(el)) continue;
                        const normalized = normalizeText(el.text);
                        candidates.push({
                            text: normalized,
                            originalText: el.text,
                            pageIndices: [el.pageIndex],
                            reason: "page_number",
                            position,
                        });
                        textsToRemove.add(normalized);
                        if (!removalsByPage.has(el.pageIndex)) {
                            removalsByPage.set(el.pageIndex, new Set());
                        }
                        removalsByPage.get(el.pageIndex)!.add(normalized);
                    }
                }
            }
        }

        return { candidates, textsToRemove, removalsByPage };
    }

    /**
     * Filter a page using smart removal results.
     * Removes lines that match identified repeating/page-number elements.
     *
     * `bodyStyles` (optional) spares the simple-margin drop for lines whose
     * font matches a document body style, so tight-margin layouts
     * keep body text packed near the page edge.
     *
     * `primaryBodyStyle` (optional) spares the smart-removal drop for
     * heading-sized lines (font size > primary body size × 1.2). Running
     * headers are body-sized or smaller by convention, so a candidate-text
     * match on a heading-sized line is almost always the document's actual
     * title or section heading sharing text with a small-font running
     * header elsewhere — keep it.
     *
     * `textRows` must match the setting the removal result was computed
     * with (see `collectMarginElements`).
     */
    static filterPageWithSmartRemoval(
        page: RawPageData,
        margins: MarginSettings,
        marginZone: MarginSettings,
        removalResult: MarginRemovalResult,
        bodyStyles?: TextStyle[],
        primaryBodyStyle?: TextStyle,
        textRows: boolean = true
    ): RawPageData {
        const pageRemovals = removalResult.removalsByPage.get(page.pageIndex);
        // Per-text reason lookup so the heading-spare can apply only to
        // `repeat` removals — page-number sequences and identifier matches
        // are structural classifications that must NOT be overridden by
        // font size (a large page-number stamp is still a page number).
        const reasonByText = new Map<string, RemovalCandidate["reason"]>();
        for (const c of removalResult.candidates) {
            if (!reasonByText.has(c.text)) reasonByText.set(c.text, c.reason);
        }

        // Smart removal matches text rows, as the analysis collected them
        // (see `collectTextRows`), and removes or keeps a row's lines
        // together. A heading-sized row whose text matches a `repeat`
        // candidate is spared: a line whose font already meets the heading-
        // size threshold cannot be a running header/footer on this page
        // regardless of textual identity with a small-font running header
        // elsewhere. This protects article titles and section headings whose
        // text happens to recur as a running header on subsequent pages. The
        // spare is gated to `repeat` reasons so page-number sequences and
        // identifier matches (URLs, DOIs in margins) remain force-removed.
        //
        // The analysis pass reports slightly different line boxes, so it may
        // have read a row's lines as rows of their own; such lines still
        // match on their own text. A running head can also share its row with
        // other text set right beside it, such as a figure label or a photo
        // credit: a row's leading or trailing run of lines matching a repeat
        // or identifier candidate in the same zone is removed, by exact text
        // for one line and digits aside for a substantial run of several
        // that carries text (see `rowTemplateKey`).
        const removedLines = new Set<RawLine>();
        const inZone = (bbox: BoundingBox) =>
            getMarginPosition(bbox, page.width, page.height, marginZone) !== null;
        // A joined row is judged as a heading by its whole text, set in
        // heading-sized type throughout.
        const remove = (lines: RawLine[], reason: RemovalCandidate["reason"] | undefined) => {
            const text = lines.length > 1 ? joinRowText(lines) : null;
            if (
                reason === "repeat"
                && lines.every(line =>
                    StyleAnalyzer.isHeadingLine(text === null ? line : { ...line, text }, primaryBodyStyle),
                )
            ) {
                return;
            }
            for (const line of lines) removedLines.add(line);
        };
        const endTexts = new Set<string>();
        const endKeys = new Set<string>();
        for (const c of removalResult.candidates) {
            if (c.reason === "page_number") continue;
            endTexts.add(`${c.position}|${c.text}`);
            if (isSubstantialSideMarginText(c.text)) endKeys.add(`${c.position}|${rowTemplateKey(c.text)}`);
        }
        const removeEndRun = (lines: RawLine[]): boolean => {
            const position = getMarginPosition(unionBBox(lines), page.width, page.height, marginZone);
            if (!position) return false;
            const matches = lines.length === 1
                ? endTexts.has(`${position}|${normalizeText(lines[0].text)}`)
                : endKeys.has(`${position}|${rowTemplateKey(joinRowText(lines))}`);
            if (!matches) return false;
            remove(lines, "repeat");
            return true;
        };
        if ((pageRemovals && pageRemovals.size > 0) || endTexts.size > 0) {
            for (const row of collectTextRows(page, textRows)) {
                const normalized = normalizeText(row.text);
                if (pageRemovals?.has(normalized) && inZone(row.bbox)) {
                    remove(row.lines, reasonByText.get(normalized));
                    continue;
                }
                const n = row.lines.length;
                if (n === 1) continue;
                for (const [k, line] of row.lines.entries()) {
                    const text = normalizeText(line.text);
                    if (!pageRemovals?.has(text) || !inZone(line.bbox)) continue;
                    // A page number only ever opens or closes a row; the
                    // same digits inside running text stay.
                    const reason = reasonByText.get(text);
                    if (reason === "page_number" && k !== 0 && k !== n - 1) continue;
                    remove([line], reason);
                }
                let headEnd = 0;
                for (let k = n - 1; k >= 1; k--) {
                    if (removeEndRun(row.lines.slice(0, k))) {
                        headEnd = k;
                        break;
                    }
                }
                for (let k = Math.max(1, headEnd); k < n; k++) {
                    if (removeEndRun(row.lines.slice(k))) break;
                }
            }
        }

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

                return !removedLines.has(line);
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
     * Log removal candidates when {@link ExtractionSettings.analyzerLogging} is enabled.
     */
    static logRemovalCandidates(result: MarginRemovalResult): void {
        if (!isAnalyzerLoggingEnabled()) return;

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
