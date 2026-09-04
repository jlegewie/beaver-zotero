import { logger } from '@beaver/agent-core/platform/logger';
import { WSAgentActionExecuteRequest, WSAgentActionExecuteResponse } from '@beaver/agent-core/protocol/agentProtocol';
import type { AgentDataRequestContext } from '@beaver/agent-core/transport/agentDataDispatch';
import { TimeoutContext, DEFAULT_TIMEOUT_SECONDS } from './timeout';
import { TimeoutError } from './timeout';
import { executeEditNoteAction } from './actions/editNote';
import { executeEditNoteBatchAction } from './actions/editNoteBatch';
import { executeEditMetadataAction } from './actions/editMetadata';
import { executeOrganizeItemsAction } from './actions/organizeItems';
import { executeCreateNoteAction } from './actions/createNote';
import { executeManageTagsAction } from './actions/manageTags';
import { executeManageCollectionsAction } from './actions/manageCollections';
import { executeCreateCollectionAction } from './actions/createCollection';
import { executeCreateItemAction } from './actions/createItems';
import { executeCreateHighlightAnnotationsAction } from './actions/createHighlightAnnotations';
import { executeCreateNoteAnnotationsAction } from './actions/createNoteAnnotations';
import { executeEditAnnotationsAction } from './actions/editAnnotations';


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
export async function handleAgentActionExecuteRequest(
    request: WSAgentActionExecuteRequest,
    context?: Pick<AgentDataRequestContext, 'receivedAt' | 'reportPhase'>,
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
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

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
        clearTimeout(timer);
    }
}
