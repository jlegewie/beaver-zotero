/**
 * Live counts for the table card's sources, resolved in this client.
 *
 * A library source (collection, tag, saved search) goes through the same
 * population handler the backend asks over the socket, so the card counts what
 * the table will be built from; items go through the item display lookup. No
 * file is opened: the "No PDF" chip is attachment presence only, of any
 * document a row reads (PDF, EPUB or snapshot). The card's numbers are a
 * preview; the backend resolves the approved entries again.
 */

import { parseItemReference } from '@beaver/agent-core/identity/libraryRef';
import type { ItemDisplayRow } from '@beaver/agent-core/protocol/agentProtocol';
import type { TableCardLibraryScope, TableCardResolved } from '@beaver/agent-core/protocol/tableCardProtocol';
import {
    MAX_ITEM_DISPLAY_IDS,
    handleItemDisplayRequest,
} from '../../../../src/services/agentDataProvider/handleItemDisplayRequest';
import { handleResolvePopulationRequest } from '../../../../src/services/agentDataProvider/handleResolvePopulationRequest';
import { resolveLibraryRef } from '../../../../src/utils/libraryIdentity';

/** Rows a table holds; the population is asked for no more. */
const ROW_CAP = 1000;
const SAMPLE_SIZE = 5;

export interface LiveSource {
    resolved: TableCardResolved;
    /** Display rows in source order, for the expanded card. */
    rows: ItemDisplayRow[];
    /** The scope's display name, when the population reported one. */
    name?: string;
}

let sequence = 0;
const requestId = (kind: string) => `table-card-${kind}-${++sequence}`;

/** Display rows for item ids, in the order given; ids that do not resolve are absent. */
export async function describeItems(ids: string[]): Promise<ItemDisplayRow[]> {
    const byId = new Map<string, ItemDisplayRow>();
    // One request describes at most MAX_ITEM_DISPLAY_IDS ids.
    for (let start = 0; start < ids.length; start += MAX_ITEM_DISPLAY_IDS) {
        const response = await handleItemDisplayRequest({
            event: 'item_display_request',
            request_id: requestId('items'),
            item_ids: ids.slice(start, start + MAX_ITEM_DISPLAY_IDS),
            include_pdf: true,
        });
        for (const row of response.items) byId.set(row.item_id, row);
    }
    return ids.map((id) => byId.get(id)).filter((row): row is ItemDisplayRow => !!row);
}

function block(rows: ItemDisplayRow[], total: number, truncated: boolean): TableCardResolved {
    return {
        count: rows.length,
        total: Math.max(total, rows.length),
        truncated,
        without_pdf: rows.filter((row) => row.has_pdf === false).length,
        sample: rows.slice(0, SAMPLE_SIZE).map((row) => ({ id: row.item_id, title: row.display_name })),
    };
}

/** Whether a portable item id names an item in the trash, which yields no row. */
function isTrashed(id: string): boolean {
    const ref = parseItemReference(id);
    const libraryID = ref ? resolveLibraryRef(ref) : null;
    if (!ref || !libraryID) return false;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, ref.zotero_key) as Zotero.Item | false;
    return !!item && item.deleted;
}

/**
 * The Selected items source: its ids that resolve to regular items outside
 * the trash, as the backend resolves them. The total is every id it holds, so
 * a source above the row cap stays above it.
 */
export async function resolveItems(ids: string[]): Promise<LiveSource> {
    const rows = (await describeItems(ids)).filter((row) => row.content_kind == null && !isTrashed(row.item_id));
    return { resolved: block(rows, ids.length, false), rows };
}

/** A collection, tag or saved search, as the population request resolves it. */
export async function resolveLibraryScope(scope: TableCardLibraryScope): Promise<LiveSource> {
    const libraryID = resolveLibraryRef({ library_ref: scope.library_ref });
    const failed = (error: string): LiveSource => ({
        resolved: { count: 0, total: 0, truncated: false, without_pdf: 0, sample: [], error },
        rows: [],
    });
    if (!libraryID) return failed('This library is not available.');
    const response = await handleResolvePopulationRequest({
        event: 'resolve_population_request',
        request_id: requestId('population'),
        library_id: libraryID,
        collection_keys: scope.kind === 'collection' && scope.key ? [scope.key] : null,
        // A collection includes its subcollections, as the backend resolves it.
        recursive: true,
        tags: scope.kind === 'tag' && scope.tag ? [scope.tag] : null,
        unfiled: false,
        untagged: false,
        conditions:
            scope.kind === 'saved_search' && scope.key
                ? [{ field: 'savedSearch', operator: 'is', value: scope.key }]
                : [],
        item_category: 'regular',
        max_items: ROW_CAP,
    });
    if (response.error) return failed(response.error);
    const ids = response.item_ids ?? [];
    const rows = await describeItems(ids);
    const name =
        scope.kind === 'collection'
            ? response.collection_names?.[0]
            : scope.kind === 'saved_search' && scope.key
              ? response.saved_search_names?.[scope.key]
              : scope.tag ?? undefined;
    return {
        resolved: block(rows, response.total_count ?? rows.length, !!response.truncated),
        rows,
        name: name ?? undefined,
    };
}
