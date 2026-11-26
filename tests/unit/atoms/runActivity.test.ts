/**
 * Thread lists mark a chat by its run (a spinner while it runs, the dot while
 * it waits for the user, the backend's parked dot otherwise), and the thread
 * menu lists running chats first.
 */
import { describe, expect, it } from 'vitest';
import { listRunningFirst, threadRunStatus, threadRunStatusLabel } from '../../../react/atoms/runActivity';
import type { RunActivity } from '../../../src/services/agentRuns/runActivity';

const activity = (threadId: string, startedAt: number, awaiting: RunActivity['awaiting'] = null): RunActivity =>
    ({ threadId, sessionId: `s-${threadId}`, awaiting, startedAt });

describe('a chat\'s mark in a thread list', () => {
    it('spins while the chat\'s session runs, and shows the dot while it waits for the user', () => {
        expect(threadRunStatus(activity('t', 1))).toEqual({ kind: 'running' });
        expect(threadRunStatus(activity('t', 1, { ask_user_question: 1 }))).toEqual({ kind: 'awaiting', awaiting: { ask_user_question: 1 } });
        expect(threadRunStatusLabel(threadRunStatus(activity('t', 1)))).toBe('responding');
    });

    it('prefers the live session over the backend\'s parked dot, and shows that dot without one', () => {
        expect(threadRunStatus(activity('t', 1), { agent_action_approval: 1 })).toEqual({ kind: 'running' });
        expect(threadRunStatus(undefined, { agent_action_approval: 1 })).toEqual({ kind: 'awaiting', awaiting: { agent_action_approval: 1 } });
        expect(threadRunStatusLabel(threadRunStatus(undefined, { agent_action_approval: 1 }))).toBe('waiting for your approval');
        expect(threadRunStatus(undefined, null)).toBeNull();
    });
});

describe('the thread menu with chats running', () => {
    const thread = (id: string) => ({ id });
    const entities = new Map(['a', 'b', 'c', 'p'].map((id) => [id, thread(id)]));
    const pinned = [thread('p'), thread('x')];
    const groups = [{ label: 'Today', threads: [thread('a'), thread('b')] }, { label: 'Older', threads: [thread('c')] }];

    it('lists running chats first, most recently started first, each once', () => {
        const listed = listRunningFirst([activity('a', 1), activity('p', 3)], entities, pinned, groups);
        expect(listed.running.map((t) => t.id)).toEqual(['p', 'a']);
        // A pinned chat moves up while it runs.
        expect(listed.pinned.map((t) => t.id)).toEqual(['x']);
        expect(listed.groups.map((g) => [g.label, g.threads.map((t) => t.id)])).toEqual([['Today', ['b']], ['Older', ['c']]]);
    });

    it('drops a group the running chats empty, and keeps the list as it is with nothing running', () => {
        expect(listRunningFirst([activity('c', 1)], entities, pinned, groups).groups.map((g) => g.label)).toEqual(['Today']);
        const idle = listRunningFirst([], entities, pinned, groups);
        expect(idle.running).toEqual([]);
        expect(idle.pinned).toEqual(pinned);
        expect(idle.groups).toEqual(groups);
    });

    it('leaves out a running chat the list does not know or does not show', () => {
        const listed = listRunningFirst([activity('unknown', 2), activity('b', 1), { ...activity('a', 3), threadId: null }], entities, pinned, groups, (t) => t.id !== 'b');
        expect(listed.running).toEqual([]);
    });
});
