import { atom } from 'jotai/vanilla';
import type { AgentRun } from '../agents/types';
import { isInterruptedRun } from './runResumeHelpers';
import {
    RUN_CONTINUED_UNTIL_STOP_NOTE,
    RUN_FINISHED_BEFORE_STOP_NOTE,
    RUN_FINISHED_WHILE_DISCONNECTED_NOTE,
} from '../transport/connectionFailure';

/**
 * How a run that lost its connection is resolved on screen, window-local and
 * never stored in history.
 *
 * When a run's reattach fails, the server usually knows within moments how it
 * ended: it finished, it was interrupted, or it is still running. Rather than
 * showing the connection error and replacing it seconds later, the run's card
 * shows a neutral "checking" state while the admission poller asks, for up to
 * `REATTACH_RESOLUTION_WINDOW_MS`.
 */

/** How long a failed reattach shows "checking" before falling back to the error. */
export const REATTACH_RESOLUTION_WINDOW_MS = 10_000;

/** A run whose reattach failed and whose outcome the server has yet to report. */
export interface ReattachResolution {
    threadId: string;
    runId: string;
    /** When the reattach failed (epoch ms). */
    since: number;
}

export const reattachResolutionAtom = atom<ReattachResolution | null>(null);

/**
 * What a failed reattach's card shows instead of the connection error:
 *
 * - `checking`: the server has not answered yet, for at most the window;
 * - `still_running`: the server reports the run still holding the chat.
 *
 * Null once the server cannot be reached, the window has passed without an
 * answer, or the run is not the one being resolved: the error card then
 * stands, with its Retry.
 */
export type ReattachResolutionView = 'checking' | 'still_running' | null;

export function reattachResolutionView(args: {
    resolution: ReattachResolution | null;
    runId: string;
    currentThreadId: string | null;
    /** The server's last word on the open chat's activity, if it is about this chat. */
    activityState: string | null;
    /** The run holding the chat's reservation, when the server names one. */
    activityRunId?: string | null;
    unreachable: boolean;
    now: number;
}): ReattachResolutionView {
    const { resolution } = args;
    if (!resolution || resolution.runId !== args.runId || resolution.threadId !== args.currentThreadId) {
        return null;
    }
    if (args.unreachable) return null;
    // Only this run's own reservation means it is still running: another
    // client may have started a successor in the chat meanwhile.
    if (
        args.activityState === 'active' &&
        (args.activityRunId == null || args.activityRunId === resolution.runId)
    ) {
        return 'still_running';
    }
    return args.now - resolution.since < REATTACH_RESOLUTION_WINDOW_MS ? 'checking' : null;
}

/**
 * One-line notes on runs whose local copy the server's replaced with a
 * different outcome, keyed by run id. Shown for as long as the chat stays
 * open; cleared when the window navigates.
 */
export const runReplacementNotesAtom = atom<ReadonlyMap<string, string>>(new Map());

/**
 * Notes for runs whose saved copy differs from what this window showed:
 *
 * - shown as failed or stopped, saved as completed: the local copy said the
 *   answer was lost, the saved one has it;
 * - stopped, and saved as stopped with more text: a stop held while the run
 *   reconnected reached the server only after it had written further.
 */
export function replacementNotes(local: readonly AgentRun[], saved: readonly AgentRun[]): Map<string, string> {
    const localById = new Map(local.map((run) => [run.id, run]));
    const notes = new Map<string, string>();
    for (const run of saved) {
        const before = localById.get(run.id);
        if (run.status === 'completed') {
            if (before?.status === 'canceled') {
                notes.set(run.id, RUN_FINISHED_BEFORE_STOP_NOTE);
            } else if (before?.status === 'error' && before.error?.type === 'connection_error') {
                notes.set(run.id, RUN_FINISHED_WHILE_DISCONNECTED_NOTE);
            }
        } else if (
            run.status === 'canceled' &&
            run.error?.reason_code === 'client_cancel' &&
            before?.status === 'canceled' &&
            responseTextLength(run) > responseTextLength(before)
        ) {
            notes.set(run.id, RUN_CONTINUED_UNTIL_STOP_NOTE);
        }
    }
    return notes;
}

/** Characters of answer text in a run's model responses. */
function responseTextLength(run: AgentRun): number {
    let length = 0;
    for (const message of run.model_messages ?? []) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind === 'text') length += part.content.length;
        }
    }
    return length;
}

/**
 * Whether a run was cut off while writing, so its last text may stop
 * mid-thought. Not one cut off at a tool call: its text above was complete.
 */
export function isCutOffMidText(run: AgentRun): boolean {
    if (!isInterruptedRun(run)) return false;
    for (let i = run.model_messages.length - 1; i >= 0; i--) {
        const message = run.model_messages[i];
        if (message.kind !== 'response') continue;
        for (let j = message.parts.length - 1; j >= 0; j--) {
            const part = message.parts[j];
            if (part.part_kind === 'tool-call') return false;
            if (part.part_kind === 'text' && part.content.trim() !== '') return true;
        }
    }
    return false;
}
