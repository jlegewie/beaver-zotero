/** Display labels for Zotero item fields whose camelCase name reads poorly. */
const FIELD_LABELS: Record<string, string> = {
    abstractNote: 'Abstract',
    accessDate: 'Accessed',
    publicationTitle: 'Publication',
    DOI: 'DOI',
    ISBN: 'ISBN',
    ISSN: 'ISSN',
    url: 'URL',
    shortTitle: 'Short Title',
    seriesNumber: 'Series Number',
    seriesTitle: 'Series Title',
    archiveLocation: 'Archive Location',
    callNumber: 'Call Number',
};

/** Format a field name for display (camelCase -> Title Case). */
export function formatFieldName(field: string): string {
    if (FIELD_LABELS[field]) {
        return FIELD_LABELS[field];
    }
    return field
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, (str) => str.toUpperCase())
        .trim();
}
