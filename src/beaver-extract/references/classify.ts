/**
 * Reference classification for structured extraction.
 *
 * `planReferences` scores every item of a document (see `model.ts`) and
 * decides which items are reference-list entries. `applyReferencePlan` turns
 * one page's plan into edited paragraphs: reference items to emit as
 * `reference` items, split where one item holds several entries, and merged
 * where an entry was broken off its continuation in the same column.
 */

import { mergeBoxes } from "@beaver/agent-core/extract/types";
import type { PageLine } from "../LineDetector";
import { joinLines, type ContentItem, type HangingRole, type PageParagraphResult } from "../ParagraphDetector";
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
 * Apply a page plan to its paragraph result. Returns the edited result and
 * the indices of its reference items. The result is unchanged when the plan
 * edits nothing; otherwise items, lines and roles are rebuilt (item ids
 * follow the new positions; `pageContent` keeps the detector's text).
 */
export function applyReferencePlan(
    result: PageParagraphResult,
    plan: ReferencePagePlan,
    removeHyphenation = true,
): { result: PageParagraphResult; references: Set<number> } {
    const references = new Set<number>();
    const edits = plan.splits.some((s) => s.length > 0) || plan.mergeWithPrevious.some(Boolean);
    if (!edits) {
        plan.reference.forEach((isRef, i) => {
            if (isRef) references.add(i);
        });
        return { result, references };
    }

    const itemLines = result.itemLines ?? [];
    const roles = result.itemLineRoles ?? [];
    const items: ContentItem[] = [];
    const lines: PageLine[][] = [];
    const lineRoles: HangingRole[][] = [];
    const push = (
        base: ContentItem,
        group: PageLine[],
        groupRoles: HangingRole[],
        isRef: boolean,
        piece = false,
    ) => {
        const text = joinLines(group.map((l) => l.text), removeHyphenation);
        // A list heading the detector merged into the first entry ("FURTHER
        // READING Heyman, K. …") is split off as a piece of its own; it is the
        // list's heading, not an entry.
        if (isRef && piece && isReferenceHeading({ header: false, column: 0, text, lines: [] })) {
            items.push({ ...base, type: "header", text: `## ${text}`, bbox: mergeBoxes(group.map((l) => l.bbox)) });
            lines.push(group);
            lineRoles.push(groupRoles);
            return;
        }
        items.push({
            ...base,
            type: isRef ? "paragraph" : base.type,
            text: isRef || base.type !== "header" ? text : `## ${text}`,
            bbox: mergeBoxes(group.map((l) => l.bbox)),
        });
        lines.push(group);
        lineRoles.push(groupRoles);
        if (isRef) references.add(items.length - 1);
    };

    result.items.forEach((item, i) => {
        const group = itemLines[i] ?? [];
        const groupRoles = roles[i] ?? group.map(() => null);
        const isRef = plan.reference[i];
        if (group.length === 0) {
            // No lines to rebuild from (not produced by the detector); keep as is.
            items.push(item);
            lines.push(group);
            lineRoles.push(groupRoles);
            if (isRef) references.add(items.length - 1);
            return;
        }
        const cuts = isRef
            ? plan.splits[i].filter((k) => k > 0 && k < group.length).sort((a, b) => a - b)
            : [];
        let start = 0;
        for (const cut of [...cuts, group.length]) {
            if (cut <= start) continue;
            const last = items.length - 1;
            if (
                start === 0 &&
                isRef &&
                plan.mergeWithPrevious[i] &&
                references.has(last) &&
                items[last].columnIndex === item.columnIndex
            ) {
                // The item's opening lines finish the previous entry.
                const previous = items.pop()!;
                references.delete(last);
                push(
                    previous,
                    [...lines.pop()!, ...group.slice(0, cut)],
                    [...lineRoles.pop()!, ...groupRoles.slice(0, cut)],
                    true,
                );
            } else {
                push(item, group.slice(start, cut), groupRoles.slice(start, cut), isRef, cuts.length > 0);
            }
            start = cut;
        }
    });
    items.forEach((item, index) => {
        item.id = `p${result.pageIndex}:i${index}`;
    });
    return {
        result: { ...result, items, itemLines: lines, itemLineRoles: lineRoles },
        references,
    };
}
