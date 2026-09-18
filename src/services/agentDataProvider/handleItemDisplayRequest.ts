/**
 * item_display handler.
 *
 * The display fields of specific items, in one round trip: the name, the
 * second line and the type a list row draws, nothing else. The backend asks
 * once when a batch job's population is minted and stores the answer beside
 * the batch, so the receipt in the transcript can name the items a row stands
 * for without this library at hand.
 *
 * Bulk by design: every item the request names is loaded in one pass, so a
 * population at the batch cap costs a few queries rather than one per item.
 * The rows use the same formatters as every other surface (`getItemDisplayName`
 * / `getItemDescription`), so the receipt calls an item what search results
 * and citations call it.
 *
 * Ids this device cannot resolve — a library it does not have, a key that is
 * gone, an excluded library — simply have no row. That is not an error: the
 * caller draws those as ids.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { parseItemReference } from '@beaver/agent-core/identity/libraryRef';
import type {
    ItemDisplayRow,
    WSItemDisplayRequest,
    WSItemDisplayResponse,
} from '@beaver/agent-core/protocol/agentProtocol';
import { modelObjectId, resolveLibraryRef } from '../../utils/libraryIdentity';
import { getItemDisplayName } from '../../utils/itemDisplayName';
import { getItemDescription } from '../../utils/itemDescription';
import { getContentKind } from '../documentExtraction/attachmentResolution';
import { loadQuickSearchHitData } from './itemSearchSerialization';
import { checkLibraryExcluded } from './utils';

/**
 * Ids described per request. Matches the largest population a batch can hold;
 * anything past it is ignored rather than refused, since a partial answer is
 * still an answer.
 */
export const MAX_ITEM_DISPLAY_IDS = 1000;

/** The row for one loaded item. Throws only if the item's fields are unreadable. */
function toItemDisplayRow(item: Zotero.Item): ItemDisplayRow {
    const row: ItemDisplayRow = {
        item_id: modelObjectId(item.libraryID, item.key),
        item_type: item.itemType,
        display_name: getItemDisplayName(item),
    };
    const subtitle = getItemDescription(item);
    if (subtitle) row.subtitle = subtitle;
    if (item.isAttachment()) row.content_kind = getContentKind(item);
    return row;
}

/**
 * Handle item_display request from backend.
 * Resolves each id on this device, loads the fields the rows read in one
 * pass, and returns one row per item that could be described.
 */
export async function handleItemDisplayRequest(
    request: WSItemDisplayRequest,
): Promise<WSItemDisplayResponse> {
    const requested = Array.isArray(request.item_ids) ? request.item_ids : [];
    logger(`handleItemDisplayRequest: Describing ${requested.length} item(s)`, 1);

    try {
        // Keys to ids from the in-memory key map, which Zotero fills for every
        // library at startup, so this loop touches no database; then the items
        // in one fetch and their fields in one load, each a query per data
        // type and library rather than a round trip per item. This runs on
        // the batch start's critical path.
        const itemIDs: number[] = [];
        const seen = new Set<number>();
        for (const itemId of requested.slice(0, MAX_ITEM_DISPLAY_IDS)) {
            if (typeof itemId !== 'string') continue;
            const ref = parseItemReference(itemId);
            if (!ref) continue;
            const libraryID = resolveLibraryRef(ref);
            // A library this device does not have, or one the user excluded
            // from Beaver: no row, and no lookup that could leak its contents.
            if (!libraryID || checkLibraryExcluded(libraryID)) continue;
            const id = Zotero.Items.getIDFromLibraryAndKey(libraryID, ref.zotero_key);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            itemIDs.push(id);
        }
        const items: Zotero.Item[] = itemIDs.length ? await Zotero.Items.getAsync(itemIDs) : [];

        await loadQuickSearchHitData(items);

        const rows: ItemDisplayRow[] = [];
        for (const item of items) {
            // One item whose fields cannot be read costs its own row, not the
            // whole answer.
            try {
                rows.push(toItemDisplayRow(item));
            } catch (error) {
                logger(`handleItemDisplayRequest: Skipped ${item.key}: ${error}`, 1);
            }
        }

        logger(`handleItemDisplayRequest: Described ${rows.length}/${requested.length} item(s)`, 1);
        return { type: 'item_display', request_id: request.request_id, items: rows };
    } catch (error) {
        logger(`handleItemDisplayRequest: Error: ${error}`, 1);
        return {
            type: 'item_display',
            request_id: request.request_id,
            items: [],
            error: String(error),
            error_code: 'internal_error',
        };
    }
}
