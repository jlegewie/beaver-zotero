/**
 * A window's copies of the session's chat state.
 *
 * The session's store is the authority. The window gets every change at once,
 * except streamed text, which it takes once per animation frame; any other
 * change brings the pending text with it. Values are shared, not copied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import type { AgentRun } from '@beaver/agent-core/agents/types';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { citationKeyToMarkerAtom, citationsAtom } from '@beaver/agent-core/citations/atoms';
import { pendingQuestionsAtom } from '@beaver/agent-core/run-state/pendingQuestions';
import type { Citation } from '@beaver/agent-core/types/citations';
import { attachRunProjection, type RunProjection } from '../../../react/runtime/runProjection';
import type { SessionStateAtom } from '../../../src/services/agentRuns/sessionState';

const ATOMS: ReadonlyArray<readonly [string, SessionStateAtom]> = [
    ['threadRuns', threadRunsAtom],
    ['activeRun', activeRunAtom],
    ['citations', citationsAtom],
    ['pendingQuestions', pendingQuestionsAtom],
];

/** A session's store, read by name as a window reads its session's port. */
function byName(store: ReturnType<typeof createStore>) {
    const atomOf = (name: string) => ATOMS.find(([entry]) => entry === name)![1];
    return {
        get: (name: string) => store.get(atomOf(name)),
        sub: (name: string, listener: () => void) => store.sub(atomOf(name), listener),
    };
}

/** A window whose animation frames only run when the test says so. */
function fakeWindow() {
    let armed: FrameRequestCallback | null = null;
    return {
        closed: false,
        requestAnimationFrame: (callback: FrameRequestCallback) => { armed = callback; return 1; },
        cancelAnimationFrame: () => { armed = null; },
        runFrame: () => { const callback = armed; armed = null; callback?.(0); },
    };
}

function run(id: string, status: AgentRun['status'], text?: string): AgentRun {
    return {
        id,
        thread_id: 'thread-1',
        status,
        user_prompt: { content: 'question', is_resume: false },
        model_messages: text === undefined ? [] : [{ kind: 'response', parts: [{ part_kind: 'text', content: text }] }],
    } as unknown as AgentRun;
}

function textOf(value: AgentRun | null): string | undefined {
    const message = value?.model_messages[0];
    if (!message || message.kind !== 'response') return undefined;
    const part = message.parts[0];
    return part?.part_kind === 'text' ? part.content : undefined;
}

describe('run projection', () => {
    let session: ReturnType<typeof createStore>;
    let view: ReturnType<typeof createStore>;
    let win: ReturnType<typeof fakeWindow>;
    let projection: RunProjection;

    beforeEach(() => {
        session = createStore();
        view = createStore();
        win = fakeWindow();
        projection = attachRunProjection(byName(session), view, ATOMS, () => win as unknown as Window);
    });

    afterEach(() => projection.detach());

    it('applies a change that is not streaming at once, sharing the value', () => {
        const runs = [run('run-0', 'completed')];
        session.set(threadRunsAtom, runs);

        expect(view.get(threadRunsAtom)).toBe(runs);
    });

    it('applies a new run at once', () => {
        session.set(activeRunAtom, run('run-1', 'in_progress'));

        expect(view.get(activeRunAtom)?.id).toBe('run-1');
    });

    it('shows streamed text on the next frame', () => {
        session.set(activeRunAtom, run('run-1', 'in_progress'));
        session.set(activeRunAtom, run('run-1', 'in_progress', 'Hel'));
        session.set(activeRunAtom, run('run-1', 'in_progress', 'Hello'));
        expect(textOf(view.get(activeRunAtom))).toBeUndefined();

        win.runFrame();
        expect(textOf(view.get(activeRunAtom))).toBe('Hello');
    });

    it('brings the pending text with a change that is not streaming', () => {
        session.set(activeRunAtom, run('run-1', 'in_progress'));
        session.set(activeRunAtom, run('run-1', 'in_progress', 'Half an answer'));

        session.set(pendingQuestionsAtom, new Map([['call-1', {} as never]]));

        expect(view.get(pendingQuestionsAtom).size).toBe(1);
        expect(textOf(view.get(activeRunAtom))).toBe('Half an answer');
    });

    it('applies a status change at once, with all its text', () => {
        session.set(activeRunAtom, run('run-1', 'in_progress'));
        session.set(activeRunAtom, run('run-1', 'in_progress', 'The whole'));
        session.set(activeRunAtom, run('run-1', 'completed', 'The whole answer.'));

        expect(view.get(activeRunAtom)?.status).toBe('completed');
        expect(textOf(view.get(activeRunAtom))).toBe('The whole answer.');
    });

    it('applies everything pending on flush', () => {
        session.set(activeRunAtom, run('run-1', 'in_progress'));
        session.set(activeRunAtom, run('run-1', 'in_progress', 'Hello'));

        projection.flush();
        expect(textOf(view.get(activeRunAtom))).toBe('Hello');
    });

    it('numbers citation markers in the window when citations arrive', () => {
        const citation = {
            run_id: 'run-1',
            requested_ref: { kind: 'external', source: 'openalex', external_id: 'W158378843' },
        } as unknown as Citation;
        session.set(citationsAtom, [citation]);

        expect(view.get(citationsAtom)).toEqual([citation]);
        expect(Object.keys(view.get(citationKeyToMarkerAtom)).length).toBeGreaterThan(0);
        expect(Object.keys(session.get(citationKeyToMarkerAtom))).toEqual([]);
    });

    it('reverts and reports a window write of session state', () => {
        session.set(threadRunsAtom, [run('run-0', 'completed')]);

        let reported: unknown;
        try {
            view.set(threadRunsAtom, []);
        } catch (error) {
            reported = error;
        }

        // The store gathers listener errors into one.
        const errors = (reported as AggregateError | undefined)?.errors ?? [reported];
        expect(String(errors[0])).toMatch(/wrote session state "threadRuns"/);
        expect(view.get(threadRunsAtom)).toBe(session.get(threadRunsAtom));
    });

    it('stops applying once detached', () => {
        projection.detach();
        session.set(threadRunsAtom, [run('run-0', 'completed')]);

        expect(view.get(threadRunsAtom)).toEqual([]);
    });

    it('starts from the session state it is attached to', () => {
        const later = createStore();
        const runs = [run('run-0', 'completed')];
        session.set(threadRunsAtom, runs);
        const attached = attachRunProjection(byName(session), later, ATOMS, () => null);

        expect(later.get(threadRunsAtom)).toBe(runs);
        attached.detach();
    });
});
