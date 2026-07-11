import type { LibrarySummary } from '../agentProtocol';
import { logger } from '../../utils/logger';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';

async function countRegularItems(libraryId: number): Promise<number> {
    try {
        const sql = `
            SELECT COUNT(*) as cnt
            FROM items A
            LEFT JOIN itemNotes B USING (itemID)
            LEFT JOIN itemAttachments C USING (itemID)
            LEFT JOIN itemAnnotations D USING (itemID)
            WHERE A.libraryID = ?
            AND B.itemID IS NULL
            AND C.itemID IS NULL
            AND D.itemID IS NULL
            AND A.itemID NOT IN (SELECT itemID FROM deletedItems)
        `;
        let count = 0;
        await Zotero.DB.queryAsync(sql, [libraryId], {
            onRow: (row: any) => {
                count = row.getResultByIndex(0) as number;
            }
        });
        return count;
    } catch (error) {
        logger(
            `getLibrarySummaries: Error counting items for library ${libraryId}: ${error}`,
            2
        );
        return 0;
    }
}

async function countNotes(libraryId: number): Promise<number> {
    try {
        const sql = `
            SELECT COUNT(*) as cnt
            FROM items I
            JOIN itemNotes N ON I.itemID = N.itemID
            WHERE I.libraryID = ?
            AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
            AND (
                N.parentItemID IS NULL
                OR N.parentItemID NOT IN (SELECT itemID FROM deletedItems)
            )
        `;
        let count = 0;
        await Zotero.DB.queryAsync(sql, [libraryId], {
            onRow: (row: any) => {
                count = row.getResultByIndex(0) as number;
            }
        });
        return count;
    } catch (error) {
        logger(
            `getLibrarySummaries: Error counting notes for library ${libraryId}: ${error}`,
            2
        );
        return 0;
    }
}

async function countCollections(libraryId: number): Promise<number> {
    try {
        const sql = `
            SELECT COUNT(*) as cnt
            FROM collections
            WHERE libraryID = ?
            AND collectionID NOT IN (SELECT collectionID FROM deletedCollections)
        `;
        let count = 0;
        await Zotero.DB.queryAsync(sql, [libraryId], {
            onRow: (row: any) => {
                count = row.getResultByIndex(0) as number;
            }
        });
        return count;
    } catch (error) {
        logger(
            `getLibrarySummaries: Error counting collections for library ${libraryId}: ${error}`,
            2
        );
        return 0;
    }
}

async function countTags(libraryId: number): Promise<number> {
    try {
        const tags = await Zotero.Tags.getAll(libraryId);
        return (tags as any[]).length;
    } catch (error) {
        logger(
            `getLibrarySummaries: Error counting tags for library ${libraryId}: ${error}`,
            2
        );
        return 0;
    }
}

async function getLibrarySummary(library: any): Promise<LibrarySummary | null> {
    try {
        const [itemCount, noteCount, collectionCount, tagCount] = await Promise.all([
            countRegularItems(library.libraryID),
            countNotes(library.libraryID),
            countCollections(library.libraryID),
            countTags(library.libraryID),
        ]);

        return {
            library_id: library.libraryID,
            library_ref: libraryRefForLibraryID(library.libraryID) ?? undefined,
            name: library.name,
            is_group: library.isGroup,
            read_only: !library.editable || !library.filesEditable,
            item_count: itemCount,
            note_count: noteCount,
            collection_count: collectionCount,
            tag_count: tagCount,
        };
    } catch (error) {
        logger(
            `getLibrarySummaries: Error summarizing library ${library?.libraryID}: ${error}`,
            2
        );
        return null;
    }
}

/**
 * Return per-library count snapshots for the requested Zotero libraries.
 */
export async function getLibrarySummaries(
    libraryIds: number[]
): Promise<LibrarySummary[]> {
    if (libraryIds.length === 0) {
        return [];
    }

    try {
        const searchableIds = new Set(libraryIds);
        const libraries = Zotero.Libraries.getAll()
            .filter((lib: any) => searchableIds.has(lib.libraryID));

        const summaries = (await Promise.all(libraries.map(getLibrarySummary)))
            .filter((summary): summary is LibrarySummary => summary !== null);
        return summaries.sort((a, b) => a.library_id - b.library_id);
    } catch (error) {
        logger(`getLibrarySummaries: Error building library summaries: ${error}`, 2);
        return [];
    }
}
