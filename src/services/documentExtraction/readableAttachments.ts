/** Readable content kinds. Images are read visually, not extracted as text. */
export type ReadableContentKind = 'pdf' | 'epub' | 'snapshot' | 'text' | 'image';

/** MIME types Beaver reads as line-based plain text. */
const READABLE_TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set([
    'text/plain',
    'text/markdown',
]);

/**
 * Classify an attachment into a readable content kind.
 *
 * Returns null for non-attachments, linked URL attachments, and unsupported
 * MIME types. The caller must load itemData before calling this on freshly
 * fetched Zotero items.
 */
export function getReadableContentKind(item: Zotero.Item): ReadableContentKind | null {
    if (!item.isAttachment()) return null;
    if (item.isPDFAttachment()) return 'pdf';
    if (item.isEPUBAttachment()) return 'epub';
    if (item.isFileAttachment() && item.attachmentContentType === 'text/html') return 'snapshot';
    if (item.isImageAttachment()) return 'image';
    if (item.isFileAttachment() && READABLE_TEXT_CONTENT_TYPES.has(item.attachmentContentType)) {
        return 'text';
    }
    return null;
}

/**
 * Return true if an attachment has a readable kind.
 */
export function isReadableAttachment(item: Zotero.Item): boolean {
    return getReadableContentKind(item) !== null;
}

/**
 * Return true for regular items and readable attachments.
 */
export function isReadableItem(item: Zotero.Item | false): boolean {
    if (!item) return false;
    if (item.isRegularItem()) return true;
    return isReadableAttachment(item);
}

/**
 * Return true if a regular item has at least one non-trashed readable child.
 */
export async function hasReadableAttachment(item: Zotero.Item): Promise<boolean> {
    if (!item.isRegularItem()) return false;
    await Zotero.Items.loadDataTypes([item], ['childItems']);
    const ids = item.getAttachments();
    if (!ids?.length) return false;
    const attachments = await Zotero.Items.getAsync(ids);
    const fetched = attachments.filter((a): a is Zotero.Item => !!a);
    if (fetched.length > 0) {
        await Zotero.Items.loadDataTypes(fetched, ['itemData']);
    }
    return fetched.some((a) => isReadableAttachment(a) && !a.deleted);
}
