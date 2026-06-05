import { getReadableContentKind } from '../services/documentExtraction/attachmentResolution';

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

/**
 * Find the best plain-text attachment for a regular Zotero item.
 * Prefers Zotero's best attachment when it is text, otherwise the first text child.
 */
export async function getBestReadableTextAttachmentAsync(item: any): Promise<any> {
    try {
        if (!item) return null;
        if (item.isAttachment?.()) return item;
        if (!item.isRegularItem?.()) return null;

        await Zotero.Items.loadDataTypes([item], ['childItems', 'itemData']);
        const attachmentIDs = item.getAttachments();
        if (!attachmentIDs?.length) return null;

        const loaded = await Zotero.Items.getAsync(attachmentIDs);
        const attachments = (Array.isArray(loaded) ? loaded : (loaded ? [loaded] : []))
            .filter((attachment: any) => attachment && !attachment.deleted);
        if (attachments.length > 0) {
            await Zotero.Items.loadDataTypes(attachments, ['itemData']);
        }

        try {
            const bestAttachment = await item.getBestAttachment();
            if (bestAttachment && !bestAttachment.deleted) {
                await Zotero.Items.loadDataTypes([bestAttachment], ['itemData']);
                if (getReadableContentKind(bestAttachment) === 'text') {
                    return bestAttachment;
                }
            }
        } catch {
            // Fall back to the loaded child attachments if Zotero's ranking
            // helper cannot inspect the parent item.
        }

        return attachments.find((attachment: any) =>
            getReadableContentKind(attachment) === 'text',
        ) ?? null;
    } catch {
        return null;
    }
}
