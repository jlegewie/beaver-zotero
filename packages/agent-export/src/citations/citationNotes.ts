/**
 * What a cited work carries besides its identity: locator (with its type),
 * prefix, suffix, and whether the author is left out. One shape across the
 * pipeline — note citation items, processor items, Word fields, LaTeX.
 */

export interface CitationNotes {
    locator?: string;
    /** CSL locator type; absent means page. */
    label?: string;
    prefix?: string;
    suffix?: string;
    suppressAuthor?: boolean;
}

/**
 * The notes that are set, and only those (a label only with a locator).
 * `labelDefault` names the locator type of a locator given without one.
 */
export function citationNotes(item: CitationNotes, options: { labelDefault?: string } = {}): CitationNotes {
    const label = item.label ?? options.labelDefault;
    return {
        ...(item.locator ? { locator: item.locator, ...(label ? { label } : {}) } : {}),
        ...(item.prefix ? { prefix: item.prefix } : {}),
        ...(item.suffix ? { suffix: item.suffix } : {}),
        ...(item.suppressAuthor ? { suppressAuthor: true } : {}),
    };
}

/** The notes as CSL citation-item fields, for citeproc and Zotero's citation JSON (`label` defaults to page). */
export function cslCitationNotes(item: CitationNotes): Record<string, string | boolean> {
    const { suppressAuthor, ...rest } = citationNotes(item, { labelDefault: 'page' });
    return { ...rest, ...(suppressAuthor ? { 'suppress-author': true } : {}) };
}
