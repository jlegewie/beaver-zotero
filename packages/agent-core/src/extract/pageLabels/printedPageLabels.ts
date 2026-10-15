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
 * through it. Labels written into Zotero (note-citation locators, annotation
 * labels) come from `resolveZoteroLocatorPageLabels`: the same printed labels,
 * with the embedded label filling pages that print none, because a locator
 * has to name every page.
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
     * Zotero locator labels fall back to them on pages without a printed label.
     */
    embedded?: Record<string, string> | Record<number, string> | null;
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

/**
 * Label Beaver writes into Zotero per 0-based page index: the printed label,
 * else the embedded label. Pages with neither are absent; callers fall back to
 * the physical page number.
 *
 * Zotero navigates a note citation by exact match of its locator against the
 * reader's labels, and labels a new annotation by counting on from the nearest
 * earlier annotation's label. Printed labels are right far more often than the
 * embedded ones in both roles, and Zotero 10's reader shows printed-like labels
 * where a PDF declares none. On a PDF whose embedded labels are wrong, Zotero
 * 11 navigates by those labels, so a printed locator can land on another page
 * there. That is accepted: the locator is also the page the citation prints in
 * a manuscript, and writing `/PageLabels` into the PDF is the fix for the click.
 */
export function resolveZoteroLocatorPageLabels(src: PageLabelSources): Record<number, string> {
    const out: Record<number, string> = {};
    if (src.embedded) {
        for (const [key, value] of Object.entries(src.embedded)) {
            const index = Number(key);
            if (!Number.isInteger(index) || index < 0) continue;
            if (src.pageCount != null && index >= src.pageCount) continue;
            if (typeof value === 'string' && value.trim()) out[index] = value;
        }
    }
    return Object.assign(out, resolvePrintedPageLabels(src));
}
