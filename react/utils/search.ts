import { logger } from '@beaver/agent-core/platform/logger';
import { ZoteroTag } from '@beaver/agent-core/types/zotero';


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
    collectionIds?: number[],
    tags?: ZoteroTag[]
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
        // property instead. An empty/missing list searches all libraries.
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

        if (!itemIDs || itemIDs.length === 0) {
            return [];
        }

        // Retrieve the full Zotero.Item objects
        const items: Zotero.Item[] = await Zotero.Items.getAsync(itemIDs);

        // Filter items by collection IDs
        const filteredByCollection = collectionIds && collectionIds.length > 0
            ? items.filter(item => item.getCollections().some(collection => collectionIds.includes(collection)))
            : items;

        const filteredItems = tags && tags.length > 0
            ? filteredByCollection.filter(item => {
                const itemTags = item.getTags();
                if (!itemTags || itemTags.length === 0) {
                    return false;
                }
                return tags.some((tag) => {
                    if (item.libraryID !== tag.libraryId) {
                        return false;
                    }
                    return itemTags.some((itemTag: { tag?: string }) => itemTag.tag === tag.tag);
                });
            })
            : filteredByCollection;

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
 * Ranking lives in `src/services/librarySearch/ranking.ts` so the agent data
 * provider — which is in the esbuild bundle and cannot reach `react/*` — ranks
 * quick-search results exactly as this menu does. Re-exported here because the
 * source menus have always imported it from this module.
 */
export { scoreSearchResult } from '../../src/services/librarySearch/ranking';
