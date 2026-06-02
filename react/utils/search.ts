import { logger } from '../../src/utils/logger';
import { ZoteroTag } from '../types/zotero';


/**
 * Searches for Zotero items by a single term across Title, Creator, and Year fields
 * in the currently selected library. Mimics the "Title, Creator, Year" quick search option.
 *
 * @param searchTerm - The term to search for across title, creator, and year fields.
 * @returns A promise that resolves to an array of Zotero.Item objects matching the criteria.
 */
export async function searchTitleCreatorYear(
    searchTerm: string,
    libraryIds?: number[],
    collectionIds?: number[],
    tags?: ZoteroTag[]
): Promise<Zotero.Item[]> {
    // If no search term is provided, return an empty array.
    if (!searchTerm || searchTerm.trim() === "") {
        logger("searchTitleCreatorYear: No search term provided.")
        Zotero.debug("searchTitleCreatorYear: No search term provided.", 2);
        return [];
    }

    try {
        const search = new Zotero.Search();
        search.addCondition('joinMode', 'any');
        
        // Set the search scope to the currently selected library.
        // Add library conditions as non-required (will be OR-ed together)
        for (const libraryID of libraryIds ?? []) {
            search.addCondition('libraryID', 'is', libraryID, false); // false = not required
        }

        // Use 'quicksearch-titleCreatorYear' condition.
        // This internally creates an OR search across title-related fields,
        // creator fields, and the year field.
        search.addCondition('quicksearch-titleCreatorYear', 'contains', searchTerm, true);

        // Execute the search
        const itemIDs: number[] = await search.search();

        if (!itemIDs || itemIDs.length === 0) {
            return [];
        }

        // Retrieve the full Zotero.Item objects
        const items: Zotero.Item[] = await Zotero.Items.getAsync(itemIDs);

        // Filter items by collection IDs
        const filteredByCollection = collectionIds && collectionIds.length > 0
            ? items.filter(item => item.getCollections().some(collection => collectionIds.includes(collection)))
            : items;

        const filteredItems = tags && tags.length > 0
            ? filteredByCollection.filter(item => {
                const itemTags = item.getTags();
                if (!itemTags || itemTags.length === 0) {
                    return false;
                }
                return tags.some((tag) => {
                    if (item.libraryID !== tag.libraryId) {
                        return false;
                    }
                    return itemTags.some((itemTag: { tag?: string }) => itemTag.tag === tag.tag);
                });
            })
            : filteredByCollection;

        logger(`searchTitleCreatorYear: Found ${filteredItems.length} items: ${filteredItems.map(item => item.id).join(', ')}`)
        return filteredItems;

    } catch (error: any) {
        // Log any errors that occur during the search process.
        logger(`searchTitleCreatorYear [ERROR]: ${error}`)
        Zotero.logError(error);
        return [];
    }
}


/**
 * Scores a Zotero item based on the search query.
 * 
 * @param item - The Zotero item to score.
 * @param query - The search query to score the item against.
 * @returns A score for the item based on the search query.
 */
export const scoreSearchResult = (item: Zotero.Item, query: string): number => {
    const normalizedQuery = normalizeSearchText(query);
    const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryTerms.length === 0) {
        return 0;
    }

    const searchableText = getRankedMetadataText(item);
    if (!searchableText) {
        return 0;
    }

    const phraseIndex = searchableText.indexOf(normalizedQuery);
    const termIndexes = queryTerms
        .map((term) => searchableText.indexOf(term))
        .filter((index) => index >= 0);

    if (phraseIndex < 0 && termIndexes.length === 0) {
        return 0;
    }

    const allTermsMatched = termIndexes.length === queryTerms.length;
    const bestMatchIndex = phraseIndex >= 0
        ? phraseIndex
        : Math.min(...termIndexes);
    const boundedMatchIndex = Math.min(bestMatchIndex, 100_000);
    const publicationYear = getPublicationYear(item) ?? 0;
    const completenessScore = allTermsMatched ? 2_000_000_000 : termIndexes.length * 10_000_000;
    const positionScore = (100_000 - boundedMatchIndex) * 10_000;
    const itemTypeScore = item.isRegularItem() ? 1 : 0;

    return completenessScore + positionScore + publicationYear + itemTypeScore;
};

/**
 * Builds the ordered metadata text used for source-menu ranking.
 */
const getRankedMetadataText = (item: Zotero.Item): string => {
    const creatorText = item.getCreators()
        .map((creator) => {
            const firstName = creator.firstName || '';
            const lastName = creator.lastName || '';
            return `${lastName} ${firstName} ${firstName} ${lastName}`.trim();
        })
        .filter(Boolean)
        .join(' ');
    const year = getPublicationYear(item)?.toString() || '';
    const title = item.getField('title') || '';

    return normalizeSearchText([creatorText, year, title].filter(Boolean).join(' '));
};

/**
 * Normalizes metadata and query text before ranking comparisons.
 */
const normalizeSearchText = (text: string): string => {
    let normalized = text.toLowerCase();
    try {
        normalized = Zotero.Utilities.removeDiacritics(normalized);
    } catch {
        // Some Zotero contexts expose a smaller utility surface.
    }
    return normalized.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
};

/**
 * Extracts the first four-digit year from an item's date field.
 */
const getPublicationYear = (item: Zotero.Item): number | undefined => {
    const date = item.getField('date') || '';
    const year = date.match(/\b(\d{4})\b/)?.[1];
    return year ? parseInt(year, 10) : undefined;
};
