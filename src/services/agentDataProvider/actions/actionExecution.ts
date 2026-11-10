/**
 * Shared plumbing for agent action executors.
 *
 * Each action type has one executor core, `apply<Action>(data, ctx, …)`, that
 * makes the Zotero change and returns the action's `result_data`, or throws.
 * Two callers reach it:
 *
 * - the backend over the socket, during a run (`execute<Action>Action`), which
 *   turns the outcome into an `agent_action_execute_response` with
 *   `toExecuteResponse` and runs against the request's deadline;
 * - the user's Apply on a stored action (`src/services/manualActions/*`), which
 *   adds the drift check against the proposal's baseline and runs with
 *   `unboundedExecutionContext()`.
 *
 * Both callers therefore make the same change and record the same
 * `result_data`, which undo and the backend's result builders read.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { ErrorCandidate, FrontendTimingMetadata, WSAgentActionExecuteResponse } from '@beaver/agent-core/protocol/agentProtocol';
import { createAbortController } from '../../../utils/abortController';
import { resolveLibraryRef, resolveWriteTargetLibrary, writeTargetLibraryError } from '../../../utils/libraryIdentity';
import { excludedLibraryUserMessage } from '../../../utils/libraryMessages';
import { TimeoutContext, TimeoutError } from '../timeout';
import { checkLibraryExcluded } from '../utils';

export interface ActionErrorExtras {
    /** Wording for the action card when `message`, written for the model, does not fit it. */
    userMessage?: string;
    errorCandidates?: ErrorCandidate[];
}

/**
 * An expected execute failure with a stable code.
 *
 * `message` is model-facing. `userMessage` replaces it on the action card
 * when the two differ (see `src/utils/userFacingError.ts`). `errorCandidates`
 * carries edit_note's ranked near-misses for an `old_string` that no longer
 * matches.
 */
export class ActionExecutionError extends Error {
    readonly code: string;
    readonly userMessage?: string;
    readonly errorCandidates?: ErrorCandidate[];

    constructor(code: string, message: string, extras: ActionErrorExtras = {}) {
        super(message);
        this.name = 'ActionExecutionError';
        this.code = code;
        if (extras.userMessage) this.userMessage = extras.userMessage;
        if (extras.errorCandidates?.length) this.errorCandidates = extras.errorCandidates;
    }
}

export function actionError(code: string, message: string, extras?: ActionErrorExtras): ActionExecutionError {
    return new ActionExecutionError(code, message, extras);
}

/**
 * The library a library-scoped action writes to, checked again at execution.
 *
 * A destructive write must carry an explicit target: a missing library is
 * refused rather than defaulting to the personal library, and a present but
 * invalid `library_ref` fails rather than falling back to a stale device-local
 * `library_id`. An excluded library is refused even when validation passed
 * earlier, since the action may have waited for approval in between.
 */
export function resolveActionWriteLibrary(data: { library_id?: number | null; library_ref?: string | null }): number {
    if ((!data.library_id || typeof data.library_id !== 'number') && !data.library_ref) {
        throw actionError('invalid_library_id', 'library_id missing or invalid in action_data');
    }
    const resolution = resolveWriteTargetLibrary({ library_id: data.library_id, library_ref: data.library_ref });
    if (!resolution.ok) {
        const { error, error_code } = writeTargetLibraryError(resolution);
        throw actionError(error_code, error);
    }
    assertLibraryNotExcluded(resolution.libraryID);
    return resolution.libraryID;
}

/** Refuse a write into a library the user excluded from Beaver. */
export function assertLibraryNotExcluded(libraryID: number): void {
    const excluded = checkLibraryExcluded(libraryID);
    if (excluded) {
        throw actionError('library_not_searchable', excluded.message, { userMessage: excludedLibraryUserMessage(libraryID) });
    }
}

/**
 * Refuse a reference into an excluded library, checked before the item is
 * looked up. A library not on this device is left to the caller's lookup.
 */
export function assertLibraryRefNotExcluded(ref: { library_id?: number | null; library_ref?: string | null }): void {
    const libraryID = resolveLibraryRef(ref);
    if (libraryID !== null) assertLibraryNotExcluded(libraryID);
}

/**
 * Context for an apply with no deadline: the user's Apply on a stored action.
 * `checkAborted` never fires on it. Only the socket path is bounded, because
 * the backend stops waiting for its answer.
 */
export function unboundedExecutionContext(): TimeoutContext {
    return {
        signal: createAbortController().signal,
        timeoutSeconds: Number.POSITIVE_INFINITY,
        startTime: Date.now(),
    };
}

/**
 * Run an executor core for the socket and wrap its outcome as the execute
 * response, with `timing()` (read after the core settles) attached when given.
 *
 * A `TimeoutError` propagates: the request handler answers it with its own
 * timing diagnostics. Any other unexpected error is reported with its message,
 * as `execution_failed` unless it carries its own `code`.
 */
export async function toExecuteResponse(
    requestId: string,
    logLabel: string,
    apply: () => Promise<object>,
    timing?: () => FrontendTimingMetadata,
): Promise<WSAgentActionExecuteResponse> {
    let response: WSAgentActionExecuteResponse;
    try {
        const resultData = await apply();
        response = {
            type: 'agent_action_execute_response',
            request_id: requestId,
            success: true,
            result_data: resultData as Record<string, any>,
        };
    } catch (error) {
        response = failureResponse(requestId, logLabel, error);
    }
    return timing ? { ...response, timing: timing() } : response;
}

/** The execute response for an error thrown by an executor core. */
export function failureResponse(requestId: string, logLabel: string, error: unknown): WSAgentActionExecuteResponse {
    if (error instanceof TimeoutError) throw error;
    if (error instanceof ActionExecutionError) {
        logger(`${logLabel}: ${error.code}: ${error.message}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: requestId,
            success: false,
            error: error.message,
            error_code: error.code,
            ...(error.errorCandidates ? { error_candidates: error.errorCandidates } : {}),
        };
    }
    logger(`${logLabel}: Failed: ${error}`, 1);
    const message = (error as Error | null)?.message;
    return {
        type: 'agent_action_execute_response',
        request_id: requestId,
        success: false,
        error: typeof message === 'string' ? message : String(error),
        error_code: (error as { code?: string } | null)?.code ?? 'execution_failed',
    };
}
