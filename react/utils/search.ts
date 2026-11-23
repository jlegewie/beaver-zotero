import { logger } from '@beaver/agent-core/platform/logger';
import { rankSearchResults } from '../../src/services/librarySearch/ranking';
import { loadFullItemData } from '../../src/utils/zoteroUtils';


/** A Zotero item key, which the quick search matches as a whole word. */
const ITEM_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

/**
 * Prepares a typed source-picker query for Zotero's quick search: joining
 * words ("and", "&") and commas become spaces, so "Smith & Jones, 2020" is
 * searched as the words "Smith Jones 2020", and a trailing year is split off
 * ("smith2020" → "smith 2020") unless the last word is an item key
 * ("2DWQHP99"). Zotero ANDs the words, each across title, creator, year and
 * the other quick-search fields.
 */
export function normalizeQuickSearchQuery(query: string): string {
    const words = query
        .replace(/ (?:&|and) /g, ' ')
        .replace(/[,&]/g, ' ')
        .trim();
    const lastWord = words.split(/\s+/).pop() ?? '';
    return ITEM_KEY.test(lastWord) ? words : words.replace(/ ?(\d{1,4})$/, ' $1');
}

/**
 * Searches for Zotero items by a single term across Title, Creator, and Year
 * fields, like Zotero's "Title, Creator, Year" quick search mode. Returns
 * top-level items only, with primary data loaded.
 *
 * @param searchTerm - The term to search for across title, creator, and year fields.
 * @param libraryIds - The libraries to search. An empty or missing list
 *   searches every library, so callers that enforce library exclusions must
 *   pass the searchable set and skip the call when it is empty.
 */
export async function searchTitleCreatorYear(
    searchTerm: string,
    libraryIds?: number[],
): Promise<Zotero.Item[]> {
    // If no search term is provided, return an empty array.
    if (!searchTerm || searchTerm.trim() === "") {
        logger("searchTitleCreatorYear: No search term provided.")
        Zotero.debug("searchTitleCreatorYear: No search term provided.", 2);
        return [];
    }

    try {
        // Run one search per library and merge the results. Zotero's search
        // API cannot OR library conditions against an ANDed quicksearch
        // condition (the `required` addCondition parameter is unsupported),
        // so each search is scoped to a single library via the `libraryID`
        // property instead.
        const scopedLibraryIds: (number | null)[] =
            libraryIds && libraryIds.length > 0 ? libraryIds : [null];
        const idArrays = await Promise.all(scopedLibraryIds.map(async (libraryID) => {
            const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
            if (libraryID !== null) {
                search.libraryID = libraryID;
            }
            // 'quicksearch-titleCreatorYear' internally creates an OR search
            // across title-related fields, creator fields, and the year field.
            search.addCondition('quicksearch-titleCreatorYear', 'contains', searchTerm);
            return (await search.search()) || [];
        }));
        const itemIDs: number[] = [...new Set(idArrays.flat())];

        if (itemIDs.length === 0) {
            return [];
        }

        const items: Zotero.Item[] = await Zotero.Items.getAsync(itemIDs);
        logger(`searchTitleCreatorYear: Found ${items.length} items`);
        return items;

    } catch (error: any) {
        // Log any errors that occur during the search process.
        logger(`searchTitleCreatorYear [ERROR]: ${error}`)
        Zotero.logError(error);
        return [];
    }
}


/**
 * A source-picker search: the best matches for `query`, fully loaded for
 * display, and how many items matched in all.
 *
 * Runs Zotero's quick search over `libraryIds` only; with none it searches
 * nothing. `include` narrows the matches before they are ranked and counted.
 * Returns null as soon as `isCurrent` reports the search was superseded, so an
 * abandoned query does not go on loading data.
 */
export async function searchSourceItems(
    query: string,
    libraryIds: number[],
    limit: number,
    { include, isCurrent = () => true }: {
        include?: (item: Zotero.Item) => boolean;
        isCurrent?: () => boolean;
    } = {},
): Promise<{ items: Zotero.Item[]; matchCount: number } | null> {
    const normalizedQuery = normalizeQuickSearchQuery(query);
    // An empty list would make `searchTitleCreatorYear` search every library,
    // excluded ones included.
    if (!normalizedQuery || libraryIds.length === 0) return { items: [], matchCount: 0 };

    const found = await searchTitleCreatorYear(normalizedQuery, libraryIds);
    if (!isCurrent()) return null;
    // Ranking reads fields and creators; the full load (children included)
    // is only needed for the rows that are shown.
    await Zotero.Items.loadDataTypes(found, ['itemData', 'creators']);
    if (!isCurrent()) return null;

    const matches = include ? found.filter(include) : found;
    const items = rankSearchResults(matches, normalizedQuery).slice(0, limit);
    await loadFullItemData(items);
    if (!isCurrent()) return null;
    return { items, matchCount: matches.length };
}


/**
 * Ranking lives in `src/services/librarySearch/ranking.ts` so the agent data
 * provider — which is in the esbuild bundle and cannot reach `react/*` — ranks
 * quick-search results exactly as this menu does. Re-exported here because the
 * source menus have always imported it from this module.
 */
export { rankSearchResults, scoreSearchResult } from '../../src/services/librarySearch/ranking';
