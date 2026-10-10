/**
 * Features of the item-boundary model (feature set `boundaries`).
 *
 * One row per line j of a page's flow, describing j and the line i before it:
 * the line above in its block (pair type `inner`), the previous block's last
 * line for a block's first line (`block`), or none for the page's first line
 * (`page`). Rows are computed from the blocks' lines with page and document
 * context only (`BoundaryPage`), never from the items the paragraph detector
 * made of them; the heuristic group carries the detector's own per-line
 * decision.
 *
 * Lengths are in body ems (the document's body size, the page's measured one
 * when known). Gaps are measured baseline to baseline where the walk recorded
 * glyph metrics: a tall glyph merged into a line (inline math, a sub- or
 * superscript) widens its box but not its baseline. Groups:
 *
 * - `gap`: baseline pitch against the block's and the page's modal pitch, its
 *   rank among the block's pitches, the box gap and the detector's gap
 *   threshold, the gap between the glyph cores, the height a line has above
 *   and below its core.
 * - `horizontal`: indents against the block's left edge mode and modal
 *   first-line indent, line ends against the right edge mode, centering,
 *   widths, the edges' spread.
 * - `typography`: size, font, bold and italic where i ends and j starts, the
 *   lines' dominant style against the body style, `isHeaderStyle`, a short
 *   opening marker's size.
 * - `text`: how i ends and j starts (punctuation, case, digits, bullets, list
 *   numbers, the next number of a list, note markers, caption labels), dot
 *   leaders and trailing page numbers.
 * - `heuristic`: the detector's decision on j and i, the rule that decided
 *   (`START_RULES` index), the break signals and vetoes, hanging roles,
 *   isolated headings.
 * - `context`: the pairs before and after, the block's size and the line's
 *   place in it and on the page, the pair type, and for a block's first line
 *   how the two blocks sit (stacked or side by side, overlap, distance, text
 *   or regions between them).
 *
 * Missing values (no line before, no glyph metrics) are NaN. Values are
 * rounded to 4 decimals. A change to any value bumps `FEATURE_VERSION`.
 *
 * Cost: `prepareBoundaryPage` computes each block's statistics once
 * (O(lines log lines)); `boundaryRow` is O(1) per inner line. A block's first
 * line also scans the page's lines for text between the two blocks.
 */

import { clamp } from "../features/geometry";
import { featureRow } from "../features/row";
import { NUMBERED_RE } from "../features/text";
import type { BoundaryBlock, BoundaryLine, BoundaryPage } from "./input";
import { START_RULES, START_SIGNALS, START_VETOES } from "./rules";

export const FEATURE_SET = "boundaries";
export const FEATURE_VERSION = 1;

/** Pair types, by their code in the `pairType` feature. */
export const PAIR_TYPES = ["inner", "block", "page"] as const;
export type PairType = (typeof PAIR_TYPES)[number];

/** Feature names by group, in column order. */
export const FEATURE_GROUPS = {
    gap: [
        "pitch",
        "pitchVsBlock",
        "pitchVsPage",
        "pitchRatio",
        "pitchRank",
        "gap",
        "gapVsThreshold",
        "gapVsMedian",
        "coreGap",
        "extraAboveI",
        "extraBelowI",
        "extraAboveJ",
        "extraBelowJ",
        "heightI",
        "heightJ",
    ],
    horizontal: [
        "indentI",
        "indentJ",
        "indentVsModal",
        "modalIndent",
        "dx",
        "endI",
        "endIMax",
        "endJ",
        "leftMad",
        "rightMad",
        "centerI",
        "centerJ",
        "widthI",
        "widthJ",
        "measure",
    ],
    typography: [
        "sizeI",
        "sizeJ",
        "sizeDiff",
        "endSizeI",
        "startSizeJ",
        "edgeSizeDiff",
        "endBodyFontI",
        "startBodyFontJ",
        "endBoldI",
        "endItalicI",
        "startBoldJ",
        "startItalicJ",
        "boldI",
        "boldJ",
        "italicI",
        "italicJ",
        "styleChange",
        "fontChange",
        "bodyFontI",
        "bodyFontJ",
        "headerStyleI",
        "headerStyleJ",
        "leadI",
        "leadJ",
    ],
    text: [
        "endsTerminal",
        "endsColon",
        "endsHyphen",
        "endsComma",
        "openBracket",
        "startsLower",
        "startsUpper",
        "startsDigit",
        "startsBracket",
        "bullet",
        "listNumber",
        "numberNext",
        "noteMarker",
        "caption",
        "leaderI",
        "leaderJ",
        "pageNumberI",
        "pageNumberJ",
        "lenI",
        "lenJ",
    ],
    heuristic: [
        "start",
        "rule",
        "headingRule",
        "startI",
        "sigGap",
        "sigIndent",
        "sigEarlyEnd",
        "sigFontSize",
        "sigLeader",
        "sigHangingEntry",
        "vetoLeaderContinuation",
        "vetoUniformLeading",
        "vetoIndentSuppression",
        "vetoSuperscriptMarker",
        "vetoDropCap",
        "vetoSameIndentHanging",
        "vetoHangingContinuation",
        "roleI",
        "roleJ",
        "isolatedI",
        "isolatedJ",
    ],
    context: [
        "pairType",
        "prevPitchVsBlock",
        "prevGap",
        "prevDx",
        "nextPitchVsBlock",
        "nextGap",
        "nextIndent",
        "nextDx",
        "blockLines",
        "posInBlock",
        "lastInBlock",
        "blockOrder",
        "pageTop",
        "pageLeft",
        "stacked",
        "blockOverlap",
        "lineOverlap",
        "blockGap",
        "sideBySide",
        "textBetween",
        "regionBetween",
    ],
} as const;

type Feature = (typeof FEATURE_GROUPS)[keyof typeof FEATURE_GROUPS][number];

export const FEATURES: readonly Feature[] = Object.values(FEATURE_GROUPS).flat();

// ----------------------------------------------------------------------------
// Text patterns
// ----------------------------------------------------------------------------

/** Sentence end, optionally followed by a closing quote or bracket and a citation marker. */
const TERMINAL_RE = /[.!?。！？]["'”’)\]」』）]?(?:\s*\[[\d,;\s–-]+\]|[⁰¹²³⁴⁵⁶⁷⁸⁹]+)?$/u;
const COLON_END_RE = /[:：]$/u;
const HYPHEN_END_RE = /[-‐‑­]$/u;
const COMMA_END_RE = /[,;，；、]$/u;
const LOWER_START_RE = /^["'“‘(]?\p{Ll}/u;
const UPPER_START_RE = /^["'“‘(]?\p{Lu}/u;
const DIGIT_START_RE = /^\d/u;
const BRACKET_START_RE = /^[([（［]/u;
const BULLET_RE = /^[•●○◦▪▫■□‣⁃∙·◆◇►▶➤✓✔❖–—-]\s/u;
/** A footnote or note marker: a symbol, a superscript digit, or digits glued to a word. */
const NOTE_MARKER_RE = /^(?:[*†‡§¶#∗⁎⁰¹²³⁴⁵⁶⁷⁸⁹]|\d{1,3}\p{L})/u;
const CAPTION_RE = /^(?:fig(?:ure)?s?|tab(?:le)?s?|notes?|sources?|scheme|plate|exhibit|chart|panel|box|appendix)\.?\s*(?:[:.–—]|S?\d|[IVX]+\b|[A-Z]\b)/iu;
const LEADER_RE = /(?:\.\s?){4,}|…{2,}|(?:·\s?){4,}|_{4,}/u;
/** A trailing page number: Arabic or Roman, after a space, a dot leader or alone. */
const PAGE_NUMBER_RE = /(?:^|[\s.…·])(?:\d{1,4}|[ivxlc]{1,6})$/iu;
/** A numbered entry leader, as `isNextNumberedEntry` reads it: "12.", "12)", "[12]" or "(12)", then a word. */
const NUMBERED_ENTRY_RE = /^\s*([([]?)(\d{1,3})([.)\]])\s+[^\s\d]/u;

interface NumberedEntry {
    open: string;
    n: number;
    close: string;
}

function numberedEntry(text: string): NumberedEntry | null {
    const m = NUMBERED_ENTRY_RE.exec(text);
    if (!m) return null;
    // "[12]" and "(12)" close their bracket; a bare number ends in "." or ")".
    if (m[1] === "[" ? m[3] !== "]" : m[1] === "(" ? m[3] !== ")" : m[3] === "]") return null;
    return { open: m[1], n: Number(m[2]), close: m[3] };
}

function unclosedBracket(text: string): boolean {
    let depth = 0;
    for (let k = 0; k < text.length; k++) {
        const c = text.charCodeAt(k);
        if (c === 40 || c === 91) depth++;
        else if ((c === 41 || c === 93) && depth > 0) depth--;
    }
    return depth > 0;
}

// ----------------------------------------------------------------------------
// Statistics
// ----------------------------------------------------------------------------

/** Sorted ascending (a typed array sorts numerically without a comparator). */
function sortedCopy(values: readonly number[]): Float64Array {
    return Float64Array.from(values).sort();
}

function medianSorted(s: ArrayLike<number>): number {
    if (s.length === 0) return NaN;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The median of the values in the most common bin of width `bin` (NaN without values). */
function binnedMode(values: readonly number[], bin: number): number {
    if (values.length === 0) return NaN;
    const counts = new Map<number, number>();
    let best = 0;
    let key = 0;
    for (const v of values) {
        const k = Math.round(v / bin);
        const c = (counts.get(k) ?? 0) + 1;
        counts.set(k, c);
        if (c > best || (c === best && k < key)) {
            best = c;
            key = k;
        }
    }
    return medianSorted(sortedCopy(values.filter((v) => Math.round(v / bin) === key)));
}

/** Values in `sorted` below `v`, and below or equal to it. */
function bounds(sorted: ArrayLike<number>, v: number): [number, number] {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < v) lo = mid + 1;
        else hi = mid;
    }
    let hi2 = lo;
    while (hi2 < sorted.length && sorted[hi2] === v) hi2++;
    return [lo, hi2];
}

const overlap = (l1: number, r1: number, l2: number, r2: number) => Math.max(0, Math.min(r1, r2) - Math.max(l1, l2));

/** Text patterns of one line: how it ends (as line i) and how it starts (as line j). */
interface LineText {
    endsTerminal: boolean;
    endsColon: boolean;
    endsHyphen: boolean;
    endsComma: boolean;
    openBracket: boolean;
    startsLower: boolean;
    startsUpper: boolean;
    startsDigit: boolean;
    startsBracket: boolean;
    bullet: boolean;
    listNumber: boolean;
    noteMarker: boolean;
    caption: boolean;
    leader: boolean;
    pageNumber: boolean;
    len: number;
    numbered: NumberedEntry | null;
}

function lineText(raw: string): LineText {
    const text = raw.trim();
    return {
        endsTerminal: TERMINAL_RE.test(text),
        endsColon: COLON_END_RE.test(text),
        endsHyphen: HYPHEN_END_RE.test(text),
        endsComma: COMMA_END_RE.test(text),
        openBracket: unclosedBracket(text),
        startsLower: LOWER_START_RE.test(text),
        startsUpper: UPPER_START_RE.test(text),
        startsDigit: DIGIT_START_RE.test(text),
        startsBracket: BRACKET_START_RE.test(text),
        bullet: BULLET_RE.test(text),
        listNumber: NUMBERED_RE.test(text),
        noteMarker: NOTE_MARKER_RE.test(text),
        caption: CAPTION_RE.test(text),
        leader: LEADER_RE.test(text),
        pageNumber: PAGE_NUMBER_RE.test(text),
        len: Math.log1p(text.length),
        numbered: numberedEntry(raw),
    };
}

/** Per-block statistics (`prepareBoundaryPage`). */
interface BlockStats {
    /** Baseline pitch to the line before in the block, per line (NaN for the first line or without metrics). */
    pitch: number[];
    /** Box gap to the line before in the block, per line (NaN for the first line). */
    gap: number[];
    modalPitch: number;
    sortedPitches: Float64Array;
    /** Modal first-line indent against the left edge mode (NaN when no line is indented). */
    modalIndent: number;
    /** Text measure: right edge mode minus left edge mode, or the block's width. */
    measure: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
    /** Per line: the last numbered entry above it in the block. */
    lastNumbered: (NumberedEntry | null)[];
    /** Per line: its text patterns. */
    text: LineText[];
}

/** A page with its statistics, ready for `boundaryRow`. */
export interface PreparedBoundaryPage {
    page: BoundaryPage;
    em: number;
    stats: BlockStats[];
    pageModalPitch: number;
}

function blockStats(block: BoundaryBlock, em: number): BlockStats {
    const lines = block.lines;
    const t = block.thresholds;
    const pitch: number[] = new Array(lines.length);
    const gap: number[] = new Array(lines.length);
    const pitches: number[] = [];
    const indents: number[] = [];
    const lastNumbered: (NumberedEntry | null)[] = new Array(lines.length);
    const text: LineText[] = new Array(lines.length);
    let numbered: NumberedEntry | null = null;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (let k = 0; k < lines.length; k++) {
        const line = lines[k];
        left = Math.min(left, line.l);
        right = Math.max(right, line.r);
        top = Math.min(top, line.t);
        bottom = Math.max(bottom, line.b);
        text[k] = lineText(line.text);
        lastNumbered[k] = numbered;
        numbered = text[k].numbered ?? numbered;
        const indent = line.l - t.leftEdgeMode;
        if (indent > Math.max(0.5 * em, 0.5 * t.indentExcessThreshold)) indents.push(indent);
        if (k === 0) {
            pitch[k] = NaN;
            gap[k] = NaN;
            continue;
        }
        const prev = lines[k - 1];
        gap[k] = line.t - prev.b;
        pitch[k] = line.baseline !== null && prev.baseline !== null ? line.baseline - prev.baseline : NaN;
        if (pitch[k] > 0) pitches.push(pitch[k]);
    }
    const measure = t.rightEdgeMode - t.leftEdgeMode > 0 ? t.rightEdgeMode - t.leftEdgeMode : Math.max(1, right - left);
    return {
        pitch,
        gap,
        modalPitch: binnedMode(pitches, 0.1 * em),
        sortedPitches: sortedCopy(pitches),
        modalIndent: binnedMode(indents, 0.25 * em),
        measure,
        left,
        right,
        top,
        bottom,
        lastNumbered,
        text,
    };
}

/** Per-block statistics of a page, computed once before its rows. */
export function prepareBoundaryPage(page: BoundaryPage): PreparedBoundaryPage {
    const bodySize = page.body?.size ?? 0;
    const em = Math.max(4, bodySize > 0 ? bodySize : page.medianHeight > 0 ? 0.8 * page.medianHeight : 10);
    const stats = page.blocks.map((block) => blockStats(block, em));
    const all: number[] = [];
    for (const s of stats) for (const p of s.pitch) if (p > 0) all.push(p);
    return { page, em, stats, pageModalPitch: binnedMode(all, 0.1 * em) };
}

// ----------------------------------------------------------------------------
// Rows
// ----------------------------------------------------------------------------

/** To 4 decimals; -0 becomes 0, as JSON writes it. */
const round = (v: number) => (Number.isNaN(v) ? NaN : Math.round(v * 1e4) / 1e4 || 0);
const bit = (flag: boolean) => (flag ? 1 : 0);
/** A length in em, clamped to ±`limit`. */
const ems = (px: number, em: number, limit = 50) => clamp(px / em, -limit, limit);

/** Pitch above line `k` of a block against the block's modal pitch, in em (NaN outside the block). */
function pitchVsModal(st: BlockStats, k: number, em: number): number {
    return k >= 1 && k < st.pitch.length ? ems(st.pitch[k] - st.modalPitch, em) : NaN;
}

const HEADING_RULES: ReadonlySet<string> = new Set([
    "heading_after_body",
    "heading_style_change",
    "heading_stacked",
    "heading_opening_style",
    "heading_ends_before_body",
]);

/**
 * The feature row of line `j` of block `b` (`FEATURES` columns): the line and
 * the line before it in the page's flow.
 */
export function boundaryRow(prep: PreparedBoundaryPage, b: number, j: number): number[] {
    const { page, em, stats } = prep;
    const block = page.blocks[b];
    const st = stats[b];
    const t = block.thresholds;
    const lines = block.lines;
    const line = lines[j];
    // The line before in the flow: above in the block, or the previous block's last.
    const ib = j > 0 ? b : b - 1;
    const iBlock = ib >= 0 ? page.blocks[ib] : null;
    const prev: BoundaryLine | null = j > 0 ? lines[j - 1] : iBlock ? iBlock.lines[iBlock.lines.length - 1] : null;
    const ist = ib >= 0 ? stats[ib] : null;
    const it = iBlock?.thresholds ?? null;
    const pairType = j > 0 ? 0 : b > 0 ? 1 : 2;
    const next = j + 1 < lines.length ? lines[j + 1] : null;

    const pitchPx = j > 0 ? st.pitch[j] : prev && line.baseline !== null && prev.baseline !== null ? line.baseline - prev.baseline : NaN;
    const gapPx = prev ? line.t - prev.b : NaN;
    let pitchRank = NaN;
    if (j > 0 && st.pitch[j] > 0 && st.sortedPitches.length > 0) {
        const [lo, hi] = bounds(st.sortedPitches, st.pitch[j]);
        pitchRank = st.sortedPitches.length > 1 ? (lo + hi - 1) / 2 / (st.sortedPitches.length - 1) : 0.5;
    }

    const ti = prev && ist ? ist.text[j > 0 ? j - 1 : iBlock!.lines.length - 1] : null;
    const tj = st.text[j];
    const numberJ = tj.numbered;
    const before = st.lastNumbered[j];
    const center = (t.leftEdgeMode + t.rightEdgeMode) / 2;
    // Where i ends and j starts.
    const end = prev?.last ?? null;
    const opening = line.first;
    const body = page.body;
    const signals = line.signals;
    const vetoes = line.vetoes;

    // A block's first line: how the two blocks sit.
    let stacked = NaN;
    let blockOverlap = NaN;
    let blockGap = NaN;
    let sideBySide = NaN;
    let textBetween = NaN;
    let regionBetween = NaN;
    if (pairType === 1 && prev && ist) {
        const minWidth = Math.max(1, Math.min(st.right - st.left, ist.right - ist.left));
        blockOverlap = clamp(overlap(st.left, st.right, ist.left, ist.right) / minWidth, 0, 1);
        blockGap = ems(st.top - ist.bottom, em);
        stacked = bit(blockOverlap >= 0.5 && st.top >= ist.bottom - 0.5 * em);
        sideBySide = bit(line.t < prev.t);
        // Text of other blocks and regions in the band between the two lines.
        const l = Math.min(prev.l, line.l);
        const r = Math.max(prev.r, line.r);
        let text = 0;
        let regions = 0;
        if (line.t > prev.b) {
            page.blocks.forEach((other, k) => {
                if (k === b || k === ib) return;
                for (const o of other.lines) {
                    const cy = (o.t + o.b) / 2;
                    if (cy > prev.b && cy < line.t && overlap(o.l, o.r, l, r) > 0) text++;
                }
            });
            for (const [rl, rt, rr, rb] of page.regions) {
                if (overlap(rt, rb, prev.b, line.t) > 0 && overlap(rl, rr, l, r) > 0) regions++;
            }
        }
        textBetween = Math.min(text, 10);
        regionBetween = Math.min(regions, 5);
    }

    const f: Record<Feature, number> = {
        // Gap
        pitch: ems(pitchPx, em),
        pitchVsBlock: ems(pitchPx - st.modalPitch, em),
        pitchVsPage: ems(pitchPx - prep.pageModalPitch, em),
        pitchRatio: st.modalPitch > 0 ? clamp(pitchPx / st.modalPitch, -10, 10) : NaN,
        pitchRank,
        gap: ems(gapPx, em),
        gapVsThreshold: ems(gapPx - t.gapExcessThreshold, em),
        gapVsMedian: ems(gapPx - t.medianGap, em),
        coreGap: prev && line.coreTop !== null && prev.coreBottom !== null ? ems(line.coreTop - prev.coreBottom, em) : NaN,
        extraAboveI: prev && prev.coreTop !== null ? ems(prev.coreTop - prev.t, em, 10) : NaN,
        extraBelowI: prev && prev.coreBottom !== null ? ems(prev.b - prev.coreBottom, em, 10) : NaN,
        extraAboveJ: line.coreTop !== null ? ems(line.coreTop - line.t, em, 10) : NaN,
        extraBelowJ: line.coreBottom !== null ? ems(line.b - line.coreBottom, em, 10) : NaN,
        heightI: prev ? ems(prev.b - prev.t, em) : NaN,
        heightJ: ems(line.b - line.t, em),
        // Horizontal
        indentI: prev && it ? ems(prev.l - it.leftEdgeMode, em) : NaN,
        indentJ: ems(line.l - t.leftEdgeMode, em),
        indentVsModal: ems(line.l - t.leftEdgeMode - st.modalIndent, em),
        modalIndent: ems(st.modalIndent, em),
        dx: prev ? ems(line.l - prev.l, em) : NaN,
        endI: prev && it ? ems(it.rightEdgeMode - prev.r, em) : NaN,
        endIMax: prev && it ? ems(it.maxRightEdge - prev.r, em) : NaN,
        endJ: ems(t.rightEdgeMode - line.r, em),
        leftMad: ems(t.leftEdgeMad, em),
        rightMad: ems(t.rightEdgeMad, em),
        centerI: prev && it ? ems(Math.abs((prev.l + prev.r) / 2 - (it.leftEdgeMode + it.rightEdgeMode) / 2), em) : NaN,
        centerJ: ems(Math.abs((line.l + line.r) / 2 - center), em),
        widthI: prev && ist ? clamp((prev.r - prev.l) / ist.measure, 0, 5) : NaN,
        widthJ: clamp((line.r - line.l) / st.measure, 0, 5),
        measure: page.width > 0 ? clamp(st.measure / page.width, 0, 2) : NaN,
        // Typography
        sizeI: prev ? ems(prev.size, em, 10) : NaN,
        sizeJ: ems(line.size, em, 10),
        sizeDiff: prev ? ems(line.size - prev.size, em, 10) : NaN,
        endSizeI: end ? ems(end.size, em, 10) : NaN,
        startSizeJ: opening ? ems(opening.size, em, 10) : NaN,
        edgeSizeDiff: end && opening ? ems(opening.size - end.size, em, 10) : NaN,
        endBodyFontI: end && body ? bit(end.font === body.font) : NaN,
        startBodyFontJ: opening && body ? bit(opening.font === body.font) : NaN,
        endBoldI: end ? bit(end.bold) : NaN,
        endItalicI: end ? bit(end.italic) : NaN,
        startBoldJ: opening ? bit(opening.bold) : NaN,
        startItalicJ: opening ? bit(opening.italic) : NaN,
        boldI: prev ? prev.bold : NaN,
        boldJ: line.bold,
        italicI: prev ? prev.italic : NaN,
        italicJ: line.italic,
        styleChange: end && opening
            ? bit(
                end.font !== opening.font ||
                    Math.abs(end.size - opening.size) >= 0.5 ||
                    end.bold !== opening.bold ||
                    end.italic !== opening.italic,
            )
            : NaN,
        fontChange: prev ? bit(prev.font !== line.font) : NaN,
        bodyFontI: prev && body ? bit(prev.font === body.font) : NaN,
        bodyFontJ: body ? bit(line.font === body.font) : NaN,
        headerStyleI: prev ? bit(prev.headerStyle) : NaN,
        headerStyleJ: bit(line.headerStyle),
        leadI: prev && prev.lead !== null && prev.size > 0 ? clamp(prev.lead / prev.size, 0, 5) : NaN,
        leadJ: line.lead !== null && line.size > 0 ? clamp(line.lead / line.size, 0, 5) : NaN,
        // Text
        endsTerminal: ti ? bit(ti.endsTerminal) : NaN,
        endsColon: ti ? bit(ti.endsColon) : NaN,
        endsHyphen: ti ? bit(ti.endsHyphen) : NaN,
        endsComma: ti ? bit(ti.endsComma) : NaN,
        openBracket: ti ? bit(ti.openBracket) : NaN,
        startsLower: bit(tj.startsLower),
        startsUpper: bit(tj.startsUpper),
        startsDigit: bit(tj.startsDigit),
        startsBracket: bit(tj.startsBracket),
        bullet: bit(tj.bullet),
        listNumber: bit(tj.listNumber),
        numberNext: bit(
            numberJ !== null &&
                before !== null &&
                numberJ.open === before.open &&
                numberJ.close === before.close &&
                numberJ.n === before.n + 1,
        ),
        noteMarker: bit(tj.noteMarker),
        caption: bit(tj.caption),
        leaderI: ti ? bit(ti.leader) : NaN,
        leaderJ: bit(tj.leader),
        pageNumberI: ti ? bit(ti.pageNumber) : NaN,
        pageNumberJ: bit(tj.pageNumber),
        lenI: ti ? ti.len : NaN,
        lenJ: tj.len,
        // Heuristic
        start: bit(line.start),
        rule: START_RULES.indexOf(line.rule),
        headingRule: bit(HEADING_RULES.has(line.rule)),
        startI: prev ? bit(prev.start) : NaN,
        sigGap: bit((signals & START_SIGNALS.gap) !== 0),
        sigIndent: bit((signals & START_SIGNALS.indent) !== 0),
        sigEarlyEnd: bit((signals & START_SIGNALS.early_end) !== 0),
        sigFontSize: bit((signals & START_SIGNALS.font_size) !== 0),
        sigLeader: bit((signals & START_SIGNALS.leader_after_continuation) !== 0),
        sigHangingEntry: bit((signals & START_SIGNALS.hanging_entry) !== 0),
        vetoLeaderContinuation: bit((vetoes & START_VETOES.leader_continuation) !== 0),
        vetoUniformLeading: bit((vetoes & START_VETOES.uniform_leading) !== 0),
        vetoIndentSuppression: bit((vetoes & START_VETOES.indent_suppression) !== 0),
        vetoSuperscriptMarker: bit((vetoes & START_VETOES.superscript_marker) !== 0),
        vetoDropCap: bit((vetoes & START_VETOES.drop_cap) !== 0),
        vetoSameIndentHanging: bit((vetoes & START_VETOES.same_indent_hanging) !== 0),
        vetoHangingContinuation: bit((vetoes & START_VETOES.hanging_continuation) !== 0),
        roleI: prev ? prev.role : NaN,
        roleJ: line.role,
        isolatedI: prev ? bit(prev.isolatedHeading) : NaN,
        isolatedJ: bit(line.isolatedHeading),
        // Context
        pairType,
        prevPitchVsBlock: j >= 2 ? pitchVsModal(st, j - 1, em) : NaN,
        prevGap: j >= 2 ? ems(st.gap[j - 1], em) : NaN,
        prevDx: j >= 2 ? ems(lines[j - 1].l - lines[j - 2].l, em) : NaN,
        nextPitchVsBlock: next ? pitchVsModal(st, j + 1, em) : NaN,
        nextGap: next ? ems(st.gap[j + 1], em) : NaN,
        nextIndent: next ? ems(next.l - t.leftEdgeMode, em) : NaN,
        nextDx: next ? ems(next.l - line.l, em) : NaN,
        blockLines: Math.log1p(lines.length),
        posInBlock: lines.length > 1 ? j / (lines.length - 1) : 0,
        lastInBlock: bit(j === lines.length - 1),
        blockOrder: page.blocks.length > 1 ? b / (page.blocks.length - 1) : 0,
        pageTop: page.height > 0 ? clamp(line.t / page.height, 0, 1) : NaN,
        pageLeft: page.width > 0 ? clamp(line.l / page.width, 0, 1) : NaN,
        stacked,
        blockOverlap,
        lineOverlap: prev ? clamp(overlap(prev.l, prev.r, line.l, line.r) / Math.max(1, Math.min(prev.r - prev.l, line.r - line.l)), 0, 1) : NaN,
        blockGap,
        sideBySide,
        textBetween,
        regionBetween,
    };
    const row = featureRow(f, FEATURES);
    for (let k = 0; k < row.length; k++) row[k] = round(row[k]);
    return row;
}

/** Feature rows of every line of a page, per block in reading order (`FEATURES` columns). */
export function boundaryFeatures(page: BoundaryPage): number[][][] {
    const prep = prepareBoundaryPage(page);
    return page.blocks.map((block, b) => block.lines.map((_, j) => boundaryRow(prep, b, j)));
}

/** Pair type of line `j` of block `b`. */
export function pairType(b: number, j: number): PairType {
    return j > 0 ? "inner" : b > 0 ? "block" : "page";
}
