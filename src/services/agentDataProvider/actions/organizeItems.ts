import { WSAgentActionValidateRequest, WSAgentActionValidateResponse, WSAgentActionExecuteRequest, WSAgentActionExecuteResponse } from '@beaver/agent-core/protocol/agentProtocol';
import { store } from '../../../../react/store';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import {
    checkLibraryExcluded,
    excludedLibraryMessage,
    getDeferredToolPreference,
    resolveCollectionForWrite,
    resolveSingleCollection,
} from '../utils';
import type { CollectionResolutionErrorCode } from '../utils';
import {
    resolveItemReference,
    resolveLibraryRef,
    parseItemReference,
    libraryRefForLibraryID,
    modelObjectId,
} from '../../../utils/libraryIdentity';
import { TimeoutContext, checkAborted } from '../timeout';
import { TimeoutError } from '../timeout';
import { logger } from '@beaver/agent-core/platform/logger';
import { TimingAccumulator } from '../../../utils/timing';


/** Reader-friendly type name for an off-contract JSON value. */
function describeJsonType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'a list';
    return `of type ${typeof value}`;
}

/**
 * Reject off-contract action data, returning the error message or null when it
 * is well formed.
 *
 * Action data is external JSON. A value of the wrong shape is a malformed
 * request, not an absent one: reading undefined leaves off a container would
 * report success for a change that was never applied, and iterating a bare
 * string walks it character by character, writing one tag or collection per
 * letter. Both validate and execute run this, since an execute request may skip
 * validation entirely.
 *
 * Entries are checked where nothing downstream reports them: an item id reaches
 * a parser that throws on a non-string, and a non-string tag is coerced by
 * Zotero into a literal `"123"` that undo's strict comparison can never match.
 * Collection entries are the exception at validate time only, where the
 * collection resolver reports them alongside the batch's other reference
 * problems; execute has no such batch report and silently skips what it cannot
 * resolve, so it passes `checkCollectionEntries` to catch them here instead.
 */
function actionDataError(
    actionData: unknown,
    options: { checkCollectionEntries: boolean },
): string | null {
    // Checked before the callers destructure it, so a null payload reports a
    // typed error instead of throwing out of the destructuring itself.
    if (actionData == null || typeof actionData !== 'object' || Array.isArray(actionData)) {
        return `Action data must be an object, but was ${describeJsonType(actionData)}.`;
    }
    const data = actionData as Record<string, unknown>;

    const itemIds = data.item_ids;
    if (itemIds != null) {
        if (!Array.isArray(itemIds)) {
            return `"item_ids" must be a list of item ids, but was ${describeJsonType(itemIds)}.`;
        }
        const badIds = itemIds.filter(id => typeof id !== 'string');
        if (badIds.length > 0) {
            // Named individually, matching the batch contract: every bad id is
            // reported in one round trip rather than one per retry.
            const named = badIds.map(id => JSON.stringify(id) ?? String(id)).join(', ');
            return `Every entry in "item_ids" must be an item id string, but ` +
                `${named} ${badIds.length === 1 ? 'is' : 'are'} not.`;
        }
    }

    for (const group of ['tags', 'collections'] as const) {
        const container = data[group];
        if (container == null) continue;
        // An empty list is the wrong shape but an unambiguous "no changes here",
        // so it reads as absent rather than failing a request whose other group
        // carries real changes.
        if (Array.isArray(container) && container.length === 0) continue;
        if (typeof container !== 'object' || Array.isArray(container)) {
            return `"${group}" must be an object with "add" and/or "remove" lists, but was ${describeJsonType(container)}.`;
        }
        for (const field of ['add', 'remove'] as const) {
            const value = (container as Record<string, unknown>)[field];
            if (value == null) continue;
            if (!Array.isArray(value)) {
                return `"${group}.${field}" must be a list, but was ${describeJsonType(value)}.`;
            }
            const checkEntries = group === 'tags' || options.checkCollectionEntries;
            if (checkEntries && value.some(entry => typeof entry !== 'string')) {
                return group === 'tags'
                    ? `Every entry in "${group}.${field}" must be a tag name string.`
                    : `Every entry in "${group}.${field}" must be a collection identifier string.`;
            }
        }
    }
    return null;
}

/**
 * Restore in-memory tags and collections on items after a transaction rollback.
 * The DB transaction rolls back automatically, but in-memory item objects still
 * carry the modifications — this restores them to prevent leaking into future saves.
 */
function restoreItemSnapshots(
    snapshots: Map<string, { item: any; tags: Array<{ tag: string; type?: number }>; collections: number[] }>,
): void {
    for (const [, snap] of snapshots) {
        try {
            snap.item.setTags(snap.tags);
            snap.item.setCollections(snap.collections);
        } catch (_) {
            // Best-effort restoration
        }
    }
}


/**
 * Validate an organize_items action.
 * Checks if items exist and are in editable libraries.
 * Returns current state of tags/collections for each item (for undo).
 *
 * Every per-item problem (bad format, missing item, unavailable/excluded/
 * read-only library, unsupported item type, etc.) is collected across the
 * whole batch before returning, rather than failing on the first one — so a
 * batch with several bad ids reports all of them in a single error.
 */
export async function validateOrganizeItemsAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    // Shape first, before the payload is destructured or its entries counted: a
    // null payload would throw out of the destructuring, and a bare string has a
    // `length`, so counting first reports a 130-character id as "too many items".
    const containerError = actionDataError(request.action_data, { checkCollectionEntries: false });
    if (containerError) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: containerError,
            error_code: 'invalid_request',
            preference: 'always_ask',
        };
    }

    const { item_ids, tags, collections } = request.action_data as {
        item_ids: string[];
        tags?: { add?: string[]; remove?: string[] } | null;
        collections?: { add?: string[]; remove?: string[] } | null;
    };

    // Validate at least one item is provided
    if (!item_ids || item_ids.length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'At least one item_id must be provided',
            error_code: 'no_items',
            preference: 'always_ask',
        };
    }

    // Validate max items
    if (item_ids.length > 100) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Maximum 100 items can be organized at once',
            error_code: 'too_many_items',
            preference: 'always_ask',
        };
    }

    // Validate at least one change is requested
    const hasTagChanges = tags && ((tags.add && tags.add.length > 0) || (tags.remove && tags.remove.length > 0));
    const hasCollectionChanges = collections && ((collections.add && collections.add.length > 0) || (collections.remove && collections.remove.length > 0));

    if (!hasTagChanges && !hasCollectionChanges) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'At least one tag or collection change must be specified',
            error_code: 'no_changes',
            preference: 'always_ask',
        };
    }

    // Validate all items exist and are in editable libraries
    // Also collect current state for undo
    const currentState: Record<string, { tags: string[]; collections: string[] }> = {};
    // Portable ids ("<library_ref>-<zotero_key>") returned to the backend so the
    // persisted/replayed action is device-independent. Kept in input order.
    const normalizedItemIds: string[] = [];
    // Resolved (device-local) libraryIDs collected for the same-library collection check.
    const resolvedLibraryIds: number[] = [];
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);

    // Collect EVERY per-item problem instead of returning on the first one. A
    // single nonexistent/invalid id in a large batch used to reject the whole
    // batch while naming only that one id, forcing one round-trip per bad id.
    // Reporting them all together lets the model drop every bad id and re-send
    // once.
    type ItemIssue = { itemId: string; message: string; code: string };
    const issues: ItemIssue[] = [];

    for (const itemId of item_ids) {
        // Accept both the portable "<library_ref>-<key>" grammar and the legacy
        // "<library_id>-<key>" numeric grammar.
        const parsed = parseItemReference(itemId);
        if (!parsed) {
            issues.push({
                itemId,
                message: `Invalid item_id format: ${itemId}. Expected 'library_id-zotero_key'`,
                code: 'invalid_item_id',
            });
            continue;
        }

        // Resolve to a device-local libraryID (library_ref wins; legacy numeric
        // falls back). null => a portable group ref not present on this device.
        const libraryId = resolveLibraryRef(parsed);
        if (libraryId == null) {
            issues.push({
                itemId,
                message: `Item not found: ${itemId}. This library isn't available on this computer.`,
                code: 'library_unavailable',
            });
            continue;
        }

        // Validate library exists
        const library = Zotero.Libraries.get(libraryId);
        if (!library) {
            issues.push({
                itemId,
                message: `Library not found for item: ${itemId}`,
                code: 'library_not_found',
            });
            continue;
        }

        // Validate library is searchable
        if (!searchableLibraryIds.includes(libraryId)) {
            issues.push({
                itemId,
                message: `Item '${itemId}': ${excludedLibraryMessage(libraryId)}`,
                code: 'library_not_searchable',
            });
            continue;
        }

        // Validate library is editable
        if (!library.editable) {
            issues.push({
                itemId,
                message: `Item '${itemId}': library '${library.name}' is read-only`,
                code: 'library_not_editable',
            });
            continue;
        }

        // Validate item exists
        const resolved = await resolveItemReference(parsed);
        if (resolved.status === 'library_unavailable') {
            issues.push({
                itemId,
                message: `Item not found: ${itemId}. This library isn't available on this computer.`,
                code: 'library_unavailable',
            });
            continue;
        }
        if (resolved.status === 'not_found') {
            issues.push({
                itemId,
                message: `Item not found: ${itemId}`,
                code: 'item_not_found',
            });
            continue;
        }
        const item = resolved.item;

        // Portable id derived from the resolved item (authoritative). Falls back
        // to the numeric libraryID only for non-portable libraries (e.g. feeds),
        // which can't reach here anyway (not searchable/editable).
        const normalizedId = modelObjectId(item.libraryID, item.key);

        // Tags: allowed on regular items, attachments, notes, and annotations
        if (hasTagChanges && !item.isRegularItem() && !item.isAttachment() && !item.isNote() && !item.isAnnotation()) {
            const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
            issues.push({
                itemId,
                message: `Item '${itemId}' is an ${itemType}. Tags can only be added to or removed from regular items, attachments, notes, and annotations.`,
                code: 'item_type_not_supported',
            });
            continue;
        }

        // Collection: allowed on regular items, attachments, and notes (mainly excludes annotations)
        if (hasCollectionChanges && !item.isRegularItem() && !item.isAttachment() && !item.isNote()) {
            const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
            issues.push({
                itemId,
                message: `Item '${itemId}' is an ${itemType}. Collections can only be added to or removed from top-level regular items, attachments or notes. Use the parent item instead.`,
                code: 'item_type_not_supported',
            });
            continue;
        }

        // Collection changes: only allowed on top-level items
        if (hasCollectionChanges && !item.isTopLevelItem()) {
            const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
            const parentKey = item.parentKey;
            // Echo the same prefix form the model sent so the id stays actionable.
            const parentId = `${parsed.library_ref ?? parsed.library_id}-${parentKey}`;
            issues.push({
                itemId,
                message: `Item '${itemId}' is a child ${itemType} and cannot be added to or removed from collections directly. Only top-level items can be added or removed from collections. Use the parent item '${parentId}' instead.`,
                code: 'item_not_top_level',
            });
            continue;
        }

        // Collect current state for undo
        const itemTags: string[] = item.getTags().map((t: { tag: string }) => t.tag);
        const itemCollections: string[] = item.isTopLevelItem()
            ? item.getCollections().map((collectionId: number) => {
                const collection = Zotero.Collections.get(collectionId);
                return collection ? collection.key : null;
            }).filter(Boolean) as string[]
            : [];

        // Key current state (and the returned item ids) by the portable id so
        // undo / current-state stay consistent with the persisted proposed_data.
        currentState[normalizedId] = {
            tags: itemTags,
            collections: itemCollections,
        };
        normalizedItemIds.push(normalizedId);
        resolvedLibraryIds.push(item.libraryID);
    }

    // Collection-key problems are collected into this and combined with any
    // per-item `issues` below, rather than returning as soon as the item loop
    // finds a problem — both checks already happen inside this same WS round
    // trip, so there's no extra cost to reporting them together instead of
    // making the model fix items, resend, and only then discover the
    // collection keys were also wrong.
    let collectionError: { message: string; code: string } | null = null;
    // Resolved bare collection keys + the library they belong to, returned to
    // the backend as normalized_action_data. Items normalize *up* to the
    // portable id; collections normalize *down* to a bare key plus an explicit
    // library, since a collection key is only meaningful inside one library.
    let normalizedCollections: { add?: string[]; remove?: string[] } | null = null;
    let normalizedCollectionLibraryId: number | null = null;

    // Validate collection operations: all items must be in the same library.
    // Only meaningful once at least one item resolved — with zero valid
    // items there's no library to scope the check against, and the item
    // `issues` below are already terminal on their own.
    if (hasCollectionChanges && normalizedItemIds.length > 0) {
        // Check that all items are in the same (resolved) library
        const libraryIds = new Set<number>(resolvedLibraryIds);

        if (libraryIds.size > 1) {
            collectionError = {
                message: 'Collection changes require all items to be in the same library. Items span multiple libraries.',
                code: 'mixed_libraries_for_collections',
            };
        } else {
            // Safe to use first value since we verified libraryIds.size >= 1 (from item_ids validation)
            const libraryId = [...libraryIds][0];

            // Collections are library-scoped: a key that exists in another library is
            // not usable here. Distinguish "exists elsewhere" from "doesn't exist at all"
            // so the agent doesn't loop calling create_collection for a key we just returned.
            // Names never resolve here (a write takes an identifier), so the probe
            // only considers key/identifier matches.
            const otherSearchableLibraryIds = searchableLibraryIds.filter((id: number) => id !== libraryId);
            const findCollectionLibrary = (collectionRef: string): number | null => {
                const probe = resolveSingleCollection(collectionRef, {
                    eligibleLibraryIds: otherSearchableLibraryIds,
                    nameLibraryIds: [],
                });
                return probe.ok ? probe.match.libraryID : null;
            };

            // Collect ALL invalid collection references (across add and remove)
            // before returning, so the agent sees the full picture in one shot.
            // Reporting only the first failure caused models to "fix" one key per
            // retry while missing the systematic pattern (e.g. mistakenly pasting
            // item keys into add_to_collections).
            type InvalidColl = {
                ref: string;
                message: string;
                code: CollectionResolutionErrorCode;
                otherLibraryId: number | null;
            };
            const invalidColls: InvalidColl[] = [];
            const seenInvalid = new Set<string>();
            const resolvedAdd: string[] = [];
            const resolvedRemove: string[] = [];

            const resolveKeys = (refs: string[], resolvedKeys: string[]) => {
                for (const collectionRef of refs) {
                    const resolution = resolveCollectionForWrite(collectionRef, {
                        eligibleLibraryIds: [libraryId],
                        explicitLibrary: true,
                    });
                    if (resolution.ok) {
                        const key = resolution.match.collection.key;
                        if (!resolvedKeys.includes(key)) resolvedKeys.push(key);
                        continue;
                    }
                    if (seenInvalid.has(collectionRef)) continue;
                    seenInvalid.add(collectionRef);
                    invalidColls.push({
                        ref: collectionRef,
                        message: resolution.message,
                        code: resolution.code,
                        otherLibraryId: resolution.code === 'collection_not_found'
                            ? findCollectionLibrary(collectionRef)
                            : null,
                    });
                }
            };

            if (collections?.add && collections.add.length > 0) resolveKeys(collections.add, resolvedAdd);
            if (collections?.remove && collections.remove.length > 0) resolveKeys(collections.remove, resolvedRemove);

            if (invalidColls.length > 0) {
                const notFound = invalidColls.filter(x => x.code === 'collection_not_found' && x.otherLibraryId === null);
                const inOtherLib = invalidColls.filter(x => x.code === 'collection_not_found' && x.otherLibraryId !== null);
                // Everything the resolver already explained precisely (name given
                // instead of an identifier, scope conflict, excluded or
                // unavailable library) is surfaced with its own message.
                const otherFailures = invalidColls.filter(x => x.code !== 'collection_not_found');

                // Detect the common model failure mode: collection references that
                // are actually item zotero-keys copy-pasted from item_ids. Compare
                // key suffixes so a pasted scoped item id is caught too.
                const itemZoteroKeys = new Set(
                    item_ids.map(id => parseItemReference(id)?.zotero_key).filter(Boolean) as string[]
                );
                // A collection reference of the wrong type reaches here (only
                // tags and item ids are type-checked up front), and parsing it
                // would throw and lose the whole batch diagnostic.
                const overlapWithItemKeys = invalidColls
                    .map(x => x.ref)
                    .filter(ref => typeof ref === 'string'
                        && itemZoteroKeys.has(parseItemReference(ref)?.zotero_key ?? ref));

                const currentLibrary = Zotero.Libraries.get(libraryId);
                const currentLibraryName = currentLibrary ? currentLibrary.name : `library ${libraryId}`;

                // A reference is echoed via JSON so an off-contract one still
                // names itself: `null` and `""` would otherwise render as
                // nothing, telling the model a collection is missing but not
                // which entry to fix.
                const describeRef = (ref: unknown): string =>
                    typeof ref === 'string' && ref.trim() !== '' ? ref : JSON.stringify(ref) ?? String(ref);

                const parts: string[] = [];
                if (notFound.length > 0) {
                    parts.push(
                        `Collection${notFound.length === 1 ? '' : 's'} not found in '${currentLibraryName}' (library ${libraryId}): ${notFound.map(x => describeRef(x.ref)).join(', ')}.`
                    );
                }
                if (inOtherLib.length > 0) {
                    const byLib = new Map<number, string[]>();
                    for (const { ref, otherLibraryId } of inOtherLib) {
                        if (otherLibraryId === null) continue;
                        const arr = byLib.get(otherLibraryId) ?? [];
                        arr.push(ref);
                        byLib.set(otherLibraryId, arr);
                    }
                    for (const [otherLibId, keys] of byLib) {
                        const otherLibrary = Zotero.Libraries.get(otherLibId);
                        const otherLibraryName = otherLibrary ? otherLibrary.name : `library ${otherLibId}`;
                        parts.push(
                            `Collection${keys.length === 1 ? '' : 's'} ${keys.join(', ')} belong${keys.length === 1 ? 's' : ''} to '${otherLibraryName}' (library ${otherLibId}), not '${currentLibraryName}'. Collections are library-scoped.`
                        );
                    }
                }
                for (const failure of otherFailures) {
                    parts.push(failure.message);
                }
                if (overlapWithItemKeys.length > 0) {
                    parts.push(
                        `Note: ${overlapWithItemKeys.length === 1 ? 'key' : 'keys'} ${overlapWithItemKeys.join(', ')} also appear in item_ids — collection identifiers must come from list_collections (or a prior create_collection), not from item IDs.`
                    );
                }
                parts.push('Use list_collections to find valid collection identifiers, or create_collection to make a new one.');

                // One code has to represent the batch: prefer a precisely
                // explained failure, then "exists but in another library", and
                // fall back to plain not-found.
                let errorCode: CollectionResolutionErrorCode | 'collection_in_different_library';
                if (otherFailures.length > 0) {
                    errorCode = otherFailures[0].code;
                } else if (notFound.length === 0 && inOtherLib.length > 0) {
                    errorCode = 'collection_in_different_library';
                } else {
                    errorCode = 'collection_not_found';
                }

                collectionError = { message: parts.join(' '), code: errorCode };
            } else {
                normalizedCollectionLibraryId = libraryId;
                normalizedCollections = {
                    ...(collections?.add ? { add: resolvedAdd } : {}),
                    ...(collections?.remove ? { remove: resolvedRemove } : {}),
                };
            }
        }
    }

    // Report item-level and collection-level problems together: both were
    // already computed inside this single WS round trip, so there's no
    // reason to make the model fix items, resend, and only then discover the
    // collection keys were also wrong (or vice versa).
    if (issues.length > 0 || collectionError) {
        const parts = [
            ...issues.map((i) => i.message),
            ...(collectionError ? [collectionError.message] : []),
        ];
        const codes = [...issues.map((i) => i.code), ...(collectionError ? [collectionError.code] : [])];
        const uniqueCodes = new Set(codes);
        // library_not_searchable/library_excluded mark a library-exclusion
        // (access-control) boundary, not just another validation failure —
        // never let it collapse into the generic 'multiple_item_errors'
        // bucket when mixed with unrelated problems, so any code that keys
        // off this specific code (now or later) still sees it.
        const exclusionCode = codes.find((c) => c === 'library_not_searchable' || c === 'library_excluded');
        // Not every message ends in terminal punctuation (e.g. "Item not
        // found: <id>"), so joining with a bare space can run two messages
        // together illegibly. Normalize each to end with a period and list
        // them as a numbered list instead.
        const normalized = parts.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`));
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: normalized.length === 1
                ? normalized[0]
                : `${normalized.length} problems found:\n` + normalized.map((p, i) => `${i + 1}. ${p}`).join('\n'),
            error_code: uniqueCodes.size === 1 ? [...uniqueCodes][0] : (exclusionCode ?? 'multiple_item_errors'),
            preference: 'always_ask',
        };
    }

    // Get user preference
    const preference = getDeferredToolPreference('organize_items');

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: currentState,
        // Return the portable ids so the backend persists + replays them instead
        // of the model-authored device-local ids (the validate-time enrichment seam).
        // Collection changes ride along as bare keys plus the library they are
        // scoped to, so apply and undo compare against the same key form the
        // undo snapshots hold.
        normalized_action_data: {
            item_ids: normalizedItemIds,
            ...(normalizedCollections && normalizedCollectionLibraryId != null
                ? {
                    collections: normalizedCollections,
                    library_id: normalizedCollectionLibraryId,
                    library_ref: libraryRefForLibraryID(normalizedCollectionLibraryId) ?? undefined,
                }
                : {}),
        },
        preference,
    };
}


/**
 * Execute an organize_items action.
 * Adds/removes tags and collection memberships for the specified items.
 * 
 * All modifications are batched in a single database transaction for performance.
 * This is an all-or-nothing operation: if any item fails to save, the entire
 * transaction rolls back. Items that don't exist are skipped (not an error).
 */
export async function executeOrganizeItemsAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const start = Date.now();
    const ta = new TimingAccumulator();
    // tx_total_ms (wall-clock around executeTransaction) minus tx_work_ms
    // (time inside the callback) = SQLite write-queue wait. Concurrent
    // organize_items calls serialize on the single writer, so this gap is
    // the answer to "is the slowness queue-wait or actual work?"
    const buildTiming = (extra?: Record<string, number>): Record<string, number> => ({
        total_ms: Date.now() - start,
        ...ta.getAll(),
        ...(extra ?? {}),
    });

    // Shape first, before the payload is destructured. Collection entries are
    // checked here but not at validate: this path has no batch reference report,
    // and the resolve step below skips what it cannot resolve, which would
    // report success for a change never applied.
    const containerError = actionDataError(request.action_data, { checkCollectionEntries: true });
    if (containerError) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: containerError,
            error_code: 'invalid_request',
            timing: buildTiming(),
        };
    }

    const { item_ids, tags, collections } = request.action_data as {
        item_ids: string[];
        tags?: { add?: string[]; remove?: string[] } | null;
        collections?: { add?: string[]; remove?: string[] } | null;
    };

    if (!item_ids || item_ids.length === 0) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'At least one item_id must be provided',
            error_code: 'no_items',
            timing: buildTiming(),
        };
    }

    // TOCTOU guard: never mutate items in a library the user excluded from Beaver,
    // even if validation passed earlier or the execute request skipped it.
    for (const itemId of item_ids) {
        const parsed = parseItemReference(itemId);
        if (!parsed) continue; // malformed → skipped in the main loop
        const libraryId = resolveLibraryRef(parsed);
        if (libraryId == null) continue; // library not on this device → skipped in the main loop
        const excluded = checkLibraryExcluded(libraryId);
        if (excluded) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: excluded.message,
                error_code: 'library_not_searchable',
                timing: buildTiming(),
            };
        }
    }

    let itemsModified = 0;
    const skippedItems: string[] = [];
    // Track actual changes (not just requested changes) for safe undo
    const actualTagsAdded = new Set<string>();
    const actualTagsRemoved = new Set<string>();
    const actualCollectionsAdded = new Set<string>();
    const actualCollectionsRemoved = new Set<string>();

    // Snapshot in-memory state for rollback after transaction failure.
    // The DB transaction rolls back automatically, but in-memory item objects
    // still carry the modifications — we must restore them explicitly.
    const itemSnapshots = new Map<string, {
        item: any;
        tags: Array<{ tag: string; type?: number }>;
        collections: number[];
    }>();

    // Resolve collection references to objects once, before opening the write
    // transaction. Validation guarantees all items share a library when collection
    // changes are requested, and that every reference in add/remove resolves — so
    // a miss here is a benign race (collection deleted between validate and
    // execute) and is skipped. The resolved bare key is what result_data records,
    // so a scoped identifier still produces the key form undo compares against.
    // Names never resolve here, matching validation: a deleted collection whose
    // key happens to be another collection's name must not redirect the write.
    const addCollections = new Map<string, { id: number; key: string }>();
    const removeCollections = new Map<string, { id: number; key: string }>();
    const hasCollectionChanges = !!(collections && ((collections.add && collections.add.length > 0) || (collections.remove && collections.remove.length > 0)));
    if (hasCollectionChanges && item_ids.length > 0) {
        // Validation guarantees a collection batch shares one library. Resolve the
        // first item reference that exists on this device and use its libraryID —
        // more robust than trusting the raw prefix of item_ids[0].
        let collectionLibraryId: number | null = null;
        for (const itemId of item_ids) {
            const parsed = parseItemReference(itemId);
            if (!parsed) continue;
            const resolved = await resolveItemReference(parsed);
            if (resolved.status === 'found') {
                collectionLibraryId = resolved.item.libraryID;
                break;
            }
        }
        if (collectionLibraryId != null) {
            const resolveInto = (refs: string[], target: Map<string, { id: number; key: string }>) => {
                for (const collectionRef of refs) {
                    checkAborted(ctx, 'organize_items:collection_resolve');
                    const resolution = resolveCollectionForWrite(collectionRef, {
                        eligibleLibraryIds: [collectionLibraryId!],
                        explicitLibrary: true,
                    });
                    if (resolution.ok) {
                        target.set(collectionRef, {
                            id: resolution.match.collection.id,
                            key: resolution.match.collection.key,
                        });
                    }
                }
            };
            await ta.track('collection_resolve_ms', async () => {
                resolveInto(collections?.add ?? [], addCollections);
                resolveInto(collections?.remove ?? [], removeCollections);
            });
        }
    }

    try {
        // Checkpoint: abort before starting the transaction
        checkAborted(ctx, 'organize_items:before_transaction');

        // pre_tx_ms: time from function entry to awaiting executeTransaction.
        // Includes collection_resolve_ms; non-tracked remainder is sync setup.
        ta.record('pre_tx_ms', Date.now() - start);

        // Batch all modifications in a single transaction for performance.
        // If any save fails (including TimeoutError), the entire transaction rolls back.
        //
        // tx_total_ms wraps the await; tx_work_ms is recorded inside the
        // callback. The difference = SQLite write-lock queue wait. Concurrent
        // organize_items calls serialize on the single writer, so that gap
        // tells us whether slowness is queue-wait or actual work.
        await ta.track('tx_total_ms', () => Zotero.DB.executeTransaction(async () => {
            const txWorkStart = Date.now();
            try {
            for (const itemId of item_ids) {
                const parsed = parseItemReference(itemId);
                if (!parsed) {
                    // Malformed id - skip but don't fail the transaction
                    skippedItems.push(itemId);
                    continue;
                }

                const resolvedItem = await ta.track('item_lookup_ms', () =>
                    resolveItemReference(parsed)
                );
                if (resolvedItem.status !== 'found') {
                    // Item not found or its library unavailable on this device - skip but don't fail the transaction
                    skippedItems.push(itemId);
                    continue;
                }
                const item = resolvedItem.item;

                // Annotations support tags but not collections. Tag changes below
                // are item-type-agnostic; collection ops are guarded by isTopLevel,
                // so they remain no-ops for annotations (which are never top-level).
                const isTopLevel = item.isTopLevelItem();
                let modified = false;

                // Snapshot in-memory state before modifications for rollback
                const originalTags = item.getTags();
                const originalCollections = isTopLevel ? item.getCollections() : [];
                itemSnapshots.set(itemId, { item, tags: originalTags, collections: originalCollections });

                // Get current state for change detection
                const existingTags = new Set(originalTags.map((t: { tag: string }) => t.tag));
                const existingCollections = isTopLevel
                    ? new Set(originalCollections.map((collectionId: number) => {
                        const collection = Zotero.Collections.get(collectionId);
                        return collection ? collection.key : null;
                    }).filter(Boolean) as string[])
                    : new Set<string>();

                // Add tags (only if not already present)
                // Tags work on regular items, attachments, notes, and annotations
                if (tags?.add && tags.add.length > 0) {
                    for (const tagName of tags.add) {
                        if (!existingTags.has(tagName)) {
                            item.addTag(tagName);
                            actualTagsAdded.add(tagName);
                            modified = true;
                        }
                    }
                }

                // Remove tags (only if present)
                if (tags?.remove && tags.remove.length > 0) {
                    for (const tagName of tags.remove) {
                        if (existingTags.has(tagName) && item.removeTag(tagName)) {
                            actualTagsRemoved.add(tagName);
                            modified = true;
                        }
                    }
                }

                // Add to collections (only for top-level items)
                if (isTopLevel && collections?.add && collections.add.length > 0) {
                    for (const collectionRef of collections.add) {
                        const collection = addCollections.get(collectionRef);
                        if (!collection || existingCollections.has(collection.key)) continue;
                        item.addToCollection(collection.id);
                        actualCollectionsAdded.add(collection.key);
                        modified = true;
                    }
                }

                // Remove from collections (only for top-level items)
                if (isTopLevel && collections?.remove && collections.remove.length > 0) {
                    for (const collectionRef of collections.remove) {
                        const collection = removeCollections.get(collectionRef);
                        if (!collection || !existingCollections.has(collection.key)) continue;
                        item.removeFromCollection(collection.id);
                        actualCollectionsRemoved.add(collection.key);
                        modified = true;
                    }
                }

                // Checkpoint: abort before each item save — throws inside
                // executeTransaction triggers full rollback
                if (modified) {
                    checkAborted(ctx, 'organize_items:before_item_save');
                    await ta.track('item_save_ms', () => item.save());
                    itemsModified++;
                }
            }
            } finally {
                ta.record('tx_work_ms', Date.now() - txWorkStart);
            }
        }));
    } catch (error) {
        // Restore in-memory state for all snapshotted items.
        // The DB transaction rolled back, but in-memory item objects still
        // carry the modifications — restore them to prevent leaking into future saves.
        restoreItemSnapshots(itemSnapshots);

        // Re-throw TimeoutError so it propagates to the main handler
        if (error instanceof TimeoutError) throw error;
        // Transaction failed and rolled back - no items were modified
        logger(`executeOrganizeItemsAction: Transaction failed: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Failed to organize items: ${error}`,
            error_code: 'transaction_failed',
            timing: buildTiming({
                item_count: item_ids.length,
                items_modified: itemsModified,
                items_skipped: skippedItems.length,
            }),
        };
    }

    logger(`executeOrganizeItemsAction: Modified ${itemsModified} items, skipped ${skippedItems.length}`, 1);

    return {
        type: 'agent_action_execute_response',
        request_id: request.request_id,
        success: true,
        result_data: {
            items_modified: itemsModified,
            // Store actual changes (not requested changes) for safe undo
            tags_added: actualTagsAdded.size > 0 ? [...actualTagsAdded] : undefined,
            tags_removed: actualTagsRemoved.size > 0 ? [...actualTagsRemoved] : undefined,
            collections_added: actualCollectionsAdded.size > 0 ? [...actualCollectionsAdded] : undefined,
            collections_removed: actualCollectionsRemoved.size > 0 ? [...actualCollectionsRemoved] : undefined,
            skipped_items: skippedItems.length > 0 ? skippedItems : undefined,
        },
        timing: buildTiming({
            item_count: item_ids.length,
            items_modified: itemsModified,
            items_skipped: skippedItems.length,
        }),
    };
}
