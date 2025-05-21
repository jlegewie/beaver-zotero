import { ItemFilterFunction, syncingItemFilter } from "./sync";
import { getPDFPageCount } from '../../react/utils/pdfUtils';

export interface LibraryStatistics {
    libraryID: number;
    name: string;
    isGroup: boolean;
    itemCount: number;
    attachmentCount: number;
    pdfCount: number;
    imageCount: number;
    pageCount: number;
}

export const getLibraryStatistics = async (
    filterFunction: ItemFilterFunction = syncingItemFilter
): Promise<LibraryStatistics[]> => {
    // Get all libraries
    const libraries = await Zotero.Libraries.getAll();
    // Filter to user libraries only (since publications are only in user libraries)
    const userLibraries = libraries.filter(library => library.libraryType === 'user');

    const libraryStatistics = await Promise.all(userLibraries.map(async (library) => {
        // 1. Get all items from the library
        const allItems = await Zotero.Items.getAll(library.libraryID, false, false, false);
                
        // 2. Filter items based on criteria
        const itemsToSync = allItems.filter(filterFunction);

        // 3. Get the page count for PDF attachments
        let totalPageCount = 0;
        for (const item of itemsToSync) {
            if (item.isPDFAttachment()) {
                const pageCount = await getPDFPageCount(item);
                totalPageCount += pageCount || 0;
            }
        }

        return {
            libraryID: library.libraryID,
            name: library.name,
            isGroup: library.isGroup,
            itemCount: itemsToSync.length,
            attachmentCount: itemsToSync.filter(item => item.isAttachment()).length,
            pdfCount: itemsToSync.filter(item => item.isPDFAttachment()).length,
            imageCount: itemsToSync.filter(item => item.isImageAttachment()).length,
            pageCount: totalPageCount,
        } as LibraryStatistics;
    }));

    return libraryStatistics;
}








// const syncingItemFilter = (item) => {
//     return item.libraryID === 1 && (item.isRegularItem() || item.isPDFAttachment() || item.isImageAttachment());
// };
