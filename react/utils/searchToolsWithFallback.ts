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

        // Search across all fields (most comprehensive)
        search.addCondition('anyField', 'contains', queryTerm);

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

