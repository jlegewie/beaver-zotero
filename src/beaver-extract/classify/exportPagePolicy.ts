/**
 * Page selection for the item-feature training export.
 *
 * Reference lists sit at the end of an article and at chapter ends in a
 * book, so a long document contributes its head (body-text negatives) and
 * its tail (where the positive class lives) rather than every page. Kept
 * worker-legal so the worker op can apply it against the page count it
 * resolves from the document itself, which is the only count that is
 * guaranteed to match the pages it can actually load.
 */

/** Documents up to this many pages are processed in full. */
export const PAGE_POLICY_FULL_MAX = 60;
/** Leading pages kept for a longer document. */
export const PAGE_POLICY_HEAD = 20;
/** Trailing pages kept for a longer document. */
export const PAGE_POLICY_TAIL = 40;

/**
 * Resolve the page indices to featurize for a document of `pageCount`
 * pages. Always sorted ascending with no duplicates; empty for a document
 * without pages.
 */
export function resolveExportPageIndices(pageCount: number): number[] {
    if (!Number.isFinite(pageCount) || pageCount <= 0) return [];
    const total = Math.floor(pageCount);
    if (total <= PAGE_POLICY_FULL_MAX) {
        return Array.from({ length: total }, (_, i) => i);
    }
    const indices = new Set<number>();
    for (let i = 0; i < PAGE_POLICY_HEAD && i < total; i++) indices.add(i);
    for (let i = Math.max(0, total - PAGE_POLICY_TAIL); i < total; i++) {
        indices.add(i);
    }
    return [...indices].sort((a, b) => a - b);
}
