/**
 * `import_item` (create_items v2) validate and execute handlers.
 *
 * Validate resolves every source to Zotero item JSON without writing and
 * reports duplicates in the target library; execute writes the approved JSON.
 * Resolution runs in the plugin realm (`Zotero.Beaver.itemImport`) because it
 * owns hidden browsers; this module may run in a window bundle.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type {
    WSAgentActionExecuteResponse,
    WSAgentActionValidateResponse,
} from '@beaver/agent-core/protocol/agentProtocol';
import type {
    ImportItemProposedData,
    ImportItemsValidateData,
    ImportItemsValidateResult,
} from '@beaver/agent-core/types/itemImport';
import { libraryRefForLibraryID, resolveWriteTargetLibrary, writeTargetLibraryError } from '../../../utils/libraryIdentity';
import { TimingAccumulator } from '../../../utils/timing';
import { resolveCollectionMemberships } from '../../collections/collectionMutations';
import { describeActiveAddons, SLOW_OBSERVERS_MS } from '../../committedTransaction';
import { ImportItemError, writeImportItem } from '../../itemImport/write';
import type { ActionExecuteRequest, ActionValidateRequest } from '../operationContext';
import { checkAborted, TimeoutContext, TimeoutError } from '../timeout';
import { checkLibraryExcluded, excludedLibraryMessage, getDeferredToolPreference } from '../utils';

/** Resolution budget ceiling, below the backend's validate timeout. */
const MAX_RESOLUTION_MS = 55_000;
const DEFAULT_RESOLUTION_MS = 45_000;

function invalid(request: ActionValidateRequest, error: string, errorCode: string): WSAgentActionValidateResponse {
    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: false,
        error,
        error_code: errorCode,
        preference: 'always_ask',
    };
}

/** Validate an import batch: check the target, then resolve every item without writing. */
export async function validateImportItemsAction(request: ActionValidateRequest): Promise<WSAgentActionValidateResponse> {
    const data = request.action_data as ImportItemsValidateData;
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) return invalid(request, 'At least one item must be provided', 'no_items');

    const searchableLibraryIds = Zotero.Beaver.libraryScopeInitialized ? (Zotero.Beaver.searchableLibraryIds ?? []) : [];
    if (!searchableLibraryIds.length) return invalid(request, 'No libraries are synced with Beaver', 'no_searchable_libraries');

    const target = resolveWriteTargetLibrary({ library_ref: data.library_ref, library_id: data.library_id, library_name: data.library_name });
    if (!target.ok) {
        const error = writeTargetLibraryError(target);
        return invalid(request, error.error, error.error_code);
    }
    const libraryID = target.libraryID;
    const library = Zotero.Libraries.get(libraryID);
    if (!library) {
        return invalid(request, `Library not found: ${libraryID}. Omit the library parameter to use the default library.`, 'library_not_found');
    }
    if (!searchableLibraryIds.includes(libraryID)) {
        return invalid(request, excludedLibraryMessage(libraryID), 'library_not_searchable');
    }
    if (!library.editable) {
        return invalid(
            request,
            `Library "${library.name}" is read-only and cannot be modified. Omit the library parameter to use the default library.`,
            'library_not_editable',
        );
    }

    const resolvedCollections = resolveCollectionMemberships(data.collections ?? [], libraryID)
        .map((entry) => ({ key: entry.key, name: entry.name, collection_id: entry.collectionId }));

    const service = Zotero.Beaver?.itemImport;
    if (!service) return invalid(request, 'Item import is unavailable. Restart Zotero and try again.', 'item_import_unavailable');
    // Fail before resolving: nothing approved here could be written.
    if (!service.canSave()) {
        return invalid(request, 'Saving imported items is not supported in this Zotero version.', 'item_import_unsupported');
    }

    const deadlineMs = Math.min(
        typeof data.deadline_ms === 'number' && data.deadline_ms > 0 ? data.deadline_ms : DEFAULT_RESOLUTION_MS,
        MAX_RESOLUTION_MS,
    );
    const started = Date.now();
    const resolved = await service.resolve(items, {
        libraryID,
        deadlineMs,
        threadId: data.thread_id ?? request.operation?.threadId ?? null,
    });
    logger(`validateImportItemsAction: resolved ${resolved.length} item(s) in ${Date.now() - started}ms`, 1);

    // Resolution takes seconds: the library may have been excluded meanwhile, and
    // its name and duplicate matches must not reach the agent then.
    const libraryAfter = Zotero.Libraries.get(libraryID);
    if (!Zotero.Beaver.libraryScopeInitialized || !(Zotero.Beaver.searchableLibraryIds ?? []).includes(libraryID)) {
        return invalid(request, excludedLibraryMessage(libraryID), 'library_not_searchable');
    }
    if (!libraryAfter || !libraryAfter.editable) {
        return invalid(request, 'The target library became read-only. Omit the library parameter to use the default library.', 'library_not_editable');
    }

    const libraryRef = libraryRefForLibraryID(libraryID) ?? undefined;
    const currentValue: ImportItemsValidateResult = {
        library_id: libraryID,
        ...(libraryRef ? { library_ref: libraryRef } : {}),
        library_name: library.name,
        resolved_collections: resolvedCollections,
        tags: data.tags ?? [],
        items: resolved,
    };

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: currentValue,
        normalized_action_data: {
            library_id: libraryID,
            library_ref: libraryRef ?? null,
            collections: resolvedCollections.map((entry) => entry.key),
            collection_keys: resolvedCollections.map((entry) => entry.key),
            collection_ids: resolvedCollections.map((entry) => entry.collection_id),
        },
        preference: getDeferredToolPreference('import_item', undefined, request.operation),
        timing: { total_ms: Date.now() - started },
    };
}

/** Execute one approved `import_item` action (called once per item). */
export async function executeImportItemAction(
    request: ActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const started = Date.now();
    const timing = new TimingAccumulator();
    const respond = async (body: Partial<WSAgentActionExecuteResponse>): Promise<WSAgentActionExecuteResponse> => {
        // Slow Notifier observers usually belong to another plugin; name the
        // active add-ons so the stall can be attributed.
        const slowObservers = timing.get('observers_deferred') > 0 || timing.get('post_commit_ms') >= SLOW_OBSERVERS_MS;
        const activeAddons = slowObservers ? await describeActiveAddons() : null;
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            timing: {
                total_ms: Date.now() - started,
                ...timing.getAll(),
                ...(activeAddons !== null ? { active_addons: activeAddons } : {}),
            },
            ...body,
        } as WSAgentActionExecuteResponse;
    };

    const data = request.action_data as ImportItemProposedData;
    if (!data?.source || (!data.item && !data.pending_resolution && !data.file)) {
        return respond({ error: 'No item data provided', error_code: 'missing_item_data' });
    }
    const target = resolveWriteTargetLibrary(data);
    if (!target.ok) return respond(writeTargetLibraryError(target));
    // TOCTOU guard: never write into a library the user excluded after validation.
    const excluded = checkLibraryExcluded(target.libraryID);
    if (excluded) return respond({ error: excluded.message, error_code: 'library_not_searchable' });

    try {
        checkAborted(ctx, 'import_item:before_write');
        const result = await writeImportItem(data, {
            libraryId: target.libraryID,
            actionId: request.action_id,
            runId: request.run_id,
            threadId: request.thread_id ?? request.operation?.threadId ?? null,
            onAttachmentResolved: request.operation?.onAttachmentResolved,
            assertCurrent: () => checkAborted(ctx, 'import_item:write'),
            timing,
        });
        logger(`executeImportItemAction: created ${result.library_id}-${result.zotero_key}`, 1);
        return respond({ success: true, result_data: result });
    } catch (error: any) {
        if (error instanceof TimeoutError) throw error;
        logger(`executeImportItemAction: failed: ${error?.message ?? error}`, 1);
        return respond({
            error: error?.message || 'Failed to create item',
            error_code: error instanceof ImportItemError ? error.code : (error?.code ?? 'create_failed'),
        });
    }
}
