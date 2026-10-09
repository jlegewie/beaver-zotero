/**
 * Features of the item-type model (feature set `item-type`).
 *
 * One row per text item of a document, computed with the whole document in
 * view (`TypedDocument`, see `input.ts`). Groups:
 *
 * - `text`: patterns of the item's text the reference features don't cover.
 * - `typography`: size, weight and font against the document's body style,
 *   how rare the item's style is in the document, and whether it is the
 *   document's most common small (footnote-sized) style.
 * - `geometry`: position on the page and in its column, gaps to the items
 *   above and below, text below it on the page.
 * - `pipeline`: signals of earlier steps — the paragraph detector's heading
 *   heuristic, the region detector's caption-line test, nearness to region
 *   items and repetition in the margin zones of other pages.
 * - `context`: page position in the document, headings so far, a reference
 *   or notes heading earlier, the item's place on its page, its text on
 *   other pages.
 *
 * Repetition across pages is given as a share of the other pages, so a
 * running header reads the same in a 4-page and a 300-page document, next to
 * a capped count and the window's size:
 *
 * - `marginRepeat`: share of the other pages of the margin window
 *   (`TypedDocument.marginWindow`) whose margin zones hold the item's text,
 *   or its first line's, digits and case ignored. The window is the
 *   cross-page analysis window. Structured extraction always reads every
 *   page of the document, in the plugin and in `items export` alike, so it
 *   is the whole document. `marginRepeatCount`: the same pages, at most 10,
 *   scaled by 1/10. `windowPages`: the window's size, `log1p(n) / 6`, at
 *   most 1.
 * - `textRepeat`: share of the document's other pages with an item of the
 *   same text (items up to 120 characters); `textRepeatCount` likewise.
 * - `reference`: the reference item features (`referenceFeatures.ts`, `refXxx`).
 *
 * Missing values (no lines, no column, no region above) are NaN. Values are
 * rounded to 4 decimals. A change to any value bumps `FEATURE_VERSION`; the
 * training repo reads the version from `items export`.
 */

import { listContext, pagePosition } from "../features/context";
import { clamp, median } from "../features/geometry";
import { featureRow } from "../features/row";
import { ITEM_FEATURES as REFERENCE_ITEM_FEATURES, itemFeatures as referenceItemFeatures } from "./referenceFeatures";
import { NOTE_CAPTION_RE, isFigureCaption, isTableCaption } from "../regions/pageSignals";
import { isWhitespace, scanWindow, visibleChars } from "../features/text";
import type { TypedDocument, TypedItem, TypedLine, TypedPage } from "./input";
import { repeatKey } from "./input";

export const FEATURE_SET = "item-type";
export const FEATURE_VERSION = 2;

const REFERENCE_FEATURES = REFERENCE_ITEM_FEATURES.map(
    (name) => `ref${name[0].toUpperCase()}${name.slice(1)}`,
) as readonly string[];

/** Feature names by group, in column order. */
export const FEATURE_GROUPS = {
    text: [
        "words",
        "avgWordLen",
        "letterShare",
        "upperShare",
        "bullet",
        "symbolLead",
        "sectionNumber",
        "endsColon",
        "noFinalPunct",
        "email",
        "frontMatterCue",
        "pageNumberLike",
    ],
    typography: [
        "sizeRatio",
        "sizeSpread",
        "lineHeight",
        "boldShare",
        "italicShare",
        "boldVsBody",
        "italicVsBody",
        "bodyFont",
        "bodyStyle",
        "styleRarity",
        "smallStyle",
    ],
    geometry: [
        "left",
        "right",
        "bottom",
        "height",
        "centerOffset",
        "columns",
        "colWidth",
        "colIndent",
        "colCentered",
        "gapAbove",
        "gapBelow",
        "textBelow",
        "itemsBelow",
    ],
    pipeline: [
        "headingHeuristic",
        "captionLine",
        "regionOverlap",
        "regionGapAbove",
        "regionGapBelow",
        "regions",
        "marginRepeat",
        "marginRepeatCount",
        "windowPages",
    ],
    context: [
        "docPos",
        "fromEnd",
        "firstPage",
        "headingsBefore",
        "refHeadingBefore",
        "refHeadingOnPage",
        "sinceRefHeading",
        "notesHeadingBefore",
        "pageItemPos",
        "pageItems",
        "textRepeat",
        "textRepeatCount",
    ],
    reference: REFERENCE_FEATURES,
} as const;

export type FeatureGroup = keyof typeof FEATURE_GROUPS;

/** Every feature name, in column order. */
export const FEATURES: readonly string[] = Object.values(FEATURE_GROUPS).flat();

const OWN_GROUPS = ["text", "typography", "geometry", "pipeline", "context"] as const;
type OwnFeature = (typeof FEATURE_GROUPS)[(typeof OWN_GROUPS)[number]][number];
const OWN_FEATURES: readonly OwnFeature[] = OWN_GROUPS.flatMap((group) => FEATURE_GROUPS[group]);

// ---------------------------------------------------------------------------
// Text patterns
// ---------------------------------------------------------------------------

const BULLET_RE = /^\s*[•◦▪▫●○■□►▸‣⁃∙·–—-]\s/u;
const SYMBOL_LEAD_RE = /^\s*[*†‡§¶#]/u;
/** A numbered section title: "3.2 Methods", "IV. RESULTS", "A. Data". */
const SECTION_NUMBER_RE = /^\s*(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVXLC]{1,6}\.|[A-Z]\.)\s+\p{Lu}/u;
const FINAL_PUNCT_RE = /[.!?:;,)\]"”’]\s*$/u;
const EMAIL_RE = /\S@\S+\.\p{L}/u;
/** Front-matter and page-bottom metadata: dates, correspondence, licenses, identifiers. */
const FRONT_MATTER_RE =
    /^\s*(?:©|\(c\)|copyright\b|(?:manuscript\s+)?(?:received|accepted|revised|published|submitted)\b|available\s+online\b|correspond(?:ence|ing)\b|e-?mail\b|keywords?\b|key\s+words\b|jel\b|doi\b|https?:\/\/doi|issn\b|isbn\b|licen[cs]ed?\b|this\s+(?:article|work)\s+is\b|to\s+cite\b|citation\s*:|article\s+history\b|funding\b|acknowledg)/iu;
const PAGE_NUMBER_RE = /^\s*(?:page\s+|p\.\s*)?(?:\d{1,4}|[ivxlc]{1,7})\s*$/iu;
const ENDS_COLON_RE = /:\s*$/u;
const LETTER_RE = /\p{L}/u;
const UPPER_RE = /\p{Lu}/u;

/** Whitespace-separated words, visible characters, letters and uppercase letters of a text. */
function letterCounts(text: string): { words: number; visible: number; letters: number; upper: number } {
    let words = 0;
    let visible = 0;
    let letters = 0;
    let upper = 0;
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (isWhitespace(code)) {
            inWord = false;
            continue;
        }
        if (!inWord) words++;
        inWord = true;
        visible++;
        if (code < 128) {
            if (code >= 65 && code <= 90) {
                letters++;
                upper++;
            } else if (code >= 97 && code <= 122) {
                letters++;
            }
        } else if (LETTER_RE.test(text[i])) {
            letters++;
            if (UPPER_RE.test(text[i])) upper++;
        }
    }
    return { words, visible, letters, upper };
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

function styleKey(font: string, size: number, bold: boolean, italic: boolean): string {
    return `${font}|${Math.round(size * 2) / 2}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
}

function lineStyle(line: TypedLine): string {
    return styleKey(line.font, line.size, line.bold >= 0.5, line.italic >= 0.5);
}

/** Visible characters and style key of each of an item's lines. */
interface LineStats {
    chars: number[];
    styles: string[];
}

/** Line statistics of every item, per page; computed once per document. */
function lineStats(doc: TypedDocument): LineStats[][] {
    return doc.pages.map((page) =>
        page.items.map((item) => ({
            chars: item.lines.map((line) => visibleChars(line.text)),
            styles: item.lines.map(lineStyle),
        })),
    );
}

/** The key with the largest total weight, the first seen on ties, or null without keys. */
function majority(keys: readonly string[], weights: readonly number[]): string | null {
    const seen: string[] = [];
    const sums: number[] = [];
    for (let k = 0; k < keys.length; k++) {
        const at = seen.indexOf(keys[k]);
        if (at < 0) {
            seen.push(keys[k]);
            sums.push(weights[k]);
        } else {
            sums[at] += weights[k];
        }
    }
    let best: string | null = null;
    let most = -1;
    for (let j = 0; j < seen.length; j++) {
        if (sums[j] > most) {
            most = sums[j];
            best = seen[j];
        }
    }
    return best;
}

/** Document-wide style statistics. */
interface DocStyles {
    /** Glyphs per style key. */
    chars: Map<string, number>;
    total: number;
    /** Most common style smaller than the body (footnote-sized), or null. */
    small: string | null;
}

function docStyles(doc: TypedDocument, stats: LineStats[][]): DocStyles {
    const chars = new Map<string, number>();
    const sizeOf = new Map<string, number>();
    let total = 0;
    doc.pages.forEach((page, p) => {
        page.items.forEach((item, i) => {
            const { chars: lineChars, styles } = stats[p][i];
            item.lines.forEach((line, k) => {
                const key = styles[k];
                const n = lineChars[k];
                chars.set(key, (chars.get(key) ?? 0) + n);
                sizeOf.set(key, line.size);
                total += n;
            });
        });
    });
    let small: string | null = null;
    let most = 0;
    if (doc.body.size > 0) {
        for (const [key, n] of chars) {
            const size = sizeOf.get(key)!;
            if (size > 0 && size < 0.92 * doc.body.size && n > most) {
                most = n;
                small = key;
            }
        }
    }
    return { chars, total, small };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

interface ItemBox {
    l: number;
    t: number;
    r: number;
    b: number;
}

function itemBox(item: TypedItem): ItemBox | null {
    if (item.lines.length === 0) return null;
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const line of item.lines) {
        l = Math.min(l, line.l);
        t = Math.min(t, line.t);
        r = Math.max(r, line.r);
        b = Math.max(b, line.b);
    }
    return { l, t, r, b };
}


/**
 * Gaps in em to the nearest item above and below in the same column that
 * overlaps the item horizontally (NaN when there is none).
 */
function columnGaps(page: TypedPage, boxes: readonly (ItemBox | null)[], em: number): { above: number; below: number }[] {
    const byColumn = new Map<number, number[]>();
    page.items.forEach((item, i) => {
        if (!boxes[i]) return;
        const members = byColumn.get(item.column) ?? [];
        members.push(i);
        byColumn.set(item.column, members);
    });
    return page.items.map((item, i) => {
        const self = boxes[i];
        let above = NaN;
        let below = NaN;
        if (!self) return { above, below };
        const mid = (self.t + self.b) / 2;
        for (const j of byColumn.get(item.column)!) {
            const box = boxes[j]!;
            if (j === i || Math.min(self.r, box.r) - Math.max(self.l, box.l) <= 0) continue;
            if ((box.t + box.b) / 2 < mid) {
                const gap = (self.t - box.b) / em;
                if (Number.isNaN(above) || gap < above) above = gap;
            } else {
                const gap = (box.t - self.b) / em;
                if (Number.isNaN(below) || gap < below) below = gap;
            }
        }
        return { above, below };
    });
}

/** Items of the page whose top is at or below each item's bottom. */
function itemsBelow(boxes: readonly (ItemBox | null)[]): number[] {
    const tops = boxes.filter((b): b is ItemBox => b !== null).map((b) => b.t).sort((a, b) => a - b);
    return boxes.map((self) => {
        if (!self) return NaN;
        // First top at or below the item's bottom.
        let lo = 0;
        let hi = tops.length;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (tops[m] < self.b) lo = m + 1;
            else hi = m;
        }
        return tops.length - lo;
    });
}

/** Gaps in em to the nearest region above and below that overlaps the item horizontally. */
function regionGaps(self: ItemBox, page: TypedPage, em: number): { above: number; below: number; overlap: number } {
    let above = NaN;
    let below = NaN;
    let covered = 0;
    const area = Math.max(1e-6, (self.r - self.l) * (self.b - self.t));
    for (const { bbox } of page.regions) {
        const [l, t, r, b] = bbox;
        const w = Math.min(self.r, r) - Math.max(self.l, l);
        const h = Math.min(self.b, b) - Math.max(self.t, t);
        if (w > 0 && h > 0) covered += w * h;
        if (w <= 0) continue;
        if (b <= (self.t + self.b) / 2) {
            const gap = Math.max(0, self.t - b) / em;
            if (Number.isNaN(above) || gap < above) above = gap;
        } else if (t >= (self.t + self.b) / 2) {
            const gap = Math.max(0, t - self.b) / em;
            if (Number.isNaN(below) || gap < below) below = gap;
        }
    }
    return { above, below, overlap: Math.min(1, covered / area) };
}

/** Longer items are not compared across pages (`textRepeat`). */
const REPEAT_MAX_CHARS = 120;

const round = (v: number) => (Number.isNaN(v) ? NaN : Math.round(v * 1e4) / 1e4);

/**
 * Feature rows of every item of a document, per page in reading order
 * (`FEATURES` columns).
 */
export function itemTypeFeatures(doc: TypedDocument): number[][][] {
    const stats = lineStats(doc);
    const styles = docStyles(doc, stats);
    const lists = listContext(doc.pages);
    const marginWindow = new Set(doc.marginWindow);
    const bodyKey = doc.body.size > 0 ? styleKey(doc.body.font, doc.body.size, doc.body.bold, doc.body.italic) : null;

    // Pages each short item text occurs on, for repetition across pages, and
    // each item's key (null for a longer text).
    const textPages = new Map<string, Set<number>>();
    const textKeys = doc.pages.map((page) =>
        page.items.map((item) => {
            if (item.text.length > REPEAT_MAX_CHARS) return null;
            const key = repeatKey(item.text);
            if (key) {
                const set = textPages.get(key) ?? new Set<number>();
                set.add(page.pageIndex);
                textPages.set(key, set);
            }
            return key;
        }),
    );

    return doc.pages.map((page, p) => {
        const em = page.bodySize > 0 ? page.bodySize : 10;
        const { docPos, fromEnd } = pagePosition(page.pageIndex, doc.pageCount);
        const boxes = page.items.map(itemBox);
        // Other pages of the margin window.
        const marginOthers = marginWindow.size - (marginWindow.has(page.pageIndex) ? 1 : 0);
        const gaps = columnGaps(page, boxes, em);
        const below = itemsBelow(boxes);
        const textBottom = Math.max(...boxes.map((b) => (b ? b.b : -Infinity)));
        return page.items.map((item, i) => {
            const self = boxes[i];
            const text = item.text.trim();
            const window = scanWindow(text);
            const letters = letterCounts(window);
            const words = letters.words;
            const sizes = item.lines.map((line) => line.size).filter((s) => s > 0);
            const size = median(sizes);
            const { chars, styles: lineStyles } = stats[p][i];
            const totalChars = chars.reduce((a, b) => a + b, 0);
            const share = (pick: (line: TypedLine) => number) =>
                totalChars > 0 ? item.lines.reduce((sum, line, k) => sum + pick(line) * chars[k], 0) / totalChars : NaN;
            const boldShare = share((line) => line.bold);
            const italicShare = share((line) => line.italic);
            // Style and font most of the item's glyphs are set in (null without lines).
            const style = majority(lineStyles, chars);
            const font = majority(item.lines.map((line) => line.font), chars);
            const column = page.columns[item.column] ?? null;
            const colWidth = column ? column[2] - column[0] : 0;
            const regions = self ? regionGaps(self, page, em) : { above: NaN, below: NaN, overlap: NaN };
            const first = item.lines.length > 0 ? item.lines[0].text : text;
            const list = lists[p][i];
            // Item texts are mostly trimmed already; their key is then the one computed above.
            const textKey = text.length <= REPEAT_MAX_CHARS ? (text === item.text ? textKeys[p][i]! : repeatKey(text)) : null;
            const repeat = textKey === null ? undefined : textPages.get(textKey);
            const bodyKnown = doc.body.size > 0;

            const f: Record<OwnFeature, number> = {
                // Text
                words: Math.min(Math.log1p(words) / 6, 1),
                avgWordLen: words > 0 ? clamp(letters.visible / words / 10, 0, 2) : NaN,
                letterShare: letters.visible > 0 ? letters.letters / letters.visible : NaN,
                upperShare: letters.letters > 0 ? letters.upper / letters.letters : NaN,
                bullet: BULLET_RE.test(text) ? 1 : 0,
                symbolLead: SYMBOL_LEAD_RE.test(text) ? 1 : 0,
                sectionNumber: SECTION_NUMBER_RE.test(text) ? 1 : 0,
                endsColon: ENDS_COLON_RE.test(text) ? 1 : 0,
                noFinalPunct: text && !FINAL_PUNCT_RE.test(text) ? 1 : 0,
                email: EMAIL_RE.test(window) ? 1 : 0,
                frontMatterCue: FRONT_MATTER_RE.test(text) ? 1 : 0,
                pageNumberLike: PAGE_NUMBER_RE.test(text) ? 1 : 0,
                // Typography
                sizeRatio: bodyKnown && size > 0 ? clamp(size / doc.body.size, 0, 4) : NaN,
                sizeSpread: bodyKnown && sizes.length > 0 ? clamp((Math.max(...sizes) - Math.min(...sizes)) / doc.body.size, 0, 2) : NaN,
                lineHeight: item.lines.length > 0 ? clamp(median(item.lines.map((l) => l.b - l.t)) / em, 0, 5) : NaN,
                boldShare,
                italicShare,
                boldVsBody: bodyKnown ? boldShare - (doc.body.bold ? 1 : 0) : NaN,
                italicVsBody: bodyKnown ? italicShare - (doc.body.italic ? 1 : 0) : NaN,
                bodyFont: font === null || !bodyKnown ? NaN : font === doc.body.font ? 1 : 0,
                bodyStyle: style === null || bodyKey === null ? NaN : style === bodyKey ? 1 : 0,
                styleRarity: style === null || styles.total === 0
                    ? NaN
                    : clamp(-Math.log10((styles.chars.get(style) ?? 0) / styles.total || 1e-9), 0, 4) / 4,
                smallStyle: style === null || styles.small === null ? NaN : style === styles.small ? 1 : 0,
                // Geometry
                left: self && page.width > 0 ? clamp(self.l / page.width, 0, 1) : NaN,
                right: self && page.width > 0 ? clamp(self.r / page.width, 0, 1) : NaN,
                bottom: self && page.height > 0 ? clamp(self.b / page.height, 0, 1) : NaN,
                height: self && page.height > 0 ? clamp((self.b - self.t) / page.height, 0, 1) : NaN,
                centerOffset: self && page.width > 0 ? clamp(Math.abs((self.l + self.r) / 2 - page.width / 2) / (page.width / 2), 0, 1) : NaN,
                columns: Math.min(page.columns.length, 4) / 4,
                colWidth: self && colWidth > 0 ? clamp((self.r - self.l) / colWidth, 0, 2) : NaN,
                colIndent: self && column ? clamp((self.l - column[0]) / em, -5, 20) / 20 : NaN,
                colCentered: self && colWidth > 0
                    ? clamp(Math.abs((self.l + self.r) / 2 - (column![0] + column![2]) / 2) / colWidth, 0, 1)
                    : NaN,
                gapAbove: Number.isNaN(gaps[i].above) ? NaN : clamp(gaps[i].above, -2, 10) / 10,
                gapBelow: Number.isNaN(gaps[i].below) ? NaN : clamp(gaps[i].below, -2, 10) / 10,
                textBelow: self && page.height > 0 ? clamp((textBottom - self.b) / page.height, 0, 1) : NaN,
                itemsBelow: self ? Math.min(below[i], 10) / 10 : NaN,
                // Pipeline signals
                headingHeuristic: item.header ? 1 : 0,
                captionLine: isFigureCaption(first) || isTableCaption(first) || NOTE_CAPTION_RE.test(first) ? 1 : 0,
                regionOverlap: regions.overlap,
                regionGapAbove: Number.isNaN(regions.above) ? NaN : clamp(regions.above, 0, 20) / 20,
                regionGapBelow: Number.isNaN(regions.below) ? NaN : clamp(regions.below, 0, 20) / 20,
                regions: Math.min(page.regions.length, 5) / 5,
                marginRepeat: marginOthers > 0 ? Math.min(item.marginPages / marginOthers, 1) : NaN,
                marginRepeatCount: Math.min(item.marginPages, 10) / 10,
                windowPages: Math.min(Math.log1p(marginWindow.size) / 6, 1),
                // Document context
                docPos,
                fromEnd,
                firstPage: page.pageIndex === 0 ? 1 : 0,
                headingsBefore: Math.min(Math.log1p(list.headingsBefore) / 4, 1),
                refHeadingBefore: list.refHeadingBefore ? 1 : 0,
                refHeadingOnPage: list.refHeadingOnPage ? 1 : 0,
                sinceRefHeading: list.refHeadingBefore ? Math.min(Math.log1p(list.sinceRefHeading) / 5, 1) : NaN,
                notesHeadingBefore: list.notesBefore ? 1 : 0,
                pageItemPos: page.items.length > 1 ? i / (page.items.length - 1) : 0,
                pageItems: Math.min(Math.log1p(page.items.length) / 5, 1),
                textRepeat: doc.pages.length > 1 ? (repeat ? repeat.size - 1 : 0) / (doc.pages.length - 1) : NaN,
                textRepeatCount: repeat ? Math.min(repeat.size - 1, 10) / 10 : 0,
            };
            const row = featureRow(f, OWN_FEATURES);
            for (const v of referenceItemFeatures(item, page)) row.push(v);
            for (let k = 0; k < row.length; k++) row[k] = round(row[k]);
            return row;
        });
    });
}
