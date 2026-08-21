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
