/**
 * Printed page labels: the page numbers printed on a document's pages.
 *
 * A PDF carries up to two label sources. Its own `/PageLabels` (the *embedded*
 * labels) are often missing or meaningless, e.g. `1..N` on an article printed
 * as pp. 1201-1220. *Derived* labels are read from the page margins during
 * full structured extraction and match the printed page far more often.
 *
 * `resolvePrintedPageLabels` is the single definition of "the printed label of
 * page i". Everything Beaver shows a person or the model as a page number goes
 * through it; labels written into Zotero (note-citation locators, annotation
 * labels) use their own namespace.
 */

/** Label sources for one document. Maps are keyed by 0-based page index. */
export interface PageLabelSources {
    /** Page count; labels past it are dropped. `null` when unknown. */
    pageCount: number | null;
    /** Labels derived from the printed page numbers (`derivedPageLabels`). */
    derived?: Record<string, string> | null;
    /**
     * The PDF's own `/PageLabels`. Not used for printed labels: they add
     * spurious labels on covers and download sheets without improving recall.
     */
    embedded?: Record<string, string> | Record<number, string> | null;
    /** The parent item's `pages` field. Not used yet. */
    itemPages?: string | null;
}

/** Printed label per 0-based page index; pages without one are absent. */
export function resolvePrintedPageLabels(src: PageLabelSources): Record<number, string> {
    const out: Record<number, string> = {};
    if (!src.derived) return out;
    for (const [key, value] of Object.entries(src.derived)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0) continue;
        if (src.pageCount != null && index >= src.pageCount) continue;
        if (typeof value === 'string' && value.trim()) out[index] = value;
    }
    return out;
}
