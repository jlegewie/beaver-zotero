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
    /**
     * Tags to filter by (OR logic — item must have at least one).
     *
     * Each name must be spelled as Zotero stores it: the tag condition below is
     * an exact, case-sensitive match. Nullable so that a filter read straight
     * out of a request payload, where an unset optional field arrives as an
     * explicit `null`, cannot turn into a tag condition.
     */
    tags?: string[] | null;
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
 * @returns Array of matching items with `itemData` and `creators` loaded; a
 *          caller needing child items, tags, or collections loads them itself
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
        collection_keys,
        limit = 50
    } = options;

    // Normalized rather than defaulted in the destructuring above: a default only
    // fires on `undefined`, and `tags` may arrive as `null`.
    const tags = options.tags ?? [];

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
        await Promise.all(collection_keys.map(collectionKey => runScopedSearch((search) => {
            search.addCondition('collection', 'is', collectionKey);
            // Collection scope always includes subcollections, matching the other
            // library-browsing tools.
            search.addCondition('recursive', 'true');
        }, itemIDSet)));
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
    
    // Only what a caller needs to compare results (fields + creators). Child
    // items are left to the caller, which loads them for the rows it serializes.
    if (items.length > 0) {
        await Zotero.Items.loadDataTypes(items, ["itemData", "creators"]);
    }

    return items;
};


/**
 * Filters for {@link resolveItemsByFilters}.
 *
 * Values are OR'd within a dimension and AND'd across dimensions.
 */
export interface ResolveItemsByFiltersOptions {
    /**
     * Collection keys already resolved for this library.
     * Resolve raw collection filters before calling.
     */
    collectionKeys?: string[];
    /** Tag names, validated against this library's tags. */
    tags?: string[];
    /** Creator-name substrings. */
    authors?: string[];
    /** Publication-year filter. */
    year?: { min?: number; max?: number; exact?: number };
    /** Include subcollections of the given collection keys. Default true. */
    recursive?: boolean;
}

/** Result of {@link resolveItemsByFilters} for a single library. */
export interface ResolveItemsByFiltersResult {
    /** Item IDs matching all provided dimensions. */
    itemIDs: number[];
    /** Input tag names that exist in this library. */
    matchedTags: string[];
    /** Input author substrings that matched at least one item in this library. */
    matchedAuthors: string[];
}

/** Run a single Zotero search scoped to a library and return matching item IDs. */
const runLibrarySearchIds = async (
    libraryID: number,
    build: (search: Zotero.Search) => void,
): Promise<number[]> => {
    // Use the libraryID property, not a condition: joinMode='any' applies to
    // conditions and would OR the library scope with collection/tag filters.
    const search = new Zotero.Search();
    // libraryID is readonly in the type defs; set it via a minimal cast.
    (search as unknown as { libraryID: number }).libraryID = libraryID;
    build(search);
    return await search.search();
};

/**
 * Resolve filters to item IDs in one library.
 *
 * Zotero's `joinMode` is global per search, so this runs one search per
 * dimension and intersects the resulting ID sets.
 */
export const resolveItemsByFilters = async (
    libraryID: number,
    options: ResolveItemsByFiltersOptions,
): Promise<ResolveItemsByFiltersResult> => {
    const { collectionKeys, tags, authors, year, recursive = true } = options;

    const hasCollections = !!collectionKeys && collectionKeys.length > 0;
    const hasTags = !!tags && tags.length > 0;
    const hasAuthors = !!authors && authors.length > 0;
    const hasYear = !!year && (
        (year.min ?? 0) > 0 || (year.max ?? 0) > 0 || (year.exact ?? 0) > 0
    );

    const dimensionSets: Set<number>[] = [];
    const matchedTags: string[] = [];
    const matchedAuthors: string[] = [];

    // Collections
    if (hasCollections) {
        const ids = await runLibrarySearchIds(libraryID, (search) => {
            if (collectionKeys!.length > 1) search.addCondition('joinMode', 'any');
            for (const key of collectionKeys!) search.addCondition('collection', 'is', key);
            if (recursive) search.addCondition('recursive', 'true');
        });
        dimensionSets.push(new Set(ids));
    }

    // Tags: validate against this library, preserving exact casing.
    if (hasTags) {
        const allTags = (await Zotero.Tags.getAll(libraryID)) as { tag: string }[];
        const lowerToExact = new Map<string, string>();
        for (const t of allTags) lowerToExact.set(t.tag.toLowerCase(), t.tag);

        const exactTags: string[] = [];
        for (const tag of tags!) {
            const exact = lowerToExact.get(tag.toLowerCase());
            if (exact !== undefined) {
                exactTags.push(exact);
                matchedTags.push(tag);
            }
        }
        const ids = exactTags.length > 0
            ? await runLibrarySearchIds(libraryID, (search) => {
                if (exactTags.length > 1) search.addCondition('joinMode', 'any');
                for (const tag of exactTags) search.addCondition('tag', 'is', tag);
            })
            : [];
        dimensionSets.push(new Set(ids));
    }

    // Authors: search separately so matched inputs can be reported.
    if (hasAuthors) {
        const authorSet = new Set<number>();
        for (const author of authors!) {
            const ids = await runLibrarySearchIds(libraryID, (search) => {
                search.addCondition('creator', 'contains', author);
            });
            if (ids.length > 0) {
                matchedAuthors.push(author);
                for (const id of ids) authorSet.add(id);
            }
        }
        dimensionSets.push(authorSet);
    }

    // Year (min/max are AND'd; exact overrides)
    if (hasYear) {
        const ids = await runLibrarySearchIds(libraryID, (search) => {
            if (year!.exact && year!.exact > 0) {
                search.addCondition('year', 'is', String(year!.exact));
            } else {
                if (year!.min && year!.min > 0) {
                    search.addCondition('date', 'isAfter', `${year!.min - 1}-12-31`);
                }
                if (year!.max && year!.max > 0) {
                    search.addCondition('date', 'isBefore', `${year!.max + 1}-01-01`);
                }
            }
        });
        dimensionSets.push(new Set(ids));
    }

    // Intersect all provided dimensions (AND). Start from the smallest set.
    let itemIDs: number[] = [];
    if (dimensionSets.length > 0) {
        dimensionSets.sort((a, b) => a.size - b.size);
        const [smallest, ...rest] = dimensionSets;
        itemIDs = Array.from(smallest).filter((id) => rest.every((set) => set.has(id)));
    }

    return { itemIDs, matchedTags, matchedAuthors };
};
