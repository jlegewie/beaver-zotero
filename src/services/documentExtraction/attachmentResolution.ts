import {
    getReadableContentKind,
    isReadableAttachment,
    ReadableContentKind,
} from './readableAttachments';

/**
 * Result of resolving a Zotero item to a PDF attachment.
 */
export type PdfAttachmentResolveResult =
    | { resolved: true; item: Zotero.Item; key: string }
    | { resolved: false; error: string; error_code: 'not_attachment' | 'is_linked_url' | 'not_pdf' };

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
 * Build Beaver's stable library-key identifier for an attachment.
 */
function attachmentKey(item: Zotero.Item): string {
    return `${item.libraryID}-${item.key}`;
}

/**
 * Format a readable attachment for regular-item resolution errors.
 */
function labelReadableAttachment(
    item: Zotero.Item,
    contentKind: ReadableContentKind,
    bestAttachmentKey: string | null,
): string {
    const key = attachmentKey(item);
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
 * Direct readable attachments are returned unchanged. Regular items resolve to
 * their only readable child, or to Zotero's best attachment when multiple
 * readable children are present and the best attachment is readable.
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
                entry.contentKind !== null && !entry.attachment.deleted,
            );

        const bestAttachment = await item.getBestAttachment();
        if (bestAttachment) {
            await Zotero.Items.loadDataTypes([bestAttachment], ['itemData']);
        }
        const bestAttachmentKey = bestAttachment
            ? attachmentKey(bestAttachment)
            : null;

        if (readable.length === 1) {
            const only = readable[0];
            const onlyKey = attachmentKey(only.attachment);
            const label = labelReadableAttachment(
                only.attachment,
                only.contentKind,
                bestAttachmentKey,
            );
            return resolveReadableChildAttachment(only.attachment, onlyKey, uniqueKey, label);
        }

        if (bestAttachment && !bestAttachment.deleted && isReadableAttachment(bestAttachment)) {
            const bestKind = getReadableContentKind(bestAttachment);
            if (bestKind) {
                return resolveReadableChildAttachment(
                    bestAttachment,
                    attachmentKey(bestAttachment),
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
