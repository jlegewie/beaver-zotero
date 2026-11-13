/**
 * The thread's open parked run: a run that ended waiting on cards the user
 * has not answered yet.
 *
 * A run is open while it is the thread's last run with a transcript and has a
 * `parked` record, the same rule the backend routes requests by. Each answer
 * resumes it: the answered call finishes, and a call still open parks again
 * in the resume run, which then becomes the open parked run. A normal message
 * instead closes every open call as not answered.
 *
 * Derived from the runs rather than stored, so it follows every change to
 * them: a resume that parks again, a retry that truncates, a reload.
 */

import { atom } from 'jotai/vanilla';
import { isRunActive } from '../agents/types';
import type { AgentRun, ParkedDeferral } from '../agents/types';
import type { WSAskUserQuestionRequest, WSBatchApprovalRequest, WSDeferredApprovalRequest } from '../protocol/agentProtocol';
import type { WSTableCardRequest } from '../protocol/tableCardProtocol';
import { allRunsAtom, mergeRunToolResults, toolResultsMapAtom, type ToolResult } from './atoms';

/** The `ParkedRun.version` this client reads. */
export const PARKED_RUN_VERSION = 1;

export interface OpenParkedRun {
    /** The run an answer resumes (`resumes_run_id`). */
    runId: string;
    threadId: string | null;
    /** The cards still open, in call order. */
    deferrals: readonly ParkedDeferral[];
    toolCallIds: ReadonlySet<string>;
}

/** The open cards of a parked run, grouped by how the client shows them. */
export interface ParkedCardRequests {
    approvals: WSDeferredApprovalRequest[];
    questions: WSAskUserQuestionRequest[];
    batchApprovals: WSBatchApprovalRequest[];
    tableCards: WSTableCardRequest[];
}

function isReadableDeferral(value: unknown): value is ParkedDeferral {
    const deferral = value as ParkedDeferral | null;
    return !!deferral
        && typeof deferral.tool_call_id === 'string'
        && typeof deferral.kind === 'string'
        && !!deferral.request
        && typeof deferral.request === 'object';
}

/**
 * The open parked run of a thread's runs, or null when there is none.
 *
 * A run still in progress is passed over: while a resume runs, the run it
 * resumes keeps naming the cards that are still open. Calls that already
 * have a result anywhere in the thread are not open, whichever run carries
 * the result. `results` returns the thread's tool results by call id, when
 * the caller already has them; it is read only once a parked run is found.
 */
export function findOpenParkedRun(
    runs: readonly AgentRun[],
    results: () => ReadonlyMap<string, ToolResult> = () => mergeRunToolResults([...runs]),
): OpenParkedRun | null {
    for (let index = runs.length - 1; index >= 0; index--) {
        const run = runs[index];
        if (isRunActive(run) || !run.model_messages?.length) continue;
        const parked = run.parked;
        if (!parked || parked.version !== PARKED_RUN_VERSION || !Array.isArray(parked.requests)) return null;

        const answered = results();
        const deferrals = parked.requests.filter(
            (deferral) => isReadableDeferral(deferral) && !answered.has(deferral.tool_call_id),
        );
        if (deferrals.length === 0) return null;
        return {
            runId: run.id,
            threadId: run.thread_id,
            deferrals,
            toolCallIds: new Set(deferrals.map((deferral) => deferral.tool_call_id)),
        };
    }
    return null;
}

/** Group open cards by kind, leaving out any listed in `exclude`. */
export function parkedCardRequests(
    deferrals: readonly ParkedDeferral[],
    exclude: ReadonlySet<string> = new Set(),
): ParkedCardRequests {
    const requests: ParkedCardRequests = { approvals: [], questions: [], batchApprovals: [], tableCards: [] };
    for (const deferral of deferrals) {
        if (exclude.has(deferral.tool_call_id)) continue;
        const request = deferral.request;
        switch (deferral.kind) {
            case 'agent_action_approval':
                requests.approvals.push(request as WSDeferredApprovalRequest);
                break;
            case 'ask_user_question':
                requests.questions.push(request as WSAskUserQuestionRequest);
                break;
            case 'batch_approval':
                requests.batchApprovals.push(request as WSBatchApprovalRequest);
                break;
            case 'table_card':
                requests.tableCards.push(request as WSTableCardRequest);
                break;
        }
    }
    return requests;
}

function sameOpenParkedRun(a: OpenParkedRun, b: OpenParkedRun): boolean {
    if (a.runId !== b.runId || a.threadId !== b.threadId || a.deferrals.length !== b.deferrals.length) return false;
    return a.deferrals.every((deferral, index) => deferral === b.deferrals[index]);
}

/**
 * The open parked run of the open thread. Holds its previous value while the
 * open run and its cards are unchanged, so streaming does not re-render its
 * readers.
 */
let lastOpenParkedRun: OpenParkedRun | null = null;
export const openParkedRunAtom = atom<OpenParkedRun | null>((get) => {
    const open = findOpenParkedRun(get(allRunsAtom), () => get(toolResultsMapAtom));
    if (open && lastOpenParkedRun && sameOpenParkedRun(open, lastOpenParkedRun)) return lastOpenParkedRun;
    lastOpenParkedRun = open;
    return open;
});
