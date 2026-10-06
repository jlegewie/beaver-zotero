/**
 * Entry boundaries inside reference items.
 *
 * The paragraph detector sometimes merges consecutive reference entries into
 * one item (single-line entries, lists without a hanging indent) or breaks
 * one entry into two items. For each line of a reference item, the line
 * model scores whether a new entry starts there; the first line's score says
 * whether the item starts an entry or continues the previous one.
 */

import { leadingNumber } from "./features";
import type { RefLine, RefPage } from "./pageInput";

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

const LEADER = String.raw`(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)](?!\d))\s*`;
/** A list leader, or a bare list number before the author ("16 Schwamm LH, …"). */
const AUTHOR_LEADER = String.raw`(?:${LEADER}|\d{1,4}\s+(?=\p{Lu}))`;
const SURNAME = String.raw`(?:(?:van|von|de|da|del|della|der|den|di|du|le|la|dos|das|ten|ter|mc|mac|o')\s?)*\p{Lu}[\p{L}'’\-]+(?:[\s\-]\p{Lu}[\p{L}'’\-]+)?`;
const NUMBERED_RE = new RegExp(`^\\s*${LEADER}\\S`, "u");
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Line feature rows of the wanted items of a page, keyed by item index. The
 * line before an item's first line is the previous item's last line when
 * that item is in the same column.
 */
export function pageLineFeatures(
    page: RefPage,
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

function lineFeatures(page: RefPage, itemIndex: number, numberBefore: number | null): number[][] {
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
        const prev: RefLine | null = k > 0 ? lines[k - 1] : prevItemLine;
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
