import type { AgentRun } from '../agents/types';
import type { WSErrorEvent } from '../protocol/agentProtocol';

export function appendRunIfMissing(runs: AgentRun[], run: AgentRun): AgentRun[] {
    return runs.some(existing => existing.id === run.id) ? runs : [...runs, run];
}

/**
 * A run that reached `completed` but never received its terminal `done`
 * event (the socket closed while run_complete post-processing was still
 * draining the message queue) lingers as the active run. Returns the run
 * to archive into thread history, or null when nothing needs finalizing.
 */
export function lingeringCompletedRun(activeRun: AgentRun | null): AgentRun | null {
    if (!activeRun || activeRun.status !== 'completed') return null;
    return {
        ...activeRun,
        completed_at: activeRun.completed_at || new Date().toISOString(),
    };
}

/**
 * Termination causes the backend records on a run it stopped because the
 * client went away, in `error.reason_code`. A user's own stop is
 * `client_cancel` and is deliberately absent: that run ended on purpose.
 */
const INTERRUPTED_REASON_CODES = new Set([
    'client_closed',
    'connection_lost',
    'server_shutdown',
]);

/**
 * True when a run was cut off rather than finished or deliberately stopped.
 *
 * The backend stores such a run as `canceled` with the cause in
 * `error.reason_code`, so its status alone cannot tell it apart from a run the
 * user stopped. Only a cut-off run is worth offering to continue.
 */
export function isInterruptedRun(run: AgentRun | null | undefined): boolean {
    if (!run || run.status !== 'canceled') return false;
    const reasonCode = run.error?.reason_code;
    return typeof reasonCode === 'string' && INTERRUPTED_REASON_CODES.has(reasonCode);
}

/**
 * True when a later run continued this one, so this run's own error card,
 * footer and resume offer all give way to the continuation's — a run that was
 * picked up is not one the reader acts on.
 *
 * Only a run that could be continued qualifies: a failed one, or one that was
 * cut off. Any other run sharing its id with a `resumes_run_id` is a data
 * error, not a continuation.
 */
export function wasRunContinued(
    run: AgentRun,
    resumedRunIds: ReadonlySet<string>,
): boolean {
    if (!resumedRunIds.has(run.id)) return false;
    return run.status === 'error' || isInterruptedRun(run);
}

/**
 * Whether to offer to continue this run.
 *
 * Only the newest run: continuing an older one would pick up from a point the
 * conversation has already moved past. A run that has already been resumed is
 * continued by the run that followed it.
 */
export function shouldOfferResume(
    run: AgentRun,
    options: { isLastRun: boolean; resumedRunIds: ReadonlySet<string> },
): boolean {
    if (!options.isLastRun) return false;
    if (options.resumedRunIds.has(run.id)) return false;
    return isInterruptedRun(run);
}

export function findRunForResume(
    threadRuns: AgentRun[],
    activeRun: AgentRun | null,
    failedRunId: string,
): AgentRun | null {
    const threadRun = threadRuns.find(run => run.id === failedRunId);
    if (threadRun) {
        return threadRun;
    }
    if (activeRun?.id === failedRunId) {
        return activeRun;
    }
    return null;
}

export function resolveErrorRunId(
    event: WSErrorEvent,
    activeRun: AgentRun | null,
): string | null {
    return event.run_id || activeRun?.id || null;
}

/**
 * Walk the resume chain back to the root run (the first non-resume run).
 *
 * Resume runs carry `is_resume: true` and `resumes_run_id` pointing at the run
 * they resumed, and they have an empty `user_prompt.content`. When retrying
 * from a resume run we want to regenerate from the original user message, not
 * from an intermediate resume prompt — so walk the chain to its root.
 *
 * Guards against cycles by tracking visited run IDs.
 */
export function findResumeChainRoot(run: AgentRun, allRuns: AgentRun[]): AgentRun {
    let current = run;
    const visited = new Set<string>([current.id]);
    while (current.user_prompt.is_resume && current.user_prompt.resumes_run_id) {
        const parent = allRuns.find(r => r.id === current.user_prompt.resumes_run_id);
        if (!parent || visited.has(parent.id)) break;
        visited.add(parent.id);
        current = parent;
    }
    return current;
}

/**
 * Returns true when the failed run has received only thinking content so far —
 * no assistant text and no tool calls. Used to decide between auto-retry (safe
 * when nothing user-visible was produced) and auto-resume (continue from the
 * failure point).
 */
export function hasOnlyThinkingParts(run: AgentRun | null): boolean {
    if (!run) return false;
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'text' || part.part_kind === 'tool-call') {
                return false;
            }
        }
    }
    return true;
}

export function toRunError(event: WSErrorEvent): NonNullable<AgentRun['error']> {
    return {
        type: event.type,
        message: event.message,
        details: event.details,
        is_retryable: event.is_retryable,
        retry_after: event.retry_after,
        is_resumable: event.is_resumable,
        has_beaver_fallback: event.has_beaver_fallback,
    };
}
