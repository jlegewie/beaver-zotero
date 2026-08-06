import { logger } from "@beaver/agent-core/platform/logger";

/**
 * Remove trashed annotations from any reader currently showing them.
 *
 * Zotero's reader does not react to an annotation being trashed. Its notifier
 * handler treats a `trash` event as being about the attachment (it closes the
 * reader when the attachment or its parent is trashed) and only drops
 * annotations on a `delete` event — which is what Zotero's own reader emits,
 * since deleting from the reader erases annotations outright rather than
 * trashing them. A soft delete therefore leaves the annotation rendered until
 * the tab is reopened.
 *
 * The save's `modify` event needs no such help in the other direction:
 * `getAnnotations()` excludes trashed items, so restoring one puts it back in
 * the set the reader re-renders, and moving one in place re-renders it at its
 * new position.
 *
 * Best-effort and non-fatal: the write has already committed, and a stale row
 * in an open reader must never surface as a failed action.
 */
export function unsetTrashedAnnotationsInOpenReaders(
    annotations: Array<{ attachmentID: number; key: string }>,
): void {
    if (!annotations.length) return;
    try {
        const readers = (Zotero.Reader as any)?._readers;
        if (!Array.isArray(readers) || !readers.length) return;

        const keysByAttachment = new Map<number, string[]>();
        for (const { attachmentID, key } of annotations) {
            const keys = keysByAttachment.get(attachmentID) ?? [];
            keys.push(key);
            keysByAttachment.set(attachmentID, keys);
        }

        for (const reader of readers) {
            const keys = keysByAttachment.get(reader?.itemID);
            if (keys?.length) reader.unsetAnnotations(keys);
        }
    } catch (error) {
        logger(
            `unsetTrashedAnnotationsInOpenReaders: reader refresh failed: ${error}`,
            1,
        );
    }
}
