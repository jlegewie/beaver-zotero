/**
 * Reference-list entries for structured extraction.
 *
 * The item-type model decides which items are references; the paragraph
 * detector's items don't always hold one entry each. `planEntries` plans, per
 * page, where reference items split into several entries and where an item
 * continues the entry before it (the line model of `lines.ts`, helped by the
 * layout of hanging lists). `applyReferencePlan` turns one page's plan into
 * edited draft items: `reference` items, split where one item holds several
 * entries, and merged where an entry was broken off its continuation in the
 * same column.
 */

import { mergeBoxes } from "@beaver/agent-core/extract/types";
import type { PageLine } from "../LineDetector";
import { joinLines, type HangingRole } from "../ParagraphDetector";
import type { DraftItem } from "../pipeline/draftItems";
import {
    HANGING_MAX_INDENT_EM,
    LINE_FEATURES,
    canOpenEntry,
    hangingLevels,
    lineStartProbability,
    pageLineFeatures,
    type ReferenceLineModel,
} from "./lines";
import type { InputPage } from "../features/itemInput";
import { isReferenceHeading } from "../features/text";
import { REFERENCE_LINE_MODEL } from "./weights";

/** The reference entries of one page: which items are entries, and where they split and join. */
export interface EntryPagePlan {
    /** Whether each input item is a reference entry (or part of one). */
    reference: boolean[];
    /** Per input item: line indices (≥ 1) at which a new entry starts. */
    splits: number[][];
    /** Per input item: it continues the previous item's entry in the same column. */
    mergeWithPrevious: boolean[];
}

/**
 * Entry plans of pages whose reference items are decided (`reference`, per
 * page and item): each page's line plan (`planLines`) over its reference
 * items. `pages` holds the input of the pages to plan, `reference` their
 * items' labels, in the same order.
 */
export function planEntries(
    pages: readonly InputPage[],
    reference: readonly (readonly boolean[])[],
    model: ReferenceLineModel = REFERENCE_LINE_MODEL,
): EntryPagePlan[] {
    return pages.map((page, p) => {
        const lines = planLines(model, page, reference[p]);
        return {
            reference: reference[p].slice(),
            splits: reference[p].map((ref, i) => (ref ? lines.splits[i] : [])),
            // Only a reference entry can be continued.
            mergeWithPrevious: reference[p].map((ref, i) => ref && lines.mergeWithPrevious[i] && reference[p][i - 1] === true),
        };
    });
}

/**
 * A caption or table note: "Table 1. Description of …", "Figure 2a.",
 * "Appendix Table A1:", "Note: …". It sits next to a table or figure, which
 * can follow a reference list without a heading between them, but it is
 * never a reference entry (the item-type pass enforces this).
 */
const CAPTION_LABEL_RE =
    /^\s*(?:(?:appendix|online|supplementary|supplemental|supporting|extended\s+data)\s+)?(?:table|figure|fig\.?|exhibit|chart|scheme|plate|map|graph)\s*[A-Z]?\d{1,3}(?:\.\d{1,2})?[a-z]?\s*(?:[.:—–-]|\(cont|$|\s+\p{Lu})|^\s*(?:notes?|sources?)\s*:/iu;

export function isCaptionLabel(text: string): boolean {
    return CAPTION_LABEL_RE.test(text);
}

/**
 * The label of an appendix or annex: "Appendix A: Journal Coverage", "Online
 * Appendix B. Journal Sample", "Supplementary Appendix", "Appendices". A new
 * section can follow a reference list in body styling at the list's indent,
 * and its title can read like part of an entry ("… Journal Coverage"). A
 * source whose title starts with the word ("Appendix to the Journals of the
 * House of Representatives") is not a label.
 */
const APPENDIX_LABEL_RE =
    /^\s*(?:(?:online|supplementary|supplemental|web|technical|statistical)\s+)?(?:appendix|appendices|annex|annexes|annexe|anhang)(?:\s*[.:—–-]|\s*$|\s+(?:[A-Z]\d{0,2}|\d{1,2}|[IVX]{1,4})(?:\s*[.:—–-]|\s*$|\s+\p{Lu}))/iu;

/** Captions, table notes and appendix labels: text beside a list that is never one of its entries. */
export function isNonEntryLabel(text: string): boolean {
    return isCaptionLabel(text) || APPENDIX_LABEL_RE.test(text);
}

interface LinePlan {
    /** Per item: line indices (≥ 1) at which a new entry starts. */
    splits: number[][];
    /** Per item: its first line continues the previous wanted item's entry in the same column. */
    mergeWithPrevious: boolean[];
}

/**
 * Entry starts inside, and continuations across, the wanted items of a page.
 * The line model decides, and in a hanging list (`hangingLevels`) the layout
 * adds what it misses: a later line at the outer edge starts an entry unless
 * it runs on from the line before (`canOpenEntry`), and an item whose first
 * line sits at the inner edge continues the previous one unless the line
 * model is confident it starts one (a box set below the list can line up
 * with the inner edge).
 */
function planLines(model: ReferenceLineModel, page: InputPage, wanted: readonly boolean[]): LinePlan {
    const splits: number[][] = page.items.map(() => []);
    const mergeWithPrevious = page.items.map(() => false);
    const em = page.bodySize > 0 ? page.bodySize : 10;
    // Whether the item's first line starts where a continuation of the
    // previous item's entry could: between that item's left edge and a
    // hanging indent in from it, and not at the outer edge of a hanging list,
    // where entries start. A page number or a centered line below an entry
    // does not.
    const aligned = page.items.map((item, i) => {
        const previous = i > 0 ? page.items[i - 1] : null;
        if (!previous || previous.lines.length === 0 || item.lines.length === 0) return false;
        const edge = Math.min(...previous.lines.map((l) => l.l));
        const d = item.lines[0].l - edge;
        return d >= -0.5 * em && d <= HANGING_MAX_INDENT_EM * em;
    });
    const lineRows = pageLineFeatures(page, (i) => wanted[i]);
    const levels = hangingLevels(page, (i) => wanted[i]);
    levels.forEach((level, i) => {
        if (level[0] === "outer") aligned[i] = false;
    });
    for (const [i, rows] of lineRows) {
        const level = levels.get(i);
        rows.forEach((x, k) => {
            const start = lineStartProbability(model, x);
            const layoutStart = level?.[k] === "outer" && canOpenEntry(page.items[i].lines[k].text);
            const layoutContinuation = level?.[k] === "inner" && aligned[i] && start < model.splitThreshold;
            if (k > 0 && (start >= model.splitThreshold || layoutStart)) splits[i].push(k);
            // Only a line after the previous item's last line in the same
            // column (`hasPrev`) can continue it.
            if (
                k === 0 &&
                i > 0 &&
                wanted[i - 1] &&
                x[LINE_HAS_PREV] === 1 &&
                (start < model.mergeThreshold || layoutContinuation)
            ) {
                mergeWithPrevious[i] = true;
            }
        });
    }
    return { splits, mergeWithPrevious };
}

const LINE_HAS_PREV = LINE_FEATURES.indexOf("hasPrev");

/**
 * Apply a page plan to its draft items. Returns the edited items: reference
 * entries become `reference` items, an item holding several entries is split
 * at their first lines, and an item that continues the previous entry in the
 * same column is merged into it. Items are rebuilt from their lines (text via
 * `joinLines`) when the plan splits or merges anything on the page; otherwise
 * only reference items are relabeled.
 */
export function applyReferencePlan(
    items: readonly DraftItem[],
    plan: EntryPagePlan,
    removeHyphenation = true,
): DraftItem[] {
    const edits = plan.splits.some((s) => s.length > 0) || plan.mergeWithPrevious.some(Boolean);
    if (!edits) {
        return items.map((item, i) => (plan.reference[i] ? { ...item, kind: "reference" } : item));
    }

    const out: DraftItem[] = [];
    const push = (base: DraftItem, lines: PageLine[], roles: HangingRole[], isRef: boolean, piece = false) => {
        const text = joinLines(lines.map((l) => l.text), removeHyphenation);
        const bbox = mergeBoxes(lines.map((l) => l.bbox));
        // A list heading the detector merged into the first entry ("FURTHER
        // READING Heyman, K. …") is split off as a piece of its own; it is the
        // list's heading, not an entry.
        if (isRef && piece && isReferenceHeading({ header: false, text })) {
            out.push({ ...base, kind: "section_header", text, bbox, lines, roles });
            return;
        }
        out.push({ ...base, kind: isRef ? "reference" : base.kind, text, bbox, lines, roles });
    };

    items.forEach((item, i) => {
        const group = item.lines;
        const isRef = plan.reference[i];
        if (group.length === 0) {
            // No lines to rebuild from (not produced by the detector); keep as is.
            out.push(isRef ? { ...item, kind: "reference" } : item);
            return;
        }
        const cuts = isRef
            ? plan.splits[i].filter((k) => k > 0 && k < group.length).sort((a, b) => a - b)
            : [];
        let start = 0;
        for (const cut of [...cuts, group.length]) {
            if (cut <= start) continue;
            const previous = out[out.length - 1];
            if (
                start === 0 &&
                isRef &&
                plan.mergeWithPrevious[i] &&
                previous?.kind === "reference" &&
                previous.columnIndex === item.columnIndex
            ) {
                // The item's opening lines finish the previous entry.
                out.pop();
                push(
                    previous,
                    [...previous.lines, ...group.slice(0, cut)],
                    [...previous.roles, ...item.roles.slice(0, cut)],
                    true,
                );
            } else {
                push(item, group.slice(start, cut), item.roles.slice(start, cut), isRef, cuts.length > 0);
            }
            start = cut;
        }
    });
    return out;
}
