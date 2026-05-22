/**
 * Find the best PDF attachment for a regular Zotero item.
 * Prefers PDF attachments and falls back to the first attachment.
 */
export function getBestPDFAttachment(item: any): any {
    try {
        const attachmentIDs = item.getAttachments();
        if (!attachmentIDs || attachmentIDs.length === 0) return null;
        for (const attID of attachmentIDs) {
            const att = Zotero.Items.get(attID);
            if (att && att.attachmentContentType === 'application/pdf') return att;
        }
        return Zotero.Items.get(attachmentIDs[0]) || null;
    } catch {
        return null;
    }
}

/**
 * Find the best PDF attachment after loading the parent item's child list and
 * attachment objects. Use this when the parent item may have only primary data.
 */
export async function getBestPDFAttachmentAsync(item: any): Promise<any> {
    try {
        if (!item) return null;
        if (item.isAttachment?.()) return item;
        if (!item.isRegularItem?.()) return null;

        await Zotero.Items.loadDataTypes([item], ['childItems']);
        const attachmentIDs = item.getAttachments();
        if (!attachmentIDs || attachmentIDs.length === 0) return null;

        const loaded = await Zotero.Items.getAsync(attachmentIDs);
        const attachments = Array.isArray(loaded) ? loaded.filter(Boolean) : (loaded ? [loaded] : []);
        if (attachments.length === 0) return null;

        return attachments.find((att: any) => (
            att?.isPDFAttachment?.() ||
            att?.attachmentContentType === 'application/pdf'
        )) ?? attachments[0];
    } catch {
        return null;
    }
}
