/**
 * Search tools for AI agent to query Zotero library using native search capabilities
 */

/**
 * Options for metadata-based item search
 */
export interface SearchItemsByMetadataOptions {
    /** Text to search in title field (substring match) */
    title_query?: string;
    /** Author name to search (substring match, searches creator field) */
    author_query?: string;
    /** Journal/publication name (searches publicationTitle field) */
    publication_query?: string;
    /** Minimum year (inclusive) */
    year_min?: number;
    /** Maximum year (inclusive) */
    year_max?: number;
    /** Exact year match */
    year_exact?: number;
    /** Filter by item type (e.g., "journalArticle", "book", "conferencePaper") */
    item_type?: string;
    /** List of tags to filter by (OR logic - item must have at least one tag) */
    tags?: string[];
    /** Collection key to search within */
    collection_key?: string;
    /** If true, search recursively in subcollections */
    recursive?: boolean;
    /**
     * "all" for AND logic, "any" for OR logic.
     *
     * Use "any" only when every condition below is genuinely optional.
     */
    join_mode?: 'all' | 'any';
    /** Maximum results to return */
    limit?: number;
}

/**
 * Search items by metadata fields (title, author, year, publication, etc.)
 * 
 * This function creates a Zotero search with conditions based on the provided options.
 * All text searches are case-insensitive substring matches unless specified otherwise.
 * 
 * @param libraryID - The library to search in
 * @param options - Search parameters
 * @returns Array of matching items with full data loaded
 * 
 * @example
 * // Find articles by Smith published after 2020 with "climate" in title
 * const results = await searchItemsByMetadata(userLibraryID, {
 *   author_query: "Smith",
 *   title_query: "climate",
 *   year_min: 2020,
 *   item_type: "journalArticle"
 * });
 */
export const searchItemsByMetadata = async (
    libraryID: number,
    options: SearchItemsByMetadataOptions
): Promise<Zotero.Item[]> => {
    const {
        title_query,
        author_query,
        publication_query,
        year_min,
        year_max,
        year_exact,
        item_type,
        tags = [],
        collection_key,
        recursive = false,
        join_mode = 'all',
        limit = 50
    } = options;

    const search = new Zotero.Search();
    search.addCondition('libraryID', 'is', String(libraryID));
    
    // Set join mode
    if (join_mode === 'any') {
        search.addCondition('joinMode', 'any');
    }

    // Collection scope
    if (collection_key) {
        search.addCondition('collection', 'is', collection_key);
        if (recursive) {
            search.addCondition('recursive', 'true');
        }
    }

    // Title search
    if (title_query) {
        search.addCondition('title', 'contains', title_query);
    }

    // Author/Creator search
    if (author_query) {
        search.addCondition('creator', 'contains', author_query);
    }

    // Publication search
    if (publication_query) {
        search.addCondition('publicationTitle', 'contains', publication_query);
    }

    // Year filters
    if (year_exact && year_exact > 0) {
        search.addCondition('year', 'is', String(year_exact));
    } else {
        if (year_min && year_min > 0) {
            search.addCondition('date', 'isAfter', `${year_min - 1}-12-31`);
        }
        if (year_max && year_max > 0) {
            search.addCondition('date', 'isBefore', `${year_max + 1}-01-01`);
        }
    }

    // Item type filter
    if (item_type) {
        search.addCondition('itemType', 'is', item_type);
    }

    // Each tag gets its own clone of the base AND search so tags are OR'd
    // without making the library and metadata conditions optional.
    const searches = tags.length > 0
        ? Array.from(new Set(tags), tag => {
            const tagSearch = search.clone(libraryID);
            tagSearch.addCondition('tag', 'is', tag);
            return tagSearch.search();
        })
        : [search.search()];
    const searchResults = await Promise.all(searches);
    const itemIDSet = new Set<number>();
    for (const result of searchResults) {
        for (const itemID of result) {
            itemIDSet.add(itemID);
        }
    }
    const itemIDs = Array.from(itemIDSet).sort((a, b) => a - b);

    // Apply limit
    const limitedIDs = limit > 0 ? itemIDs.slice(0, limit) : itemIDs;

    if (limitedIDs.length === 0) {
        return [];
    }

    // Load items with full data
    const items: Zotero.Item[] = await Zotero.Items.getAsync(limitedIDs);
    
    if (items.length > 0) {
        await Zotero.Items.loadDataTypes(items, ["itemData", "creators", "childItems"]);
    }

    return items;
};
