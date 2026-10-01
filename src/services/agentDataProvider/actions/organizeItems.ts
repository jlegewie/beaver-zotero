import { formatCollectionId, CollectionResolutionError } from '../../collections/collectionIdentity';
import { collectionDeletedSinceValidationMessage, resolveOrganizeLibrary, resolveCollectionMemberships, recheckCollection, recheckExistingCollections } from '../../collections/collectionMutations';
import { logger } from '@beaver/agent-core/platform/logger';
import { WSAgentActionExecuteResponse, WSAgentActionValidateResponse } from '@beaver/agent-core/protocol/agentProtocol';
import { modelObjectId, parseItemReference, resolveItemReference, resolveLibraryRef } from '../../../utils/libraryIdentity';
import { TimingAccumulator } from '../../../utils/timing';
import type { ActionExecuteRequest, ActionValidateRequest } from '../operationContext';
import { TimeoutContext, TimeoutError, checkAborted } from '../timeout';
import { checkLibraryExcluded, excludedLibraryMessage, getDeferredToolPreference } from '../utils';


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
    request: ActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { item_ids, tags, collections: requestedCollections } = request.action_data as {
        item_ids: string[];
        tags?: { add?: string[]; remove?: string[] } | null;
        collections?: { add?: string[]; remove?: string[] } | null;
    };
    const collections = requestedCollections ? { ...requestedCollections } : requestedCollections;

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
    const searchableLibraryIds = (Zotero.Beaver.libraryScopeInitialized ? (Zotero.Beaver.searchableLibraryIds ?? []) : []);

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

    // Display names of the collections this action touches, keyed by collection
    // key.
    const collectionNames: Record<string, string> = {};

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

            try {
                for (const operation of ['add', 'remove'] as const) {
                    const resolved = resolveCollectionMemberships(collections?.[operation] ?? [], libraryId);
                    if (collections?.[operation]) collections[operation] = resolved.map(entry => entry.key);
                    for (const entry of resolved) {
                        collectionNames[entry.key] = entry.name;
                        collectionNames[entry.collectionId] = entry.name;
                    }
                }
            } catch (error) {
                if (!(error instanceof CollectionResolutionError)) throw error;
                collectionError = { message: error.message, code: error.code };
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
    const preference = getDeferredToolPreference('organize_items', undefined, request.operation);

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: currentState,
        // Return the portable ids so the backend persists + replays them instead
        // of the model-authored device-local ids (the validate-time enrichment seam).
        normalized_action_data: { item_ids: normalizedItemIds, ...(hasCollectionChanges ? { collections } : {}) },
        // Omitted for tag-only actions, which touch no collection.
        collection_names: Object.keys(collectionNames).length > 0 ? collectionNames : undefined,
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
    request: ActionExecuteRequest,
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

    const { item_ids: requestedItemIds, tags, collections: requestedCollections } = request.action_data as {
        item_ids: string[];
        tags?: { add?: string[]; remove?: string[] } | null;
        collections?: { add?: string[]; remove?: string[] } | null;
    };
    const collections = requestedCollections ? { ...requestedCollections } : requestedCollections;

    // Collapse repeated ids before anything classifies them. Processing the same
    // id twice makes the second pass read the state the first pass just wrote,
    // so the item would be counted as modified AND listed as unchanged — and the
    // second rollback snapshot would capture the already-modified state.
    const item_ids = [...new Set(requestedItemIds)];

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
    // Items found on this device that already held every requested change, so
    // nothing was written for them. Reported per item, not just as the
    // itemsModified shortfall: a caller tracking a large job needs to know WHICH
    // items it left alone, or it counts a no-op as work done.
    const unchangedItems: string[] = [];
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

    // Resolve collection keys to objects once, before opening the write transaction.
    // Validation guarantees all items share a library when collection changes are
    // requested, and that every key in add/remove resolves — so a miss here means
    // the collection was deleted between validate and execute.
    const addCollections = new Map<string, { id: number }>();
    const removeCollections = new Map<string, { id: number }>();
    const hasCollectionChanges = !!(collections && ((collections.add && collections.add.length > 0) || (collections.remove && collections.remove.length > 0)));
    // Library the collection keys were resolved against; null when no requested
    // item exists on this device (every item is skipped below, so there is
    // nothing to resolve keys for).
    const collectionLibraryId = hasCollectionChanges ? await resolveOrganizeLibrary(item_ids, true) : null;
    if (hasCollectionChanges && item_ids.length > 0) {
        if (collectionLibraryId != null) {
            // An "add" whose key no longer resolves fails the batch before
            // anything is written: the per-item loop would silently do nothing
            // for it and still report the item as handled, leaving the caller
            // to treat incomplete work as complete. A missing REMOVE target
            // needs no such guard — an item cannot be in a collection that no
            // longer exists, so the requested state already holds, and failing
            // over it would also drop tag changes requested alongside it.
            await ta.track('collection_resolve_ms', async () => {
                for (const collKey of collections?.add ?? []) {
                    checkAborted(ctx, 'organize_items:collection_resolve');
                    try {
                        const entry = recheckCollection(collKey, collectionLibraryId!);
                        addCollections.set(entry.key, entry.collection);
                    } catch (error) {
                        if (error instanceof CollectionResolutionError && error.code === 'collection_not_found') {
                            throw new CollectionResolutionError('collection_not_found', collectionDeletedSinceValidationMessage('Collection', collKey));
                        }
                        throw error;
                    }
                }
                checkAborted(ctx, 'organize_items:collection_resolve');
                for (const entry of recheckExistingCollections(collections?.remove ?? [], collectionLibraryId!)) {
                    removeCollections.set(entry.key, entry.collection);
                }
            });
            if (collections?.add) collections.add = [...addCollections.keys()];
            if (collections?.remove) collections.remove = [...removeCollections.keys()];
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
                    for (const collKey of collections.add) {
                        if (!existingCollections.has(collKey)) {
                            const collection = addCollections.get(collKey);
                            if (collection) {
                                item.addToCollection(collection.id);
                                actualCollectionsAdded.add(collKey);
                                modified = true;
                            }
                        }
                    }
                }

                // Remove from collections (only for top-level items)
                if (isTopLevel && collections?.remove && collections.remove.length > 0) {
                    for (const collKey of collections.remove) {
                        if (existingCollections.has(collKey)) {
                            const collection = removeCollections.get(collKey);
                            if (collection) {
                                item.removeFromCollection(collection.id);
                                actualCollectionsRemoved.add(collKey);
                                modified = true;
                            }
                        }
                    }
                }

                // Checkpoint: abort before each item save — throws inside
                // executeTransaction triggers full rollback
                if (modified) {
                    checkAborted(ctx, 'organize_items:before_item_save');
                    await ta.track('item_save_ms', () => item.save());
                    itemsModified++;
                } else {
                    // Every requested change was already in place (the item has
                    // the tags, is in the collections, is out of the ones being
                    // removed). Not a failure — the item is in the requested
                    // state — and distinct from skippedItems, which never
                    // resolved at all.
                    unchangedItems.push(itemId);
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
                items_unchanged: unchangedItems.length,
            }),
        };
    }

    logger(`executeOrganizeItemsAction: Modified ${itemsModified} items, skipped ${skippedItems.length}, unchanged ${unchangedItems.length}`, 1);

    return {
        type: 'agent_action_execute_response',
        request_id: request.request_id,
        success: true,
        result_data: {
            items_modified: itemsModified,
            current_state: Object.fromEntries([...itemSnapshots].map(([id, snapshot]) => [id, {
                tags: snapshot.tags.map(tag => tag.tag),
                collections: snapshot.collections.map(id => Zotero.Collections.get(id)?.key).filter(Boolean),
            }])),
            // Store actual changes (not requested changes) for safe undo
            tags_added: actualTagsAdded.size > 0 ? [...actualTagsAdded] : undefined,
            tags_removed: actualTagsRemoved.size > 0 ? [...actualTagsRemoved] : undefined,
            collection_ids_added: actualCollectionsAdded.size > 0 && collectionLibraryId != null ? [...actualCollectionsAdded].map(key => formatCollectionId(collectionLibraryId!, key)) : undefined,
            collection_ids_removed: actualCollectionsRemoved.size > 0 && collectionLibraryId != null ? [...actualCollectionsRemoved].map(key => formatCollectionId(collectionLibraryId!, key)) : undefined,
            collections_added: actualCollectionsAdded.size > 0 ? [...actualCollectionsAdded] : undefined,
            collections_removed: actualCollectionsRemoved.size > 0 ? [...actualCollectionsRemoved] : undefined,
            skipped_items: skippedItems.length > 0 ? skippedItems : undefined,
            unchanged_items: unchangedItems.length > 0 ? unchangedItems : undefined,
        },
        timing: buildTiming({
            item_count: item_ids.length,
            items_modified: itemsModified,
            items_skipped: skippedItems.length,
            items_unchanged: unchangedItems.length,
        }),
    };
}
