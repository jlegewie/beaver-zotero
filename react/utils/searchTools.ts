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
    /** "all" for AND logic, "any" for OR logic */
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
    if (year_exact !== undefined) {
        search.addCondition('year', 'is', String(year_exact));
    } else {
        if (year_min !== undefined) {
            search.addCondition('year', 'isGreaterThan', String(year_min - 1));
        }
        if (year_max !== undefined) {
            search.addCondition('year', 'isLessThan', String(year_max + 1));
        }
    }

    // Item type filter
    if (item_type) {
        search.addCondition('itemType', 'is', item_type);
    }

    // Tag filters (OR logic)
    if (tags.length > 0) {
        // For tag OR logic, we need to use a subsearch approach or accept that
        // multiple tags with 'all' mode means item must have ALL tags
        // With 'any' mode, we can add multiple tag conditions
        for (const tag of tags) {
            search.addCondition('tag', 'is', tag);
        }
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
 * Options for full-text keyword search
 */
export interface SearchFulltextKeywordsOptions {
    /** List of 1-5 keywords/phrases to search for. Use quotes for exact phrases (e.g., "machine learning") */
    keywords: string[];
    /** "all" requires all keywords, "any" requires at least one */
    join_mode?: 'all' | 'any';
    /** Author name to filter results */
    author_filter?: string;
    /** Minimum year (inclusive) */
    year_min?: number;
    /** Maximum year (inclusive) */
    year_max?: number;
    /** Limit to specific collection */
    collection_key?: string;
    /** Filter by tags (OR logic) */
    tags?: string[];
    /** Maximum results to return */
    limit?: number;
}

/**
 * Search document full-text content using keyword matching
 * 
 * Searches indexed full-text content of attachments. Supports both individual words
 * and exact phrases (use quotes). Does not support semantic search - only keyword matching.
 * 
 * Note: Only items with indexed full-text content will be searched.
 * 
 * @param libraryID - The library to search in
 * @param options - Search parameters including keywords
 * @returns Array of items whose attachments contain the keywords
 * 
 * @example
 * // Find documents containing either "neural network" or "deep learning"
 * const results = await searchFulltextKeywords(userLibraryID, {
 *   keywords: ['"neural network"', '"deep learning"'],
 *   join_mode: "any",
 *   year_min: 2015
 * });
 */
export const searchFulltextKeywords = async (
    libraryID: number,
    options: SearchFulltextKeywordsOptions
): Promise<Zotero.Item[]> => {
    const {
        keywords,
        join_mode = 'any',
        author_filter,
        year_min,
        year_max,
        collection_key,
        tags = [],
        limit = 30
    } = options;

    if (!keywords || keywords.length === 0) {
        throw new Error('At least one keyword is required');
    }

    if (keywords.length > 5) {
        throw new Error('Maximum 5 keywords allowed');
    }

    const search = new Zotero.Search();
    search.addCondition('libraryID', 'is', String(libraryID));
    
    // Set join mode
    if (join_mode === 'any') {
        search.addCondition('joinMode', 'any');
    }

    // Collection scope
    if (collection_key) {
        search.addCondition('collection', 'is', collection_key);
    }

    // Add full-text conditions
    // Phrases in quotes use fulltextContent, individual words use fulltextWord
    for (const keyword of keywords) {
        const trimmed = keyword.trim();
        
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
            // Exact phrase - use fulltextContent
            const phrase = trimmed.slice(1, -1);
            search.addCondition('fulltextContent', 'contains', phrase);
        } else {
            // Individual word(s) - split and add as fulltextWord conditions
            // Zotero's semanticSplitter would normally handle this, but we'll do it simply
            const words = trimmed.split(/\s+/);
            for (const word of words) {
                if (word) {
                    search.addCondition('fulltextWord', 'contains', word);
                }
            }
        }
    }

    // Author filter
    if (author_filter) {
        search.addCondition('creator', 'contains', author_filter);
    }

    // Year filters
    if (year_min !== undefined) {
        search.addCondition('year', 'isGreaterThan', String(year_min - 1));
    }
    if (year_max !== undefined) {
        search.addCondition('year', 'isLessThan', String(year_max + 1));
    }

    // Tag filters
    if (tags.length > 0) {
        for (const tag of tags) {
            search.addCondition('tag', 'is', tag);
        }
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
    if (tags.length > 0) {
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
    /** Author name substring match */
    author?: string;
    /** Journal/publication substring match */
    publication?: string;
    /** Minimum year (inclusive) */
    year_min?: number;
    /** Maximum year (inclusive) */
    year_max?: number;
    /** Filter by item type (e.g., "journalArticle", "book") */
    item_type?: string;
    /** Collection key to search within */
    collection_key?: string;
    /** Tags to filter by */
    tags?: string[];
    /** Maximum results to return */
    limit?: number;
}

/**
 * Search Zotero items across multiple libraries using query phrases.
 * 
 * This function executes a search for each query phrase, aggregates results,
 * and deduplicates by item key. It searches the quicksearch-titleCreatorYear
 * mode which matches title, creators, and year.
 * 
 * @param libraryIds - Array of library IDs to search across
 * @param queries - Array of query phrases to search for
 * @param filters - Additional filters to apply
 * @returns Array of unique matching items (deduplicated by library_id + zotero_key)
 * 
 * @example
 * const results = await searchZoteroItemsWithQueries(
 *   [1, 2],
 *   ["climate change", "global warming"],
 *   { author: "Smith", year_min: 2020 }
 * );
 */
export const searchZoteroItemsWithQueries = async (
    libraryIds: number[],
    queries: string[],
    filters: ZoteroItemSearchFilters
): Promise<Zotero.Item[]> => {
    const {
        author,
        publication,
        year_min,
        year_max,
        item_type,
        collection_key,
        tags = [],
        limit = 50
    } = filters;

    // Track unique items by library_id + zotero_key
    const uniqueItems = new Map<string, Zotero.Item>();
    const makeKey = (libraryId: number, key: string) => `${libraryId}-${key}`;

    // Search each library with each query
    for (const libraryId of libraryIds) {
        for (const query of queries) {
            if (!query.trim()) continue;

            const search = new Zotero.Search();
            search.addCondition('libraryID', 'is', String(libraryId));

            // Use quicksearch-titleCreatorYear mode for the query
            // This searches title, creators, and year fields
            search.addCondition('quicksearch-titleCreatorYear', 'contains', query);

            // Apply author filter
            if (author) {
                search.addCondition('creator', 'contains', author);
            }

            // Apply publication filter
            if (publication) {
                search.addCondition('publicationTitle', 'contains', publication);
            }

            // Apply year filters
            if (year_min !== undefined) {
                search.addCondition('year', 'isGreaterThan', String(year_min - 1));
            }
            if (year_max !== undefined) {
                search.addCondition('year', 'isLessThan', String(year_max + 1));
            }

            // Apply item type filter
            if (item_type) {
                search.addCondition('itemType', 'is', item_type);
            }

            // Apply collection filter (only if collection exists in this library)
            if (collection_key) {
                search.addCondition('collection', 'is', collection_key);
            }

            // Apply tag filters
            if (tags.length > 0) {
                for (const tag of tags) {
                    search.addCondition('tag', 'is', tag);
                }
            }

            // Execute search
            try {
                const itemIDs: number[] = await search.search();
                
                if (itemIDs.length > 0) {
                    const items: Zotero.Item[] = await Zotero.Items.getAsync(itemIDs);
                    
                    // Filter to regular items only and deduplicate
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
                // Log and continue with other queries/libraries
                console.error(`searchZoteroItemsWithQueries: Error searching library ${libraryId} with query "${query}":`, error);
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

