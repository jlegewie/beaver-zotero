import type { LibraryShape } from '../constants/featureCreditTasks';
import { logger } from '@beaver/agent-core/platform/logger';

/**
 * How the user organizes the given libraries: how many collections they
 * have and whether they tag items by hand. Read locally; pass only the
 * libraries Beaver may read.
 */
export async function readLibraryShape(libraryIds: number[]): Promise<LibraryShape | null> {
    if (libraryIds.length === 0) return { collectionCount: 0, usesTags: false };
    try {
        let collectionCount = 0;
        for (const libraryID of libraryIds) {
            collectionCount += Zotero.Collections.getByLibrary(libraryID, true).length;
        }
        const placeholders = libraryIds.map(() => '?').join(', ');
        let usesTags = false;
        // Manual tags only (type 0): automatic tags come from imports and
        // say nothing about how the user organizes.
        await Zotero.DB.queryAsync(
            `SELECT 1 FROM itemTags JOIN items USING (itemID)
             WHERE itemTags.type = 0 AND items.libraryID IN (${placeholders}) LIMIT 1`,
            libraryIds,
            { onRow: () => { usesTags = true; } },
        );
        return { collectionCount, usesTags };
    } catch (error) {
        logger(`readLibraryShape failed: ${String(error)}`, 2);
        return null;
    }
}

/**
 * Regular items (not notes, attachments or annotations) that are not in the
 * trash, counted up to `cap`: in the given libraries, or in every library
 * except feeds when none are given. The scan stops at `cap`, so the query
 * stays cheap on a large library. Null when the query fails.
 */
export async function countLibraryItems(cap: number, libraryIds?: number[]): Promise<number | null> {
    if (libraryIds?.length === 0) return 0;
    const scope = libraryIds
        ? `i.libraryID IN (${libraryIds.map(() => '?').join(', ')})`
        : `i.libraryID IN (SELECT libraryID FROM libraries WHERE type != 'feed')`;
    try {
        let count = 0;
        await Zotero.DB.queryAsync(
            `SELECT 1 FROM items i
             WHERE ${scope}
               AND i.itemTypeID NOT IN (
                   SELECT itemTypeID FROM itemTypes
                   WHERE typeName IN ('note', 'attachment', 'annotation')
               )
               AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
             LIMIT ?`,
            [...(libraryIds ?? []), cap],
            { onRow: () => { count++; } },
        );
        return count;
    } catch (error) {
        logger(`countLibraryItems failed: ${String(error)}`, 2);
        return null;
    }
}
