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
 * The non-trashed attachments of the given items, as item ids.
 * The population of an attachment scope: the filters describe bibliographic
 * items, and these are the attachments hanging off the ones that matched.
 */
async function attachmentIdsForItems(itemIds: number[]): Promise<number[]> {
    const attachmentIds: number[] = [];

    for (let i = 0; i < itemIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = itemIds.slice(i, i + SQL_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        await Zotero.DB.queryAsync(
            'SELECT ia.itemID FROM itemAttachments ia '
                + 'LEFT JOIN deletedItems di ON di.itemID = ia.itemID '
                + `WHERE ia.parentItemID IN (${placeholders}) AND di.itemID IS NULL`,
            chunk,
            {
                onRow: (row: any) => {
                    attachmentIds.push(row.getResultByIndex(0));
                },
            },
        );
    }

    return attachmentIds;
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

        if (collectionId !== null) {
            search.addCondition('collectionID', 'is', String(collectionId));
            // `recursive` only affects collection conditions.
            if (request.recursive !== false) {
                search.addCondition('recursive', 'true', '');
            }
        }

        if (request.tag) {
            // A tag that does not exist matches nothing, which reads to the
            // model as "these filters cover no items" rather than "you typed
            // the tag wrong". Name it, as list_items does.
            const allTags = await Zotero.Tags.getAll(library.libraryID);
            const tagExists = (allTags as { tag: string }[]).some(
                (t) => t.tag.toLowerCase() === request.tag!.toLowerCase()
            );
            if (!tagExists) {
                return errorResponse(
                    request.request_id,
                    `Tag not found: "${request.tag}" in library "${library.name}"`,
                    'tag_not_found',
                );
            }
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

        // Every filter above describes a bibliographic item, so the search
        // always selects regular items — including for an attachment
        // population, whose members are then derived from the matches below.
        // Filtering attachments directly would evaluate `tag`, `unfiled` and
        // `conditions` against the attachment rows instead, where a field like
        // DOI is never present and the population silently becomes every
        // attachment in the library.
        search.addCondition('itemType', 'isNot', 'attachment');
        search.addCondition('itemType', 'isNot', 'note');
        search.addCondition('itemType', 'isNot', 'annotation');
        search.addCondition('noChildren', 'true', '');

        let itemIds = await search.search();

        // has_attachments, in SQL. This is the only filter that could
        // reintroduce an O(population) item load, so it must never become a
        // getAsync + loadDataTypes(['childItems']) pass.
        //
        // It describes a regular item, and the combination with an attachment
        // population was rejected above.
        if (request.has_attachments != null && itemIds.length > 0) {
            const withAttachments = await itemIdsWithAttachments(itemIds);
            itemIds = request.has_attachments
                ? itemIds.filter(id => withAttachments.has(id))
                : itemIds.filter(id => !withAttachments.has(id));
        }

        // An attachment population is the matched items' own attachments, so
        // it is derived here rather than searched for. Standalone attachments
        // are not included: they have none of the bibliographic fields the
        // filters describe.
        const matchedIds = itemCategory === 'attachment'
            ? await attachmentIdsForItems(itemIds)
            : itemIds;

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
