/**
 * Per-collection count queries shared by the `list_collections` tool and the
 * application-state snapshot, so both report the same numbers for the same
 * collection.
 *
 * All counts are for **direct membership**, not recursive: in Zotero only
 * top-level items belong to a collection, and a subcollection's contents are
 * not part of its parent. A child note or attachment is reached through its
 * parent item rather than being a collection member itself, which is why the
 * note and attachment counts here only cover standalone ones.
 *
 * Trashed collections and items are excluded throughout.
 */

import { logger } from '../../utils/logger';

/** Direct-membership counts for a single collection. */
export interface CollectionItemCounts {
    /** Top-level regular items (excludes attachments, notes and annotations). */
    itemCount: number;
    /** Attachments that sit directly in the collection rather than under an item. */
    standaloneAttachmentCount: number;
    /** Notes that sit directly in the collection rather than under an item. */
    standaloneNoteCount: number;
}

const EMPTY_COUNTS: CollectionItemCounts = {
    itemCount: 0,
    standaloneAttachmentCount: 0,
    standaloneNoteCount: 0,
};

/**
 * SQLite caps the number of bound variables per statement, so collection ids
 * are queried in chunks rather than as one unbounded `IN` list.
 */
const MAX_IDS_PER_QUERY = 500;

function chunk<T>(values: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
        chunks.push(values.slice(i, i + size));
    }
    return chunks;
}

/** Run one grouped `collectionID -> count` query and fold it into `target`. */
async function tally(
    sql: string,
    collectionIds: number[],
    target: Map<number, number>,
): Promise<void> {
    await Zotero.DB.queryAsync(sql, collectionIds, {
        onRow: (row: any) => {
            target.set(row.getResultByIndex(0) as number, row.getResultByIndex(1) as number);
        },
    });
}

/**
 * Count top-level items, standalone attachments and standalone notes for each
 * of the given collections.
 *
 * Collections with nothing in them are absent from the returned map; use
 * {@link countsFor} to read it with a zero default. Returns an empty map rather
 * than throwing if the queries fail — counts are contextual information, and a
 * failure here should not fail the caller.
 */
export async function getCollectionItemCounts(
    collectionIds: number[],
): Promise<Map<number, CollectionItemCounts>> {
    const counts = new Map<number, CollectionItemCounts>();
    if (collectionIds.length === 0) return counts;

    const items = new Map<number, number>();
    const attachments = new Map<number, number>();
    const notes = new Map<number, number>();

    try {
        for (const ids of chunk(collectionIds, MAX_IDS_PER_QUERY)) {
            const placeholders = ids.map(() => '?').join(',');

            // Top-level regular items, matching how the library-wide item count
            // is defined so the two are comparable.
            await tally(`
                SELECT CI.collectionID, COUNT(*)
                FROM collectionItems CI
                JOIN items I ON CI.itemID = I.itemID
                LEFT JOIN itemAttachments IA ON I.itemID = IA.itemID
                LEFT JOIN itemNotes INo ON I.itemID = INo.itemID
                LEFT JOIN itemAnnotations IAn ON I.itemID = IAn.itemID
                WHERE CI.collectionID IN (${placeholders})
                AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
                AND IA.itemID IS NULL
                AND INo.itemID IS NULL
                AND IAn.itemID IS NULL
                GROUP BY CI.collectionID
            `, ids, items);

            await tally(`
                SELECT CI.collectionID, COUNT(*)
                FROM collectionItems CI
                JOIN items I ON CI.itemID = I.itemID
                JOIN itemAttachments IA ON I.itemID = IA.itemID
                WHERE CI.collectionID IN (${placeholders})
                AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
                AND IA.parentItemID IS NULL
                GROUP BY CI.collectionID
            `, ids, attachments);

            await tally(`
                SELECT CI.collectionID, COUNT(*)
                FROM collectionItems CI
                JOIN items I ON CI.itemID = I.itemID
                JOIN itemNotes INo ON I.itemID = INo.itemID
                WHERE CI.collectionID IN (${placeholders})
                AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
                AND INo.parentItemID IS NULL
                GROUP BY CI.collectionID
            `, ids, notes);
        }
    } catch (error) {
        logger(`getCollectionItemCounts: Error fetching collection counts: ${error}`, 2);
        return new Map();
    }

    for (const collectionId of collectionIds) {
        const itemCount = items.get(collectionId) || 0;
        const standaloneAttachmentCount = attachments.get(collectionId) || 0;
        const standaloneNoteCount = notes.get(collectionId) || 0;
        if (itemCount || standaloneAttachmentCount || standaloneNoteCount) {
            counts.set(collectionId, { itemCount, standaloneAttachmentCount, standaloneNoteCount });
        }
    }
    return counts;
}

/**
 * Count the direct, non-trashed subcollections of each given collection.
 *
 * Collections with no subcollections are absent from the returned map.
 */
export async function getSubcollectionCounts(
    collectionIds: number[],
): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if (collectionIds.length === 0) return counts;

    try {
        for (const ids of chunk(collectionIds, MAX_IDS_PER_QUERY)) {
            const placeholders = ids.map(() => '?').join(',');
            await tally(`
                SELECT parentCollectionID, COUNT(*)
                FROM collections
                WHERE parentCollectionID IN (${placeholders})
                AND collectionID NOT IN (SELECT collectionID FROM deletedCollections)
                GROUP BY parentCollectionID
            `, ids, counts);
        }
    } catch (error) {
        logger(`getSubcollectionCounts: Error fetching subcollection counts: ${error}`, 2);
        return new Map();
    }
    return counts;
}

/** Read a collection's counts from {@link getCollectionItemCounts}, defaulting to zero. */
export function countsFor(
    counts: Map<number, CollectionItemCounts>,
    collectionId: number,
): CollectionItemCounts {
    return counts.get(collectionId) ?? EMPTY_COUNTS;
}
