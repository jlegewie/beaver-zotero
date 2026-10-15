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

import { formatNumberRanges, formatPageRangesWithLabels } from './pageRanges';

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

/** How one page displays: its printed label, or its physical position. */
export interface PrintedPage {
    /** Printed label, or null when the page has none. */
    label: string | null;
    /** 1-based physical page number. */
    physical: number;
    /** Whether any page of the document has a printed label. */
    documentHasLabels: boolean;
}

/**
 * Describe a 0-based page against a document's printed labels.
 *
 * A page without a label in a document that has labels is shown in a distinct
 * physical form ("PDF p. 5"): otherwise the physical "5" would read as the
 * printed page 5. In a document without any labels the plain physical number
 * is unambiguous.
 */
export function formatPrintedPage(pageIndex: number, labels: PageLabelMap | null | undefined): PrintedPage {
    const documentHasLabels = hasPageLabels(labels);
    const raw = documentHasLabels ? labels[pageIndex] : undefined;
    const label = raw != null && raw.trim() !== '' ? raw : null;
    return { label, physical: pageIndex + 1, documentHasLabels };
}

/** Display strings for the pages a citation cites. Empty strings when there are none. */
export interface CitedPagesDisplay {
    /** Inline locator, prefix included: "p.12", "p.12-14", "PDF p.5", "p.12, PDF p.5". */
    locator: string;
    /** Same pages for prose: "page 12", "PDF page 5", "page 12, PDF page 5". */
    reference: string;
}

/**
 * Format the cited 1-based pages with printed labels.
 *
 * Labelled pages show their labels; unlabelled pages of a labelled document
 * show the distinct physical form. Without labels (or with `useLabels` off)
 * every page shows its physical number.
 */
export function formatCitedPages(
    pageNumbers: number[],
    labels: PageLabelMap | null | undefined,
    useLabels = true,
): CitedPagesDisplay {
    const pages = [...new Set(pageNumbers.filter(page => Number.isInteger(page) && page > 0))].sort((a, b) => a - b);
    if (pages.length === 0) return { locator: '', reference: '' };
    const physicalAll = formatNumberRanges(pages);
    if (!useLabels || !hasPageLabels(labels)) {
        return { locator: `p.${physicalAll}`, reference: `page ${physicalAll}` };
    }

    const labelled: number[] = [];
    const labelledText: string[] = [];
    const unlabelled: number[] = [];
    for (const page of pages) {
        const { label } = formatPrintedPage(page - 1, labels);
        if (label === null) {
            unlabelled.push(page);
        } else {
            labelled.push(page);
            labelledText.push(label);
        }
    }

    const labelledPart = formatPageRangesWithLabels(labelled, labelledText);
    const unlabelledPart = formatNumberRanges(unlabelled);
    const locator = [
        labelledPart ? `p.${labelledPart}` : '',
        unlabelledPart ? `PDF p.${unlabelledPart}` : '',
    ].filter(Boolean).join(', ');
    const reference = [
        labelledPart ? `page ${labelledPart}` : '',
        unlabelledPart ? `PDF page ${unlabelledPart}` : '',
    ].filter(Boolean).join(', ');
    return { locator, reference };
}
