import type { ExtractContentKind } from './shared/contentKinds';

/**
 * Return the extractor content kind represented by the current Zotero item.
 */
export function liveAttachmentContentKind(item: Zotero.Item): ExtractContentKind | null {
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
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
        return 'snapshot';
    }
    if (contentType.startsWith('text/')) {
        return 'text';
    }

    return null;
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
