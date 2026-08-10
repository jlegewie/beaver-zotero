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
    /** Collection keys to search within (OR logic, includes subcollections) */
    collection_keys?: string[];
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
        collection_keys,
        join_mode = 'all',
        limit = 50
    } = options;

    // Builds a search with every condition except the collection scope, so the
    // same query can be run once per collection key.
    const buildSearch = (): Zotero.Search => {
        const search = new Zotero.Search();
        search.addCondition('libraryID', 'is', String(libraryID));

        // Set join mode
        if (join_mode === 'any') {
            search.addCondition('joinMode', 'any');
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

        // Exclude standalone attachments, notes, and annotations so the result limit
        // is applied to regular items only. Negations are only safe under AND join
        // mode; in 'any' mode they would OR in and match the whole library.
        if (join_mode === 'all') {
            search.addCondition('itemType', 'isNot', 'attachment');
            search.addCondition('itemType', 'isNot', 'note');
            search.addCondition('itemType', 'isNot', 'annotation');
        }

        // Tag filters (OR logic)
        if (tags && tags.length > 0) {
            // For tag OR logic, we need to use a subsearch approach or accept that
            // multiple tags with 'all' mode means item must have ALL tags
            // With 'any' mode, we can add multiple tag conditions
            for (const tag of tags) {
                search.addCondition('tag', 'is', tag);
            }
        }

        return search;
    };

    // One search per collection key, unioned. Zotero 10's groupStart/groupEnd
    // could express `query AND (collection A OR B)` in a single search, but
    // addCondition throws on those names in Zotero 7, which is still supported.
    const itemIDSet = new Set<number>();
    if (collection_keys && collection_keys.length > 0) {
        for (const collectionKey of collection_keys) {
            const search = buildSearch();
            search.addCondition('collection', 'is', collectionKey);
            // Collection scope always includes subcollections, matching the other
            // library-browsing tools.
            search.addCondition('recursive', 'true');
            const ids: number[] = await search.search();
            for (const id of ids) {
                itemIDSet.add(id);
            }
        }
    } else {
        const ids: number[] = await buildSearch().search();
        for (const id of ids) {
            itemIDSet.add(id);
        }
    }

    // Zotero returns itemIDs in ascending order; sorting the union preserves
    // that so a truncated page is deterministic instead of depending on Set
    // iteration order.
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

/**
 * Options for tag and collection-based search
 */
export interface SearchItemsByTagsAndCollectionsOptions {
    /** List of tags (OR logic - item must have at least one) */
    tags?: string[];
    /** Collection to search within */
    collection_key?: string;
    /** Search in subcollections */
    recursive?: boolean;
    /** Use a saved search as scope */
    saved_search_key?: string;
    /** Filter by item type */
    item_type?: string;
    /** Only return unfiled items (not in any collection) */
    include_unfiled?: boolean;
    /** Filter by date added (ISO date string or "today", "yesterday") */
    date_added_after?: string;
    /** Filter by modification date (ISO date string or "today", "yesterday") */
    date_modified_after?: string;
    /** Maximum results to return */
    limit?: number;
}

/**
 * Navigate library organization using tags, collections, and saved searches
 * 
 * This function is useful for exploring the library structure and finding items
 * based on organizational metadata rather than content.
 * 
 * @param libraryID - The library to search in
 * @param options - Search parameters
 * @returns Array of matching items
 * 
 * @example
 * // Find recent items tagged "to-read" in a specific collection
 * const results = await searchItemsByTagsAndCollections(userLibraryID, {
 *   tags: ["to-read"],
 *   collection_key: "ABCD1234",
 *   date_added_after: "2024-01-01"
 * });
 */
export const searchItemsByTagsAndCollections = async (
    libraryID: number,
    options: SearchItemsByTagsAndCollectionsOptions
): Promise<Zotero.Item[]> => {
    const {
        tags = [],
        collection_key,
        recursive = false,
        saved_search_key,
        item_type,
        include_unfiled = false,
        date_added_after,
        date_modified_after,
        limit = 50
    } = options;

    const search = new Zotero.Search();
    search.addCondition('libraryID', 'is', String(libraryID));

    // If multiple tags, use OR logic (any tag matches)
    if (tags && tags.length > 0) {
        if (tags.length > 1) {
            search.addCondition('joinMode', 'any');
        }
        for (const tag of tags) {
            search.addCondition('tag', 'is', tag);
        }
    }

    // Collection scope
    if (collection_key) {
        search.addCondition('collection', 'is', collection_key);
        if (recursive) {
            search.addCondition('recursive', 'true');
        }
    }

    // Saved search scope
    if (saved_search_key) {
        search.addCondition('savedSearch', 'is', saved_search_key);
    }

    // Unfiled items
    if (include_unfiled) {
        search.addCondition('unfiled', 'true');
    }

    // Item type filter
    if (item_type) {
        search.addCondition('itemType', 'is', item_type);
    }

    // Date added filter
    if (date_added_after) {
        search.addCondition('dateAdded', 'isAfter', date_added_after);
    }

    // Date modified filter
    if (date_modified_after) {
        search.addCondition('dateModified', 'isAfter', date_modified_after);
    }

    // Execute search
    const itemIDs: number[] = await search.search();

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

/**
 * Helper function to get collection key from collection name
 * Useful when users refer to collections by name rather than key
 * 
 * @param libraryID - The library to search in
 * @param collectionName - Name of the collection
 * @returns Collection key or null if not found
 */
export const getCollectionKeyByName = async (
    libraryID: number,
    collectionName: string
): Promise<string | null> => {
    const collections = Zotero.Collections.getByLibrary(libraryID);
    
    for (const collection of collections) {
        if (collection.name === collectionName) {
            return collection.key;
        }
    }
    
    return null;
};


/**
 * Filters for Zotero item search (used by backend search requests)
 */
export interface ZoteroItemSearchFilters {
    /** Minimum year (inclusive) */
    year_min?: number;
    /** Maximum year (inclusive) */
    year_max?: number;
    /** Filter by item type (e.g., "journalArticle", "book") */
    item_type_filter?: string;
    /** Filter by library IDs (OR logic) */
    libraries_filter?: number[];
    /** Filter by collection keys (OR logic) */
    collections_filter?: string[];
    /** Filter by tags (OR logic) */
    tags_filter?: string[];
    /** Maximum results to return */
    limit?: number;
}

/**
 * Search parameters for topic-based search (title + abstract)
 */
export interface TopicSearchParams {
    /** List of topic phrases to search in title and abstract (OR logic) */
    topic_phrases: string[];
    /** Author name substring match (AND logic with topic) */
    author_query?: string;
    /** Publication name substring match (AND logic with topic) */
    publication_query?: string;
}

/**
 * Search items by topic phrases in title and abstract fields.
 * 
 * This function searches for items where ANY of the topic phrases appear
 * in either the title OR abstract field. Results are deduplicated.
 * If author_query or publication_query are provided, results must match ALL queries (AND logic).
 * 
 * @param libraryIds - Array of library IDs to search across
 * @param params - Search parameters (topic_phrases required, author/publication optional)
 * @param filters - Additional filters to narrow results
 * @returns Array of unique matching items
 * 
 * @example
 * const results = await searchItemsByTopic(
 *   [1, 2],
 *   { topic_phrases: ["machine learning", "ML"] },
 *   { year_min: 2020, item_type_filter: "journalArticle" }
 * );
 */
export const searchItemsByTopic = async (
    libraryIds: number[],
    params: TopicSearchParams,
    filters: ZoteroItemSearchFilters
): Promise<Zotero.Item[]> => {
    const { topic_phrases, author_query, publication_query } = params;
    const {
        year_min,
        year_max,
        item_type_filter,
        collections_filter = [],
        tags_filter = [],
        limit = 50
    } = filters;

    if (!topic_phrases || topic_phrases.length === 0) {
        throw new Error('At least one topic phrase is required');
    }

    // Track unique items by library_id + zotero_key
    const uniqueItems = new Map<string, Zotero.Item>();
    const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;

    // For each library and each topic phrase, search title and abstract
    for (const libraryId of libraryIds) {
        for (const phrase of topic_phrases) {
            if (!phrase.trim()) continue;

            // Search title field
            const titleSearch = new Zotero.Search();
            titleSearch.addCondition('libraryID', 'is', String(libraryId));
            titleSearch.addCondition('title', 'contains', phrase);

            // Apply author query (AND logic)
            if (author_query) {
                titleSearch.addCondition('creator', 'contains', author_query);
            }

            // Apply publication query (AND logic)
            if (publication_query) {
                titleSearch.addCondition('publicationTitle', 'contains', publication_query);
            }

            // Apply year filters
            if (year_min && year_min > 0) {
                titleSearch.addCondition('date', 'isAfter', `${year_min - 1}-12-31`);
            }
            if (year_max && year_max > 0) {
                titleSearch.addCondition('date', 'isBefore', `${year_max + 1}-01-01`);
            }

            // Apply item type filter
            if (item_type_filter) {
                titleSearch.addCondition('itemType', 'is', item_type_filter);
            }

            // Apply collection filters (OR logic)
            if (collections_filter.length > 0) {
                if (collections_filter.length > 1) {
                    titleSearch.addCondition('joinMode', 'any');
                }
                for (const collectionKey of collections_filter) {
                    titleSearch.addCondition('collection', 'is', String(collectionKey));
                }
            }

            // Apply tag filters (OR logic)
            if (tags_filter && tags_filter.length > 0) {
                if (tags_filter.length > 1) {
                    titleSearch.addCondition('joinMode', 'any');
                }
                for (const tag of tags_filter) {
                    titleSearch.addCondition('tag', 'is', tag);
                }
            }

            try {
                const titleItemIDs: number[] = await titleSearch.search();
                if (titleItemIDs.length > 0) {
                    const items: Zotero.Item[] = await Zotero.Items.getAsync(titleItemIDs);
                    for (const item of items) {
                        if (item.isRegularItem() && !item.deleted) {
                            const key = makeKey(item.libraryID, item.key);
                            if (!uniqueItems.has(key)) {
                                uniqueItems.set(key, item);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`searchItemsByTopic: Error searching title in library ${libraryId} with phrase "${phrase}":`, error);
            }

            // Search abstract field
            const abstractSearch = new Zotero.Search();
            abstractSearch.addCondition('libraryID', 'is', String(libraryId));
            abstractSearch.addCondition('abstractNote', 'contains', phrase);

            // Apply same filters to abstract search
            if (author_query) {
                abstractSearch.addCondition('creator', 'contains', author_query);
            }
            if (publication_query) {
                abstractSearch.addCondition('publicationTitle', 'contains', publication_query);
            }
            if (year_min && year_min > 0) {
                abstractSearch.addCondition('date', 'isAfter', `${year_min - 1}-12-31`);
            }
            if (year_max && year_max > 0) {
                abstractSearch.addCondition('date', 'isBefore', `${year_max + 1}-01-01`);
            }
            if (item_type_filter) {
                abstractSearch.addCondition('itemType', 'is', item_type_filter);
            }
            if (collections_filter.length > 0) {
                if (collections_filter.length > 1) {
                    abstractSearch.addCondition('joinMode', 'any');
                }
                for (const collectionKey of collections_filter) {
                    abstractSearch.addCondition('collection', 'is', String(collectionKey));
                }
            }
            if (tags_filter && tags_filter.length > 0) {
                if (tags_filter.length > 1) {
                    abstractSearch.addCondition('joinMode', 'any');
                }
                for (const tag of tags_filter) {
                    abstractSearch.addCondition('tag', 'is', tag);
                }
            }

            try {
                const abstractItemIDs: number[] = await abstractSearch.search();
                if (abstractItemIDs.length > 0) {
                    const items: Zotero.Item[] = await Zotero.Items.getAsync(abstractItemIDs);
                    for (const item of items) {
                        if (item.isRegularItem() && !item.deleted) {
                            const key = makeKey(item.libraryID, item.key);
                            if (!uniqueItems.has(key)) {
                                uniqueItems.set(key, item);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`searchItemsByTopic: Error searching abstract in library ${libraryId} with phrase "${phrase}":`, error);
            }

            // Early exit if we have enough results
            if (limit > 0 && uniqueItems.size >= limit) {
                break;
            }
        }

        // Early exit if we have enough results
        if (limit > 0 && uniqueItems.size >= limit) {
            break;
        }
    }

    // Convert to array and apply limit
    const results = Array.from(uniqueItems.values());
    return limit > 0 ? results.slice(0, limit) : results;
};

/**
 * Search items by author name.
 * 
 * @param libraryIds - Array of library IDs to search across
 * @param author_query - Author name to search for (substring match)
 * @param filters - Additional filters to narrow results
 * @returns Array of unique matching items
 */
export const searchItemsByAuthor = async (
    libraryIds: number[],
    author_query: string,
    filters: ZoteroItemSearchFilters
): Promise<Zotero.Item[]> => {
    const {
        year_min,
        year_max,
        item_type_filter,
        collections_filter = [],
        tags_filter = [],
        limit = 50
    } = filters;

    const uniqueItems = new Map<string, Zotero.Item>();
    const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;

    for (const libraryId of libraryIds) {
        const search = new Zotero.Search();
        search.addCondition('libraryID', 'is', String(libraryId));
        search.addCondition('creator', 'contains', author_query);

        // Apply year filters
        if (year_min && year_min > 0) {
            search.addCondition('date', 'isAfter', `${year_min - 1}-12-31`);
        }
        if (year_max && year_max > 0) {
            search.addCondition('date', 'isBefore', `${year_max + 1}-01-01`);
        }

        // Apply item type filter
        if (item_type_filter) {
            search.addCondition('itemType', 'is', item_type_filter);
        }

        // Apply collection filters (OR logic)
        if (collections_filter.length > 0) {
            if (collections_filter.length > 1) {
                search.addCondition('joinMode', 'any');
            }
            for (const collectionKey of collections_filter) {
                search.addCondition('collection', 'is', String(collectionKey));
            }
        }

        // Apply tag filters (OR logic)
        if (tags_filter && tags_filter.length > 0) {
            if (tags_filter.length > 1) {
                search.addCondition('joinMode', 'any');
            }
            for (const tag of tags_filter) {
                search.addCondition('tag', 'is', tag);
            }
        }

        try {
            const itemIDs: number[] = await search.search();
            if (itemIDs.length > 0) {
                const items: Zotero.Item[] = await Zotero.Items.getAsync(itemIDs);
                for (const item of items) {
                    if (item.isRegularItem() && !item.deleted) {
                        const key = makeKey(item.libraryID, item.key);
                        if (!uniqueItems.has(key)) {
                            uniqueItems.set(key, item);
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`searchItemsByAuthor: Error searching library ${libraryId}:`, error);
        }

        if (limit > 0 && uniqueItems.size >= limit) {
            break;
        }
    }

    const results = Array.from(uniqueItems.values());
    return limit > 0 ? results.slice(0, limit) : results;
};

/**
 * Search items by publication name.
 * 
 * @param libraryIds - Array of library IDs to search across
 * @param publication_query - Publication name to search for (substring match)
 * @param filters - Additional filters to narrow results
 * @returns Array of unique matching items
 */
export const searchItemsByPublication = async (
    libraryIds: number[],
    publication_query: string,
    filters: ZoteroItemSearchFilters
): Promise<Zotero.Item[]> => {
    const {
        year_min,
        year_max,
        item_type_filter,
        collections_filter = [],
        tags_filter = [],
        limit = 50
    } = filters;

    const uniqueItems = new Map<string, Zotero.Item>();
    const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;

    for (const libraryId of libraryIds) {
        const search = new Zotero.Search();
        search.addCondition('libraryID', 'is', String(libraryId));
        search.addCondition('publicationTitle', 'contains', publication_query);

        // Apply year filters
        if (year_min && year_min > 0) {
            search.addCondition('date', 'isAfter', `${year_min - 1}-12-31`);
        }
        if (year_max && year_max > 0) {
            search.addCondition('date', 'isBefore', `${year_max + 1}-01-01`);
        }

        // Apply item type filter
        if (item_type_filter) {
            search.addCondition('itemType', 'is', item_type_filter);
        }

        // Apply collection filters (OR logic)
        if (collections_filter.length > 0) {
            if (collections_filter.length > 1) {
                search.addCondition('joinMode', 'any');
            }
            for (const collectionKey of collections_filter) {
                search.addCondition('collection', 'is', String(collectionKey));
            }
        }

        // Apply tag filters (OR logic)
        if (tags_filter && tags_filter.length > 0) {
            if (tags_filter.length > 1) {
                search.addCondition('joinMode', 'any');
            }
            for (const tag of tags_filter) {
                search.addCondition('tag', 'is', tag);
            }
        }

        try {
            const itemIDs: number[] = await search.search();
            if (itemIDs.length > 0) {
                const items: Zotero.Item[] = await Zotero.Items.getAsync(itemIDs);
                for (const item of items) {
                    if (item.isRegularItem() && !item.deleted) {
                        const key = makeKey(item.libraryID, item.key);
                        if (!uniqueItems.has(key)) {
                            uniqueItems.set(key, item);
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`searchItemsByPublication: Error searching library ${libraryId}:`, error);
        }

        if (limit > 0 && uniqueItems.size >= limit) {
            break;
        }
    }

    const results = Array.from(uniqueItems.values());
    return limit > 0 ? results.slice(0, limit) : results;
};



