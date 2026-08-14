/**
 * Shared serialization of item rows into the two projections the library ops
 * offer: the full `ItemSearchFrontendResultItem` (item metadata plus
 * attachments) and the compact `QuickSearchHit`.
 *
 * Used by every handler that serves either projection, so the rows a client or
 * the model sees do not depend on which op produced them.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { ItemSearchFrontendResultItem, QuickSearchHit } from '@beaver/agent-core/protocol/agentProtocol';
import { serializeItem, getYearFromItem } from '../../utils/zoteroSerializers';
import { getItemDisplayName } from '../../utils/itemDisplayName';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';
import { TimingAccumulator } from '../../utils/timing';
import { prepareAttachmentInfoBatchData, processAttachmentInfoBatch } from './utils';

/**
 * Build the compact projection: what a chip, a menu row and a hover card need.
 *
 * `display_name` and `formatted_citation` are computed here, in Zotero, so a
 * client without a local library renders the same label the Zotero UI does
 * rather than rebuilding one from `creators[]` and drifting from what citations
 * and tool-call headers call the same item.
 *
 * Requires `childItems` to be loaded for `has_attachment`; the flag is omitted
 * rather than reported as false when it is not.
 *
 * @param score - Ranking score, for the ops that rank. Omitted when there is
 * no ranking to explain.
 */
export function toQuickSearchHit(item: Zotero.Item, score?: number): QuickSearchHit {
    let hasAttachment: boolean | undefined;
    try {
        hasAttachment = item.getAttachments().length > 0;
    } catch {
        hasAttachment = undefined;
    }

    // Only a regular item has a bibliography entry. A note or an attachment
    // formats as something like "“PDF.” n.d.", which is worse for a hover card
    // than having no body at all.
    let formattedCitation: string | undefined;
    if (item.isRegularItem()) {
        try {
            formattedCitation = Zotero.Beaver?.citationService?.formatBibliography(item) || undefined;
        } catch {
            formattedCitation = undefined;
        }
    }

    return {
        library_id: item.libraryID,
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        zotero_key: item.key,
        item_type: item.itemType,
        display_name: getItemDisplayName(item),
        title: item.getDisplayTitle?.() || item.getField('title') || undefined,
        year: getYearFromItem(item),
        formatted_citation: formattedCitation,
        has_attachment: hasAttachment,
        score,
    };
}

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
