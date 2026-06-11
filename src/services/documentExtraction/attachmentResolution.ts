import {
    readableToExtractKind,
    isReadableContentKind,
    type ContentKind,
    type ExtractContentKind,
    type ReadableContentKind,
} from './shared/contentKinds';
import {
    hasSnapshotContentType,
    isLinkedUrlAttachment,
    safeFileExists,
} from '../../utils/attachmentFiles';
import { getItemKey } from '../../utils/zoteroItemUtils';

/**
 * Return the readable content kind represented by the current Zotero item.
 */
export function getReadableContentKind(item: Zotero.Item): ReadableContentKind | null {
    if (!item.isAttachment()) {
        return null;
    }
    if (item.isPDFAttachment()) {
        return 'pdf';
    }

    const maybeIsEPUB = (item as unknown as { isEPUBAttachment?: () => boolean })
        .isEPUBAttachment;
    if (typeof maybeIsEPUB === 'function' && maybeIsEPUB.call(item)) {
        return 'epub';
    }

    const contentType = (item.attachmentContentType || '').toLowerCase();
    if (contentType === 'application/epub+zip') {
        return 'epub';
    }
    const maybeIsImage = (item as unknown as { isImageAttachment?: () => boolean })
        .isImageAttachment;
    if (
        (contentType && typeof maybeIsImage === 'function' && maybeIsImage.call(item))
        || contentType.startsWith('image/')
    ) {
        return 'image';
    }
    if (hasSnapshotContentType(item)) {
        return 'snapshot';
    }
    if (contentType.startsWith('text/')) {
        return 'text';
    }

    return null;
}

function mimeToBroadKind(mimeType: string): ContentKind {
    const mime = mimeType.toLowerCase();
    if (!mime) return 'other';
    if (
        mime.includes('word')
        || mime.includes('msword')
        || mime.includes('officedocument.wordprocessingml')
        || mime === 'application/rtf'
    ) {
        return 'word';
    }
    if (
        mime.includes('excel')
        || mime.includes('spreadsheet')
        || mime.includes('officedocument.spreadsheetml')
        || mime === 'text/csv'
    ) {
        return 'spreadsheet';
    }
    if (
        mime.includes('powerpoint')
        || mime.includes('presentation')
        || mime.includes('officedocument.presentationml')
    ) {
        return 'presentation';
    }
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (
        mime.includes('zip')
        || mime.includes('tar')
        || mime.includes('gzip')
        || mime.includes('rar')
        || mime.includes('7z')
        || mime.includes('archive')
    ) {
        return 'archive';
    }
    return 'other';
}

/**
 * Return Beaver's full attachment content-kind taxonomy for a Zotero item.
 */
export function getContentKind(item: Zotero.Item): ContentKind {
    if (!item.isAttachment()) {
        return 'other';
    }
    if (isLinkedUrlAttachment(item)) {
        return 'linked_url';
    }
    const readable = getReadableContentKind(item);
    if (readable && isReadableContentKind(readable)) {
        return readable;
    }
    return mimeToBroadKind(item.attachmentContentType || '');
}

/**
 * Return the extractor content kind represented by the current Zotero item.
 */
export function liveAttachmentContentKind(item: Zotero.Item): ExtractContentKind | null {
    return readableToExtractKind(getReadableContentKind(item)) ?? null;
}

/**
 * Check whether Beaver can read an attachment in principle.
 */
export function isAgentReadableAttachment(item: Zotero.Item): boolean {
    return getReadableContentKind(item) !== null && !isLinkedUrlAttachment(item);
}

/**
 * Check whether an attachment has a readable content kind.
 */
export function isReadableAttachment(item: Zotero.Item): boolean {
    return getReadableContentKind(item) !== null;
}

/**
 * Check whether Beaver can read an attachment from a local file.
 */
export async function isLocallyReadableAttachment(item: Zotero.Item): Promise<boolean> {
    return isAgentReadableAttachment(item) && await safeFileExists(item);
}

/**
 * Result of resolving a Zotero item to a PDF attachment.
 */
export type PdfAttachmentResolveResult =
    | { resolved: true; item: Zotero.Item; key: string }
    | { resolved: false; error: string; error_code: 'not_attachment' | 'is_linked_url' | 'not_pdf' };

/**
 * Resolve a Zotero item to a PDF attachment.
 *
 * If the item is already a PDF attachment, returns it directly. If it is a
 * regular item with exactly one PDF attachment, auto-resolves to that
 * attachment. Notes, annotations, non-PDF attachments, and ambiguous regular
 * items return an error.
 */
export async function resolveToPdfAttachment(
    item: Zotero.Item,
    uniqueKey: string,
): Promise<PdfAttachmentResolveResult> {
    if (item.isAttachment()) {
        if (item.isPDFAttachment()) {
            return { resolved: true, item, key: uniqueKey };
        }
        if (item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
            return {
                resolved: false,
                error: `Attachment ${uniqueKey} is a linked URL, not a stored file. Beaver cannot access linked URL attachments.`,
                error_code: 'is_linked_url',
            };
        }
        const contentType = item.attachmentContentType || 'unknown';
        return {
            resolved: false,
            error: `Attachment ${uniqueKey} is not a PDF (type: ${contentType})`,
            error_code: 'not_pdf',
        };
    }

    if (item.isRegularItem()) {
        await Zotero.Items.loadDataTypes([item], ['childItems']);
        const ids = item.getAttachments();
        const fetched = await Zotero.Items.getAsync(ids);
        const pdfAttachments = fetched.filter(
            (a): a is Zotero.Item => !!a && a.isPDFAttachment(),
        );

        if (pdfAttachments.length > 0) {
            await Zotero.Items.loadDataTypes(pdfAttachments, ['itemData']);
        }

        const bestAttachment = await item.getBestAttachment();
        const bestAttachmentKey = bestAttachment
            ? `${bestAttachment.libraryID}-${bestAttachment.key}`
            : null;

        if (pdfAttachments.length === 1) {
            const only = pdfAttachments[0];
            const onlyKey = `${only.libraryID}-${only.key}`;
            const resolved = await Zotero.Items.getByLibraryAndKeyAsync(
                only.libraryID,
                only.key,
            );
            if (!resolved) {
                const label = bestAttachmentKey === onlyKey
                    ? `'${only.attachmentFilename}' (${onlyKey}, primary)`
                    : `'${only.attachmentFilename}' (${onlyKey})`;
                return {
                    resolved: false,
                    error: `The id '${uniqueKey}' is a regular item with one attachment (${label}) but it could not be resolved.`,
                    error_code: 'not_attachment',
                };
            }
            await resolved.loadAllData();
            return resolveToPdfAttachment(resolved, onlyKey);
        }

        const text = pdfAttachments
            .map((a) => {
                const k = `${a.libraryID}-${a.key}`;
                return k === bestAttachmentKey
                    ? `'${a.attachmentFilename}' (${k}, primary)`
                    : `'${a.attachmentFilename}' (${k})`;
            })
            .join(', ');
        const message = pdfAttachments.length > 0
            ? `The id '${uniqueKey}' is a regular item, not an attachment. The item has ${pdfAttachments.length} attachments: ${text}`
            : `The id '${uniqueKey}' is a regular item, not an attachment. The item has no attachments.`;
        return { resolved: false, error: message, error_code: 'not_attachment' };
    }

    const kind = item.isNote() ? 'note' : item.isAnnotation() ? 'annotation' : 'non-attachment item';
    return {
        resolved: false,
        error: `The id '${uniqueKey}' is a ${kind}, not an attachment.`,
        error_code: 'not_attachment',
    };
}

/**
 * Result of resolving a Zotero item to an image attachment.
 */
export type ImageAttachmentResolveResult =
    | { resolved: true; item: Zotero.Item; key: string }
    | { resolved: false; error: string; error_code: 'not_attachment' | 'is_linked_url' | 'not_image' };

/**
 * Resolve a Zotero item to an image attachment.
 *
 * If the item is already an image attachment, returns it directly. If it is a
 * regular item with exactly one image attachment, auto-resolves to that
 * attachment. Notes, annotations, non-image attachments, and ambiguous
 * regular items return an error.
 *
 * The linked-URL check runs before image detection so an image-typed linked
 * URL is rejected instead of being treated as a stored file.
 */
export async function resolveToImageAttachment(
    item: Zotero.Item,
    uniqueKey: string,
): Promise<ImageAttachmentResolveResult> {
    if (item.isAttachment()) {
        if (item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
            return {
                resolved: false,
                error: `Attachment ${uniqueKey} is a linked URL, not a stored file. Beaver cannot access linked URL attachments.`,
                error_code: 'is_linked_url',
            };
        }
        if (getReadableContentKind(item) === 'image') {
            return { resolved: true, item, key: uniqueKey };
        }
        const contentType = item.attachmentContentType || 'unknown';
        return {
            resolved: false,
            error: `Attachment ${uniqueKey} is not an image (type: ${contentType})`,
            error_code: 'not_image',
        };
    }

    if (item.isRegularItem()) {
        await Zotero.Items.loadDataTypes([item], ['childItems']);
        const ids = item.getAttachments();
        const fetched = ids?.length ? await Zotero.Items.getAsync(ids) : [];
        const imageAttachments = fetched.filter(
            (a): a is Zotero.Item =>
                !!a
                && !a.deleted
                && !isLinkedUrlAttachment(a)
                && getReadableContentKind(a) === 'image',
        );

        if (imageAttachments.length > 0) {
            await Zotero.Items.loadDataTypes(imageAttachments, ['itemData']);
        }

        if (imageAttachments.length === 1) {
            const only = imageAttachments[0];
            const onlyKey = getItemKey(only);
            const resolved = await Zotero.Items.getByLibraryAndKeyAsync(
                only.libraryID,
                only.key,
            );
            if (!resolved) {
                return {
                    resolved: false,
                    error: `The id '${uniqueKey}' is a regular item with one image attachment ('${only.attachmentFilename}' (${onlyKey})) but it could not be resolved.`,
                    error_code: 'not_attachment',
                };
            }
            await resolved.loadAllData();
            return resolveToImageAttachment(resolved, onlyKey);
        }

        const text = imageAttachments
            .map((a) => `'${a.attachmentFilename}' (${getItemKey(a)})`)
            .join(', ');
        const message = imageAttachments.length > 0
            ? `The id '${uniqueKey}' is a regular item, not an attachment. The item has ${imageAttachments.length} image attachments: ${text}`
            : `The id '${uniqueKey}' is a regular item, not an attachment. The item has no image attachments.`;
        return { resolved: false, error: message, error_code: 'not_attachment' };
    }

    const kind = item.isNote() ? 'note' : item.isAnnotation() ? 'annotation' : 'non-attachment item';
    return {
        resolved: false,
        error: `The id '${uniqueKey}' is a ${kind}, not an attachment.`,
        error_code: 'not_attachment',
    };
}

/**
 * Result of resolving a Zotero item to any readable attachment.
 */
export type ReadableAttachmentResolveResult =
    | {
        resolved: true;
        item: Zotero.Item;
        key: string;
        contentKind: ReadableContentKind;
        contentType: string;
    }
    | {
        resolved: false;
        error: string;
        error_code: 'not_attachment' | 'is_linked_url' | 'not_readable';
    };

/**
 * Format a readable attachment for regular-item resolution errors.
 */
function labelReadableAttachment(
    item: Zotero.Item,
    contentKind: ReadableContentKind,
    bestAttachmentKey: string | null,
): string {
    const key = getItemKey(item);
    const primary = key === bestAttachmentKey ? ', primary' : '';
    return `'${item.attachmentFilename}' (${key}${primary}, ${contentKind})`;
}

/**
 * Re-fetch and resolve a chosen child attachment through the direct path.
 */
async function resolveReadableChildAttachment(
    attachment: Zotero.Item,
    uniqueKey: string,
    parentKey: string,
    label: string,
): Promise<ReadableAttachmentResolveResult> {
    const resolved = await Zotero.Items.getByLibraryAndKeyAsync(
        attachment.libraryID,
        attachment.key,
    );
    if (!resolved) {
        return {
            resolved: false,
            error: `The id '${parentKey}' is a regular item with one readable attachment (${label}) but it could not be resolved.`,
            error_code: 'not_attachment',
        };
    }
    await resolved.loadAllData();
    return resolveToReadableAttachment(resolved, uniqueKey);
}

/**
 * Resolve a Zotero item to a readable attachment.
 *
 * Direct readable attachments are returned unchanged. Regular items prefer
 * their only PDF child to preserve existing document-request behavior, then
 * resolve to their only readable child, or to Zotero's best attachment when
 * multiple readable children are present and the best attachment is readable.
 */
export async function resolveToReadableAttachment(
    item: Zotero.Item,
    uniqueKey: string,
): Promise<ReadableAttachmentResolveResult> {
    if (item.isAttachment()) {
        if (item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
            return {
                resolved: false,
                error: `Attachment ${uniqueKey} is a linked URL, not a stored file. Beaver cannot access linked URL attachments.`,
                error_code: 'is_linked_url',
            };
        }

        const contentKind = getReadableContentKind(item);
        if (contentKind) {
            return {
                resolved: true,
                item,
                key: uniqueKey,
                contentKind,
                contentType: item.attachmentContentType || 'unknown',
            };
        }

        const contentType = item.attachmentContentType || 'unknown';
        return {
            resolved: false,
            error: `Attachment ${uniqueKey} is not a readable document (type: ${contentType})`,
            error_code: 'not_readable',
        };
    }

    if (item.isRegularItem()) {
        await Zotero.Items.loadDataTypes([item], ['childItems']);
        const ids = item.getAttachments();
        const fetched = ids?.length
            ? await Zotero.Items.getAsync(ids)
            : [];
        const attachments = fetched.filter((a): a is Zotero.Item => !!a);
        if (attachments.length > 0) {
            await Zotero.Items.loadDataTypes(attachments, ['itemData']);
        }

        const readable = attachments
            .map((attachment) => ({
                attachment,
                contentKind: getReadableContentKind(attachment),
            }))
            .filter((entry): entry is { attachment: Zotero.Item; contentKind: ReadableContentKind } =>
                entry.contentKind !== null
                && !entry.attachment.deleted
                && !isLinkedUrlAttachment(entry.attachment),
            );
        const pdfReadable = readable.filter((entry) => entry.contentKind === 'pdf');

        const bestAttachment = await item.getBestAttachment();
        if (bestAttachment) {
            await Zotero.Items.loadDataTypes([bestAttachment], ['itemData']);
        }
        const bestAttachmentKey = bestAttachment
            ? getItemKey(bestAttachment)
            : null;

        if (pdfReadable.length === 1) {
            const only = pdfReadable[0];
            const onlyKey = getItemKey(only.attachment);
            const label = labelReadableAttachment(
                only.attachment,
                only.contentKind,
                bestAttachmentKey,
            );
            return resolveReadableChildAttachment(only.attachment, onlyKey, uniqueKey, label);
        }

        if (readable.length === 1) {
            const only = readable[0];
            const onlyKey = getItemKey(only.attachment);
            const label = labelReadableAttachment(
                only.attachment,
                only.contentKind,
                bestAttachmentKey,
            );
            return resolveReadableChildAttachment(only.attachment, onlyKey, uniqueKey, label);
        }

        if (bestAttachment && !bestAttachment.deleted && isAgentReadableAttachment(bestAttachment)) {
            const bestKind = getReadableContentKind(bestAttachment);
            if (bestKind) {
                return resolveReadableChildAttachment(
                    bestAttachment,
                    getItemKey(bestAttachment),
                    uniqueKey,
                    labelReadableAttachment(bestAttachment, bestKind, bestAttachmentKey),
                );
            }
        }

        const text = readable
            .map((entry) => labelReadableAttachment(
                entry.attachment,
                entry.contentKind,
                bestAttachmentKey,
            ))
            .join(', ');
        const message = readable.length > 0
            ? `The id '${uniqueKey}' is a regular item, not an attachment. The item has ${readable.length} readable attachments: ${text}`
            : `The id '${uniqueKey}' is a regular item, not an attachment. The item has no readable attachments.`;
        return { resolved: false, error: message, error_code: 'not_attachment' };
    }

    const kind = item.isNote() ? 'note' : item.isAnnotation() ? 'annotation' : 'non-attachment item';
    return {
        resolved: false,
        error: `The id '${uniqueKey}' is a ${kind}, not an attachment.`,
        error_code: 'not_attachment',
    };
}
