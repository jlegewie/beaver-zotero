import { ItemMetadata } from "../types/document";

/**
 * Get the authors of a Zotero item
 * @param item - The Zotero item
 * @returns A string of authors separated by a semicolon
 */
export function getAuthors(item: Zotero.Item) {
    return item.getCreatorsJSON()
        .filter(creator => creator.creatorType === "author")
        .map(author => `${author.lastName}, ${author.firstName}`)
        .join("; ")
}

/**
 * Get the identifiers of a Zotero item
 * @param item - The Zotero item
 * @returns A string of identifiers separated by a semicolon
 */
export function getIdentifiers(item: Zotero.Item) {
    const identifierMap = {
        'DOI': 'doi',
        'ISBN': 'isbn',
        'ISSN': 'issn',
        'archiveID': 'archiveId',
        'PMID': 'pmid',
        'ADS Bibcode': 'bibcode'
    };

    return Object.entries(identifierMap)
        .map(([zoteroField, prefix]) => {
            const value = item.getField(zoteroField);
            return value ? `${prefix}:${value}` : null;
        })
        .filter(id => id !== null)
        .join("; ");
}

/**
 * Get the metadata of a Zotero item
 * @param item - The Zotero item
 * @returns The metadata of the item as an ItemMetadata object
 */
export function getMetadata(item: Zotero.Item): ItemMetadata {
    return {
        itemId: item.id,
        title: item.getField('title'),
        abstract: item.getField('abstractNote'),
        year: parseInt(item.getField('year')) || undefined,
        authors: getAuthors(item) || undefined,
        publication: item.getField('publicationTitle'),
        itemType: item.itemType,
        identifiers: getIdentifiers(item)
    } as ItemMetadata;
}
