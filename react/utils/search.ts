import { logger } from '../../src/utils/logger';


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
    collectionIds?: number[]
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
        const filteredItems = collectionIds && collectionIds.length > 0
            ? items.filter(item => item.getCollections().some(collection => collectionIds.includes(collection)))
            : items;

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
    const queryLower = query.toLowerCase();
    let score = 0;
    
    // Get item data
    const title = item.getField('title')?.toLowerCase() || '';
    const creators = item.getCreators();
    const year = item.getField('date') || '';
    
    // Perfect matches get highest scores
    const titleExactMatch = title === queryLower;
    const authorExactMatch = creators.some(creator => {
        const lastName = creator.lastName?.toLowerCase() || '';
        const firstName = creator.firstName?.toLowerCase() || '';
        const fullName = `${firstName} ${lastName}`.trim();
        return lastName === queryLower || firstName === queryLower || fullName === queryLower;
    });
    
    if (titleExactMatch) score += 1000;
    if (authorExactMatch) score += 900;
    
    // Starts with matches (high priority)
    const titleStartsWith = title.startsWith(queryLower);
    const authorStartsWith = creators.some(creator => {
        const lastName = creator.lastName?.toLowerCase() || '';
        const firstName = creator.firstName?.toLowerCase() || '';
        return lastName.startsWith(queryLower) || firstName.startsWith(queryLower);
    });
    
    if (titleStartsWith) score += 500;
    if (authorStartsWith) score += 600; // Author matches weighted higher
    
    // Word boundary matches (medium priority)
    const titleWordMatch = new RegExp(`\\b${queryLower}`, 'i').test(title);
    const authorWordMatch = creators.some(creator => {
        const lastName = creator.lastName || '';
        const firstName = creator.firstName || '';
        const fullName = `${firstName} ${lastName}`;
        return new RegExp(`\\b${queryLower}`, 'i').test(fullName);
    });
    
    if (titleWordMatch) score += 200;
    if (authorWordMatch) score += 300; // Author matches weighted higher
    
    // Contains matches (lower priority)
    const titleContains = title.includes(queryLower);
    const authorContains = creators.some(creator => {
        const lastName = creator.lastName?.toLowerCase() || '';
        const firstName = creator.firstName?.toLowerCase() || '';
        return lastName.includes(queryLower) || firstName.includes(queryLower);
    });
    
    if (titleContains) score += 50;
    if (authorContains) score += 100; // Author matches weighted higher
    
    // Year match bonus
    if (year.includes(queryLower)) {
        score += 150;
    }
    
    // Boost for regular items over attachments/notes
    if (item.isRegularItem()) {
        score += 10;
    }
    
    return score;
};
