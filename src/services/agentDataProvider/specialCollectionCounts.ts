/**
 * Item counts for Zotero's built-in views (Unfiled Items, My Publications,
 * Retracted Items, Trash), reported in application state alongside the
 * selected view.
 *
 * Counts use the same three categories as {@link getCollectionItemCounts}:
 * regular items, and attachments and notes that stand on their own rather
 * than under a parent. Each view's filter mirrors the condition Zotero itself
 * uses to fill the view. Trash counts are what is actually in the trash (see
 * `standsAlone`), which can differ from the rows Zotero shows there.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { CollectionItemCounts } from './collectionCounts';
import type { SpecialCollectionType } from '@beaver/agent-core/protocol/agentProtocol';

const NOT_TRASHED = 'I.itemID NOT IN (SELECT itemID FROM deletedItems)';

/** Which items of a library each counted view holds. Views absent here are not counted. */
const VIEW_FILTERS: Partial<Record<SpecialCollectionType, string>> = {
    // Zotero's unfiled condition also leaves out items in My Publications.
    unfiled: `I.itemID NOT IN (
            SELECT itemID FROM collectionItems
            WHERE collectionID NOT IN (SELECT collectionID FROM deletedCollections)
        )
        AND I.itemID NOT IN (SELECT itemID FROM publicationsItems)
        AND ${NOT_TRASHED}`,
    publications: `I.itemID IN (SELECT itemID FROM publicationsItems) AND ${NOT_TRASHED}`,
    retracted: `I.itemID IN (SELECT itemID FROM retractedItems WHERE flag = 0) AND ${NOT_TRASHED}`,
    trash: 'I.itemID IN (SELECT itemID FROM deletedItems)',
};

/**
 * When an attachment or note counts on its own rather than under a parent.
 * In the trash that also covers a trashed child whose parent is still in the
 * library: Zotero shows it under its greyed-out parent, but the child is what
 * sits in the trash, so it is counted.
 */
function standsAlone(view: SpecialCollectionType, column: string): string {
    if (view === 'trash') {
        return `(${column} IS NULL OR ${column} NOT IN (SELECT itemID FROM deletedItems))`;
    }
    return `${column} IS NULL`;
}

/**
 * Count the items in one built-in view of a library.
 *
 * Returns null for a view that is not counted (Duplicate Items) or when the
 * query fails — counts are contextual information, and a failure here should
 * not fail the caller.
 */
export async function getSpecialCollectionItemCounts(
    view: SpecialCollectionType,
    libraryID: number,
): Promise<CollectionItemCounts | null> {
    const filter = VIEW_FILTERS[view];
    if (!filter) return null;

    let counts: CollectionItemCounts | null = null;
    try {
        await Zotero.DB.queryAsync(`
            SELECT
                COALESCE(SUM(CASE WHEN IA.itemID IS NULL AND INo.itemID IS NULL AND IAn.itemID IS NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN IA.itemID IS NOT NULL AND ${standsAlone(view, 'IA.parentItemID')} THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN INo.itemID IS NOT NULL AND ${standsAlone(view, 'INo.parentItemID')} THEN 1 ELSE 0 END), 0)
            FROM items I
            LEFT JOIN itemAttachments IA ON I.itemID = IA.itemID
            LEFT JOIN itemNotes INo ON I.itemID = INo.itemID
            LEFT JOIN itemAnnotations IAn ON I.itemID = IAn.itemID
            WHERE I.libraryID = ?
            AND ${filter}
        `, [libraryID], {
            onRow: (row: any) => {
                counts = {
                    itemCount: row.getResultByIndex(0) as number,
                    standaloneAttachmentCount: row.getResultByIndex(1) as number,
                    standaloneNoteCount: row.getResultByIndex(2) as number,
                };
            },
        });
    } catch (error) {
        logger(`getSpecialCollectionItemCounts: Error counting ${view} in library ${libraryID}: ${error}`, 2);
        return null;
    }
    return counts;
}
