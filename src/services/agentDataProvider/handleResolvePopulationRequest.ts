/**
 * resolve_population handler.
 *
 * Resolves a batch operation's population — every item matching a filter
 * description — in a single round trip, returning ids only. The population is
 * frozen by the backend and later sliced against the returned order, so this
 * handler must never load or serialize items (that is what made the old
 * `list_items` paging loop cost O(library)), and the order it returns must be
 * deterministic.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    WSResolvePopulationRequest,
    WSResolvePopulationResponse,
} from '@beaver/agent-core/protocol/agentProtocol';
import { modelObjectId } from '../../utils/libraryIdentity';
import { validateLibraryAccess } from './utils';
import { addSearchCondition } from './searchConditions';

/** SQLite's bound-variable limit is well above this; 500 keeps a margin. */
const SQL_CHUNK_SIZE = 500;

/** Mirrors the backend's `max_items` default, for a request that omits it. */
const DEFAULT_MAX_ITEMS = 1000;

/** Row of the id/order query. `key`, `libraryID` and `dateAdded` are all columns on `items`. */
interface PopulationRow {
    itemID: number;
    key: string;
    libraryID: number;
    dateAdded: string;
}

/**
 * Item ids that have at least one attachment that is not in the trash.
 * A trashed attachment must not count, so that this matches what the user
 * sees in Zotero (and what `item.numAttachments()` reports).
 */
async function itemIdsWithAttachments(itemIds: number[]): Promise<Set<number>> {
    const withAttachments = new Set<number>();

    for (let i = 0; i < itemIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = itemIds.slice(i, i + SQL_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        await Zotero.DB.queryAsync(
            'SELECT DISTINCT ia.parentItemID FROM itemAttachments ia '
                + 'LEFT JOIN deletedItems di ON di.itemID = ia.itemID '
                + `WHERE ia.parentItemID IN (${placeholders}) AND di.itemID IS NULL`,
            chunk,
            {
                onRow: (row: any) => {
                    withAttachments.add(row.getResultByIndex(0));
                },
            },
        );
    }

    return withAttachments;
}

/**
 * Read key/library/dateAdded for the matched ids without loading any item.
 * Chunked, so the caller must re-sort globally — a per-chunk `ORDER BY` only
 * orders within its own chunk.
 */
async function readPopulationRows(itemIds: number[]): Promise<PopulationRow[]> {
    const rows: PopulationRow[] = [];

    for (let i = 0; i < itemIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = itemIds.slice(i, i + SQL_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        await Zotero.DB.queryAsync(
            `SELECT itemID, key, libraryID, dateAdded FROM items WHERE itemID IN (${placeholders}) `
                + 'ORDER BY dateAdded, itemID',
            chunk,
            {
                onRow: (row: any) => {
                    rows.push({
                        itemID: row.getResultByIndex(0),
                        key: row.getResultByIndex(1),
                        libraryID: row.getResultByIndex(2),
                        dateAdded: row.getResultByIndex(3),
                    });
                },
            },
        );
    }

    return rows;
}

/** Empty response carrying an error. A failed resolution must never look like an empty match. */
function errorResponse(
    requestId: string,
    error: string,
    errorCode: string,
    availableLibraries?: WSResolvePopulationResponse['available_libraries'],
): WSResolvePopulationResponse {
    return {
        type: 'resolve_population',
        request_id: requestId,
        item_ids: [],
        total_count: 0,
        truncated: false,
        error,
        error_code: errorCode,
        available_libraries: availableLibraries,
    };
}

/**
 * Handle resolve_population request from backend.
 * Runs one native Zotero search with every filter ANDed and returns ids only.
 */
export async function handleResolvePopulationRequest(
    request: WSResolvePopulationRequest
): Promise<WSResolvePopulationResponse> {
    logger(`handleResolvePopulationRequest: Resolving population (${request.conditions?.length ?? 0} conditions)`, 1);

    try {
        // Validate library (checks both existence and searchability)
        const validation = validateLibraryAccess(request.library_id);
        if (!validation.valid) {
            return errorResponse(
                request.request_id,
                validation.error!,
                validation.error_code!,
                validation.available_libraries,
            );
        }
        const library = validation.library!;

        // Item category. Anything other than 'attachment' resolves to the
        // 'regular' default: a bogus value must not widen the population.
        const itemCategory = request.item_category === 'attachment' ? 'attachment' : 'regular';

        // A filter this handler cannot apply must fail the request, never be
        // dropped: the population it resolves is about to be mutated, and a
        // dropped filter makes it strictly larger than the caller described.
        if (itemCategory === 'attachment' && request.has_attachments != null) {
            return errorResponse(
                request.request_id,
                "has_attachments describes a regular item and cannot be combined with "
                    + "item_category='attachment'. Drop has_attachments.",
                'invalid_request',
            );
        }
        if (request.tag === '') {
            return errorResponse(
                request.request_id,
                'tag was empty. Pass an exact tag name, or use untagged=true to select items with no tags.',
                'invalid_request',
            );
        }
        if (request.collection_key === '') {
            return errorResponse(
                request.request_id,
                'collection_key was empty. Pass a collection key from list_collections, or omit it.',
                'invalid_request',
            );
        }

        // Resolve the collection scope. The wire always carries a BARE key;
        // the backend has already down-converted a library-qualified one.
        let collectionId: number | null = null;
        if (request.collection_key) {
            const collection = Zotero.Collections.getByLibraryAndKey(library.libraryID, request.collection_key);
            if (!collection) {
                return errorResponse(
                    request.request_id,
                    `Collection not found: "${request.collection_key}" in library "${library.name}". `
                        + 'Use list_collections to get the collection key.',
                    'collection_not_found',
                );
            }
            collectionId = collection.id;
        }

        // Warnings are surfaced to the backend so the agent can correct bad
        // conditions rather than mutate a silently-widened population.
        const warnings: string[] = [];

        // One search, join mode 'all' — never add a `joinMode` condition. With
        // 'any', the itemType conditions below become an always-true disjunct
        // and the population becomes the whole library.
        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID;

        // Collection membership.
        //
        // For a regular population the condition is enough. An attachment
        // population is made of CHILD items, and a child attachment is not a
        // row in `collectionItems` — only its parent is — so a plain collection
        // condition would resolve to nothing. The collection therefore becomes
        // a search *scope* with includeChildren, which admits the collection's
        // items and their attachments.
        let scopeSearch: Zotero.Search | null = null;
        if (collectionId !== null) {
            let collectionTarget = search;
            if (itemCategory === 'attachment') {
                collectionTarget = new Zotero.Search() as unknown as ZoteroSearchWritable;
                collectionTarget.libraryID = library.libraryID;
                scopeSearch = collectionTarget as unknown as Zotero.Search;
            }
            collectionTarget.addCondition('collectionID', 'is', String(collectionId));
            // `recursive` only affects collection conditions, so it is added
            // wherever the collection condition went.
            if (request.recursive !== false) {
                collectionTarget.addCondition('recursive', 'true', '');
            }
        }

        if (request.tag) {
            search.addCondition('tag', 'is', request.tag);
        }

        // Both predicates are native Zotero conditions; emulating them in the
        // backend is what this request exists to avoid.
        if (request.unfiled) {
            search.addCondition('unfiled', 'true', '');
        }
        if (request.untagged) {
            search.addCondition('tag', 'doesNotContain', '');
        }

        for (const condition of request.conditions ?? []) {
            addSearchCondition(search, condition, warnings, 'handleResolvePopulationRequest');
        }

        if (itemCategory === 'attachment') {
            search.addCondition('itemType', 'is', 'attachment');
        } else {
            search.addCondition('itemType', 'isNot', 'attachment');
            search.addCondition('itemType', 'isNot', 'note');
            search.addCondition('itemType', 'isNot', 'annotation');
            // noChildren only for the regular category: an attachment
            // population is made of child items and this would empty it.
            search.addCondition('noChildren', 'true', '');
        }

        if (scopeSearch) {
            search.setScope(scopeSearch, true);
        }

        const itemIds = await search.search();

        // has_attachments, in SQL. This is the only filter that could
        // reintroduce an O(population) item load, so it must never become a
        // getAsync + loadDataTypes(['childItems']) pass.
        //
        // It describes a regular item, and the combination with an attachment
        // population was rejected above.
        let matchedIds = itemIds;
        if (request.has_attachments != null && itemIds.length > 0) {
            const withAttachments = await itemIdsWithAttachments(itemIds);
            matchedIds = request.has_attachments
                ? itemIds.filter(id => withAttachments.has(id))
                : itemIds.filter(id => !withAttachments.has(id));
        }

        const maxItems = typeof request.max_items === 'number' && request.max_items > 0
            ? request.max_items
            : DEFAULT_MAX_ITEMS;
        const totalCount = matchedIds.length;
        const truncated = totalCount > maxItems;

        // Ids and a stable order in one query — no getAsync, no loadDataTypes,
        // no serialization. The order must be deterministic across chunks
        // because the population is frozen and sliced against it.
        const rows = await readPopulationRows(matchedIds);
        rows.sort((a, b) => {
            if (a.dateAdded !== b.dateAdded) return a.dateAdded < b.dateAdded ? -1 : 1;
            return a.itemID - b.itemID;
        });

        const orderedIds = rows.map(row => modelObjectId(row.libraryID, row.key));
        const resultIds = truncated ? orderedIds.slice(0, maxItems) : orderedIds;

        logger(
            `handleResolvePopulationRequest: Returning ${resultIds.length}/${totalCount} item ids`
                + `${truncated ? ' (truncated)' : ''}${warnings.length ? ` with ${warnings.length} warning(s)` : ''}`,
            1,
        );

        return {
            type: 'resolve_population',
            request_id: request.request_id,
            item_ids: resultIds,
            total_count: totalCount,
            truncated,
            warnings: warnings.length ? warnings : undefined,
        };
    } catch (error) {
        logger(`handleResolvePopulationRequest: Error: ${error}`, 1);
        return errorResponse(request.request_id, String(error), 'internal_error');
    }
}
