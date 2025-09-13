import { getAllItemsToSync } from "./sync";
import {
    getPDFPageCountFromFulltext,
    getPDFPageCountFromWorker,
} from "../../react/utils/pdfUtils";
import { logger } from "./logger";

export interface LibraryStatistics {
    libraryID: number;
    name: string;
    isGroup: boolean;
    itemCount: number;
    attachmentCount: number;
    pdfCount: number;
    imageCount: number;
    pageCount?: number | null;
}

export const getLibraryStatistics = async (
    includePageCounts: boolean,
): Promise<LibraryStatistics[]> => {
    const libraries = await Zotero.Libraries.getAll();
    const filteredLibraries = libraries.filter(library => library.libraryType === 'user' || library.libraryType === 'group');

    // Step 1: Collect basic item and attachment counts
    const basicLibraryDataPromises = filteredLibraries.map(async (library) => {
        try {
            const allItems = await getAllItemsToSync(library.libraryID);
            const regularItems = allItems.filter((item) => item.isRegularItem());
            const attachments = allItems.filter((item) => item.isAttachment());
            const pdfAttachments = attachments.filter((item) =>
                item.isPDFAttachment(),
            );
            const imageAttachments = attachments.filter((item) =>
                item.isImageAttachment(),
            );

            return {
                library,
                regularItems,
                attachments,
                pdfAttachments,
                imageAttachments,
            };
        } catch (error) {
            logger(`Error processing library ${library.libraryID} (${library.name}): ${error}`,);
            return null;
        }
    });

    const basicLibraryDataWithNulls = await Promise.all(basicLibraryDataPromises);
    const basicLibraryData = basicLibraryDataWithNulls.filter(
        (data): data is NonNullable<typeof data> => data !== null,
    );

    if (!includePageCounts) {
        const statistics = basicLibraryData.map((data) => ({
            libraryID: data.library.libraryID,
            name: data.library.name,
            isGroup: data.library.isGroup,
            itemCount: data.regularItems.length,
            attachmentCount: data.attachments.length,
            pdfCount: data.pdfAttachments.length,
            imageCount: data.imageAttachments.length,
            pageCount: null,
        }));
        return statistics;
    }

    // Step 2: Collect unique PDF hashes for page counting
    const hashToPageCount = new Map<string, number>();
    const libraryToHashes = new Map<number, Set<string>>();
    const uniquePdfAttachments = new Map<string, Zotero.Item>();

    for (const data of basicLibraryData) {
        const libraryHashes = new Set<string>();
        for (const pdf of data.pdfAttachments) {
            try {
                const hash = await pdf.attachmentHash;
                if (hash) {
                    libraryHashes.add(hash);
                    if (!uniquePdfAttachments.has(hash)) {
                        uniquePdfAttachments.set(hash, pdf);
                    }
                }
            } catch (error) {
                // Ignore attachments without a valid hash
            }
        }
        libraryToHashes.set(data.library.libraryID, libraryHashes);
    }

    // Step 3: Calculate page counts for unique PDFs
    const hashPageCounts = await Promise.all(
        Array.from(uniquePdfAttachments.entries()).map(async ([hash, item]) => ({
            hash,
            item,
            pageCount: await getPDFPageCountFromFulltext(item),
        })),
    );

    // Step 4: Use worker for PDFs where full-text count failed
    const itemsForWorker = hashPageCounts.filter((hpc) => hpc.pageCount === null);
    for (let i = 0; i < itemsForWorker.length; i += 5) {
        const batch = itemsForWorker.slice(i, i + 5);
        const batchResults = await Promise.all(
            batch.map(async (hpc) => ({
                hash: hpc.hash,
                pageCount: (await getPDFPageCountFromWorker(hpc.item)) || 0,
            })),
        );
        for (const result of batchResults) {
            hashToPageCount.set(result.hash, result.pageCount);
        }
    }

    for (const hpc of hashPageCounts) {
        if (hpc.pageCount !== null) {
            hashToPageCount.set(hpc.hash, hpc.pageCount);
        }
    }

    // Step 5: Assemble final statistics with page counts
    return basicLibraryData.map((data) => {
        const libraryHashes =
            libraryToHashes.get(data.library.libraryID) || new Set();
        const pageCount = Array.from(libraryHashes).reduce(
            (total, hash) => total + (hashToPageCount.get(hash) || 0),
            0,
        );

        return {
            libraryID: data.library.libraryID,
            name: data.library.name,
            isGroup: data.library.isGroup,
            itemCount: data.regularItems.length,
            attachmentCount: data.attachments.length,
            pdfCount: data.pdfAttachments.length,
            imageCount: data.imageAttachments.length,
            pageCount,
        };
    });
};


/**
 * Get the item counts for a library
 * @param library The library
 * @returns The item counts
 */
export async function getLibraryItemCounts(libraryID: number): Promise<LibraryStatistics> {
    // Get the library
    const library = await Zotero.Libraries.get(libraryID) as Zotero.Library;
    if (!library) {
        throw new Error('Library not found');
    }

    // Count regular items (not attachments or notes)
    const regularItemsSQL = `
        SELECT COUNT(*) FROM items 
        WHERE libraryID = ? 
        AND itemTypeID NOT IN (
            SELECT itemTypeID FROM itemTypesCombined 
            WHERE typeName IN ('attachment', 'note', 'annotation')
        )
        AND itemID NOT IN (SELECT itemID FROM deletedItems)
    `;
    
    // Count all attachments
    const attachmentsSQL = `
        SELECT COUNT(*) FROM items 
        JOIN itemAttachments USING (itemID)
        WHERE libraryID = ? 
        AND itemID NOT IN (SELECT itemID FROM deletedItems)
    `;
    
    // Count PDF attachments
    const pdfAttachmentsSQL = `
        SELECT COUNT(*) FROM items 
        JOIN itemAttachments USING (itemID)
        WHERE libraryID = ? 
        AND contentType = 'application/pdf'
        AND linkMode != ?
        AND itemID NOT IN (SELECT itemID FROM deletedItems)
    `;
    
    // Count image attachments  
    const imageAttachmentsSQL = `
        SELECT COUNT(*) FROM items 
        JOIN itemAttachments USING (itemID)
        WHERE libraryID = ? 
        AND contentType LIKE ?
        AND linkMode != ?
        AND itemID NOT IN (SELECT itemID FROM deletedItems)
    `;
    
    const [regularItems, attachments, pdfAttachments, imageAttachments] = await Promise.all([
        Zotero.DB.valueQueryAsync(regularItemsSQL, [libraryID]),
        Zotero.DB.valueQueryAsync(attachmentsSQL, [libraryID]),
        Zotero.DB.valueQueryAsync(pdfAttachmentsSQL, [libraryID, Zotero.Attachments.LINK_MODE_LINKED_URL]),
        Zotero.DB.valueQueryAsync(imageAttachmentsSQL, [libraryID, 'image/%', Zotero.Attachments.LINK_MODE_LINKED_URL])
    ]);
    
    return {
        libraryID,
        name: library.name,
        isGroup: library.isGroup,
        itemCount: regularItems || 0,
        attachmentCount: attachments || 0,
        pdfCount: pdfAttachments || 0,
        imageCount: imageAttachments || 0
    } as LibraryStatistics;
}