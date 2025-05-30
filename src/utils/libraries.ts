import { getItemsToSync } from "./sync";
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

export const getLibraryStatistics = async (): Promise<LibraryStatistics[]> => {
    // Get all libraries
    const libraries = await Zotero.Libraries.getAll();
    // Filter to user libraries only (since publications are only in user libraries)
    const userLibraries = libraries.filter(library => library.libraryType === 'user');

    const libraryStatistics = await Promise.all(userLibraries.map(async (library) => {
        // 1. Get all items from the library
        const allItems = await getItemsToSync(library.libraryID);
                
        // 2. Get the page count for PDF attachments
        let totalPageCount = 0;
        for (const item of allItems) {
            if (item.isPDFAttachment()) {
                const pageCount = await getPDFPageCount(item);
                totalPageCount += pageCount || 0;
            }
        }

        return {
            libraryID: library.libraryID,
            name: library.name,
            isGroup: library.isGroup,
            itemCount: allItems.length,
            attachmentCount: allItems.filter(item => item.isAttachment()).length,
            pdfCount: allItems.filter(item => item.isPDFAttachment()).length,
            imageCount: allItems.filter(item => item.isImageAttachment()).length,
            pageCount: totalPageCount,
        } as LibraryStatistics;
    }));

    return libraryStatistics;
}
