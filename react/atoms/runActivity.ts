/**
 * The instance's chats with a run going, as this window's thread lists show
 * them: a spinner while a response is going, the awaiting-input dot while it
 * waits for the user. Projected from `addon.agentRuns`
 * (`react/runtime/runActivityProjection.ts`).
 */

import { atom, useAtomValue } from 'jotai';
import type { RunActivity } from '../../src/services/agentRuns/runActivity';
import { awaitingInputLabel, type AwaitingInput } from '../../src/services/threads/awaitingInput';

export const runActivityAtom = atom<readonly RunActivity[]>([]);

/** The activity of each chat with a run going, by thread id. */
export const runActivityByThreadAtom = atom((get) => {
    const byThread = new Map<string, RunActivity>();
    for (const entry of get(runActivityAtom)) if (entry.threadId) byThread.set(entry.threadId, entry);
    return byThread;
});

/** What a thread list row shows about a chat's run. */
export type ThreadRunStatus =
    | { kind: 'running' }
    | { kind: 'awaiting'; awaiting: AwaitingInput };

/**
 * The run status of a chat in a thread list: its live session's while it has
 * one, else what the backend reports of a parked run (`awaiting_input`).
 */
export function threadRunStatus(activity: RunActivity | undefined, awaitingInput?: AwaitingInput | null): ThreadRunStatus | null {
    if (activity) return activity.awaiting ? { kind: 'awaiting', awaiting: activity.awaiting } : { kind: 'running' };
    return awaitingInput ? { kind: 'awaiting', awaiting: awaitingInput } : null;
}

/** `threadRunStatus` of a row, following the activity. */
export function useThreadRunStatus(threadId: string, awaitingInput?: AwaitingInput | null): ThreadRunStatus | null {
    return threadRunStatus(useAtomValue(runActivityByThreadAtom).get(threadId), awaitingInput);
}

/**
 * A thread list with the chats that have a live session listed first, most
 * recently started first, ahead of the pinned chats. Each chat is listed
 * once: it leaves its usual group while its session lives. A running chat the
 * list does not know (`entities` lacks it) is left out.
 */
export function listRunningFirst<T extends { id: string }, G extends { threads: T[] }>(
    activity: readonly RunActivity[],
    entities: ReadonlyMap<string, T>,
    pinned: readonly T[],
    groups: readonly G[],
    include: (thread: T) => boolean = () => true,
): { running: T[]; pinned: T[]; groups: G[] } {
    const running = [...activity]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((entry) => (entry.threadId ? entities.get(entry.threadId) : undefined))
        .filter((thread): thread is T => !!thread && include(thread));
    if (running.length === 0) return { running, pinned: [...pinned], groups: [...groups] };
    const ids = new Set(running.map((thread) => thread.id));
    return {
        running,
        pinned: pinned.filter((thread) => !ids.has(thread.id)),
        groups: groups
            .map((group) => ({ ...group, threads: group.threads.filter((thread) => !ids.has(thread.id)) }))
            .filter((group) => group.threads.length > 0),
    };
}

/** The status for a row's accessible label, or '' when there is none. */
export function threadRunStatusLabel(status: ThreadRunStatus | null): string {
    if (!status) return '';
    return status.kind === 'running' ? 'responding' : awaitingInputLabel(status.awaiting).toLowerCase();
}
