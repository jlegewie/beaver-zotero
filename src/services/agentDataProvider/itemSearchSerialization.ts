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
import { getItemDescription } from '../../utils/itemDescription';
import { formatItemReference } from '../../utils/itemReference';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';
import { TimingAccumulator } from '../../utils/timing';
import { prepareAttachmentInfoBatchData, processAttachmentInfoBatch } from './utils';

/** Levels of parent walked for a compact row: annotation → attachment → work. */
const PARENT_CHAIN_DEPTH = 2;

/**
 * Load everything a compact row reads, for a whole page at once.
 *
 * {@link toQuickSearchHit} is synchronous, so every value it touches has to be
 * in memory before it runs — and Zotero loads item data lazily, per data type.
 * Two of those are easy to miss because failing to load them raises nothing a
 * caller sees, it just quietly degrades the row:
 *
 * - **`note`.** `getNoteTitle()` only needs `itemData`, so a note's display
 *   name looks right, but `getNote()` requires the separate `note` type and
 *   throws without it — turning the content preview into a bare "Attached
 *   note".
 * - **The parent chain.** `item.parentItem` is a synchronous cache lookup
 *   (`Zotero.Items.get(parentID) || undefined`), so an uncached parent is
 *   indistinguishable from no parent: a real child attachment describes itself
 *   as "Standalone attachment" and an annotation loses the work it sits in.
 *
 * Annotations need nothing extra despite reading lazily-loaded properties:
 * loading `itemData` runs Zotero's own `updateDisplayTitle()`, which catches
 * the unloaded-data error and pulls in the `annotation` type before recomputing
 * the highlighted-text label. That back-fill is why a note is the odd one out —
 * a note's *display title* only needs `itemData`, so nothing ever forces its
 * content to load.
 *
 * Loads are batched per type and skipped when nothing needs them, so a page of
 * ordinary top-level items still costs the single call it always did.
 */
export async function loadQuickSearchHitData(items: Zotero.Item[]): Promise<void> {
    if (items.length === 0) return;

    // Fields and creators for both lines; child items for `has_attachment`.
    await Zotero.Items.loadDataTypes(items, ['itemData', 'creators', 'childItems']);

    /** Items matching a type predicate, ignoring any that cannot answer it. */
    const select = (predicate: (item: Zotero.Item) => boolean): Zotero.Item[] =>
        items.filter((item) => {
            try {
                return predicate(item);
            } catch {
                return false;
            }
        });

    const notes = select((item) => item.isNote());
    if (notes.length > 0) {
        await Zotero.Items.loadDataTypes(notes, ['note']);
    }

    // Walk up to the work itself, resolving each level into the cache that
    // `parentItem` reads. The parents are only ever named, so they need the
    // fields `getItemDisplayName` reads and nothing more.
    const parents: Zotero.Item[] = [];
    let frontier = items;
    for (let depth = 0; depth < PARENT_CHAIN_DEPTH; depth++) {
        const parentIds = Array.from(new Set(
            frontier
                .map((item) => {
                    try {
                        return item.parentItemID;
                    } catch {
                        return null;
                    }
                })
                .filter((id): id is number => typeof id === 'number')
        ));
        if (parentIds.length === 0) break;

        let resolved: Zotero.Item[];
        try {
            resolved = await Zotero.Items.getAsync(parentIds);
        } catch (error) {
            logger(`loadQuickSearchHitData: Failed to resolve parent items: ${error}`, 2);
            break;
        }
        parents.push(...resolved);
        frontier = resolved;
    }
    if (parents.length > 0) {
        await Zotero.Items.loadDataTypes(parents, ['itemData', 'creators']);
    }
}

/** Options for {@link toQuickSearchHit}. */
export interface QuickSearchHitOptions {
    /**
     * Ranking score, for the ops that rank. Omitted when there is no ranking
     * to explain.
     */
    score?: number;
}

/**
 * Build the compact projection: what a chip, a menu row and a hover card need.
 *
 * `display_name` and `description` are computed here, in Zotero, so a client
 * without a local library renders the same two lines the Zotero UI does rather
 * than rebuilding them from `creators[]` and drifting from what citations and
 * tool-call headers call the same item.
 *
 * Synchronous, so the caller must have run {@link loadQuickSearchHitData} over
 * the page first — every value read here comes from already-loaded data.
 */
export function toQuickSearchHit(
    item: Zotero.Item,
    options: QuickSearchHitOptions = {}
): QuickSearchHit {
    const { score } = options;

    let hasAttachment: boolean | undefined;
    try {
        hasAttachment = item.getAttachments().length > 0;
    } catch {
        hasAttachment = undefined;
    }

    // Guarded because the compact path serializes a whole page without a
    // per-item catch: one item whose fields cannot be read must cost its own
    // second line, not the entire response.
    let description: string | undefined;
    try {
        description = getItemDescription(item) || undefined;
    } catch {
        description = undefined;
    }

    // Notes and attachments format as "PDF (n.d.). Attachment.", which is
    // worse for a hover card than having no body at all.
    //
    // Guarded like `description` above, and for the same reason: this path
    // serializes a whole page without a per-item catch, so one unreadable item
    // must cost its own hover card rather than the entire response.
    let formattedCitation: string | undefined;
    if (item.isRegularItem()) {
        try {
            formattedCitation = formatItemReference(item) || undefined;
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
        description,
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
