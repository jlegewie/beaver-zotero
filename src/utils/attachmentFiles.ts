/**
 * Safely check if an attachment file exists.
 *
 * Unlike item.fileExists(), this handles linked URL attachments which have no
 * associated file. Calling fileExists() on a linked URL throws an error.
 *
 * @param item - Zotero item to check
 * @returns true if the file exists, false for linked URLs and non-attachments
 */
export async function safeFileExists(item: Zotero.Item): Promise<boolean> {
    if (!item.isAttachment()) return false;

    if (item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
        return false;
    }

    return item.fileExists();
}

/**
 * Safely read an attachment's filename.
 *
 * Zotero's `attachmentFilename` getter calls `PathUtils.filename()` for any
 * attachment path not prefixed `storage:` or `attachments:` — i.e. a linked
 * file stored with an absolute path. Gecko throws
 * `NS_ERROR_FILE_UNRECOGNIZED_PATH` when that path is not valid for the current
 * platform: a library carried across Windows and macOS, a `file://` URL stored
 * as a path, or a `~`-prefixed or relative path. The stored path itself is a
 * plain field read, so fall back to its trailing segment.
 *
 * Always use this instead of reading `item.attachmentFilename` directly — one
 * malformed row must never take out a whole response.
 *
 * @param item - Zotero item to read
 * @returns the filename, a best-effort basename, or null
 */
export function safeAttachmentFilename(item: Zotero.Item): string | null {
    try {
        return item.attachmentFilename || null;
    } catch {
        try {
            return item.attachmentPath?.split(/[\\/]/).pop() || null;
        } catch {
            return null;
        }
    }
}

export type AttachmentDocumentType = 'pdf' | 'epub';

/** The content type Zotero's reader, PDF worker and annotations require. */
export const CANONICAL_DOCUMENT_CONTENT_TYPES: Record<AttachmentDocumentType, string> = {
    pdf: 'application/pdf',
    epub: 'application/epub+zip',
};

/** Nonstandard content types that name a PDF or EPUB. */
const DOCUMENT_CONTENT_TYPE_ALIASES: Record<string, AttachmentDocumentType> = {
    'application/pdf': 'pdf',
    'application/x-pdf': 'pdf',
    'application/acrobat': 'pdf',
    'applications/vnd.pdf': 'pdf',
    'text/pdf': 'pdf',
    'text/x-pdf': 'pdf',
    'application/epub+zip': 'epub',
    // Zotero accepts this incorrect type for EPUBs for compatibility.
    'application/epub': 'epub',
};

/** Content types that say nothing about the file, so the extension decides. */
const GENERIC_CONTENT_TYPES = new Set([
    '',
    'application/octet-stream',
    'binary/octet-stream',
    'application/binary',
    'application/unknown',
    'application/download',
    'application/force-download',
    'application/x-download',
]);

const DOCUMENT_EXTENSIONS: Record<string, AttachmentDocumentType> = {
    pdf: 'pdf',
    epub: 'epub',
};

/**
 * Classify a stored or linked file attachment as a PDF or EPUB.
 *
 * Zotero's `isPDFAttachment()` / `isEPUBAttachment()` match the stored content
 * type exactly, but attachments synced from other clients can carry a blank,
 * generic (`application/octet-stream`) or nonstandard (`application/x-pdf`)
 * type. This accepts known aliases, and falls back to the filename extension
 * only when the stored type is generic, so a specific non-document type is
 * never overridden by a misleading extension.
 *
 * @param item - Zotero item to classify
 * @returns 'pdf', 'epub', or null for everything else
 */
export function attachmentDocumentType(item: Zotero.Item): AttachmentDocumentType | null {
    if (!item.isAttachment() || isLinkedUrlAttachment(item)) return null;
    const contentType = (item.attachmentContentType || '').split(';', 1)[0].trim().toLowerCase();
    const aliased = DOCUMENT_CONTENT_TYPE_ALIASES[contentType];
    if (aliased) return aliased;
    if (!GENERIC_CONTENT_TYPES.has(contentType)) return null;
    const extension = safeAttachmentFilename(item)?.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
    return extension ? DOCUMENT_EXTENSIONS[extension] ?? null : null;
}

/** Check whether an attachment is a PDF, including mislabelled ones. */
export function isPdfDocument(item: Zotero.Item): boolean {
    return attachmentDocumentType(item) === 'pdf';
}

/** Check whether an attachment is an EPUB, including mislabelled ones. */
export function isEpubDocument(item: Zotero.Item): boolean {
    return attachmentDocumentType(item) === 'epub';
}

/**
 * Return the canonical content type a mislabelled PDF/EPUB needs before
 * Zotero's reader or annotation APIs accept it, or null when the attachment is
 * not a document or already carries that type.
 */
export function canonicalContentTypeCorrection(item: Zotero.Item): string | null {
    const documentType = attachmentDocumentType(item);
    if (!documentType) return null;
    const canonical = CANONICAL_DOCUMENT_CONTENT_TYPES[documentType];
    return item.attachmentContentType === canonical ? null : canonical;
}

/**
 * Check if an attachment is a linked URL, which has no associated file.
 *
 * @param item - Zotero item to check
 * @returns true if the item is a linked URL attachment
 */
export function isLinkedUrlAttachment(item: Zotero.Item): boolean {
    return item.isAttachment() && item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL;
}

/**
 * Check whether an attachment has a browser snapshot content type.
 *
 * Zotero's native snapshot predicate is stricter than Beaver's existing
 * content-type classification, so this preserves the broader detector
 * semantics used by document extraction.
 *
 * @param item - Zotero item to check
 * @returns true for HTML/XHTML attachment content types
 */
export function hasSnapshotContentType(item: Zotero.Item): boolean {
    return item.isAttachment()
        && ['text/html', 'application/xhtml+xml'].includes(
            (item.attachmentContentType || '').toLowerCase(),
        );
}
