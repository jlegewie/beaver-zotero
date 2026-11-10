import { resolveCollectionMemberships } from '../../collections/collectionMutations';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    FrontendTimingMetadata,
    WSAgentActionExecuteResponse,
    WSAgentActionValidateResponse
} from '@beaver/agent-core/protocol/agentProtocol';
import type { CreateItemProposedData, CreateItemResultData } from '@beaver/agent-core/types/agentActions/items';
import { batchFindExistingReferences, BatchReferenceCheckItem } from '../../../utils/batchFindExistingReferences';
import { libraryRefForLibraryID, resolveWriteTargetLibrary, writeTargetLibraryError } from '../../../utils/libraryIdentity';
import { TimingAccumulator } from '../../../utils/timing';
import { applyCreateItemData } from '../../itemImport/legacy';
import type { ActionExecuteRequest, ActionValidateRequest } from '../operationContext';
import type { AttachmentResolvedPayload } from '../../attachmentResolved';
import { checkAborted, TimeoutContext, TimeoutError } from '../timeout';
import { excludedLibraryMessage, getDeferredToolPreference } from '../utils';
import { ActionExecutionError, actionError, assertLibraryNotExcluded, toExecuteResponse } from './actionExecution';


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
    request: ActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const { library_id: rawLibraryId, library_ref, library_name, items, collections, tags } = request.action_data as {
        library_id?: number | null;
        library_ref?: string | null;
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
    const searchableLibraryIds = (Zotero.Beaver.libraryScopeInitialized ? (Zotero.Beaver.searchableLibraryIds ?? []) : []);
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

    const targetResolution = resolveWriteTargetLibrary({ library_ref, library_id: rawLibraryId, library_name });
    if (!targetResolution.ok) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            ...writeTargetLibraryError(targetResolution),
            preference: 'always_ask',
        };
    }
    const targetLibraryId = targetResolution.libraryID;

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

    const resolvedCollections = resolveCollectionMemberships(collections ?? [], targetLibraryId)
        .map(entry => ({ key: entry.key, name: entry.name, collection_id: entry.collectionId }));

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
    const preference = getDeferredToolPreference('create_item', undefined, request.operation);

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            library_id: targetLibraryId,
            library_ref: libraryRefForLibraryID(targetLibraryId) ?? undefined,
            library_name: targetLibrary.name,
            items_count: items.length,
            existing_items: existingItems,
            resolved_collections: resolvedCollections,
            tags: tags || [],
        },
        normalized_action_data: {
            library_id: targetLibraryId, library_ref: libraryRefForLibraryID(targetLibraryId),
            collections: resolvedCollections.map(entry => entry.key),
            collection_keys: resolvedCollections.map(entry => entry.key),
            collection_ids: resolvedCollections.map(entry => entry.collection_id),
        },
        preference,
    };
}


export interface CreateItemApplyOptions {
    actionId?: string;
    runId?: string;
    threadId?: string;
    /** Called when the background PDF fetch for the new item settles. */
    onAttachmentResolved?: (payload: AttachmentResolvedPayload) => void;
    timing?: TimingAccumulator;
}

/**
 * Create the item of one create_item action and return its `result_data`.
 *
 * Importing from the item's URL can take tens of seconds, so an apply with a
 * deadline (the socket path) skips it and relies on identifier translation
 * and the metadata the action carries; an apply without one tries it.
 */
export async function applyCreateItem(
    proposedData: CreateItemProposedData,
    ctx: TimeoutContext,
    options: CreateItemApplyOptions = {},
): Promise<CreateItemResultData> {
    const ta = options.timing ?? new TimingAccumulator();
    if (!proposedData || !proposedData.item) {
        throw actionError('missing_item_data', 'No item data provided');
    }

    // Resolve target library: use provided ID, resolve name, or default to user's main library
    const libResolveStart = Date.now();
    const targetResolution = resolveWriteTargetLibrary(proposedData);
    ta.record('resolve_library_ms', Date.now() - libResolveStart);
    if (!targetResolution.ok) {
        const { error, error_code } = writeTargetLibraryError(targetResolution);
        throw actionError(error_code, error);
    }
    const library_id = targetResolution.libraryID;

    // TOCTOU guard: never create in a library the user excluded from Beaver,
    // even if validation passed earlier or the action waited for approval.
    assertLibraryNotExcluded(library_id);

    try {
        logger(`applyCreateItem: Creating item "${proposedData.item.title}" in library ${library_id}`, 1);

        // Checkpoint: abort before starting item creation
        checkAborted(ctx, 'create_item:before_apply');

        // Forward action/run/thread IDs so the background PDF fetch task can
        // emit `attachment_resolved` back to the right thread on completion.
        const result: CreateItemResultData = await ta.track('apply_ms', () =>
            applyCreateItemData(proposedData, {
                libraryId: library_id,
                skipUrlTranslation: Number.isFinite(ctx.timeoutSeconds),
                timing: ta,
                actionId: options.actionId,
                runId: options.runId,
                onAttachmentResolved: options.onAttachmentResolved,
                threadId: options.threadId,
            })
        );

        logger(`applyCreateItem: Successfully created item ${result.library_id}-${result.zotero_key}`, 1);
        return result;
    } catch (error: any) {
        if (error instanceof TimeoutError || error instanceof ActionExecutionError) throw error;
        const errorMsg = error?.message || String(error) || 'Failed to create item';
        logger(`applyCreateItem: Failed to create item: ${errorMsg}`, 1);
        if (error?.stack) logger(`applyCreateItem: Stack: ${error.stack}`, 1);
        throw actionError(error?.code ?? 'create_failed', errorMsg);
    }
}

/**
 * Create one item for the backend during a run.
 *
 * Note: This handler is called once PER ITEM from the backend.
 * The action_data contains a single item's proposed_data.
 */
async function executeCreateItemAction(
    request: ActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const startTime = Date.now();
    const ta = new TimingAccumulator();
    const buildTiming = (): FrontendTimingMetadata => ({
        total_ms: Date.now() - startTime,
        ...ta.getAll(),
    });
    return toExecuteResponse(request.request_id, 'executeCreateItemAction', () => applyCreateItem(
        request.action_data as CreateItemProposedData, ctx, {
            actionId: request.action_id,
            runId: request.run_id,
            threadId: request.thread_id,
            onAttachmentResolved: request.operation?.onAttachmentResolved,
            timing: ta,
        },
    ), buildTiming);
}

export { executeCreateItemAction, validateCreateItemAction };
