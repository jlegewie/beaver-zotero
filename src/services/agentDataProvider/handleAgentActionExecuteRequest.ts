import { logger } from '../../utils/logger';
import { sanitizeCreators } from '../../utils/zoteroUtils';
import { WSAgentActionExecuteRequest, WSAgentActionExecuteResponse } from '../agentProtocol';
import type { MetadataEdit } from '../../../react/types/agentActions/base';
import type { CreateItemProposedData, CreateItemResultData } from '../../../react/types/agentActions/items';
import { applyCreateItemData } from '../../../react/utils/addItemActions';


/** Default timeout in seconds if not specified by backend */
const DEFAULT_TIMEOUT_SECONDS = 25;

/** Timeout error for cooperative cancellation */
class TimeoutError extends Error {
    constructor(
        public readonly timeoutSeconds: number,
        public readonly elapsedMs: number,
        public readonly phase: string,
    ) {
        super(`Operation timed out after ${timeoutSeconds} seconds`);
        this.name = 'TimeoutError';
    }
}

/** Context passed to executors for cooperative timeout checking */
interface TimeoutContext {
    signal: AbortSignal;
    timeoutSeconds: number;
    startTime: number;
}

/**
 * Check if the operation has been aborted and throw TimeoutError if so.
 * Called at checkpoints before irreversible operations (saves, transactions).
 */
function checkAborted(ctx: TimeoutContext, phase: string): void {
    const elapsed = Date.now() - ctx.startTime;
    if (ctx.signal.aborted || elapsed >= ctx.timeoutSeconds * 1000) {
        throw new TimeoutError(ctx.timeoutSeconds, elapsed, phase);
    }
}

/**
 * Restore in-memory field values on an item after a failed save or timeout.
 * Prevents dirty in-memory state from leaking into future saves.
 */
function restoreFieldSnapshots(
    item: any,
    snapshots: Array<{ field: string; originalValue: any }>,
): void {
    for (const snap of snapshots) {
        try {
            item.setField(snap.field, snap.originalValue ?? '');
        } catch (_) {
            // Best-effort restoration — field may not be settable
        }
    }
}

/**
 * Restore in-memory creators on an item after a failed save or timeout.
 * Uses the internal format snapshot from item.getCreators().
 */
function restoreCreatorSnapshots(item: any, originalCreators: any[] | null): void {
    if (originalCreators === null) return;
    try {
        item.setCreators(originalCreators);
    } catch (_) {
        // Best-effort restoration — setCreators may fail if item is in bad state
    }
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
 * Handle agent_action_execute request from backend.
 * Executes the action and returns the result.
 *
 * Timeout handling:
 * - Uses timeout_seconds from request (default: 25s)
 * - Uses cooperative cancellation via AbortController so executors
 *   check the signal before irreversible operations (saves, transactions)
 * - Returns detailed diagnostics on timeout
 */
export async function handleAgentActionExecuteRequest(
    request: WSAgentActionExecuteRequest
): Promise<WSAgentActionExecuteResponse> {
    const rawTimeout = request.timeout_seconds;
    const timeoutSeconds = (typeof rawTimeout === 'number' && rawTimeout > 0)
        ? rawTimeout
        : DEFAULT_TIMEOUT_SECONDS;
    const startTime = Date.now();

    logger(`handleAgentActionExecuteRequest: Executing ${request.action_type} with timeout ${timeoutSeconds}s`, 1);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    try {
        const ctx: TimeoutContext = {
            signal: controller.signal,
            timeoutSeconds,
            startTime,
        };

        let result: WSAgentActionExecuteResponse;

        if (request.action_type === 'edit_metadata') {
            result = await executeEditMetadataAction(request, ctx);
        } else if (request.action_type === 'create_collection') {
            result = await executeCreateCollectionAction(request, ctx);
        } else if (request.action_type === 'organize_items') {
            result = await executeOrganizeItemsAction(request, ctx);
        } else if (request.action_type === 'create_item') {
            result = await executeCreateItemAction(request, ctx);
        } else {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Unsupported action type: ${request.action_type}`,
                error_code: 'unsupported_action_type',
            };
        }

        return result;
    } catch (error) {
        const elapsedMs = Date.now() - startTime;

        if (error instanceof TimeoutError) {
            logger(`handleAgentActionExecuteRequest: Timeout after ${error.elapsedMs}ms in phase '${error.phase}'`, 1);
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Operation timed out after ${error.timeoutSeconds} seconds`,
                error_code: 'timeout',
                result_data: {
                    started_at: startTime,
                    elapsed_ms: error.elapsedMs,
                    phase: error.phase,
                    action_type: request.action_type,
                    timeout_seconds: error.timeoutSeconds,
                },
            };
        }

        logger(`handleAgentActionExecuteRequest: Error after ${elapsedMs}ms: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: String(error),
            error_code: 'execution_failed',
            result_data: {
                started_at: startTime,
                elapsed_ms: elapsedMs,
                action_type: request.action_type,
            },
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Execute an edit_metadata action.
 * Applies the field edits to the Zotero item.
 */
async function executeEditMetadataAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const { library_id, zotero_key, edits, creators } = request.action_data as {
        library_id: number;
        zotero_key: string;
        edits: MetadataEdit[];
        creators?: Array<{ firstName?: string; lastName?: string; name?: string; creatorType: string }> | null;
    };

    // Get the item
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Item not found: ${library_id}-${zotero_key}`,
            error_code: 'item_not_found',
        };
    }

    const appliedEdits: Array<{ field: string; old_value: string | null; new_value: string }> = [];
    const failedEdits: Array<{ field: string; error: string }> = [];
    // Snapshot original field values for in-memory rollback on failure
    const fieldSnapshots: Array<{ field: string; originalValue: any }> = [];
    // Snapshot original creators for in-memory rollback on failure
    let creatorSnapshot: any[] | null = null;
    let oldCreatorsJSON: any[] | null = null;
    let creatorsApplied = false;

    try {
        // Apply each field edit (in-memory only, not persisted until saveTx)
        for (const edit of edits) {
            try {
                // includeBaseMapped=true so base fields (e.g. 'publicationTitle')
                // resolve to the type-specific field (e.g. 'bookTitle' on bookSection)
                const oldValue = item.getField(edit.field, false, true);
                fieldSnapshots.push({ field: edit.field, originalValue: oldValue });
                item.setField(edit.field, edit.new_value);
                appliedEdits.push({
                    field: edit.field,
                    old_value: oldValue ? String(oldValue) : null,
                    new_value: edit.new_value,
                });
            } catch (error) {
                // Re-throw TimeoutError so it propagates to the outer catch
                if (error instanceof TimeoutError) throw error;
                failedEdits.push({
                    field: edit.field,
                    error: String(error),
                });
            }
        }

        // Apply creators (in-memory only, not persisted until saveTx)
        if (creators && creators.length > 0) {
            try {
                creatorSnapshot = item.getCreators();
                oldCreatorsJSON = item.getCreatorsJSON();
                // Type assertion: creatorType has been validated by the validate handler
                item.setCreators(sanitizeCreators(creators) as any[]);
                creatorsApplied = true;
            } catch (error) {
                if (error instanceof TimeoutError) throw error;
                failedEdits.push({
                    field: 'creators',
                    error: String(error),
                });
            }
        }

        // Save the item if any changes were applied
        if (appliedEdits.length > 0 || creatorsApplied) {
            // Checkpoint: abort before persisting if timeout has fired
            checkAborted(ctx, 'edit_metadata:before_save');
            try {
                await item.saveTx();
                logger(`executeEditMetadataAction: Saved ${appliedEdits.length} edits${creatorsApplied ? ' + creators' : ''} to ${library_id}-${zotero_key}`, 1);
            } catch (error) {
                if (error instanceof TimeoutError) throw error;
                // Save failed — restore in-memory state so dirty fields don't leak
                restoreFieldSnapshots(item, fieldSnapshots);
                restoreCreatorSnapshots(item, creatorSnapshot);
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error: `Failed to save item: ${error}`,
                    error_code: 'save_failed',
                };
            }
        }

        const allSucceeded = failedEdits.length === 0;

        // Build result data
        const resultData: Record<string, any> = {
            applied_edits: appliedEdits,
            failed_edits: failedEdits,
        };

        // Include creator change info in result
        if (creatorsApplied) {
            resultData.old_creators = oldCreatorsJSON;
            resultData.new_creators = item.getCreatorsJSON();
        }

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: allSucceeded,
            error: allSucceeded ? undefined : `Some edits failed: ${failedEdits.map(e => e.field).join(', ')}`,
            result_data: resultData,
        };
    } catch (error) {
        // Restore in-memory state on any unhandled error (including TimeoutError)
        restoreFieldSnapshots(item, fieldSnapshots);
        restoreCreatorSnapshots(item, creatorSnapshot);
        throw error;
    }
}

/**
 * Execute a create_collection action.
 * Creates a new Zotero collection with the specified properties.
 */
async function executeCreateCollectionAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const { library_id: rawLibraryId, library_name, name, parent_key, item_ids } = request.action_data as {
        library_id?: number | null;
        library_name?: string | null;
        name: string;
        parent_key?: string | null;
        item_ids?: string[];
    };

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    let library_id: number;

    if (rawLibraryId == null || rawLibraryId === 0) {
        // Not provided or normalized to 0 — try library_name, then default
        if (library_name) {
            const allLibraries = Zotero.Libraries.getAll();
            const matchedLibrary = allLibraries.find(
                (lib) => lib.name.toLowerCase() === library_name.toLowerCase()
            );
            if (!matchedLibrary) {
                return {
                    type: 'agent_action_execute_response',
                    request_id: request.request_id,
                    success: false,
                    error: `Library not found: "${library_name}"`,
                    error_code: 'library_not_found',
                };
            }
            library_id = matchedLibrary.libraryID;
        } else {
            library_id = Zotero.Libraries.userLibraryID;
        }
    } else if (typeof rawLibraryId === 'number' && rawLibraryId > 0) {
        library_id = rawLibraryId;
    } else {
        // Explicitly provided but invalid (negative, NaN, fractional, etc.)
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Invalid library ID: ${rawLibraryId}`,
            error_code: 'library_not_found',
        };
    }

    // Build collection params
    const collectionParams: { name: string; libraryID: number; parentID?: number } = {
        name,
        libraryID: library_id,
    };

    // Set parent if provided
    if (parent_key) {
        const parentCollection = await Zotero.Collections.getByLibraryAndKeyAsync(library_id, parent_key);
        if (parentCollection) {
            collectionParams.parentID = parentCollection.id;
        } else {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Parent collection not found: ${parent_key}`,
                error_code: 'parent_not_found',
            };
        }
    }

    let collection: any = null;
    let collectionSaved = false;

    try {
        // Create the collection
        collection = new Zotero.Collection(collectionParams);

        // Checkpoint: abort before persisting collection
        checkAborted(ctx, 'create_collection:before_save');

        // Save the collection
        await collection.saveTx();
        collectionSaved = true;
        logger(`executeCreateCollectionAction: Created collection "${name}" with key ${collection.key}`, 1);

        let itemsAdded = 0;

        // Add items to the collection if specified
        if (item_ids && item_ids.length > 0) {
            // Checkpoint: abort before item-adding transaction
            checkAborted(ctx, 'create_collection:before_add_items');

            await Zotero.DB.executeTransaction(async () => {
                const itemIdsToAdd: number[] = [];

                for (const itemIdStr of item_ids) {
                    const [libId, key] = itemIdStr.split('-');
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(parseInt(libId, 10), key);
                    if (item && !item.isAttachment() && !item.isNote() && !item.isAnnotation()) {
                        itemIdsToAdd.push(item.id);
                    }
                }

                if (itemIdsToAdd.length > 0) {
                    await collection.addItems(itemIdsToAdd);
                    itemsAdded = itemIdsToAdd.length;
                    logger(`executeCreateCollectionAction: Added ${itemsAdded} items to collection`, 1);
                }
            });
        }

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: {
                library_id,
                collection_key: collection.key,
                items_added: itemsAdded,
            },
        };
    } catch (error) {
        // Compensating action: delete collection if it was persisted but
        // subsequent operations (item addition) failed or timed out.
        // This prevents orphaned empty collections from accumulating.
        if (collectionSaved) {
            try {
                await collection.eraseTx();
                logger(`executeCreateCollectionAction: Rolled back collection "${name}"`, 1);
            } catch (eraseError) {
                logger(`executeCreateCollectionAction: Failed to roll back collection: ${eraseError}`, 1);
            }
        }

        // Re-throw TimeoutError so it propagates to the main handler
        if (error instanceof TimeoutError) throw error;
        logger(`executeCreateCollectionAction: Failed to create collection: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `Failed to create collection: ${error}`,
            error_code: 'create_failed',
        };
    }
}

/**
 * Execute an organize_items action.
 * Adds/removes tags and collection memberships for the specified items.
 * 
 * All modifications are batched in a single database transaction for performance.
 * This is an all-or-nothing operation: if any item fails to save, the entire
 * transaction rolls back. Items that don't exist are skipped (not an error).
 */
async function executeOrganizeItemsAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const { item_ids, tags, collections } = request.action_data as {
        item_ids: string[];
        tags?: { add?: string[]; remove?: string[] } | null;
        collections?: { add?: string[]; remove?: string[] } | null;
    };

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

    try {
        // Checkpoint: abort before starting the transaction
        checkAborted(ctx, 'organize_items:before_transaction');

        // Batch all modifications in a single transaction for performance.
        // If any save fails (including TimeoutError), the entire transaction rolls back.
        await Zotero.DB.executeTransaction(async () => {
            for (const itemId of item_ids) {
                const parts = itemId.split('-');
                const libraryId = parseInt(parts[0], 10);
                const zoteroKey = parts.slice(1).join('-');

                const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
                if (!item) {
                    // Item not found - skip but don't fail the transaction
                    skippedItems.push(itemId);
                    continue;
                }

                let modified = false;

                // Snapshot in-memory state before modifications for rollback
                const originalTags = item.getTags();
                const originalCollections = item.getCollections();
                itemSnapshots.set(itemId, { item, tags: originalTags, collections: originalCollections });

                // Get current state for change detection
                const existingTags = new Set(originalTags.map((t: { tag: string }) => t.tag));
                const existingCollections = new Set(originalCollections.map((collectionId: number) => {
                    const collection = Zotero.Collections.get(collectionId);
                    return collection ? collection.key : null;
                }).filter(Boolean) as string[]);

                // Add tags (only if not already present)
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

                // Add to collections (only if not already member)
                if (collections?.add && collections.add.length > 0) {
                    for (const collKey of collections.add) {
                        if (!existingCollections.has(collKey)) {
                            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
                            if (collection) {
                                item.addToCollection(collection.id);
                                actualCollectionsAdded.add(collKey);
                                modified = true;
                            }
                        }
                    }
                }

                // Remove from collections (only if member)
                if (collections?.remove && collections.remove.length > 0) {
                    for (const collKey of collections.remove) {
                        if (existingCollections.has(collKey)) {
                            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, collKey);
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
                    await item.save();
                    itemsModified++;
                }
            }
        });
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
    };
}

/**
 * Execute a create_item action.
 * Creates the item in Zotero from the proposed data.
 * 
 * Note: This handler is called once PER ITEM from the backend.
 * The action_data contains a single item's proposed_data.
 */
async function executeCreateItemAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    // The action_data is the proposed_data for a single create_item action
    const proposedData = request.action_data as CreateItemProposedData;

    // Validate we have item data
    if (!proposedData || !proposedData.item) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'No item data provided',
            error_code: 'missing_item_data',
        };
    }

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    let library_id: number;

    if (proposedData.library_id != null && proposedData.library_id !== 0) {
        if (typeof proposedData.library_id === 'number' && proposedData.library_id > 0) {
            library_id = proposedData.library_id;
        } else {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Invalid library ID: ${proposedData.library_id}`,
                error_code: 'library_not_found',
            };
        }
    } else if (proposedData.library_name) {
        const allLibraries = Zotero.Libraries.getAll();
        const matchedLibrary = allLibraries.find(
            (lib) => lib.name.toLowerCase() === proposedData.library_name!.toLowerCase()
        );
        if (!matchedLibrary) {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Library not found: "${proposedData.library_name}"`,
                error_code: 'library_not_found',
            };
        }
        library_id = matchedLibrary.libraryID;
    } else {
        library_id = Zotero.Libraries.userLibraryID;
    }

    try {
        logger(`executeCreateItemAction: Creating item "${proposedData.item.title}" in library ${library_id}`, 1);

        // Checkpoint: abort before starting item creation
        checkAborted(ctx, 'create_item:before_apply');

        // Create the item using the existing utility function
        // Pass library_id from resolved library to target the correct library
        const result: CreateItemResultData = await applyCreateItemData(proposedData, {
            libraryId: library_id,
        });

        logger(`executeCreateItemAction: Successfully created item ${result.library_id}-${result.zotero_key}`, 1);

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: result,
        };
    } catch (error: any) {
        // Re-throw TimeoutError so it propagates to the main handler
        if (error instanceof TimeoutError) throw error;
        const errorMsg = error?.message || String(error) || 'Failed to create item';
        const errorStack = error?.stack || '';
        logger(`executeCreateItemAction: Failed to create item: ${errorMsg}`, 1);
        if (errorStack) {
            logger(`executeCreateItemAction: Stack: ${errorStack}`, 1);
        }
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: errorMsg,
            error_code: 'create_failed',
        };
    }
}
