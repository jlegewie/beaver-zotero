/**
 * Item passes: step 3 of structured extraction.
 *
 * After every page is segmented, ordered passes see the draft items of the
 * whole document at once and may relabel, split or merge them (reference
 * classification is the first). Each schema preset lists its passes by name
 * (`PdfExtractionPreset.itemPasses`); `createItemPasses` builds them.
 *
 * Region items are not draft items. Region detection runs in step 2 and
 * removes the lines it absorbs, and the items are placed among the page's
 * items after sentence mapping, because placement keeps a region from
 * splitting a paragraph whose last sentence continues past it (a sentence
 * mapping result). Passes see the regions of each page as context
 * (`DraftPage.regions`).
 */

import type { MarginAnalysis, StyleProfile } from "@beaver/agent-core/extract/types";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import type { DraftPage } from "./draftItems";

/** The draft items of every target page, in page order. */
export interface DraftDocument {
    pages: DraftPage[];
    /** Pages in the document (the target pages may be fewer). */
    pageCount: number;
    styleProfile: StyleProfile;
    /** Margin-zone text of the analysis pages (running headers, page numbers). */
    marginAnalysis: MarginAnalysis;
    /**
     * Pages the cross-page analysis read (`marginAnalysis`, style profile).
     * Structured extraction reads every page of the document.
     */
    analysisPageIndices: readonly number[];
}

export interface PassContext {
    paragraphSettings: ParagraphDetectionSettings | undefined;
    /** Attribute `ms` of the pass's time to page `k` (position in `DraftDocument.pages`). */
    addPageMs(k: number, ms: number): void;
}

/** A document-level pass over the draft items. */
export interface ItemPass {
    /** Names the pass in phase timings (`<name>Ms`). */
    name: string;
    /** Edits `doc.pages[*].items` in place (relabel, split, merge). */
    run(doc: DraftDocument, ctx: PassContext): void;
}

/** Per page: time each pass that reported any spent on it, by pass name. */
export type PagePassTimings = Record<string, number>;

/** Run `passes` in order over `doc`. Returns each page's pass timings. */
export function runPasses(
    passes: readonly ItemPass[],
    doc: DraftDocument,
    paragraphSettings: ParagraphDetectionSettings | undefined,
): PagePassTimings[] {
    const timings: PagePassTimings[] = doc.pages.map(() => ({}));
    for (const pass of passes) {
        pass.run(doc, {
            paragraphSettings,
            addPageMs: (k, ms) => {
                timings[k][pass.name] = (timings[k][pass.name] ?? 0) + ms;
            },
        });
    }
    return timings;
}
