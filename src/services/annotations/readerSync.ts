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
 * The save's `modify` event needs no such help when restoring an annotation:
 * `getAnnotations()` excludes trashed items, so restoring one puts it back in
 * the set the reader re-renders.
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

/**
 * Replace moved annotations in every open reader showing their attachment.
 *
 * Zotero normally replaces an annotation with the same key in one
 * `setAnnotations()` pass. Its targeted annotation renders can leave the old
 * pixels on the source-page canvas even though both Zotero's item and the
 * reader's annotation manager already contain the new position. A pointer
 * move into the reader fixes it because Zotero's pointer handler calls the
 * full PDF-view render path. Explicitly unsetting and setting the item keeps
 * the reader model in sync; invoking that same full render path removes the
 * stale source pixels without waiting for pointer input.
 *
 * This runs only after the database transaction commits and is deliberately
 * best-effort: reader repaint trouble must not turn a successful write into a
 * failed agent action.
 */
export async function refreshMovedAnnotationsInOpenReaders(
    annotations: Array<{ attachmentID: number; item: Zotero.Item }>,
): Promise<void> {
    if (!annotations.length) return;
    try {
        const readers = (Zotero.Reader as any)?._readers;
        if (!Array.isArray(readers) || !readers.length) return;

        const annotationsByAttachment = new Map<number, Zotero.Item[]>();
        for (const { attachmentID, item } of annotations) {
            const items = annotationsByAttachment.get(attachmentID) ?? [];
            items.push(item);
            annotationsByAttachment.set(attachmentID, items);
        }

        // Snapshot the registry because a reader can close (and splice itself
        // out of Zotero.Reader._readers) while an asynchronous refresh is in
        // progress. Iterating the live array could otherwise skip its
        // successor even when the failure itself is caught.
        for (const reader of readers.slice()) {
            const items = annotationsByAttachment.get(reader?.itemID);
            if (!items?.length) continue;
            try {
                reader.unsetAnnotations(items.map((item) => item.key));
                await reader.setAnnotations(items);
                // This is the redraw path Zotero's PDF pointer-move handler uses.
                // The annotation manager and item are already correct at this
                // point; this call only invalidates stale canvas pixels.
                reader._internalReader?._primaryView?._render();
                reader._internalReader?._secondaryView?._render();
            } catch (error) {
                logger(
                    `refreshMovedAnnotationsInOpenReaders: reader ${reader?.itemID ?? "unknown"} refresh failed: ${error}`,
                    1,
                );
            }
        }
    } catch (error) {
        logger(
            `refreshMovedAnnotationsInOpenReaders: reader refresh failed: ${error}`,
            1,
        );
    }
}
