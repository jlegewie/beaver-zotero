import { atom } from "jotai/vanilla";
import { logger } from "../platform/logger";
import {
    AgentRun,
    ModelMessage,
    ModelRequest,
    ToolReturnPart,
    ToolCallPart,
    TextPart,
    ThinkingPart,
    RetryPromptPart,
    AgentRunStatus,
    isRunActive,
    isUnsuccessfulToolReturn,
} from "../agents/types";
import {
    WSPartEvent,
    WSToolReturnEvent,
    WSRunCompleteEvent,
    WSToolCallProgressEvent,
    WSToolCallArgsStreamEvent,
} from "../protocol/agentProtocol";
import { MessageAttachment, messageAttachmentKey, messageAttachmentsHaveSameIdentity } from "../types/attachments/apiTypes";

// =============================================================================
// Core Atoms
// =============================================================================

/** All completed runs for the thread (loaded from DB or finished streaming) */
export const threadRunsAtom = atom<AgentRun[]>([]);

/** The currently streaming run (null when not streaming) */
export const activeRunAtom = atom<AgentRun | null>(null);

/**
 * ID of the thread the runs above belong to (null before a thread is opened).
 * Lives here with the run state so run-state code has no dependency on the
 * thread module; a client may re-export it from its own thread module.
 */
export const currentThreadIdAtom = atom<string | null>(null);

/** Display name of the open thread (null when it has none yet). */
export const currentThreadNameAtom = atom<string | null>(null);

/** True while a thread's history is being loaded. */
export const isLoadingThreadAtom = atom<boolean>(false);

// =============================================================================
// Derived Atoms
// =============================================================================

/** Combined view for rendering - use this in components */
export const allRunsAtom = atom((get) => {
    const completed = get(threadRunsAtom);
    const active = get(activeRunAtom);
    return active ? [...completed, active] : completed;
});

/** Set of run IDs that were resumed (for hiding error runs that were resumed) */
export const resumedRunIdsAtom = atom((get) => {
    const runs = get(allRunsAtom);
    const resumedIds = new Set<string>();
    
    for (const run of runs) {
        if (run.user_prompt.is_resume && run.user_prompt.resumes_run_id) {
            resumedIds.add(run.user_prompt.resumes_run_id);
        }
    }
    
    return resumedIds;
});

/** Total number of runs in the thread */
export const runsCountAtom = atom((get) => get(allRunsAtom).length);

/**
 * Whether Beaver is still generating in the open thread.
 *
 * A failed or canceled run can sit in `activeRunAtom` (no terminal `done`
 * archives it), so presence of an active run is not the same as streaming.
 * See `isRunActive`.
 */
export const isStreamingAtom = atom((get) => isRunActive(get(activeRunAtom)));

/** Quick lookup of tool results by tool_call_id */
export const toolResultsMapAtom = atom((get) => {
    const runs = get(allRunsAtom);
    const map = new Map<string, (ToolReturnPart | RetryPromptPart)>();

    for (const run of runs) {
        for (const msg of run.model_messages) {
            if (msg.kind === 'request') {
                for (const part of msg.parts) {
                    // Allowlist, not a filter: request messages also carry
                    // model-facing user-prompt parts that must not reach the UI
                    // (see `isRenderableMessage`). Only add a part kind here
                    // after deciding it is displayable.
                    if (part.part_kind === 'tool-return' || part.part_kind === 'retry-prompt') {
                        map.set(part.tool_call_id, part as ToolReturnPart | RetryPromptPart);
                    }
                }
            }
        }
    }

    return map;
});

/**
 * Map of user attachments in all runs, keyed by the canonical
 * messageAttachmentKey. Identity comparison falls back to numeric IDs when a
 * pre-library_ref record is involved, while distinct portable refs stay apart.
 */
export const allUserAttachmentsAtom = atom((get) => {
    const runs = get(allRunsAtom);
    const attachmentsMap = new Map<string, MessageAttachment>();

    for (const run of runs) {
        const runAttachments = run.user_prompt.attachments || [];
        for (const attachment of runAttachments) {
            const matchingEntry = Array.from(attachmentsMap.entries()).find(
                ([, existing]) =>
                    messageAttachmentsHaveSameIdentity(existing, attachment)
            );
            if (matchingEntry) {
                const [existingKey, existing] = matchingEntry;
                const existingHasPortableRef =
                    'library_ref' in existing && Boolean(existing.library_ref);
                const attachmentHasPortableRef =
                    'library_ref' in attachment && Boolean(attachment.library_ref);

                // A legacy record may appear first in persisted history. Replace
                // it with the portable representative so thread-level identity
                // remains stable when local library IDs differ across devices.
                if (!existingHasPortableRef && attachmentHasPortableRef) {
                    attachmentsMap.delete(existingKey);
                    attachmentsMap.set(messageAttachmentKey(attachment), attachment);
                }
                continue;
            }
            attachmentsMap.set(messageAttachmentKey(attachment), attachment);
        }
    }

    return attachmentsMap;
});

/** Set of canonical identity keys for all deduplicated thread attachments. */
export const allUserAttachmentKeysAtom = atom((get) => {
    const attachmentsMap = get(allUserAttachmentsAtom);
    return new Set(Array.from(attachmentsMap.values()).map(messageAttachmentKey));
});


// =============================================================================
// Retry and Reconnect State
// =============================================================================

/*
 * Two unrelated things can be happening while a run is in trouble, and a third
 * thing shares their name:
 *
 * - `wsReconnectingAtom` — *this client* is quietly retrying a connect attempt
 *   that failed before the run started. Nothing has been reported to the reader,
 *   and if the next attempt succeeds nothing ever will be.
 * - `wsRetryAtom` — the *backend* is retrying a failed model request and keeping
 *   the run alive. The connection is fine; the run is waiting on the server.
 * - The Retry button a reader presses on a run that already failed is neither of
 *   these: it starts a new run and writes nothing here.
 */

/**
 * The backend is retrying a failed model request while keeping the run alive.
 *
 * Written from the `retry` wire event, so it describes work happening on the
 * server rather than anything this client is doing: the run has not ended and no
 * error is being reported.
 *
 * It is not self-clearing, and a client that renders it owes it two things: a
 * clear when the run it names ends, and a `runId` match before showing it — the
 * backend can emit a retry for a run the client has already stopped waiting on.
 */
export interface RetryState {
    /** The run being retried. A renderer must match on this before showing it. */
    runId: string;
    attempt: number;
    maxAttempts: number;
    /** Why the previous attempt failed, as the backend describes it. */
    reason: string;
    /** How long the backend waits before the next attempt, when it says. */
    waitSeconds?: number | null;
}

/** The backend retry in progress, or null when the backend is not retrying. */
export const wsRetryAtom = atom<RetryState | null>(null);

/**
 * This client is retrying its own failed connect attempt, before the run has
 * started and before anything reaches the reader as an error.
 *
 * Written from the shared connect-retry loop's `onRetrying` callback, which
 * guarantees a final `null` on every exit — so a client that renders
 * "Reconnecting…" from this can never be left showing a reconnect that is over.
 */
export interface ReconnectState {
    /** The attempt about to be made, out of `maxAttempts`. */
    attempt: number;
    maxAttempts: number;
}

/** The connect attempt about to be retried, or null when none is. */
export const wsReconnectingAtom = atom<ReconnectState | null>(null);


// =============================================================================
// Helper Functions
// =============================================================================

export type ToolCallStatus = 'in_progress' | 'completed' | 'error';

/** Get the status of a tool call based on its result */
export function getToolCallStatus(
    toolCallId: string,
    resultsMap: Map<string, (ToolReturnPart | RetryPromptPart)>,
    runStatus?: AgentRunStatus
): ToolCallStatus {
    const result = resultsMap.get(toolCallId);
    if (!result && runStatus && runStatus === 'in_progress') return 'in_progress';
    if (!result) return 'error';

    // Two shapes reach here: a retry request (the model was asked to fix its
    // call) and a tool-return whose outcome is anything but success. Both mean
    // the call produced no usable result, which is what the user sees as an error.
    if (result.part_kind === 'retry-prompt' || isUnsuccessfulToolReturn(result)) {
        return 'error';
    }

    return 'completed';
}


// =============================================================================
// Run Update Helpers
// =============================================================================

/**
 * Ensure model_messages array has a ModelResponse at the given index.
 * Creates empty ModelResponse objects for any missing indices.
 */
function ensureModelResponse(messages: ModelMessage[], messageIndex: number, runId: string): ModelMessage[] {
    const result = [...messages];

    // Fill in any missing indices with empty ModelResponse
    while (result.length <= messageIndex) {
        result.push({
            kind: 'response',
            run_id: runId,
            parts: [],
        });
    }

    return result;
}

/**
 * Ensure model_messages array has a ModelRequest at the given index.
 * Creates empty ModelRequest objects for any missing indices.
 */
function ensureModelRequest(messages: ModelMessage[], messageIndex: number, runId: string): ModelMessage[] {
    const result = [...messages];

    // Fill in any missing indices
    while (result.length <= messageIndex) {
        result.push({
            kind: 'request',
            run_id: runId,
            parts: [],
            instructions: '',
        });
    }

    // Ensure the target index is a ModelRequest
    if (result[messageIndex].kind !== 'request') {
        result[messageIndex] = {
            kind: 'request',
            run_id: runId,
            parts: [],
            instructions: '',
        };
    }

    return result;
}

/**
 * Update an AgentRun with a part event.
 * Parts are accumulated content (not deltas), so we replace the part at the given index.
 */
export function updateRunWithPart(run: AgentRun, event: WSPartEvent): AgentRun {
    // Ensure we have a ModelResponse at message_index
    const messages = ensureModelResponse(run.model_messages, event.message_index, event.run_id);

    // Get the message and ensure it's a ModelResponse
    const message = messages[event.message_index];
    if (message.kind !== 'response') {
        // This shouldn't happen for part events, but handle gracefully
        logger('Part event received for non-response message', 1);
        return run;
    }

    // Update the part at part_index, preserving client-side streaming_args
    const parts = [...message.parts];
    let newPart = event.part as TextPart | ThinkingPart | ToolCallPart;
    const existingPart = parts[event.part_index];
    if (
        newPart.part_kind === 'tool-call' &&
        existingPart?.part_kind === 'tool-call' &&
        existingPart.streaming_args
    ) {
        newPart = { ...newPart, streaming_args: existingPart.streaming_args };
    }
    parts[event.part_index] = newPart;

    // Update the message
    messages[event.message_index] = {
        ...message,
        parts,
    };

    return {
        ...run,
        model_messages: messages,
    };
}

/**
 * Update an AgentRun with a tool return event.
 * Tool returns go into a ModelRequest message.
 */
export function updateRunWithToolReturn(run: AgentRun, event: WSToolReturnEvent): AgentRun {
    // Ensure we have a ModelRequest at message_index
    const messages = ensureModelRequest(run.model_messages, event.message_index, event.run_id);

    // Get the message (should be a ModelRequest now)
    const message = messages[event.message_index] as ModelRequest;

    // Add the tool return part
    // Multiple tool returns can go into the same message (parallel tool calls)
    const parts = [...message.parts, event.part];

    messages[event.message_index] = {
        ...message,
        parts,
    };

    return {
        ...run,
        model_messages: messages,
    };
}

/**
 * Update an AgentRun with a tool call progress event.
 * Tool call progress goes into a ToolCallPart.
 */
export function updateRunWithToolCallProgress(run: AgentRun, event: WSToolCallProgressEvent): AgentRun {
    // Find the response message containing this tool call
    for (let i = 0; i < run.model_messages.length; i++) {
        const message = run.model_messages[i];
        if (message.kind === 'response') {
            const toolCallPart = message.parts.find(
                part => part.part_kind === 'tool-call' && part.tool_call_id === event.tool_call_id
            ) as ToolCallPart | undefined;
            
            if (toolCallPart) {                
                // Create new parts array with updated tool call
                const newParts = message.parts.map(part => 
                    part.part_kind === 'tool-call' && part.tool_call_id === event.tool_call_id
                        ? { ...part, progress: event.progress }
                        : part
                );
                
                // Create new messages array with updated message
                const newMessages = [...run.model_messages];
                newMessages[i] = { ...message, parts: newParts };
                
                return { ...run, model_messages: newMessages };
            }
        }
    }
    
    logger(`updateRunWithToolCallProgress: tool call ${event.tool_call_id} not found in any message`, 1);
    return run;
}

/**
 * Update an AgentRun with streaming tool call arguments.
 * Adds parsed partial args to the ToolCallPart for live preview.
 */
export function updateRunWithToolCallArgsStream(run: AgentRun, event: WSToolCallArgsStreamEvent): AgentRun {
    for (let i = 0; i < run.model_messages.length; i++) {
        const message = run.model_messages[i];
        if (message.kind === 'response') {
            const hasToolCall = message.parts.some(
                part => part.part_kind === 'tool-call' && part.tool_call_id === event.tool_call_id
            );
            if (hasToolCall) {
                const newParts = message.parts.map(part =>
                    part.part_kind === 'tool-call' && part.tool_call_id === event.tool_call_id
                        ? { ...part, streaming_args: event.args }
                        : part
                );
                const newMessages = [...run.model_messages];
                newMessages[i] = { ...message, parts: newParts };
                return { ...run, model_messages: newMessages };
            }
        }
    }
    return run;
}

/**
 * Update an AgentRun when the run completes.
 */
export function updateRunComplete(run: AgentRun, event: WSRunCompleteEvent): AgentRun {
    return {
        ...run,
        status: 'completed',
        total_usage: event.usage ?? undefined,
        total_cost: event.cost ?? undefined,
        completed_at: new Date().toISOString(),
    };
}

/**
 * Reset run messages to initial state.
 * Used when a retry event requests a reset of streamed content.
 */
export function resetRunMessages(run: AgentRun): AgentRun {
    return {
        ...run,
        model_messages: [],
    };
}
