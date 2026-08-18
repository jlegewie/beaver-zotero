/**
 * Printed page-label resolution.
 *
 * A page *number* is the physical position of a page in a file (1-based); a page
 * *label* is what is printed on that page ("xii", "A-3", "17"). The two diverge
 * whenever a document has front matter or per-part numbering, so a locator shown
 * to the user should carry the label while navigation still uses the number.
 *
 * Resolution is deliberately a pure lookup against an explicit map: every caller
 * resolves the map up front (from citation metadata, or via the client's
 * `itemData` host slice) and passes it in, so no render path reads mutable cache
 * state and static rendering under an isolated store behaves identically.
 */

/**
 * Sparse 0-based page index -> printed page label.
 *
 * Sparse because a document may only label some of its pages. Numeric keys index
 * a string-keyed object equally well, so a client that stores labels as
 * `Record<string, string>` satisfies this without conversion.
 */
export type PageLabelMap = Record<number, string>;

export function hasPageLabels(labels: PageLabelMap | null | undefined): labels is PageLabelMap {
    return !!labels && Object.keys(labels).length > 0;
}

/**
 * Resolve the printed label for a 1-based page number, falling back to the page
 * number itself when the map has no usable label for it.
 */
export function resolvePageLabelFromLabels(
    pageLabels: PageLabelMap | null | undefined,
    pageNumber: number,
): string {
    if (!hasPageLabels(pageLabels)) return String(pageNumber);
    const pageIndex = pageNumber - 1;
    const label = pageLabels[pageIndex];
    if (label == null || label.trim() === '') return String(pageNumber);
    return label;
}
