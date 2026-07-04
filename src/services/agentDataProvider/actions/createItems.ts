import { logger } from '../../../utils/logger';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { batchFindExistingReferences, BatchReferenceCheckItem } from '../../../../react/utils/batchFindExistingReferences';
import { store } from '../../../../react/store';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    FrontendTimingMetadata,
} from '../../agentProtocol';
import { excludedLibraryMessage, getDeferredToolPreference } from '../utils';
import { TimeoutContext, checkAborted } from '../timeout';
import { TimeoutError } from '../timeout';
import { TimingAccumulator } from '../../../utils/timing';
import type { CreateItemProposedData, CreateItemResultData } from '../../../../react/types/agentActions/items';
import { applyCreateItemData } from '../../../../react/utils/addItemActions';


/**
 * Item data sent from backend for validation
 */
interface CreateItemValidationItem {
    source_id: string;
    title?: string;
    authors?: string[];
    year?: number;
    doi?: string;
    isbn?: string;
}


/**
 * Validate a create_item action.
 * Checks which items already exist in the library using batch reference checking.
 * Returns validation result with existing items info for partial processing.
 */
async function validateCreateItemAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id: rawLibraryId, library_name, items, collections, tags } = request.action_data as {
        library_id?: number | null;
        library_name?: string | null;
        items: CreateItemValidationItem[];
        collections?: string[];
        tags?: string[];
    };

    // Validate at least one item is provided
    if (!items || items.length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'At least one item must be provided',
            error_code: 'no_items',
            preference: 'always_ask',
        };
    }

    // Get searchable library IDs - these are the libraries we can check for duplicates
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    if (searchableLibraryIds.length === 0) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'No libraries are synced with Beaver',
            error_code: 'no_searchable_libraries',
            preference: 'always_ask',
        };
    }

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    let targetLibraryId: number;

    if (rawLibraryId == null || rawLibraryId === 0) {
        // Not provided or normalized to 0 — try library_name, then default
        if (library_name) {
            const allLibraries = Zotero.Libraries.getAll();
            const matchedLibrary = allLibraries.find(
                (lib) => lib.name.toLowerCase() === library_name.toLowerCase()
            );
            if (!matchedLibrary) {
                const availableNames = allLibraries.map((lib) => lib.name).join(', ');
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Library not found: "${library_name}". Omit the library parameter to use the default library. Available libraries: ${availableNames}`,
                    error_code: 'library_not_found',
                    preference: 'always_ask',
                };
            }
            targetLibraryId = matchedLibrary.libraryID;
        } else {
            targetLibraryId = Zotero.Libraries.userLibraryID;
        }
    } else if (typeof rawLibraryId === 'number' && rawLibraryId > 0) {
        targetLibraryId = rawLibraryId;
    } else {
        // Explicitly provided but invalid (negative, NaN, fractional, etc.)
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Invalid library ID: ${rawLibraryId}`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // Validate library exists
    const targetLibrary = Zotero.Libraries.get(targetLibraryId);
    if (!targetLibrary) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found: ${targetLibraryId}. Omit the library parameter to use the default library.`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // Validate library is searchable (synced with Beaver)
    if (!searchableLibraryIds.includes(targetLibraryId)) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: excludedLibraryMessage(targetLibraryId),
            error_code: 'library_not_searchable',
            preference: 'always_ask',
        };
    }
    
    // Validate library is editable
    if (!targetLibrary.editable) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library "${targetLibrary.name}" is read-only and cannot be modified. Omit the library parameter to use the default library.`,
            error_code: 'library_not_editable',
            preference: 'always_ask',
        };
    }

    // Validate collections exist (if specified)
    const resolvedCollections: Array<{ key: string; name: string }> = [];
    if (collections && collections.length > 0) {
        for (const collectionKey of collections) {
            const collection = await Zotero.Collections.getByLibraryAndKeyAsync(targetLibraryId, collectionKey);
            if (!collection) {
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Collection not found: ${collectionKey}`,
                    error_code: 'collection_not_found',
                    preference: 'always_ask',
                };
            }
            resolvedCollections.push({
                key: collectionKey,
                name: collection.name,
            });
        }
    }

    // Check which items already exist in the library using batch reference checking
    const batchItems: BatchReferenceCheckItem[] = items.map(item => ({
        id: item.source_id,
        data: {
            title: item.title,
            date: item.year?.toString(),
            DOI: item.doi,
            ISBN: item.isbn,
            creators: item.authors,
        }
    }));

    // Map from source_id to Zotero item_id (format: "library_id-zotero_key")
    const existingItems: Record<string, string> = {};
    try {
        const batchOutput = await batchFindExistingReferences(batchItems, [targetLibraryId]);
        for (const result of batchOutput.results) {
            if (result.item !== null) {
                existingItems[result.id] = `${result.item.library_id}-${result.item.zotero_key}`;
            }
        }

        logger(`validateCreateItemAction: Found ${Object.keys(existingItems).length}/${items.length} items already in target library (${batchOutput.timing.total_ms}ms)`, 1);
    } catch (error) {
        logger(`validateCreateItemAction: Batch reference check failed: ${error}`, 1);
        // Continue with empty existing items - let the frontend handle per-item checks
    }
    
    // Get user preference
    const preference = getDeferredToolPreference('create_item');

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            library_id: targetLibraryId,
            library_name: targetLibrary.name,
            items_count: items.length,
            existing_items: existingItems,
            resolved_collections: resolvedCollections,
            tags: tags || [],
        },
        preference,
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
    const startTime = Date.now();
    const ta = new TimingAccumulator();

    const buildTiming = (): FrontendTimingMetadata => ({
        total_ms: Date.now() - startTime,
        ...ta.getAll(),
    });

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
            timing: buildTiming(),
        };
    }

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    const libResolveStart = Date.now();
    let library_id: number;

    if (proposedData.library_id != null && proposedData.library_id !== 0) {
        if (typeof proposedData.library_id === 'number' && proposedData.library_id > 0) {
            library_id = proposedData.library_id;
        } else {
            ta.record('resolve_library_ms', Date.now() - libResolveStart);
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Invalid library ID: ${proposedData.library_id}`,
                error_code: 'library_not_found',
                timing: buildTiming(),
            };
        }
    } else if (proposedData.library_name) {
        const allLibraries = Zotero.Libraries.getAll();
        const matchedLibrary = allLibraries.find(
            (lib) => lib.name.toLowerCase() === proposedData.library_name!.toLowerCase()
        );
        if (!matchedLibrary) {
            ta.record('resolve_library_ms', Date.now() - libResolveStart);
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Library not found: "${proposedData.library_name}"`,
                error_code: 'library_not_found',
                timing: buildTiming(),
            };
        }
        library_id = matchedLibrary.libraryID;
    } else {
        library_id = Zotero.Libraries.userLibraryID;
    }
    ta.record('resolve_library_ms', Date.now() - libResolveStart);

    try {
        logger(`executeCreateItemAction: Creating item "${proposedData.item.title}" in library ${library_id}`, 1);

        // Checkpoint: abort before starting item creation
        checkAborted(ctx, 'create_item:before_apply');

        // Create the item using the existing utility function.
        // Forward action/run/thread IDs so the background PDF fetch task can
        // emit `attachment_resolved` back to the right thread on completion.
        const result: CreateItemResultData = await ta.track('apply_ms', () =>
            applyCreateItemData(proposedData, {
                libraryId: library_id,
                skipUrlTranslation: true,
                timing: ta,
                actionId: request.action_id,
                runId: request.run_id,
                threadId: request.thread_id,
            })
        );

        logger(`executeCreateItemAction: Successfully created item ${result.library_id}-${result.zotero_key}`, 1);

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: result,
            timing: buildTiming(),
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
            timing: buildTiming(),
        };
    }
}

export { validateCreateItemAction, executeCreateItemAction };