import type { AgentRun, RunUsage } from '../agents/types';
import type { ContinuationOffer } from '../protocol/agentProtocol';
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
 * The offer to continue this run, or null when there is nothing to offer.
 *
 * The backend composes the offer and stores it on the run, so every kind of
 * unfinished run — a response cut off, a batch nobody approved in time —
 * arrives already worded. New kinds must never be added below; a kind the
 * backend does not send is a kind the user should not be offered.
 *
 * The fallback covers a cut-off run that reaches us WITHOUT an offer, which is
 * not the same as the backend declining to make one. That happens two ways,
 * and both still deserve the button: a run stored before the field existed,
 * and one whose terminal write shed the offer to get its status saved at all.
 * An absent offer and an explicit null therefore mean the same thing here on
 * purpose — the backend expresses "do not offer" by the run not being a
 * cut-off one (a stop the user chose is never `INTERRUPTED_REASON_CODES`), not
 * by nulling a field the fallback can see past.
 */
export function continuationOfferFor(
    run: AgentRun | null | undefined,
): ContinuationOffer | null {
    if (!run) return null;
    if (run.continuation) return run.continuation;
    if (!isInterruptedRun(run)) return null;
    return {
        kind: 'interrupted',
        title: 'Response interrupted',
        message: legacyInterruptionText(run.error?.reason_code),
        continue_label: 'Continue response',
        allow_message: false,
    };
}

/** Copy for interrupted runs stored before the backend composed it. */
function legacyInterruptionText(reasonCode?: string): string {
    switch (reasonCode) {
        case 'connection_lost':
            return 'The connection dropped before this response finished. Continuing picks up where it left off.';
        case 'server_shutdown':
            return 'The server restarted before this response finished. Continuing picks up where it left off.';
        case 'client_closed':
        default:
            return 'Beaver closed before this response finished. Continuing picks up where it left off.';
    }
}

/**
 * True when a later run continued this one, so this run's own error card,
 * footer and continue offer all give way to the continuation's — a run that
 * was picked up is not one the reader acts on.
 *
 * Only a run that could be continued qualifies: a failed one, or one carrying
 * an offer. Any other run sharing its id with a `resumes_run_id` is a data
 * error, not a continuation.
 */
export function wasRunContinued(
    run: AgentRun,
    resumedRunIds: ReadonlySet<string>,
): boolean {
    if (!resumedRunIds.has(run.id)) return false;
    return run.status === 'error' || continuationOfferFor(run) !== null;
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
    return continuationOfferFor(run) !== null;
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
 * The runs that make up one answer, oldest first: the run that started it, the
 * run that continued it, and so on up to `run`.
 *
 * Resume runs carry `is_resume: true` and `resumes_run_id` pointing at the run
 * they continued, and their own `user_prompt.content` is empty. On screen the
 * whole chain reads as a single response, so anything describing that response
 * — its text, its citations, its cost, the question that produced it — has to
 * be gathered across the chain rather than taken from its last run.
 *
 * A run that continued nothing yields just itself. Guards against cycles by
 * tracking visited run IDs.
 */
export function collectResumeChain(run: AgentRun, allRuns: AgentRun[]): AgentRun[] {
    const chain: AgentRun[] = [run];
    const visited = new Set<string>([run.id]);
    let current = run;
    while (current.user_prompt.is_resume && current.user_prompt.resumes_run_id) {
        const parent = allRuns.find(r => r.id === current.user_prompt.resumes_run_id);
        if (!parent || visited.has(parent.id)) break;
        visited.add(parent.id);
        chain.push(parent);
        current = parent;
    }
    return chain.reverse();
}

/**
 * Walk the resume chain back to the root run (the first non-resume run).
 *
 * When retrying from a resume run we want to regenerate from the original user
 * message, not from an intermediate resume prompt (whose content is empty).
 */
export function findResumeChainRoot(run: AgentRun, allRuns: AgentRun[]): AgentRun {
    return collectResumeChain(run, allRuns)[0];
}

/** The numeric totals of `RunUsage`, all summed the same way. */
const RUN_USAGE_TOTALS = [
    'requests',
    'tool_calls',
    'input_tokens',
    'cache_write_tokens',
    'cache_read_tokens',
    'input_audio_tokens',
    'cache_audio_read_tokens',
    'output_tokens',
] as const;

/**
 * What a whole answer cost, across every run that produced it.
 *
 * Returns nulls when no run in the chain reported the figure, which is what
 * callers gate their display on — a run that was cut off before it finished
 * reports neither.
 */
export function sumChainUsage(runs: AgentRun[]): { usage: RunUsage | null; cost: number | null } {
    const withUsage = runs.filter(run => run.total_usage);
    const costs = runs
        .map(run => run.total_cost)
        .filter((cost): cost is number => typeof cost === 'number');

    const cost = costs.length ? costs.reduce((total, next) => total + next, 0) : null;
    if (!withUsage.length) return { usage: null, cost };

    const usage = { ...withUsage[0].total_usage } as RunUsage;
    for (const key of RUN_USAGE_TOTALS) {
        usage[key] = withUsage.reduce((total, run) => total + (run.total_usage?.[key] ?? 0), 0);
    }

    const modelRequests = withUsage.flatMap(run => run.total_usage?.model_requests ?? []);
    if (modelRequests.length) usage.model_requests = modelRequests;

    const details = withUsage.reduce<Record<string, number>>((merged, run) => {
        for (const [key, value] of Object.entries(run.total_usage?.details ?? {})) {
            merged[key] = (merged[key] ?? 0) + value;
        }
        return merged;
    }, {});
    if (Object.keys(details).length) usage.details = details;

    return { usage, cost };
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
