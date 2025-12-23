/**
 * Enhanced search tools with fallback strategy for better keyword matching
 * 
 * These tools implement a query_primary/query_fallback pattern to account for
 * the lack of semantic search in Zotero. They try specific terms first, then
 * fall back to broader queries if needed.
 */

/**
 * Result from a search with fallback strategy
 */
export interface SearchResultWithTier<T> {
    /** The matching items */
    items: T[];
    /** Which query tier produced results: "primary", "fallback", or "none" */
    matched_tier: 'primary' | 'fallback' | 'none';
    /** The specific query that produced results (if any) */
    matched_query?: string;
}

/**
 * Options for metadata search with fallback strategy
 */
export interface SearchMetadataWithFallbackOptions {
    /** 2-3 short literal phrases (2-6 words) representing the same concept with terminology variations */
    query_primary?: string[];
    /** 1-2 broader backup queries (1-3 words) if primary returns nothing */
    query_fallback?: string[];
    /** Which field to search with the query terms: "title", "any" (all fields), "abstract" */
    query_target?: 'title' | 'any' | 'abstract';
    /** Author name to filter results */
    author_query?: string;
    /** Journal/publication name */
    publication_query?: string;
    /** Minimum year (inclusive) */
    year_min?: number;
    /** Maximum year (inclusive) */
    year_max?: number;
    /** Exact year match */
    year_exact?: number;
    /** Filter by item type */
    item_type?: string;
    /** List of tags to filter by */
    tags?: string[];
    /** Collection key to search within */
    collection_key?: string;
    /** Search recursively in subcollections */
    recursive?: boolean;
    /** Maximum results to return per query attempt */
    limit?: number;
}

/**
 * Search items by metadata with fallback strategy for keyword variations
 * 
 * Tries multiple query variations to account for terminology differences:
 * 1. Tries each primary query (specific phrases, 2-6 words)
 * 2. If no results, tries fallback queries (broader terms, 1-3 words)
 * 
 * This approach helps find relevant items even when exact terminology is unknown.
 * 
 * @param libraryID - The library to search in
 * @param options - Search parameters with query tiers
 * @returns Results with indication of which query tier matched
 * 
 * @example
 * // Try specific phrases first, fall back to broader terms
 * const result = await searchMetadataWithFallback(userLibraryID, {
 *   query_primary: [
 *     "systematic literature review",
 *     "systematic review methodology",
 *     "meta-analytic approach"
 *   ],
 *   query_fallback: ["systematic review", "meta-analysis"],
 *   query_target: "title",
 *   year_min: 2020
 * });
 * 
 * if (result.matched_tier === "primary") {
 *   console.log(`Found ${result.items.length} items using: ${result.matched_query}`);
 * }
 */
export const searchMetadataWithFallback = async (
    libraryID: number,
    options: SearchMetadataWithFallbackOptions
): Promise<SearchResultWithTier<Zotero.Item>> => {
    const {
        query_primary = [],
        query_fallback = [],
        query_target = 'title',
        author_query,
        publication_query,
        year_min,
        year_max,
        year_exact,
        item_type,
        tags = [],
        collection_key,
        recursive = false,
        limit = 50
    } = options;

    // Helper to build and execute a search with given query term
    const executeSearch = async (queryTerm: string): Promise<Zotero.Item[]> => {
        const search = new Zotero.Search();
        search.addCondition('libraryID', 'is', String(libraryID));

        // Add query condition based on target field
        if (query_target === 'title') {
            search.addCondition('title', 'contains', queryTerm);
        } else if (query_target === 'abstract') {
            // Note: abstractNote is the field name in Zotero
            search.addCondition('abstractNote', 'contains', queryTerm);
        } else if (query_target === 'any') {
            search.addCondition('anyField', 'contains', queryTerm);
        }

        // Add all other filters
        if (author_query) {
            search.addCondition('creator', 'contains', author_query);
        }

        if (publication_query) {
            search.addCondition('publicationTitle', 'contains', publication_query);
        }

        if (collection_key) {
            search.addCondition('collection', 'is', collection_key);
            if (recursive) {
                search.addCondition('recursive', 'true');
            }
        }

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

        if (item_type) {
            search.addCondition('itemType', 'is', item_type);
        }

        // Add tags (with AND logic since all filters are ANDed)
        for (const tag of tags) {
            search.addCondition('tag', 'is', tag);
        }

        // Execute search
        const itemIDs: number[] = await search.search();
        const limitedIDs = limit > 0 ? itemIDs.slice(0, limit) : itemIDs;

        if (limitedIDs.length === 0) {
            return [];
        }

        const items: Zotero.Item[] = await Zotero.Items.getAsync(limitedIDs);
        if (items.length > 0) {
            await Zotero.Items.loadDataTypes(items, ["itemData", "creators", "childItems"]);
        }

        return items;
    };

    // Try primary queries first
    for (const query of query_primary) {
        const items = await executeSearch(query);
        if (items.length > 0) {
            return {
                items,
                matched_tier: 'primary',
                matched_query: query
            };
        }
    }

    // If no results from primary, try fallback queries
    for (const query of query_fallback) {
        const items = await executeSearch(query);
        if (items.length > 0) {
            return {
                items,
                matched_tier: 'fallback',
                matched_query: query
            };
        }
    }

    // No results from any query
    return {
        items: [],
        matched_tier: 'none'
    };
};

/**
 * Options for fulltext search with fallback strategy
 */
export interface SearchFulltextWithFallbackOptions {
    /** 2-3 short literal phrases (2-6 words) to search for. Use quotes for exact matches. */
    query_primary: string[];
    /** 1-2 broader backup queries (1-3 words) if primary returns nothing */
    query_fallback?: string[];
    /** Author name to filter results */
    author_filter?: string;
    /** Minimum year (inclusive) */
    year_min?: number;
    /** Maximum year (inclusive) */
    year_max?: number;
    /** Limit to specific collection */
    collection_key?: string;
    /** Filter by tags */
    tags?: string[];
    /** Maximum results to return per query attempt */
    limit?: number;
}

/**
 * Search document full-text with fallback strategy for terminology variations
 * 
 * Tries multiple keyword variations to find documents:
 * 1. Tries each primary query (specific phrases/terms)
 * 2. If no results, tries fallback queries (broader terms)
 * 
 * This is especially useful when searching for concepts that can be expressed
 * in multiple ways (e.g., "random controlled trial" vs "RCT" vs "randomized experiment").
 * 
 * @param libraryID - The library to search in
 * @param options - Search parameters with query tiers
 * @returns Results with indication of which query tier matched
 * 
 * @example
 * // Search for methodology concepts with variations
 * const result = await searchFulltextWithFallback(userLibraryID, {
 *   query_primary: [
 *     '"grounded theory methodology"',
 *     '"grounded theory approach"',
 *     '"constant comparative method"'
 *   ],
 *   query_fallback: ['"grounded theory"', 'qualitative coding'],
 *   year_min: 2015
 * });
 */
export const searchFulltextWithFallback = async (
    libraryID: number,
    options: SearchFulltextWithFallbackOptions
): Promise<SearchResultWithTier<Zotero.Item>> => {
    const {
        query_primary,
        query_fallback = [],
        author_filter,
        year_min,
        year_max,
        collection_key,
        tags = [],
        limit = 30
    } = options;

    if (!query_primary || query_primary.length === 0) {
        throw new Error('At least one primary query is required');
    }

    // Helper to execute a fulltext search with given keywords
    const executeSearch = async (keywords: string[]): Promise<Zotero.Item[]> => {
        const search = new Zotero.Search();
        search.addCondition('libraryID', 'is', String(libraryID));

        if (collection_key) {
            search.addCondition('collection', 'is', collection_key);
        }

        // Add fulltext conditions
        for (const keyword of keywords) {
            const trimmed = keyword.trim();
            
            if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
                // Exact phrase - use fulltextContent
                const phrase = trimmed.slice(1, -1);
                search.addCondition('fulltextContent', 'contains', phrase);
            } else {
                // Individual word(s) - split and add as fulltextWord conditions
                const words = trimmed.split(/\s+/);
                for (const word of words) {
                    if (word) {
                        search.addCondition('fulltextWord', 'contains', word);
                    }
                }
            }
        }

        // Add filters
        if (author_filter) {
            search.addCondition('creator', 'contains', author_filter);
        }

        if (year_min !== undefined) {
            search.addCondition('year', 'isGreaterThan', String(year_min - 1));
        }
        if (year_max !== undefined) {
            search.addCondition('year', 'isLessThan', String(year_max + 1));
        }

        for (const tag of tags) {
            search.addCondition('tag', 'is', tag);
        }

        // Execute search
        const itemIDs: number[] = await search.search();
        const limitedIDs = limit > 0 ? itemIDs.slice(0, limit) : itemIDs;

        if (limitedIDs.length === 0) {
            return [];
        }

        const items: Zotero.Item[] = await Zotero.Items.getAsync(limitedIDs);
        if (items.length > 0) {
            await Zotero.Items.loadDataTypes(items, ["itemData", "creators", "childItems"]);
        }

        return items;
    };

    // Try each primary query individually first
    for (const query of query_primary) {
        const items = await executeSearch([query]);
        if (items.length > 0) {
            return {
                items,
                matched_tier: 'primary',
                matched_query: query
            };
        }
    }

    // If no results from primary, try fallback queries
    for (const query of query_fallback) {
        const items = await executeSearch([query]);
        if (items.length > 0) {
            return {
                items,
                matched_tier: 'fallback',
                matched_query: query
            };
        }
    }

    // No results from any query
    return {
        items: [],
        matched_tier: 'none'
    };
};

/**
 * Options for combined metadata + fulltext search with comprehensive fallback
 */
export interface SearchCombinedWithFallbackOptions {
    /** Concept or topic to search for - will generate variations automatically */
    concept: string;
    /** 2-3 specific phrases to search in metadata/fulltext (manual variations) */
    query_primary_metadata?: string[];
    /** 1-2 broader terms for metadata fallback */
    query_fallback_metadata?: string[];
    /** 2-3 specific phrases for fulltext search */
    query_primary_fulltext?: string[];
    /** 1-2 broader terms for fulltext fallback */
    query_fallback_fulltext?: string[];
    /** Search metadata first (faster) before fulltext */
    try_metadata_first?: boolean;
    /** Author name filter */
    author_filter?: string;
    /** Minimum year */
    year_min?: number;
    /** Maximum year */
    year_max?: number;
    /** Collection key */
    collection_key?: string;
    /** Maximum results */
    limit?: number;
}

/**
 * Combined metadata and fulltext search with comprehensive fallback strategy
 * 
 * This is the most comprehensive search tool, trying multiple strategies:
 * 1. Metadata search with primary queries
 * 2. Metadata search with fallback queries
 * 3. Fulltext search with primary queries
 * 4. Fulltext search with fallback queries
 * 
 * @param libraryID - The library to search in
 * @param options - Search parameters with multiple query tiers
 * @returns Results with indication of which strategy succeeded
 * 
 * @example
 * // Comprehensive search for a concept
 * const result = await searchCombinedWithFallback(userLibraryID, {
 *   query_primary_metadata: [
 *     "structural equation modeling",
 *     "structural equation modelling",
 *     "SEM analysis"
 *   ],
 *   query_fallback_metadata: ["SEM", "path analysis"],
 *   query_primary_fulltext: [
 *     '"structural equation model"',
 *     '"covariance structure analysis"'
 *   ],
 *   query_fallback_fulltext: ['"path model"', 'LISREL'],
 *   try_metadata_first: true,
 *   year_min: 2010
 * });
 */
export const searchCombinedWithFallback = async (
    libraryID: number,
    options: SearchCombinedWithFallbackOptions
): Promise<SearchResultWithTier<Zotero.Item> & { search_type: 'metadata' | 'fulltext' }> => {
    const {
        query_primary_metadata = [],
        query_fallback_metadata = [],
        query_primary_fulltext = [],
        query_fallback_fulltext = [],
        try_metadata_first = true,
        author_filter,
        year_min,
        year_max,
        collection_key,
        limit = 30
    } = options;

    const commonFilters = {
        author_filter,
        year_min,
        year_max,
        collection_key,
        limit
    };

    // Strategy 1: Try metadata search
    if (try_metadata_first && (query_primary_metadata.length > 0 || query_fallback_metadata.length > 0)) {
        const metadataResult = await searchMetadataWithFallback(libraryID, {
            query_primary: query_primary_metadata,
            query_fallback: query_fallback_metadata,
            query_target: 'title',
            author_query: author_filter,
            year_min,
            year_max,
            collection_key,
            limit
        });

        if (metadataResult.matched_tier !== 'none') {
            return {
                ...metadataResult,
                search_type: 'metadata'
            };
        }
    }

    // Strategy 2: Try fulltext search
    if (query_primary_fulltext.length > 0 || query_fallback_fulltext.length > 0) {
        const fulltextResult = await searchFulltextWithFallback(libraryID, {
            query_primary: query_primary_fulltext,
            query_fallback: query_fallback_fulltext,
            ...commonFilters
        });

        if (fulltextResult.matched_tier !== 'none') {
            return {
                ...fulltextResult,
                search_type: 'fulltext'
            };
        }
    }

    // Strategy 3: If metadata wasn't tried first, try it now
    if (!try_metadata_first && (query_primary_metadata.length > 0 || query_fallback_metadata.length > 0)) {
        const metadataResult = await searchMetadataWithFallback(libraryID, {
            query_primary: query_primary_metadata,
            query_fallback: query_fallback_metadata,
            query_target: 'title',
            author_query: author_filter,
            year_min,
            year_max,
            collection_key,
            limit
        });

        if (metadataResult.matched_tier !== 'none') {
            return {
                ...metadataResult,
                search_type: 'metadata'
            };
        }
    }

    // No results from any strategy
    return {
        items: [],
        matched_tier: 'none',
        search_type: 'metadata'
    };
};

/**
 * Helper function to generate query variations for common academic concepts
 * Useful for AI agents to automatically create primary/fallback queries
 */
export const generateQueryVariations = (concept: string): {
    primary: string[];
    fallback: string[];
} => {
    const lower = concept.toLowerCase().trim();
    
    // Common academic concept patterns
    const patterns: Record<string, { primary: string[], fallback: string[] }> = {
        // Research methods
        'qualitative': {
            primary: ['qualitative research', 'qualitative methodology', 'qualitative analysis'],
            fallback: ['qualitative', 'interviews']
        },
        'quantitative': {
            primary: ['quantitative research', 'quantitative methodology', 'quantitative analysis'],
            fallback: ['quantitative', 'statistical']
        },
        'mixed methods': {
            primary: ['mixed methods', 'mixed methodology', 'multi-method'],
            fallback: ['mixed', 'triangulation']
        },
        
        // Statistical concepts
        'regression': {
            primary: ['regression analysis', 'regression model', 'linear regression'],
            fallback: ['regression']
        },
        'anova': {
            primary: ['analysis of variance', 'ANOVA', 'variance analysis'],
            fallback: ['variance', 'F-test']
        },
        
        // Research designs
        'rct': {
            primary: ['randomized controlled trial', 'randomised controlled trial', 'RCT'],
            fallback: ['randomized', 'controlled trial']
        },
        'case study': {
            primary: ['case study method', 'case study approach', 'case study research'],
            fallback: ['case study']
        }
    };

    // Check if concept matches a known pattern
    for (const [key, variations] of Object.entries(patterns)) {
        if (lower.includes(key)) {
            return variations;
        }
    }

    // Default: generate basic variations
    return {
        primary: [concept, `${concept} method`, `${concept} approach`],
        fallback: [concept.split(' ')[0]] // Just first word
    };
};

