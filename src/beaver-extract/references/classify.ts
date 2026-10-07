/**
 * Reference classification for structured extraction.
 *
 * `planReferences` scores every item of a document (see `model.ts`) and
 * decides which items are reference-list entries. `applyReferencePlan` turns
 * one page's plan into edited draft items: `reference` items, split where one
 * item holds several entries, and merged where an entry was broken off its
 * continuation in the same column.
 */

import { mergeBoxes } from "@beaver/agent-core/extract/types";
import type { PageLine } from "../LineDetector";
import { joinLines, type HangingRole } from "../ParagraphDetector";
import type { DraftItem } from "../pipeline/draftItems";
import { lineStartProbability, scoreReferences, type ReferenceModel } from "./model";
import { LINE_FEATURES, pageLineFeatures } from "./lines";
import { isReferenceHeading } from "./features";
import type { RefPage } from "./pageInput";
import { REFERENCE_MODEL } from "./weights";

export interface ReferencePagePlan {
    /** Reference probability of each input item. */
    probs: number[];
    /** Whether each input item is a reference entry (or part of one). */
    reference: boolean[];
    /** Per input item: line indices (≥ 1) at which a new entry starts. */
    splits: number[][];
    /** Per input item: it continues the previous item's entry in the same column. */
    mergeWithPrevious: boolean[];
}

/** Classify the items of a document. `pages` are its pages in order. */
export function planReferences(
    pages: readonly RefPage[],
    pageCount: number,
    model: ReferenceModel = REFERENCE_MODEL,
): ReferencePagePlan[] {
    const probs = scoreReferences(model, pages, pageCount);
    return pages.map((page, p) => {
        const reference = probs[p].map((prob) => prob >= model.threshold);
        const splits: number[][] = page.items.map(() => []);
        const mergeWithPrevious = page.items.map(() => false);
        const lineRows = pageLineFeatures(page, (i) => reference[i]);
        for (const [i, rows] of lineRows) {
            rows.forEach((x, k) => {
                const start = lineStartProbability(model, x);
                if (k > 0 && start >= model.lines.splitThreshold) splits[i].push(k);
                // Only a line after the previous item's last line in the same
                // column (`hasPrev`) can continue it.
                if (k === 0 && i > 0 && reference[i - 1] && x[LINE_HAS_PREV] === 1 && start < model.lines.mergeThreshold) {
                    mergeWithPrevious[i] = true;
                }
            });
        }
        return { probs: probs[p], reference, splits, mergeWithPrevious };
    });
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
    plan: ReferencePagePlan,
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
        if (isRef && piece && isReferenceHeading({ header: false, column: 0, text, lines: [] })) {
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
