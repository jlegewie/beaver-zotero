import { logger } from '../../utils/logger';
import { safeIsInTrash } from '../../utils/zoteroUtils';
import type { TimingAccumulator } from '../../utils/timing';
import { getAttachmentInfo, type AttachmentInfoOptions } from './attachmentInfo';
import type { AttachmentInfo } from './shared/contentKinds';
import { modelObjectId } from '../../utils/libraryIdentity';

/**
 * Batch-fetch the "best attachment" for multiple parent items in a single SQL query.
 */
export async function getBestAttachmentBatch(
    parentItemIds: number[],
): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (parentItemIds.length === 0) return result;

    const CHUNK_SIZE = 500;
    for (let i = 0; i < parentItemIds.length; i += CHUNK_SIZE) {
        const chunk = parentItemIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');

        const sql = `
            WITH ranked AS (
                SELECT
                    IA.parentItemID,
                    IA.itemID AS attachmentItemID,
                    ROW_NUMBER() OVER (
                        PARTITION BY IA.parentItemID
                        ORDER BY
                            CASE WHEN IA.contentType = 'application/pdf' THEN 0 ELSE 1 END,
                            CASE WHEN COALESCE(IDV_att.value, '') = COALESCE(IDV_parent.value, '') THEN 0 ELSE 1 END,
                            I.dateAdded ASC
                    ) AS rn
                FROM itemAttachments IA
                JOIN items I ON I.itemID = IA.itemID
                LEFT JOIN deletedItems DI ON DI.itemID = IA.itemID
                LEFT JOIN itemData ID_att ON ID_att.itemID = IA.itemID
                    AND ID_att.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'url')
                LEFT JOIN itemDataValues IDV_att ON IDV_att.valueID = ID_att.valueID
                LEFT JOIN itemData ID_parent ON ID_parent.itemID = IA.parentItemID
                    AND ID_parent.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'url')
                LEFT JOIN itemDataValues IDV_parent ON IDV_parent.valueID = ID_parent.valueID
                WHERE IA.parentItemID IN (${placeholders})
                  AND DI.itemID IS NULL
                  AND IA.linkMode != ${Zotero.Attachments.LINK_MODE_LINKED_URL}
            )
            SELECT parentItemID, attachmentItemID
            FROM ranked
            WHERE rn = 1
        `;

        const rows: { parentItemID: number; attachmentItemID: number }[] = [];
        await Zotero.DB.queryAsync(sql, chunk, {
            onRow: (row: any) => {
                rows.push({
                    parentItemID: row.getResultByIndex(0),
                    attachmentItemID: row.getResultByIndex(1),
                });
            },
        });

        for (const row of rows) {
            result.set(row.parentItemID, row.attachmentItemID);
        }
    }

    return result;
}

export interface AttachmentInfoBatchData {
    bestAttachmentMap: Map<number, number>;
}

/**
 * Prepare reusable lookup data for resolving attachment info in batches.
 */
export async function prepareAttachmentInfoBatchData(
    parentItems: Zotero.Item[],
    timing?: TimingAccumulator,
): Promise<AttachmentInfoBatchData> {
    const parentItemIds = parentItems.map(item => item.id);
    const fn = () => getBestAttachmentBatch(parentItemIds);
    const bestAttachmentMap = timing
        ? await timing.track('batch_prefetch_ms', fn)
        : await fn();
    return { bestAttachmentMap };
}

/**
 * Process a regular item's child attachments into unified AttachmentInfo results.
 */
export async function processAttachmentInfoBatch(
    item: Zotero.Item,
    batchData: AttachmentInfoBatchData,
    options?: AttachmentInfoOptions,
): Promise<AttachmentInfo[]> {
    const ta = options?.timing;
    const attachmentIds = item.getAttachments();
    if (attachmentIds.length === 0) {
        return [];
    }

    const fetchFn = () => Zotero.Items.getAsync(attachmentIds);
    const attachmentItems = ta
        ? await ta.track('att_fetch_ms', fetchFn)
        : await fetchFn();

    const loadFn = () => Zotero.Items.loadDataTypes(
        attachmentItems,
        ['primaryData', 'itemData', 'tags', 'collections', 'relations', 'childItems'],
    );
    await (ta ? ta.track('att_load_data_ms', loadFn) : loadFn());

    const bestAttachmentId = batchData.bestAttachmentMap.get(item.id);
    const parentItemId = modelObjectId(item.libraryID, item.key);
    const attachmentPromises = attachmentItems.map(async (attachment): Promise<AttachmentInfo | null> => {
        if (!attachment || attachment.deleted || safeIsInTrash(attachment)) {
            return null;
        }
        const isPrimary = bestAttachmentId !== undefined && attachment.id === bestAttachmentId;
        const infoFn = () => getAttachmentInfo(attachment, {
            ...options,
            parentItemId,
            isPrimary,
        });
        try {
            return await (ta ? ta.track('att_file_status_ms', infoFn) : infoFn());
        } catch (error) {
            logger(`processAttachmentInfoBatch: failed for ${attachment.libraryID}-${attachment.key}: ${error}`, 2);
            return null;
        }
    });

    const results = await Promise.all(attachmentPromises);
    return results.filter((result): result is AttachmentInfo => result !== null);
}
