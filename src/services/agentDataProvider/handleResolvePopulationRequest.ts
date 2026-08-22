/**
 * resolve_population handler.
 *
 * Resolves a batch operation's population — every item matching a filter
 * description — in a single round trip, returning ids only. The population is
 * frozen by the backend and later sliced against the returned order, so this
 * handler must never load or serialize items (that is what made the old
 * `list_items` paging loop cost O(library)), and the order it returns must be
 * deterministic.
 *
 * Filters are ANDed. Some of them are internally an OR-group inside that AND:
 * `collection_keys`, `tags`, and — when `conditions_join_mode` is 'any' — the
 * `conditions` list. So the population is the items in ANY of the collections
 * that also carry ANY of the tags and also satisfy the conditions group.
 *
 * An OR-group is expressed as its own search (see `valuesOrGroup` and
 * `conditionsOrGroup`) rather than as conditions on the main search, because
 * Zotero's join mode is per-search: flipping the main search to 'any' would
 * turn its item-type guards into always-true disjuncts and select the whole
 * library. Groups are recombined with the main search by `setScope` or by
 * intersecting ids, both of which keep the group ANDed with everything else.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    WSResolvePopulationRequest,
    WSResolvePopulationResponse,
    ZoteroSearchCondition,
} from '@beaver/agent-core/protocol/agentProtocol';
import { modelObjectId } from '../../utils/libraryIdentity';
import { resolveStoredTagName, validateLibraryAccess } from './utils';
import { addSearchCondition } from './searchConditions';

/** SQLite's bound-variable limit is well above this; 500 keeps a margin. */
const SQL_CHUNK_SIZE = 500;

/** Mirrors the backend's `max_items` default when the request omits it or sends a negative value. */
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
 * Conditions that cannot be a disjunct of a `joinMode any` group.
 *
 * Zotero pulls each of these out of the condition list while building the query
 * and applies it as its own ` AND (...)` clause, which makes it a search-wide
 * flag rather than something the join mode combines. Inside an OR-group it
 * would therefore be ANDed with the disjuncts and make the population NARROWER
 * than the caller described, with nothing to signal it. Under join mode 'all'
 * they are ordinary narrowing filters and stay allowed.
 *
 * The restructuring conditions (`joinMode`, `recursive`, `noChildren`, ...)
 * never reach here: `addSearchCondition` refuses them outright.
 */
const NON_DISJUNCT_CONDITION_FIELDS = new Set(['unfiled', 'retracted', 'publications', 'feed']);

/**
 * An empty group search over one library, in join mode 'any'.
 *
 * `joinMode any` is safe in a group search and nowhere else in this handler:
 * the group carries nothing but its own disjuncts, so there is no ANDed guard
 * for the OR to swallow. The caller keeps the group ANDed with the rest of the
 * filters by attaching it as the main search's scope or by intersecting its
 * ids.
 */
function newOrGroup(libraryID: number): ZoteroSearchWritable {
    const group = new Zotero.Search() as unknown as ZoteroSearchWritable;
    group.libraryID = libraryID;
    group.addCondition('joinMode', 'any', '');
    return group;
}

/**
 * A group matching the union of `values` under one condition name.
 *
 * Returns null for an empty group — a search with no conditions matches the
 * whole library, so attaching one would widen the population instead of
 * narrowing it.
 */
function valuesOrGroup(
    libraryID: number,
    condition: 'collection' | 'tag',
    values: string[],
    recursive: boolean,
): Zotero.Search | null {
    if (values.length === 0) return null;

    const group = newOrGroup(libraryID);
    for (const value of values) {
        group.addCondition(condition, 'is', value);
    }
    // `recursive` applies to every collection in the group. It is a flag rather
    // than a disjunct, so it stays ANDed even under join mode 'any' — it says
    // how to read a collection condition, not what to match.
    if (condition === 'collection' && recursive) {
        group.addCondition('recursive', 'true', '');
    }
    // Returned as `Zotero.Search`, not `ZoteroSearchWritable`: `setScope`
    // takes the former, and checking the interface against it trips TS2589
    // ("type instantiation is excessively deep") at the call site.
    return group as unknown as Zotero.Search;
}

/**
 * A group matching an item that satisfies ANY of `conditions`.
 *
 * `recursive` is added for the same reason the main search gets it: a
 * `collection` condition would otherwise match direct membership only while
 * `collection_keys` recursed.
 *
 * Returns null when no condition survived validation, because such a group
 * would carry nothing but its join mode and match the whole library. The
 * dropped conditions are already recorded in `warnings`.
 */
function conditionsOrGroup(
    libraryID: number,
    conditions: ZoteroSearchCondition[],
    recursive: boolean,
    warnings: string[],
): Zotero.Search | null {
    if (conditions.length === 0) return null;

    const group = newOrGroup(libraryID);
    let disjuncts = 0;
    for (const condition of conditions) {
        if (addSearchCondition(group, condition, warnings, 'handleResolvePopulationRequest')) {
            disjuncts++;
        }
    }
    if (disjuncts === 0) return null;

    if (recursive) {
        group.addCondition('recursive', 'true', '');
    }
    return group as unknown as Zotero.Search;
}

/**
 * Handle resolve_population request from backend.
 * Runs one native Zotero search per filter group, ANDs the groups together and
 * returns ids only.
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
        const requestedTags = request.tags ?? [];
        const requestedCollectionKeys = request.collection_keys ?? [];
        if (requestedTags.some((tag) => !tag)) {
            return errorResponse(
                request.request_id,
                'tags contained an empty entry. Pass exact tag names, or use untagged=true to select items with no tags.',
                'invalid_request',
            );
        }
        if (requestedCollectionKeys.some((key) => !key)) {
            return errorResponse(
                request.request_id,
                'collection_keys contained an empty entry. Pass collection keys from list_collections, or omit the filter.',
                'invalid_request',
            );
        }

        // How the `conditions` list is joined among itself, and nothing else.
        // Anything other than 'any' resolves to 'all': a bogus value must not
        // widen the population.
        const conditionsJoinMode = request.conditions_join_mode === 'any' ? 'any' : 'all';
        const requestedConditions = request.conditions ?? [];

        // A condition Zotero applies as a search-wide flag cannot be one of the
        // disjuncts, and silently behaves as its opposite (narrowing, not
        // widening). Refuse it rather than resolve a population that does not
        // match the description the user is about to approve.
        if (conditionsJoinMode === 'any') {
            const flagCondition = requestedConditions.find(
                (condition) => NON_DISJUNCT_CONDITION_FIELDS.has(condition.field));
            if (flagCondition) {
                return errorResponse(
                    request.request_id,
                    `conditions_join_mode='any' cannot be combined with field='${flagCondition.field}': `
                        + 'Zotero applies it as a search-wide flag, so it would be ANDed with the other '
                        + 'conditions rather than ORed with them and the population would be narrower than '
                        + 'described. Give it as a filter that always applies (unfiled has its own request '
                        + 'flag), or resolve it as a separate batch.',
                    'invalid_request',
                );
            }
        }

        // Resolve the collection scope. The wire always carries BARE keys; the
        // backend has already down-converted library-qualified ones. The names
        // are kept alongside: they are the only thing that turns the keys back
        // into something the approval card can show the user, and they are
        // returned in the order the request named them.
        //
        // A key the library does not have fails the whole request. Zotero's
        // own answer for an unknown collection is to match nothing, which the
        // backend would read as "these filters select no items" and hand the
        // model as a reason to change the filters rather than fix the key.
        const collectionNames: string[] = [];
        for (const key of requestedCollectionKeys) {
            const collection = Zotero.Collections.getByLibraryAndKey(library.libraryID, key);
            if (!collection) {
                return errorResponse(
                    request.request_id,
                    `Collection not found: "${key}" in library "${library.name}". `
                        + 'Use list_collections to get the collection key.',
                    'collection_not_found',
                );
            }
            collectionNames.push(collection.name);
        }

        // Warnings are surfaced to the backend so the agent can correct bad
        // conditions rather than mutate a silently-widened population.
        const warnings: string[] = [];

        // Resolve every tag to the casing the library stores; unknown tags
        // error instead of matching nothing, for the same reason as an unknown
        // collection key.
        const resolvedTags: string[] = [];
        for (const tag of requestedTags) {
            const resolved = await resolveStoredTagName(library.libraryID, library.name, tag);
            if (!resolved.found) {
                return errorResponse(request.request_id, resolved.error, 'tag_not_found');
            }
            resolvedTags.push(resolved.name);
        }

        // The main search, join mode 'all' — never add a `joinMode` condition
        // here. With 'any', the itemType conditions below become an
        // always-true disjunct and the population becomes the whole library.
        // The OR-groups live in their own scope searches instead.
        const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
        search.libraryID = library.libraryID;

        const recursive = request.recursive !== false;

        // Both predicates are native Zotero conditions; emulating them in the
        // backend is what this request exists to avoid.
        if (request.unfiled) {
            search.addCondition('unfiled', 'true', '');
        }
        if (request.untagged) {
            search.addCondition('tag', 'doesNotContain', '');
        }

        // Under join mode 'all' the conditions are ANDed with every other
        // filter, so they belong on the main search. Under 'any' they become a
        // third OR-group below instead: putting them here would require
        // `joinMode any` on the main search, which turns the itemType guards
        // into always-true disjuncts and selects the whole library.
        if (conditionsJoinMode === 'all') {
            for (const condition of requestedConditions) {
                addSearchCondition(search, condition, warnings, 'handleResolvePopulationRequest');
            }
        }

        // `recursive` only affects collection conditions, so this is a no-op
        // unless one was given as a condition — and it must be added for those
        // too, or a `collection` condition would match direct membership only
        // while `collection_keys` recursed. Mirrors handleZoteroSearchRequest.
        // The conditions group carries its own, for the same reason.
        if (recursive) {
            search.addCondition('recursive', 'true', '');
        }

        // The OR-groups, in a fixed order so which one becomes the scope is
        // deterministic. A search carries ONE scope, and scopes must not be
        // nested: Zotero 7 materializes an outer scope from `getSQL()`, which
        // ignores that scope's own `_scope`, so the inner group is silently
        // dropped — and a dropped group WIDENS the population to every item the
        // outer group matched. (Zotero 10 added a branch that runs a nested
        // scope properly, which is exactly why the bug is invisible there.) So
        // the first group becomes the scope and the rest are intersected below.
        const groups = [
            valuesOrGroup(library.libraryID, 'collection', requestedCollectionKeys, recursive),
            valuesOrGroup(library.libraryID, 'tag', resolvedTags, recursive),
            conditionsJoinMode === 'any'
                ? conditionsOrGroup(library.libraryID, requestedConditions, recursive, warnings)
                : null,
        ].filter((group): group is Zotero.Search => group !== null);

        const [scope, ...extraGroups] = groups;
        if (scope) {
            search.setScope(scope, true);
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

        // Every group that did not become the scope, intersected here. Running
        // one as its own search costs a single ids-only query and is what makes
        // the groups independent of how a given Zotero version materializes a
        // nested scope. Intersecting can only narrow, which is the safe
        // direction for a population about to be mutated.
        for (const group of extraGroups) {
            if (itemIds.length === 0) break;
            const matched = new Set(await group.search());
            itemIds = itemIds.filter(id => matched.has(id));
        }

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

        // 0 is a real cap (return no ids, still report the count). Only omit /
        // NaN / negative fall back to the backend default.
        const maxItems = typeof request.max_items === 'number' && request.max_items >= 0
            ? request.max_items
            : DEFAULT_MAX_ITEMS;
        const totalCount = matchedIds.length;

        // Count-only: total_count is already known, so skip the id/order query.
        if (maxItems === 0) {
            logger(
                `handleResolvePopulationRequest: Returning 0/${totalCount} item ids`
                    + `${totalCount > 0 ? ' (truncated)' : ''}${warnings.length ? ` with ${warnings.length} warning(s)` : ''}`,
                1,
            );
            return {
                type: 'resolve_population',
                request_id: request.request_id,
                item_ids: [],
                total_count: totalCount,
                truncated: totalCount > 0,
                library_name: library.name,
                collection_names: collectionNames,
                // Echoed so a caller that asked for 'any' can tell an applied
                // 'any' from a provider that never knew the field.
                conditions_join_mode: conditionsJoinMode,
                warnings: warnings.length ? warnings : undefined,
            };
        }

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
            // Where the population lives, in the names the user gave those
            // places. The approval card states the location from these alone.
            library_name: library.name,
            collection_names: collectionNames,
            // Echoed so a caller that asked for 'any' can tell an applied
            // 'any' from a provider that never knew the field.
            conditions_join_mode: conditionsJoinMode,
            warnings: warnings.length ? warnings : undefined,
        };
    } catch (error) {
        logger(`handleResolvePopulationRequest: Error: ${error}`, 1);
        return errorResponse(request.request_id, String(error), 'internal_error');
    }
}
