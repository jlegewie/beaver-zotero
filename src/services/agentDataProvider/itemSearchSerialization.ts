/**
 * Shared serialization of item-search hits into the full
 * `ItemSearchFrontendResultItem` rows (item metadata plus attachments).
 *
 * Used by every search handler that serves the `full` projection, so the rows
 * a client or the model sees do not depend on which search produced them.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { ItemSearchFrontendResultItem } from '@beaver/agent-core/protocol/agentProtocol';
import { serializeItem } from '../../utils/zoteroSerializers';
import { TimingAccumulator } from '../../utils/timing';
import { prepareAttachmentInfoBatchData, processAttachmentInfoBatch } from './utils';

/** Items serialized concurrently per batch. */
const BATCH_SIZE_CAP = 20;

/**
 * Serialize candidate items into full search rows, in bounded parallel batches.
 *
 * Batches keep the cost tracking what the page actually serializes: a search
 * over-fetches to survive deduplication and the page slice, and only the rows
 * reached here are ever serialized. A row that fails to serialize is dropped
 * and the next candidate backfills it, so a single unreadable item does not
 * shorten the page.
 *
 * @param candidates - Ranked, already-filtered and already-offset items
 * @param targetLimit - Rows to return; serialization stops once it is reached
 * @param ta - Timing accumulator for the serialization breakdown
 * @param logLabel - Handler name used in failure logs
 */
export async function serializeItemSearchRows(
    candidates: Zotero.Item[],
    targetLimit: number,
    ta: TimingAccumulator,
    logLabel: string,
): Promise<ItemSearchFrontendResultItem[]> {
    const batchSize = Math.max(1, Math.min(targetLimit, BATCH_SIZE_CAP));
    const resultItems: ItemSearchFrontendResultItem[] = [];

    for (let batchStart = 0; batchStart < candidates.length && resultItems.length < targetLimit; batchStart += batchSize) {
        const batch = candidates.slice(batchStart, batchStart + batchSize);

        // The search itself loads only the fields ranking and deduplication
        // compare, so the rest is loaded per batch, for the rows that survive.
        await ta.track('data_loading_ms', () =>
            Zotero.Items.loadDataTypes(batch, ["primaryData", "tags", "collections", "relations", "childItems"])
        );
        const batchAttachmentData = await prepareAttachmentInfoBatchData(batch, ta);

        const serialized = await Promise.all(
            batch.map(async (item): Promise<ItemSearchFrontendResultItem | null> => {
                try {
                    const [itemData, attachments] = await Promise.all([
                        ta.track('item_serialization_ms', () => serializeItem(item, undefined, { skipHash: true })),
                        ta.track('attachment_processing_ms', () => processAttachmentInfoBatch(
                            item,
                            batchAttachmentData,
                            {
                                skipWorkerFallback: true,
                                timing: ta,
                                includeAnnotationsCount: true,
                            },
                        )),
                    ]);
                    return { item: itemData, attachments };
                } catch (error) {
                    logger(`${logLabel}: Failed to serialize item ${item.key}: ${error}`, 1);
                    return null;
                }
            })
        );

        for (const result of serialized) {
            if (result !== null) {
                resultItems.push(result);
                if (resultItems.length >= targetLimit) break;
            }
        }
    }

    return resultItems;
}
