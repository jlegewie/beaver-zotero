import { getAllItemsToSync } from "./sync";
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
    const libraries = await Zotero.Libraries.getAll();
    // const userLibraries = libraries.filter(library => library.libraryType === 'user');

    // Step 1: Collect all PDF attachments across all libraries with their hashes
    const hashToPageCount = new Map<string, number>();
    const libraryToHashes = new Map<number, Set<string>>();
    
    // Collect all attachments first
    const allLibraryData = await Promise.all(libraries.map(async (library) => {
        const allItems = await getAllItemsToSync(library.libraryID);
        const regularItems = allItems.filter(item => item.isRegularItem());
        const attachments = allItems.filter(item => item.isAttachment());
        const pdfAttachments = attachments.filter(item => item.isPDFAttachment());
        
        return {
            library,
            allItems,
            regularItems,
            attachments,
            pdfAttachments
        };
    }));

    // Step 2: Build hash map for unique PDFs
    const uniquePdfAttachments = new Map<string, Zotero.Item>();
    
    for (const libraryData of allLibraryData) {
        const libraryHashes = new Set<string>();
        
        for (const pdfAttachment of libraryData.pdfAttachments) {
            try {
                const hash = await pdfAttachment.attachmentHash;
                if (hash) {
                    libraryHashes.add(hash);
                    
                    // Store first occurrence of each hash for page counting
                    if (!uniquePdfAttachments.has(hash)) {
                        uniquePdfAttachments.set(hash, pdfAttachment);
                    }
                }
            } catch (error) {
                // Skip items without valid hash
                continue;
            }
        }
        
        libraryToHashes.set(libraryData.library.libraryID, libraryHashes);
    }

    // Step 3: Calculate page counts for unique hashes only
    const hashPageCounts = await Promise.all(
        Array.from(uniquePdfAttachments.entries()).map(async ([hash, item]) => {
            const pageCount = await getPDFPageCountFromFulltext(item);
            return { hash, item, pageCount };
        })
    );

    // Process items that need worker page count in batches of 5
    const itemsNeedingWorkerPageCount = hashPageCounts.filter(hpc => hpc.pageCount === null);
    
    for (let i = 0; i < itemsNeedingWorkerPageCount.length; i += 5) {
        const batch = itemsNeedingWorkerPageCount.slice(i, i + 5);
        const batchResults = await Promise.all(
            batch.map(async (hpc) => {
                const workerPageCount = await getPDFPageCountFromWorker(hpc.item);
                return { hash: hpc.hash, pageCount: workerPageCount || 0 };
            })
        );
        
        for (const result of batchResults) {
            hashToPageCount.set(result.hash, result.pageCount);
        }
    }

    // Store fulltext page counts
    for (const hpc of hashPageCounts) {
        if (hpc.pageCount !== null) {
            hashToPageCount.set(hpc.hash, hpc.pageCount);
        }
    }

    // Step 4: Calculate statistics per library
    const libraryStatistics = allLibraryData.map((libraryData) => {
        const libraryHashes = libraryToHashes.get(libraryData.library.libraryID) || new Set();
        
        // Calculate unique page count for this library
        const uniquePageCount = Array.from(libraryHashes)
            .reduce((total, hash) => total + (hashToPageCount.get(hash) || 0), 0);

        return {
            libraryID: libraryData.library.libraryID,
            name: libraryData.library.name,
            isGroup: libraryData.library.isGroup,
            itemCount: libraryData.regularItems.length,
            attachmentCount: libraryData.attachments.length,
            pdfCount: libraryData.pdfAttachments.length,
            imageCount: libraryData.attachments.filter(item => item.isImageAttachment()).length,
            pageCount: uniquePageCount,
        } as LibraryStatistics;
    });

    return libraryStatistics;
}
