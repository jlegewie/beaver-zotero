import type { AgentRun } from './types';
import type { WSErrorEvent } from '../../src/services/agentProtocol';

export function appendRunIfMissing(runs: AgentRun[], run: AgentRun): AgentRun[] {
    return runs.some(existing => existing.id === run.id) ? runs : [...runs, run];
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
