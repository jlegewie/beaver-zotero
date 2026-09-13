/**
 * resolve_population handler.
 *
 * Resolves a batch job's population — every item matching a filter
 * description — in a single round trip, returning ids only. The population is
 * frozen by the backend and later sliced against the returned order, so this
 * handler must never load or serialize items (that is what made the old
 * `list_items` paging loop cost O(library)), and the order it returns must be
 * deterministic.
 *
 * Filters are ANDed. Some of them are internally an OR-group inside that AND:
 * `collection_keys`, `tags`, `any_conditions`, and — when
 * `conditions_join_mode` is 'any' — the `conditions` list. So the population is
 * the items in ANY of the collections that also carry ANY of the tags and also
 * satisfy each conditions group. Two condition groups is what lets a caller mix
 * the joins: `conditions` that must all hold AND `any_conditions` of which one
 * must.
 *
 * An OR-group is expressed as its own search (see `valuesOrGroup` and
 * `conditionsOrGroup`) rather than as conditions on the main search, because
 * Zotero's join mode is per-search: flipping the main search to 'any' would
 * turn its item-type guards into always-true disjuncts and select the whole
 * library. Groups are recombined with the main search by `setScope` or by
 * intersecting ids, both of which keep the group ANDed with everything else.
 *
 * A filter that cannot be applied as described FAILS the request; this handler
 * never answers with ids beside a warning. The population it resolves is about
 * to be mutated, so an answer that no longer matches the description has to be
 * impossible to act on, not merely flagged. A filter applied exactly as
 * described that still excludes nothing fails for the same reason — see
 * `findVacuousNegation`.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    WSResolvePopulationRequest,
    WSResolvePopulationResponse,
    ZoteroSearchCondition,
} from '@beaver/agent-core/protocol/agentProtocol';
import { modelObjectId, parseItemReference, resolveLibraryRef } from '../../utils/libraryIdentity';
import { resolveStoredTagName, validateLibraryAccess } from './utils';
import { addSearchCondition, findVacuousNegation, vacuousNegationMessage } from './searchConditions';

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

/** Non-bibliographic types excluded unless standalone attachments are requested. */
const NON_BIBLIOGRAPHIC_ITEM_TYPES = ['attachment', 'note', 'annotation'];

/** Item types a population can hold: everything the search does not exclude. */
function searchableItemTypes(includeStandalone = false): { id: number; name: string }[] {
    return Zotero.ItemTypes.getAll()
        .filter(itemType => !NON_BIBLIOGRAPHIC_ITEM_TYPES.includes(itemType.name)
            || (includeStandalone && itemType.name === 'attachment'));
}

/**
 * Whether a condition asks "is this field unset".
 *
 * Both spellings: `addSearchCondition` rewrites `is ''` into `doesNotContain
 * ''`, so the two reach Zotero as the same search.
 */
function isEmptyValueCheck(condition: ZoteroSearchCondition): boolean {
    return (condition.operator === 'is' || condition.operator === 'doesNotContain')
        && (condition.value === null || condition.value === undefined || condition.value === '');
}

/**
 * Which of `itemTypes` can hold `fieldName`, as item type ids, or null when
 * the answer is not knowable.
 *
 * Not a plain `isValidForType` check: Zotero maps a base field onto a
 * type-specific name — a film's `distributor` IS `publisher` — and an item
 * carrying the variant does hold the field a condition on the base field
 * names. `getFieldIDFromTypeAndBase` answers for both spellings at once.
 *
 * Null means "do not restrict": the condition field is not an item-data field
 * at all (`tag`, `year`, `creator`, `note`), or item-field data is not loaded
 * yet. A cold cache must never narrow a population.
 */
function itemTypeIdsWithField(
    fieldName: string,
    itemTypes: { id: number; name: string }[],
): number[] | null {
    try {
        // Item-data fields only. Every other condition field either lives in
        // its own table or is a search-only predicate, and neither has an
        // item-type validity to check.
        if (!Zotero.ItemFields.getID(fieldName)) return null;

        const typeIds = itemTypes
            .filter(itemType => Zotero.ItemFields.getFieldIDFromTypeAndBase(itemType.id, fieldName))
            .map(itemType => itemType.id);
        // No field Zotero knows is valid for no type, so an empty answer says
        // the lookup came back wrong rather than that the field is exotic.
        // Refusing to narrow on it is the answer that cannot empty a
        // population by mistake.
        return typeIds.length > 0 ? typeIds : null;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger(`handleResolvePopulationRequest: Skipped field-validity check for '${fieldName}': ${msg}`, 1);
        return null;
    }
}

/** What the empty-value conditions in an ANDed list say about item types. */
interface EmptyFieldTypeRestriction {
    /** The types that hold EVERY one of those fields. Empty: no type does. */
    allowedTypeIds: Set<number>;
    /** Whether it excludes a type the search itself does not already exclude. */
    narrows: boolean;
    /** The fields it was read off, in the order the caller gave them. */
    fields: string[];
}

/**
 * The item types a population may hold, given the "this field is unset"
 * conditions in an ANDed condition list — or null when none of them says
 * anything about item types.
 *
 * An empty value compiles to "no value stored for this field", which every
 * item of a type that HAS no such field satisfies for free: `publisher is ""`
 * matches every blog post and presentation, and an operation that fills
 * publishers in can do nothing with one. Under join mode 'all' every condition
 * holds of every item, so the answer is the intersection.
 *
 * Only the empty-value spelling is restricted. `publisher doesNotContain
 * "springer"` matches a blog post for the same reason, but there the caller is
 * asking about the text of a field rather than about whether it is filled in,
 * and that reading is the documented one.
 */
function emptyFieldTypeRestriction(
    conditions: ZoteroSearchCondition[],
    includeStandalone = false,
): EmptyFieldTypeRestriction | null {
    let itemTypes: { id: number; name: string }[];
    try {
        itemTypes = searchableItemTypes(includeStandalone);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger(`handleResolvePopulationRequest: Skipped field-validity check: ${msg}`, 1);
        return null;
    }

    let allowed: number[] | null = null;
    const fields: string[] = [];

    for (const condition of conditions) {
        if (!isEmptyValueCheck(condition)) continue;

        const typeIds = itemTypeIdsWithField(condition.field, itemTypes);
        if (typeIds === null) continue;

        fields.push(condition.field);
        // ANDed conditions all hold of every item, so each one narrows what is
        // left rather than adding to it.
        allowed = allowed === null ? typeIds : allowed.filter(id => typeIds.indexOf(id) !== -1);
    }

    if (allowed === null) return null;

    const allowedTypeIds = new Set(allowed);
    return {
        allowedTypeIds,
        // Read off the same list the allowed ids were chosen from, so the two
        // cannot end up counted over different universes.
        narrows: itemTypes.some(itemType => !allowedTypeIds.has(itemType.id)),
        fields,
    };
}

/**
 * The subset of `itemIds` whose item type is one of `allowedTypeIds`, in the
 * order given.
 *
 * Reads the type rather than filtering in SQL against the excluded ids: the
 * excluded list can hold most of Zotero's item types, and keeping them out of
 * the statement keeps the bound-variable count a function of the chunk alone.
 */
async function filterItemIdsByTypes(
    itemIds: number[],
    allowedTypeIds: Set<number>,
): Promise<number[]> {
    const kept = new Set<number>();

    for (let i = 0; i < itemIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = itemIds.slice(i, i + SQL_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        await Zotero.DB.queryAsync(
            `SELECT itemID, itemTypeID FROM items WHERE itemID IN (${placeholders})`,
            chunk,
            {
                onRow: (row: any) => {
                    if (allowedTypeIds.has(row.getResultByIndex(1))) {
                        kept.add(row.getResultByIndex(0));
                    }
                },
            },
        );
    }

    return itemIds.filter(id => kept.has(id));
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

/** Zotero keys to leave out of one library's population. */
function excludedZoteroKeys(
    excludeItemIds: string[] | null | undefined,
    libraryID: number,
): Set<string> {
    const keys = new Set<string>();
    for (const objectId of excludeItemIds ?? []) {
        const parsed = parseItemReference(objectId);
        if (!parsed) continue;

        // Zotero keys are unique only within a library.
        if (resolveLibraryRef(parsed) === libraryID) {
            keys.add(parsed.zotero_key);
        }
    }
    return keys;
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
 * refused conditions are recorded in `warnings`, which fails the request.
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
        if (addSearchCondition(group, condition, warnings, 'handleResolvePopulationRequest', libraryID)) {
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
    logger(
        'handleResolvePopulationRequest: Resolving population '
            + `(${request.conditions?.length ?? 0} conditions, `
            + `${request.any_conditions?.length ?? 0} any_conditions)`,
        1,
    );

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
        const includeStandalone = itemCategory === 'attachment' && request.include_standalone_attachments === true;

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

        // The second condition list, ORed among itself and ANDed with
        // everything else — including with `conditions`, whatever its join
        // mode. It is its own OR-group below, so nothing here depends on
        // `conditions_join_mode`.
        const requestedAnyConditions = request.any_conditions ?? [];

        // A condition Zotero applies as a search-wide flag cannot be one of the
        // disjuncts, and silently behaves as its opposite (narrowing, not
        // widening). Refuse it rather than resolve a population that does not
        // match the description the user is about to approve. Checked on every
        // list that becomes an OR-group.
        const oredLists: [string, ZoteroSearchCondition[], string][] = [
            [
                "conditions_join_mode='any'",
                conditionsJoinMode === 'any' ? requestedConditions : [],
                "Join `conditions` with 'all' instead",
            ],
            [
                'any_conditions',
                requestedAnyConditions,
                'Move it to the ANDed `conditions` list',
            ],
        ];
        for (const [listName, conditions, remedy] of oredLists) {
            const flagCondition = conditions.find(
                (condition) => NON_DISJUNCT_CONDITION_FIELDS.has(condition.field));
            if (flagCondition) {
                return errorResponse(
                    request.request_id,
                    `${listName} cannot carry field='${flagCondition.field}': `
                        + 'Zotero applies it as a search-wide flag, so it would be ANDed with the other '
                        + 'conditions rather than ORed with them and the population would be narrower than '
                        + `described. ${remedy} (unfiled has its own request flag), or resolve it as a `
                        + 'separate batch.',
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
                addSearchCondition(search, condition, warnings, 'handleResolvePopulationRequest', library.libraryID);
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
            conditionsOrGroup(library.libraryID, requestedAnyConditions, recursive, warnings),
        ].filter((group): group is Zotero.Search => group !== null);

        // Every condition is now in place, so this is the first point at which
        // a refused one is known. A population is about to be MUTATED, and what
        // is left of the filter no longer describes it, so the request fails
        // rather than resolving ids beside a warning: an empty answer cannot be
        // acted on by mistake, and it is how every other unapplicable filter in
        // this handler already answers. A read path can afford to hand back
        // results and a warning; this one cannot.
        if (warnings.length > 0) {
            logger(`handleResolvePopulationRequest: Refused ${warnings.length} condition(s)`, 1);
            return errorResponse(request.request_id, warnings.join(' '), 'invalid_condition');
        }

        // Every condition Zotero accepted is applied by now, and one of them
        // may still mean nothing. Under join mode 'any' a disjunct that
        // excludes nothing makes the whole group always true; under 'all' it
        // simply drops out, leaving a population the approval card describes
        // by a filter that did not narrow it. Both are refused here.
        const vacuous = await findVacuousNegation(
            library.libraryID,
            [...requestedConditions, ...requestedAnyConditions],
            'handleResolvePopulationRequest',
        );
        if (vacuous) {
            logger('handleResolvePopulationRequest: Refused a negation that excludes nothing', 1);
            return errorResponse(
                request.request_id, vacuousNegationMessage(vacuous, 'refused'), 'invalid_condition',
            );
        }

        // What the "field is unset" conditions say about item types. A type
        // that HAS no such field satisfies the check for free — `publisher is
        // ""` matches every blog post — so the population is restricted to the
        // types that can hold every field checked this way. Under join mode
        // 'any' the conditions are ORed and an item may have matched through a
        // different disjunct, so the restriction is not true of it and is not
        // computed.
        const typeRestriction = conditionsJoinMode === 'all'
            ? emptyFieldTypeRestriction(requestedConditions, includeStandalone)
            : null;

        // No item type has all of those fields at once. Items missing all of
        // them exist — every item missing a field it cannot have counts — but
        // none of them could ever hold the fields, so there is nothing an
        // operation could fill in. Refused rather than resolved as an empty
        // population: "no items matched" reads as a filter to loosen, while
        // this one cannot be loosened into anything workable.
        if (typeRestriction && typeRestriction.allowedTypeIds.size === 0) {
            logger('handleResolvePopulationRequest: Refused empty-value conditions no item type can satisfy', 1);
            return errorResponse(
                request.request_id,
                `Refused the empty-value conditions on ${typeRestriction.fields.join(', ')}: `
                    + 'no Zotero item type has all of those fields, so every item this would select is '
                    + 'one that cannot hold them in the first place. Check one of those fields per '
                    + 'batch, or drop the ones that do not apply to the item types you mean.',
                'invalid_condition',
            );
        }

        const [scope, ...extraGroups] = groups;
        if (scope) {
            search.setScope(scope, true);
        }

        // Standalone attachments match their own fields; children inherit parent filters.
        for (const itemType of NON_BIBLIOGRAPHIC_ITEM_TYPES) {
            if (includeStandalone && itemType === 'attachment') continue;
            search.addCondition('itemType', 'isNot', itemType);
        }
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

        // The item-type restriction, applied to the matched ids. `narrows` is
        // false for the fields these conditions almost always ask about
        // (`abstractNote` and `DOI` are valid for every type the search can
        // return), and then there is nothing to read from the database.
        //
        // Dropping every match is a real empty population, not the refusal
        // above: those conditions CAN be satisfied, this library just holds no
        // item of a type that could carry the field.
        if (typeRestriction && typeRestriction.narrows && itemIds.length > 0) {
            const matchedCount = itemIds.length;
            itemIds = await filterItemIdsByTypes(itemIds, typeRestriction.allowedTypeIds);
            if (itemIds.length < matchedCount) {
                logger(
                    'handleResolvePopulationRequest: Dropped '
                        + `${matchedCount - itemIds.length} item(s) of a type that cannot hold `
                        + `${typeRestriction.fields.join(', ')}`,
                    1,
                );
            }
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

        let standaloneIds: number[] = [];
        if (includeStandalone) {
            const attachmentType = Zotero.ItemTypes.getID('attachment');
            if (attachmentType === false) throw new Error('Attachment item type is unavailable');
            standaloneIds = await filterItemIdsByTypes(itemIds, new Set([attachmentType]));
        }
        const standaloneSet = new Set(standaloneIds);
        const parentIds = itemIds.filter(id => !standaloneSet.has(id));
        const matchedItemCount = parentIds.length;
        const matchedIds = itemCategory === 'attachment'
            ? [...await attachmentIdsForItems(parentIds), ...standaloneIds]
            : itemIds;

        // 0 is a real cap (return no ids, still report the count). Only omit /
        // NaN / negative fall back to the backend default.
        const maxItems = typeof request.max_items === 'number' && request.max_items >= 0
            ? request.max_items
            : DEFAULT_MAX_ITEMS;
        // Drop excluded ids before truncating. After would keep returning the
        // same first `max_items` matches, and later items would be unreachable.
        const excludedKeys = excludedZoteroKeys(request.exclude_item_ids, library.libraryID);
        const hasExclusion = excludedKeys.size > 0;

        // Count-only: skip the id/order query. Unavailable when excluding —
        // which items to drop (and thus the count) is only knowable from the rows.
        if (maxItems === 0 && !hasExclusion) {
            const totalCount = matchedIds.length;
            logger(
                `handleResolvePopulationRequest: Returning 0/${totalCount} item ids`
                    + `${totalCount > 0 ? ' (truncated)' : ''}`,
                1,
            );
            return {
                type: 'resolve_population',
                request_id: request.request_id,
                item_ids: [],
                total_count: totalCount,
                matched_item_count: matchedItemCount,
                truncated: totalCount > 0,
                library_name: library.name,
                collection_names: collectionNames,
                // Echoed so a caller that asked for 'any' can tell an applied
                // 'any' from a provider that never knew the field.
                conditions_join_mode: conditionsJoinMode,
                // Presence tells the caller this build applied `any_conditions`
                // rather than dropping a group it does not know — which would
                // WIDEN the population.
                any_conditions_applied: true,
                standalone_attachments_included: includeStandalone,
                excluded_count: 0,
            };
        }

        // Ids and a stable order in one query — no getAsync, no loadDataTypes,
        // no serialization. The order must be deterministic across chunks
        // because the population is frozen and sliced against it.
        const rows = await readPopulationRows(matchedIds);
        const keptRows = hasExclusion
            ? rows.filter(row => !excludedKeys.has(row.key))
            : rows;
        keptRows.sort((a, b) => {
            if (a.dateAdded !== b.dateAdded) return a.dateAdded < b.dateAdded ? -1 : 1;
            return a.itemID - b.itemID;
        });
        const excludedCount = rows.length - keptRows.length;

        const totalCount = keptRows.length;
        // Regular: both counts describe the same residual. Attachments: keep
        // the pre-derivation item count — exclusions remove attachment rows,
        // not the bibliographic matches they came from.
        const responseMatchedItemCount = itemCategory === 'regular'
            ? totalCount
            : matchedItemCount;
        const truncated = totalCount > maxItems;

        const resultIds = keptRows.slice(0, maxItems).map(row => modelObjectId(row.libraryID, row.key));

        logger(
            `handleResolvePopulationRequest: Returning ${resultIds.length}/${totalCount} item ids`
                + `${truncated ? ' (truncated)' : ''}`,
            1,
        );

        return {
            type: 'resolve_population',
            request_id: request.request_id,
            item_ids: resultIds,
            total_count: totalCount,
            matched_item_count: responseMatchedItemCount,
            truncated,
            // Where the population lives, in the names the user gave those
            // places. The approval card states the location from these alone.
            library_name: library.name,
            collection_names: collectionNames,
            // Echoed so a caller that asked for 'any' can tell an applied
            // 'any' from a provider that never knew the field.
            conditions_join_mode: conditionsJoinMode,
            // Presence tells the caller this build applied `any_conditions`
            // rather than dropping a group it does not know — which would
            // WIDEN the population.
            any_conditions_applied: true,
            standalone_attachments_included: includeStandalone,
            // Always set, including 0. Presence tells the caller this build
            // applied `exclude_item_ids`.
            excluded_count: excludedCount,
        };
    } catch (error) {
        logger(`handleResolvePopulationRequest: Error: ${error}`, 1);
        return errorResponse(request.request_id, String(error), 'internal_error');
    }
}
