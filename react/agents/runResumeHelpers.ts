import type { AgentRun } from './types';
import type { WSErrorEvent } from '../../src/services/agentProtocol';

export function appendRunIfMissing(runs: AgentRun[], run: AgentRun): AgentRun[] {
    return runs.some(existing => existing.id === run.id) ? runs : [...runs, run];
}

/**
 * The run, if any, that the backend may still be finalizing after an
 * interruption — returned as an id, or null when there is nothing to wait for.
 *
 * Only the newest run can qualify. Runs are ordered oldest-first, so an
 * `in_progress` run with anything after it was abandoned: a later run could not
 * have started while it was still going. The last one is genuinely ambiguous,
 * because the row is created `in_progress` and stays that way for as long as
 * the save takes.
 */
export function runAwaitingFinalization(runs: AgentRun[]): string | null {
    const newest = runs[runs.length - 1];
    return newest?.status === 'in_progress' ? newest.id : null;
}

/**
 * Replace a run in place, matched by id.
 *
 * Unlike `appendRunIfMissing` this NEVER appends. A run that is no longer in
 * the list was truncated away — by a regenerate or a resume, both of which
 * slice the tail off `threadRunsAtom` — and putting it back would resurrect a
 * turn the user deliberately discarded.
 */
export function replaceRunById(runs: AgentRun[], run: AgentRun): AgentRun[] {
    let found = false;
    const next = runs.map(existing => {
        if (existing.id !== run.id) return existing;
        found = true;
        return run;
    });
    return found ? next : runs;
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
