/**
 * Document context of each item, shared by the item models: where its page
 * sits in the document, the list headings (reference list, notes) read so
 * far in reading order, and runs of consecutive list numbers.
 */

import type { InputPage } from "./itemInput";
import { isNotesHeading, isReferenceHeading, leadingNumber } from "./text";

/** Where a page sits in the document. */
export interface PagePosition {
    /** Page index over the last index (1 for a one-page document). */
    docPos: number;
    /** Pages after this one, at most 20, scaled by 1/20. */
    fromEnd: number;
}

export function pagePosition(pageIndex: number, pageCount: number): PagePosition {
    return {
        docPos: pageCount > 1 ? pageIndex / (pageCount - 1) : 1,
        fromEnd: Math.min(pageCount - 1 - pageIndex, 20) / 20,
    };
}

/** List headings around one item, in document reading order (`listContext`). */
export interface ListContext {
    /** The item reads as a reference-list heading. */
    listHeading: boolean;
    /** The item reads as a notes heading (and not a reference-list heading). */
    notesHeading: boolean;
    /** A reference-list heading came earlier in the document. */
    refHeadingBefore: boolean;
    /** A reference-list heading came earlier on the item's page. */
    refHeadingOnPage: boolean;
    /** Items since the last reference-list heading (0 when there was none). */
    sinceRefHeading: number;
    /** Detector headings since the last reference-list heading. */
    headingsAfterRef: number;
    /** The last list heading before the item was a notes heading. */
    notesBefore: boolean;
    /** Detector headings before the item in the document. */
    headingsBefore: number;
    /** The item's leading list number continues or is continued by a neighbour's. */
    numberSeq: boolean;
}

/** List context of every item of a document, in page and reading order. `pages` are the document's pages in order. */
export function listContext(pages: readonly InputPage[]): ListContext[][] {
    // Leading list numbers in document reading order, for the sequence test.
    const numbers: (number | null)[] = [];
    for (const page of pages) for (const item of page.items) numbers.push(leadingNumber(item.text));

    const out: ListContext[][] = [];
    let headingSeen = false;
    let notesLast = false;
    let sinceHeading = 0;
    let headingsAfter = 0;
    let headingsBefore = 0;
    let flat = 0;
    for (const page of pages) {
        let headingOnPage = false;
        const rows: ListContext[] = [];
        for (const item of page.items) {
            const listHeading = isReferenceHeading(item);
            const notesHeading = !listHeading && isNotesHeading(item);
            if (listHeading) {
                headingSeen = true;
                headingOnPage = true;
                sinceHeading = 0;
                headingsAfter = 0;
                notesLast = false;
            } else if (notesHeading) {
                notesLast = true;
            }
            const n = numbers[flat];
            const prev = flat > 0 ? numbers[flat - 1] : null;
            const next = flat + 1 < numbers.length ? numbers[flat + 1] : null;
            rows.push({
                listHeading,
                notesHeading,
                refHeadingBefore: headingSeen && !listHeading,
                refHeadingOnPage: headingOnPage && !listHeading,
                sinceRefHeading: headingSeen && !listHeading ? sinceHeading : 0,
                headingsAfterRef: headingsAfter,
                notesBefore: notesLast && !notesHeading,
                headingsBefore,
                numberSeq: n !== null && ((prev !== null && prev === n - 1) || (next !== null && next === n + 1)),
            });
            if (!listHeading && headingSeen) {
                sinceHeading++;
                if (item.header) headingsAfter++;
            }
            if (item.header) headingsBefore++;
            flat++;
        }
        out.push(rows);
    }
    return out;
}
