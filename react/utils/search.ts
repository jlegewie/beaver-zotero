import { logger } from '../../src/utils/logger';


/**
 * Searches for Zotero items by a single term across Title, Creator, and Year fields
 * in the currently selected library. Mimics the "Title, Creator, Year" quick search option.
 *
 * @param searchTerm - The term to search for across title, creator, and year fields.
 * @returns A promise that resolves to an array of Zotero.Item objects matching the criteria.
 */
export async function searchTitleCreatorYear(
    searchTerm: string
): Promise<Zotero.Item[]> {
    // If no search term is provided, return an empty array.
    if (!searchTerm || searchTerm.trim() === "") {
        logger("searchTitleCreatorYear: No search term provided.")
        Zotero.debug("searchTitleCreatorYear: No search term provided.", 2);
        return [];
    }

    try {
        const search = new Zotero.Search();
        
        // Set the search scope to the currently selected library.
        if (libraryCondition) {
            search.addCondition("libraryID", "is", 1)
            // const libraryID = Zotero.getActiveZoteroPane()?.getSelectedLibraryID();
            // if (libraryID !== null) {
            //     search.addCondition("libraryID", "is", libraryID)
            // }
        }

        // Use 'quicksearch-titleCreatorYear' condition.
        // This internally creates an OR search across title-related fields,
        // creator fields, and the year field.
        search.addCondition('quicksearch-titleCreatorYear', 'contains', searchTerm);

        // Execute the search
        const itemIDs: number[] = await search.search();

        if (!itemIDs || itemIDs.length === 0) {
            return [];
        }

        // Retrieve the full Zotero.Item objects
        const items: Zotero.Item[] = await Zotero.Items.getAsync(itemIDs);
        return items;

    } catch (error: any) {
        // Log any errors that occur during the search process.
        logger(`searchTitleCreatorYear [ERROR]: ${error}`)
        Zotero.logError(error);
        return [];
    }
}