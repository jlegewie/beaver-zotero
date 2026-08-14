/**
 * Quick search over a Zotero library: one string, matched the way Zotero's own
 * item picker matches it.
 *
 * React-free by requirement: the agent data provider is in the esbuild bundle,
 * which cannot reach `react/*`. Ranking lives alongside in `./ranking.ts`.
 */

/** Options for a single-string quick search */
export interface QuickSearchItemsOptions {
    /** The raw query, ORed across title-like fields, creator fields and the year */
    query: string;
    /** Filter by item type (e.g., "journalArticle", "book") */
    item_type?: string;
    /**
     * Tags to filter by (OR logic — item must have at least one).
     *
     * Each name must be spelled as Zotero stores it: the tag condition is an
     * exact, case-sensitive match. Nullable so a filter read straight out of a
     * request payload, where an unset optional field arrives as an explicit
     * `null`, cannot turn into a tag condition.
     */
    tags?: string[] | null;
    /** Collection keys to search within (OR logic, includes subcollections) */
    collection_keys?: string[];
    /**
     * Cap on the items loaded and returned. Matching item ids are always
     * counted in full, so `truncated` reports whether this cut the result.
     * Non-positive means unlimited.
     */
    limit?: number;
}

/** Outcome of one library's quick search */
export interface QuickSearchItemsResult {
    /** Matching items, capped at `limit`, with `itemData` and `creators` loaded */
    items: Zotero.Item[];
    /** Total matches in this library, counted before `limit` was applied */
    matchCount: number;
    /** True when `limit` cut matches out of `items` */
    truncated: boolean;
}

/**
 * Quick search: one string matched across title, creators and year.
 *
 * Uses Zotero's own `quicksearch-titleCreatorYear` condition, which internally
 * ORs across title-like fields, creator fields and the year — the semantics of
 * Zotero's own item picker. That is the difference from a fielded search, whose
 * separate field queries are ANDed: a picker has one string and no idea which
 * field it belongs to, so "legewie high school" must be allowed to match a
 * creator *or* a title rather than demanding both.
 *
 * Results are unranked; callers rank with `scoreSearchResult` (`./ranking.ts`).
 *
 * @param libraryID - The library to search in
 * @param options - Query and filters
 */
export const quickSearchItems = async (
    libraryID: number,
    options: QuickSearchItemsOptions
): Promise<QuickSearchItemsResult> => {
    const { query, item_type, collection_keys, limit = 50 } = options;

    // Normalized rather than defaulted in the destructuring above: a default
    // only fires on `undefined`, and `tags` may arrive as `null`.
    const tags = options.tags ?? [];

    const empty: QuickSearchItemsResult = { items: [], matchCount: 0, truncated: false };
    if (!query || !query.trim()) {
        return empty;
    }

    // Builds a search with every condition except collection and tag scope, so
    // the same query can be run once per collection key and once per tag.
    const buildSearch = (): Zotero.Search => {
        // Zotero's default join mode is 'all'. It must stay that way: under
        // 'any' the collection and itemType conditions below would widen the
        // search instead of narrowing it. The quicksearch condition does its
        // own ORing internally, so it is unaffected.
        const search = new Zotero.Search();
        search.addCondition('libraryID', 'is', String(libraryID));
        search.addCondition('quicksearch-titleCreatorYear', 'contains', query.trim());

        if (item_type) {
            search.addCondition('itemType', 'is', item_type);
        }

        // Exclude standalone attachments, notes, and annotations so the result
        // limit is applied to regular items only.
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
            // Collection scope always includes subcollections, matching the
            // other library-browsing tools.
            search.addCondition('recursive', 'true');
        }, itemIDSet)));
    } else {
        await runScopedSearch(() => {}, itemIDSet);
    }

    // Zotero returns itemIDs in ascending order; sorting the union preserves
    // that so a truncated page is deterministic instead of depending on Set
    // iteration order.
    const itemIDs = Array.from(itemIDSet).sort((a, b) => a - b);
    const matchCount = itemIDs.length;
    const limitedIDs = limit > 0 ? itemIDs.slice(0, limit) : itemIDs;
    const truncated = limitedIDs.length < matchCount;

    if (limitedIDs.length === 0) {
        return { ...empty, matchCount };
    }

    const items: Zotero.Item[] = await Zotero.Items.getAsync(limitedIDs);

    // Fields + creators are what ranking compares and what a compact hit
    // renders. Child items are left to the caller.
    if (items.length > 0) {
        await Zotero.Items.loadDataTypes(items, ["itemData", "creators"]);
    }

    return { items, matchCount, truncated };
};
