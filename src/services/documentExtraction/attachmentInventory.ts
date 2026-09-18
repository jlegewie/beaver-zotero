/** Current file attachments, excluding trash, trashed parents and linked URLs. */
export async function queryLibraryAttachmentIds(
    libraryId: number,
    options: { contentTypes?: readonly string[] } = {},
): Promise<number[]> {
    const { contentTypes } = options;
    if (contentTypes?.length === 0) return [];
    const ids: number[] = [];
    await Zotero.DB.queryAsync(
        `SELECT I.itemID FROM items I JOIN itemAttachments IA USING (itemID)
         WHERE I.libraryID = ? AND IA.linkMode != ?
           AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
           AND NOT EXISTS (SELECT 1 FROM deletedItems D WHERE D.itemID = IA.parentItemID)
           ${contentTypes ? `AND LOWER(COALESCE(IA.contentType, '')) IN (${contentTypes.map(() => '?').join(', ')})` : ''}
         ORDER BY I.itemID`,
        [libraryId, Zotero.Attachments.LINK_MODE_LINKED_URL, ...(contentTypes ?? [])],
        { onRow: (row: any) => ids.push(row.getResultByIndex(0)) },
    );
    return ids;
}
