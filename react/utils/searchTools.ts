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
    /** Tags to filter by (OR logic — item must have at least one) */
    tags?: string[];
    /** Collection keys to search within (OR logic, includes subcollections) */
    collection_keys?: string[];
    /** Maximum results to return */
    limit?: number;
}

/**
 * Search items by metadata fields (title, author, year, publication, etc.)
 * 
 * This function creates a Zotero search with conditions based on the provided options.
 * All text searches are case-insensitive substring matches unless specified otherwise.
 * Conditions are ANDed; collection keys and tags are each ORed against each other.
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
        limit = 50
    } = options;

    // Builds a search with every condition except collection and tag scope, so
    // the same query can be run once per collection key and once per tag.
    const buildSearch = (): Zotero.Search => {
        // Zotero's default join mode is 'all'. It must stay that way: under 'any' the
        // collection and itemType conditions below would widen the search instead of
        // narrowing it.
        const search = new Zotero.Search();
        search.addCondition('libraryID', 'is', String(libraryID));

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
        // is applied to regular items only.
        search.addCondition('itemType', 'isNot', 'attachment');
        search.addCondition('itemType', 'isNot', 'note');
        search.addCondition('itemType', 'isNot', 'annotation');

        return search;
    };

    /**
     * Run the base search under an optional collection scope, ORing tags via
     * one clone per tag so joinMode stays 'all'.
     */
    const runScopedSearch = async (
        addScope: (search: Zotero.Search) => void,
        into: Set<number>,
    ): Promise<void> => {
        const base = buildSearch();
        addScope(base);

        // Each tag gets its own clone of the base AND search so tags are OR'd
        // without making the library and metadata conditions optional.
        const searches = tags.length > 0
            ? Array.from(new Set(tags), tag => {
                const tagSearch = base.clone(libraryID);
                tagSearch.addCondition('tag', 'is', tag);
                return tagSearch.search();
            })
            : [base.search()];
        const searchResults = await Promise.all(searches);
        for (const result of searchResults) {
            for (const itemID of result) {
                into.add(itemID);
            }
        }
    };

    // One search per collection key, unioned. Zotero 10's groupStart/groupEnd
    // could express `query AND (collection A OR B)` in a single search, but
    // addCondition throws on those names in Zotero 7, which is still supported.
    const itemIDSet = new Set<number>();
    if (collection_keys && collection_keys.length > 0) {
        for (const collectionKey of collection_keys) {
            await runScopedSearch((search) => {
                search.addCondition('collection', 'is', collectionKey);
                // Collection scope always includes subcollections, matching the other
                // library-browsing tools.
                search.addCondition('recursive', 'true');
            }, itemIDSet);
        }
    } else {
        await runScopedSearch(() => {}, itemIDSet);
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
