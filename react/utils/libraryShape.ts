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
