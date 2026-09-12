import { logger } from '@beaver/agent-core/platform/logger';
import { WSAgentActionExecuteResponse } from '@beaver/agent-core/protocol/agentProtocol';
import type { AgentDataRequestContext } from '@beaver/agent-core/transport/agentDataDispatch';
import { executeCreateCollectionAction } from './actions/createCollection';
import { executeCreateHighlightAnnotationsAction } from './actions/createHighlightAnnotations';
import { executeCreateItemAction } from './actions/createItems';
import { executeCreateNoteAction } from './actions/createNote';
import { executeCreateNoteAnnotationsAction } from './actions/createNoteAnnotations';
import { executeEditAnnotationsAction } from './actions/editAnnotations';
import { executeEditMetadataAction } from './actions/editMetadata';
import { executeEditNoteAction } from './actions/editNote';
import { executeEditNoteBatchAction } from './actions/editNoteBatch';
import { executeManageCollectionsAction } from './actions/manageCollections';
import { executeManageTagsAction } from './actions/manageTags';
import { executeOrganizeItemsAction } from './actions/organizeItems';
import type { ActionExecuteRequest } from './operationContext';
import { prepareOperationRendering } from './prepareOperationRendering';
import { DEFAULT_TIMEOUT_SECONDS, TimeoutContext, TimeoutError } from './timeout';


/**
 * Handle agent_action_execute request from backend.
 * Executes the action and returns the result.
 *
 * Timeout handling:
 * - Uses timeout_seconds from request (default: 25s), measured from when this
 *   handler started. It bounds the executor's own work, not the request's age:
 *   the backend keeps waiting on a request it can see is being worked (acks
 *   and keepalives), so time spent queued behind other executes is not the
 *   executor's to spend, and charging it here would abort work the backend
 *   still wants — the more so because executes are serialized.
 * - Uses cooperative cancellation via AbortController so executors
 *   check the signal before irreversible operations (saves, transactions).
 *   Hitting the deadline therefore means the change did not land, which is
 *   what makes this a better answer than the backend's own give-up.
 * - Returns detailed diagnostics on timeout
 * - Merges `queued_ms` / `total_ms` into the response timing, both measured
 *   from socket receipt, so slow executes can still be attributed to queueing
 *   versus the executor itself.
 */
export async function executeRequest(
    request: ActionExecuteRequest,
    context?: AgentDataRequestContext,
): Promise<WSAgentActionExecuteResponse> {
    const rawTimeout = request.timeout_seconds;
    const timeoutSeconds = (typeof rawTimeout === 'number' && rawTimeout > 0)
        ? rawTimeout
        : DEFAULT_TIMEOUT_SECONDS;
    // The deadline runs from here; the receipt time only measures the wait.
    const startTime = Date.now();
    const receivedAt = context?.receivedAt ?? startTime;
    const queuedMs = Math.max(0, startTime - receivedAt);

    logger(`handleAgentActionExecuteRequest: Executing ${request.action_type} with timeout ${timeoutSeconds}s (queued ${queuedMs}ms)`, 1);

    const controller = new AbortController();
    const timers = typeof ChromeUtils !== 'undefined'
        ? ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs')
        : { setTimeout, clearTimeout };
    const timer = timers.setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    const withTiming = (result: WSAgentActionExecuteResponse): WSAgentActionExecuteResponse => ({
        ...result,
        timing: {
            ...result.timing,
            queued_ms: queuedMs,
            total_ms: Date.now() - receivedAt,
        },
    });

    try {
        const ctx: TimeoutContext = {
            signal: controller.signal,
            assertCurrent: context?.assertCurrent,
            timeoutSeconds,
            startTime,
            reportPhase: context?.reportPhase,
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
        } else if (request.action_type === 'edit_note') {
            result = await executeEditNoteAction(request, ctx);
        } else if (request.action_type === 'edit_note_batch') {
            result = await executeEditNoteBatchAction(request, ctx);
        } else if (request.action_type === 'create_note') {
            result = await executeCreateNoteAction(request, ctx);
        } else if (request.action_type === 'create_highlight_annotations') {
            result = await executeCreateHighlightAnnotationsAction(request, ctx);
        } else if (request.action_type === 'create_note_annotations') {
            result = await executeCreateNoteAnnotationsAction(request, ctx);
        } else if (request.action_type === 'edit_annotations') {
            result = await executeEditAnnotationsAction(request, ctx);
        } else if (request.action_type === 'manage_tags') {
            result = await executeManageTagsAction(request, ctx);
        } else if (request.action_type === 'manage_collections') {
            result = await executeManageCollectionsAction(request, ctx);
        } else {
            return {
                type: 'agent_action_execute_response',
                request_id: request.request_id,
                success: false,
                error: `Unsupported action type: ${request.action_type}`,
                error_code: 'unsupported_action_type',
            };
        }

        return withTiming(result);
    } catch (error) {
        const elapsedMs = Date.now() - startTime;

        if (error instanceof TimeoutError) {
            logger(`handleAgentActionExecuteRequest: Timeout after ${error.elapsedMs}ms in phase '${error.phase}'`, 1);
            return withTiming({
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
            });
        }

        logger(`handleAgentActionExecuteRequest: Error after ${elapsedMs}ms: ${error}`, 1);
        return withTiming({
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
        });
    } finally {
        timers.clearTimeout(timer);
    }
}

/** Queue the entire operation so its reads see the preceding writer's committed state. */
export async function handleAgentActionExecuteRequest(
    request: ActionExecuteRequest,
    context?: AgentDataRequestContext,
): Promise<WSAgentActionExecuteResponse> {
    const receivedAt = context?.receivedAt ?? Date.now();
    const generation = request.operation?.accountGeneration ?? Zotero.Beaver.account?.getGeneration();
    const assertCurrent = () => {
        if (generation !== Zotero.Beaver.account?.getGeneration()) throw Object.assign(new Error('Account changed'), { code: 'account_changed' });
        if (context?.signal?.aborted) throw Object.assign(new Error('Operation cancelled'), { code: 'operation_cancelled' });
        context?.assertCurrent?.();
    };
    try {
        const operation = await prepareOperationRendering(request.action_type, request.action_data, request.operation);
        return await Zotero.Beaver.libraryOperations.run('executeRequest', [{ ...request, operation }, { ...context, assertCurrent, receivedAt, reportPhase: context?.reportPhase ?? (() => {}) }], {
            signal: context?.signal,
            owner: context?.owner,
            assertCurrent,
        });
    } catch (error) {
        return {
            type: 'agent_action_execute_response', request_id: request.request_id,
            success: false, error: String(error),
            error_code: (error as { code?: string }).code ?? 'execution_failed',
        };
    }
}
