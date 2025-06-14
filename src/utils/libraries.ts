import { getItemsToSync } from "./sync";
import { getPDFPageCountFromFulltext, getPDFPageCountFromWorker } from '../../react/utils/pdfUtils';

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
        const attachments = allItems.filter(item => item.isAttachment());
        const pdfAttachments = attachments.filter(item => item.isPDFAttachment());
                
        // 2. Get the page count for PDF attachments
        const pageCountsFromFulltext = await Promise.all(pdfAttachments.map(async (item) => {
            return {item: item, pageCount: await getPDFPageCountFromFulltext(item)};
        }));

        // Process items that need worker page count in batches of 5
        const itemsNeedingWorkerPageCount = pageCountsFromFulltext.filter(pc => pc.pageCount === null);
        const pageCountsFromWorker = [];
        
        for (let i = 0; i < itemsNeedingWorkerPageCount.length; i += 5) {
            const batch = itemsNeedingWorkerPageCount.slice(i, i + 5);
            const batchResults = await Promise.all(
                batch.map(async (pc) => {
                    return {item: pc.item, pageCount: await getPDFPageCountFromWorker(pc.item)};
                })
            );
            pageCountsFromWorker.push(...batchResults);
        }

        const totalPageCountFromFulltext = pageCountsFromFulltext.reduce((acc, count) => acc + (count.pageCount || 0), 0);
        const totalPageCountFromWorker = pageCountsFromWorker.reduce((acc, count) => acc + (count.pageCount || 0), 0);

        return {
            libraryID: library.libraryID,
            name: library.name,
            isGroup: library.isGroup,
            itemCount: allItems.length,
            // itemCount: allItems.filter(item => item.isRegularItem()).length,
            attachmentCount: attachments.length,
            pdfCount: pdfAttachments.length,
            imageCount: attachments.filter(item => item.isImageAttachment()).length,
            pageCount: totalPageCountFromWorker + totalPageCountFromFulltext,
        } as LibraryStatistics;
    }));

    return libraryStatistics;
}
