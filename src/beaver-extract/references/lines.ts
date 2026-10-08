/**
 * Entry boundaries inside reference items.
 *
 * The paragraph detector sometimes merges consecutive reference entries into
 * one item (single-line entries, lists without a hanging indent) or breaks
 * one entry into two items. For each line of a reference item, the line
 * model scores whether a new entry starts there; the first line's score says
 * whether the item starts an entry or continues the previous one.
 */

import { clamp } from "../features/geometry";
import type { InputLine, InputPage } from "../features/itemInput";
import { AUTHOR_LEADER, NUMBERED_RE, SURNAME, leadingNumber } from "../features/text";

export const LINE_FEATURE_VERSION = 3;

export const LINE_FEATURES = [
    "first",
    "hasPrev",
    "prevSameItem",
    "roleEntry",
    "roleCont",
    "dxPrev",
    "dxMin",
    "prevGapRight",
    "prevEndsPeriod",
    "prevEndsDigit",
    "prevEndsLink",
    "prevEndsOpen",
    "numbered",
    "leadSmall",
    "numberNext",
    "authorStart",
    "initialsStart",
    "dashStart",
    "startsLower",
    "startsUpper",
    "startsDigit",
    "yearEarly",
    "gap",
    "width",
] as const;

type LineFeatureName = (typeof LINE_FEATURES)[number];

const AUTHOR_RE = new RegExp(
    `^\\s*(?:${AUTHOR_LEADER})?${SURNAME},?\\s+(?:\\p{Lu}\\.|\\p{Lu}[\\p{Ll}]+[-,;.\\s(]|\\p{Lu}{1,3}[,;.\\s])`,
    "u",
);
const INITIALS_RE = new RegExp(
    `^\\s*(?:${AUTHOR_LEADER})?(?:\\p{Lu}\\.\\s?(?:-\\s?\\p{Lu}\\.\\s?)?){1,3}\\s?${SURNAME}`,
    "u",
);
const DASH_RE = /^\s*(?:[—–-]\s?){2,}/u;
const YEAR_RE = /(?<![\d/.])(?:1[5-9]\d\d|20[0-3]\d)[a-z]?(?!\d)/u;

/**
 * An author opening with initials: "Smith, J.", "Smith JA,", "Huber E,", "van der Berg, A.".
 * Unlike `AUTHOR_RE`, a capitalized word after the surname doesn't count:
 * title and publisher lines open that way ("Memorial Lecture, Proceedings").
 */
const INITIALED_AUTHOR_RE = new RegExp(
    `^\\s*(?:${AUTHOR_LEADER})?${SURNAME},?\\s+\\p{Lu}{1,3}(?:[,.;]|\\s|$)`,
    "u",
);

/**
 * A line that opens like a reference entry: a list number (not a year), an
 * author with initials, or a repeated-author rule, which scanned text often
 * reduces to one dash ("- ed. Studies in …").
 */
export function opensLikeEntry(text: string): boolean {
    const n = leadingNumber(text);
    if (n !== null) return n < 1500 || n > 2039;
    return INITIALED_AUTHOR_RE.test(text) || INITIALS_RE.test(text) || /^\s*[—–-]/u.test(text);
}

/**
 * Whether a line at the outer edge of a hanging list can open an entry: it
 * starts with a capital, a repeated-author dash or a list number. A line
 * that starts in lowercase, with a year or a page number, or with a marker
 * such as "*" runs on from the line before.
 */
export function canOpenEntry(text: string): boolean {
    const n = leadingNumber(text);
    if (n !== null) return n < 1500 || n > 2039;
    return /^\s*(?:\p{Lu}|[—–-])/u.test(text);
}

/** Widest hanging indent, in em: the inner edge sits 0.5–4.5 em in from the outer one. */
export const HANGING_MAX_INDENT_EM = 4.5;

/** Where a line starts in a hanging-indent list: at the outer edge, the inner edge, or neither. */
export type HangingLevel = "outer" | "inner" | null;

/**
 * Lines on each side whose left edges set a line's local outer edge: scanned
 * pages drift, but the window has to reach past the longest entry's
 * continuation lines.
 */
const LEVEL_WINDOW = 20;

/**
 * Levels of the lines of the wanted items of a page when they form hanging
 * lists: per column, entries open at an outer edge and wrap to an inner edge
 * 0.5–4.5 em further in. A column reads as such a list when at least three
 * lines open at the outer edge and two of the voting items' lines at the
 * inner one, and when most outer lines open like an entry and few inner
 * ones do. Evidence for the layout (inner lines, outer lines that open like
 * an entry) comes from the voting items, the reference entries, only; the
 * other wanted items count against it. An indented paragraph after a
 * flush-left list then cannot make the list read as hanging, though text
 * that runs on at the outer edge can still keep a list from reading so.
 * Keyed by item index; items in other columns, or in columns that don't
 * hang, are absent.
 */
export function hangingLevels(
    page: InputPage,
    wanted: (itemIndex: number) => boolean,
    votes: (itemIndex: number) => boolean = wanted,
): Map<number, HangingLevel[]> {
    const em = page.bodySize > 0 ? page.bodySize : 10;
    const out = new Map<number, HangingLevel[]>();
    const columns = new Map<number, { i: number; k: number; line: InputLine }[]>();
    page.items.forEach((item, i) => {
        if (!wanted(i)) return;
        const seq = columns.get(item.column) ?? [];
        item.lines.forEach((line, k) => seq.push({ i, k, line }));
        columns.set(item.column, seq);
    });
    for (const seq of columns.values()) {
        const offsets = seq.map((_, j) => {
            let edge = Infinity;
            for (let n = Math.max(0, j - LEVEL_WINDOW); n <= Math.min(seq.length - 1, j + LEVEL_WINDOW); n++) {
                edge = Math.min(edge, seq[n].line.l);
            }
            return (seq[j].line.l - edge) / em;
        });
        const inner = offsets
            .filter((d, j) => votes(seq[j].i) && d >= 0.5 && d <= HANGING_MAX_INDENT_EM)
            .sort((a, b) => a - b);
        if (inner.length < 2) continue;
        const step = inner[inner.length >> 1];
        const levels: HangingLevel[] = offsets.map((d) =>
            d <= 0.3 ? "outer" : Math.abs(d - step) <= 0.3 ? "inner" : null,
        );
        let outerN = 0;
        let outerEntries = 0;
        let innerN = 0;
        let innerVotes = 0;
        let innerEntries = 0;
        seq.forEach(({ i, line }, j) => {
            const entry = opensLikeEntry(line.text.trim());
            if (levels[j] === "outer") {
                outerN++;
                if (entry && votes(i)) outerEntries++;
            } else if (levels[j] === "inner") {
                innerN++;
                if (votes(i)) innerVotes++;
                if (entry) innerEntries++;
            }
        });
        if (outerN < 3 || innerVotes < 2 || outerEntries < 0.6 * outerN || innerEntries > 0.2 * innerN) continue;
        seq.forEach(({ i, k }, j) => {
            const row = out.get(i) ?? page.items[i].lines.map((): HangingLevel => null);
            row[k] = levels[j];
            out.set(i, row);
        });
    }
    return out;
}

/**
 * Line feature rows of the wanted items of a page, keyed by item index. The
 * line before an item's first line is the previous item's last line when
 * that item is in the same column.
 */
export function pageLineFeatures(
    page: InputPage,
    wanted: (itemIndex: number) => boolean,
): Map<number, number[][]> {
    const out = new Map<number, number[][]>();
    // Last list number seen before each line, in reading order on the page.
    let lastNumber: number | null = null;
    page.items.forEach((item, i) => {
        if (wanted(i)) out.set(i, lineFeatures(page, i, lastNumber));
        for (const line of item.lines) {
            const n = leadingNumber(line.text);
            if (n !== null) lastNumber = n;
        }
    });
    return out;
}

function lineFeatures(page: InputPage, itemIndex: number, numberBefore: number | null): number[][] {
    const item = page.items[itemIndex];
    const lines = item.lines;
    if (lines.length === 0) return [];
    const em = page.bodySize > 0 ? page.bodySize : 10;
    const prevItem = itemIndex > 0 ? page.items[itemIndex - 1] : null;
    const prevItemLine =
        prevItem && prevItem.column === item.column && prevItem.lines.length > 0
            ? prevItem.lines[prevItem.lines.length - 1]
            : null;
    const minL = Math.min(...lines.map((l) => l.l));
    const maxR = Math.max(...lines.map((l) => l.r), prevItemLine?.r ?? -Infinity);
    const width = Math.max(1, maxR - minL);
    const gaps: number[] = [];
    for (let k = 1; k < lines.length; k++) gaps.push(lines[k].t - lines[k - 1].b);
    gaps.sort((a, b) => a - b);
    const medianGap = gaps.length > 0 ? gaps[gaps.length >> 1] : 0;

    let lastNumber = numberBefore;
    const rows: number[][] = [];
    lines.forEach((line, k) => {
        const prev: InputLine | null = k > 0 ? lines[k - 1] : prevItemLine;
        const text = line.text.trim();
        const prevText = prev ? prev.text.trim() : "";
        const n = leadingNumber(text);
        const f: Record<LineFeatureName, number> = {
            first: k === 0 ? 1 : 0,
            hasPrev: prev ? 1 : 0,
            prevSameItem: k > 0 ? 1 : 0,
            roleEntry: line.role === 1 ? 1 : 0,
            roleCont: line.role === 2 ? 1 : 0,
            dxPrev: prev ? clamp((line.l - prev.l) / em, -3, 3) / 3 : 0,
            dxMin: clamp((line.l - minL) / em, 0, 5) / 5,
            prevGapRight: prev ? clamp((maxR - prev.r) / em, 0, 10) / 10 : 0,
            prevEndsPeriod: /[.]["'”’)\]]?$/u.test(prevText) ? 1 : 0,
            prevEndsDigit: /[\d)\]]$/u.test(prevText) ? 1 : 0,
            prevEndsLink: /(?:https?:\/\/|www\.|doi[:.])\S*$/iu.test(prevText) ? 1 : 0,
            prevEndsOpen: /(?:[,;:&\-–(]|\b(?:and|und|et|in|In|of|the|&))$/u.test(prevText) ? 1 : 0,
            numbered: NUMBERED_RE.test(text) || n !== null ? 1 : 0,
            leadSmall: line.lead < 0.85 ? 1 : 0,
            numberNext: n !== null && lastNumber !== null && n === lastNumber + 1 ? 1 : 0,
            authorStart: AUTHOR_RE.test(text) ? 1 : 0,
            initialsStart: INITIALS_RE.test(text) ? 1 : 0,
            dashStart: DASH_RE.test(text) ? 1 : 0,
            startsLower: /^\p{Ll}/u.test(text) ? 1 : 0,
            startsUpper: /^\p{Lu}/u.test(text) ? 1 : 0,
            startsDigit: /^\d/u.test(text) ? 1 : 0,
            yearEarly: YEAR_RE.test(text.slice(0, 80)) ? 1 : 0,
            gap: prev ? clamp((line.t - prev.b - medianGap) / em, -1, 2) / 2 : 0,
            width: clamp((line.r - line.l) / width, 0, 1),
        };
        if (n !== null) lastNumber = n;
        rows.push(LINE_FEATURES.map((name) => Math.round(f[name] * 1e4) / 1e4));
    });
    return rows;
}
