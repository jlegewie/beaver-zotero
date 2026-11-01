export interface LibraryStatistics {
    libraryID: number;
    groupID: number | null;
    name: string;
    isGroup: boolean;
    itemCount: number;
    attachmentCount: number;
    pdfCount: number;
    imageCount: number;
}

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
        groupID: library.isGroup ? library.id : null,
        name: library.name,
        isGroup: library.isGroup,
        itemCount: regularItems || 0,
        attachmentCount: attachments || 0,
        pdfCount: pdfAttachments || 0,
        imageCount: imageAttachments || 0
    } as LibraryStatistics;
}
