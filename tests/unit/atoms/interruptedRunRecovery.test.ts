/**
 * Waiting for a run the backend is still finalizing.
 *
 * The behaviour under test: a run that is `in_progress` when a thread opens is
 * not immediately rendered as an empty canceled turn. We wait a few times for
 * the backend's save to land, merge it in when it does, and fall back to the
 * old local cancel when it never does — without ever writing into a thread the
 * user has already navigated away from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

import type { AgentRun } from '../../../react/agents/types';
import type { AgentAction } from '../../../react/agents/agentActions';

const getRunMock = vi.fn();
vi.mock('../../../src/services/agentService', () => ({
    agentRunService: { getRun: (...args: unknown[]) => getRunMock(...args) },
    agentService: { cancel: vi.fn() },
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../react/agents/atoms', async () => {
    const { atom } = await import('jotai');
    return {
        threadRunsAtom: atom<unknown[]>([]),
        activeRunAtom: atom<unknown | null>(null),
    };
});

vi.mock('../../../react/agents/agentActions', async () => {
    const { atom } = await import('jotai');
    return {
        threadAgentActionsAtom: atom<unknown[]>([]),
        isCreateItemAgentAction: (action: any) => action?.action_type === 'create_item',
    };
});

const addExternalReferencesMock = vi.fn();
const checkExternalReferencesMock = vi.fn();
vi.mock('../../../react/atoms/externalReferences', async () => {
    const { atom } = await import('jotai');
    return {
        addExternalReferencesToMappingAtom: atom(null, (_get, _set, refs: unknown) =>
            addExternalReferencesMock(refs)
        ),
        checkExternalReferencesAtom: atom(null, (_get, _set, refs: unknown) =>
            checkExternalReferencesMock(refs)
        ),
    };
});

vi.mock('../../../react/atoms/citations', async () => {
    const { atom } = await import('jotai');
    return {
        citationsAtom: atom<unknown[]>([]),
        processCitationsAtom: atom(null, () => {}),
        mergePageLabelsByAttachmentIdAtom: atom(null, () => {}),
    };
});

// threads.ts imports this module back; mocking it keeps the real one (and the
// whole WS layer behind it) out of the test.
const reconcileToolcallIdsMock = vi.fn();
vi.mock('../../../react/atoms/threads', async () => {
    const { atom } = await import('jotai');
    return {
        currentThreadIdAtom: atom<string | null>(null),
        reconcileToolcallIds: (...args: unknown[]) => reconcileToolcallIdsMock(...args),
    };
});

const { processToolReturnResultsMock, loadItemDataForAgentActionsMock } = vi.hoisted(() => ({
    processToolReturnResultsMock: vi.fn(async () => {}),
    loadItemDataForAgentActionsMock: vi.fn(async () => {}),
}));

vi.mock('../../../react/agents/toolResultProcessing', () => ({
    processToolReturnResults: processToolReturnResultsMock,
}));

vi.mock('../../../react/compat/legacyToolResults', () => ({
    upgradeToolReturn: vi.fn(async () => {}),
}));

vi.mock('../../../react/utils/pageLabels', () => ({
    preloadPageLabelsForCitations: vi.fn(async () => new Map()),
}));

vi.mock('../../../react/utils/agentActionUtils', () => ({
    loadItemDataForAgentActions: loadItemDataForAgentActionsMock,
}));

const { recoverInterruptedRunAtom, recoveringRunIdsAtom, threadLoadGenerationAtom } = await import(
    '../../../react/atoms/interruptedRunRecovery'
);
const { threadRunsAtom, activeRunAtom } = await import('../../../react/agents/atoms');
const { threadAgentActionsAtom } = await import('../../../react/agents/agentActions');
const { citationsAtom } = await import('../../../react/atoms/citations');
const { currentThreadIdAtom } = await import('../../../react/atoms/threads');
const { ApiError } = await import('../../../react/types/apiErrors');

const THREAD_ID = 'thread-1';
const RUN_ID = 'run-1';

function makeRun(status: AgentRun['status'], overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id: RUN_ID,
        user_id: 'user-1',
        thread_id: THREAD_ID,
        agent_name: 'beaver',
        user_prompt: { content: 'Original question', is_resume: false },
        status,
        model_messages: [],
        created_at: new Date().toISOString(),
        consent_to_share: false,
        model_name: 'gpt-5',
        ...overrides,
    } as AgentRun;
}

/**
 * A fetch result carrying BOTH metadata channels, so the follow-up look does not
 * fire. Use in tests that are not about that follow-up. Both are needed: an
 * absent channel is indistinguishable from one still being written, so either
 * one missing keeps us looking.
 */
function makeFullySettledFetch() {
    return {
        run: makeRun('canceled', {
            metadata: { citations: [{ citation_id: 'c1' }] } as AgentRun['metadata'],
        }),
        agent_actions: [{ id: 'a1', run_id: RUN_ID }],
    };
}

function makeStore(runs: AgentRun[] = [makeRun('in_progress')]) {
    const store = createStore();
    store.set(currentThreadIdAtom, THREAD_ID);
    store.set(threadRunsAtom, runs);
    return store;
}

/**
 * Drive the loop's timers to completion without waiting in real time.
 *
 * Budget generously: the slowest path is four attempts that each burn the full
 * refetch timeout on top of their backoff, so a tight budget makes these tests
 * flaky whenever the jitter lands high.
 */
async function runTimers() {
    for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(5000);
    }
}

describe('recoverInterruptedRunAtom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    it('merges the partial answer once the backend has written it', async () => {
        const settled = makeRun('canceled', {
            model_messages: [
                { kind: 'response', parts: [{ part_kind: 'text', content: 'Partial answer' }] },
            ] as AgentRun['model_messages'],
            error: { type: 'canceled', message: 'Connection lost', reason_code: 'connection_lost' },
            metadata: { citations: [{ citation_id: 'c1' }] } as AgentRun['metadata'],
        });
        getRunMock
            .mockResolvedValueOnce({ run: makeRun('in_progress'), agent_actions: null })
            .mockResolvedValueOnce({ run: settled, agent_actions: null });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        const merged = store.get(threadRunsAtom)[0] as AgentRun;
        expect(merged.status).toBe('canceled');
        expect(merged.model_messages).toHaveLength(1);
        expect(store.get(citationsAtom)).toEqual([{ citation_id: 'c1', run_id: RUN_ID }]);
        expect(store.get(recoveringRunIdsAtom).size).toBe(0);
    });

    it('keeps the prompt the thread load already resolved', async () => {
        // The refetched run carries unenriched attachment stubs; the user's own
        // message cannot have changed, so the enriched one is kept.
        const settled = makeRun('canceled', {
            user_prompt: { content: 'Refetched, unenriched', is_resume: false },
        });
        getRunMock.mockResolvedValue({ run: settled, agent_actions: null });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect((store.get(threadRunsAtom)[0] as AgentRun).user_prompt.content).toBe(
            'Original question'
        );
    });

    it('gives up after a bounded number of attempts and cancels locally', async () => {
        getRunMock.mockResolvedValue({ run: makeRun('in_progress'), agent_actions: null });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(getRunMock).toHaveBeenCalledTimes(4);
        const run = store.get(threadRunsAtom)[0] as AgentRun;
        expect(run.status).toBe('canceled');
        expect(run.completed_at).toBeTruthy();
    });

    it('stops asking when the user switches thread', async () => {
        getRunMock.mockResolvedValue({
            run: makeRun('canceled', {
                metadata: { citations: [{ citation_id: 'c1' }] } as AgentRun['metadata'],
            }),
            agent_actions: null,
        });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        store.set(currentThreadIdAtom, 'a-different-thread');
        await runTimers();
        await done;

        expect(getRunMock).not.toHaveBeenCalled();
        // Nothing fetched means nothing to leak into the thread now on screen.
        expect(store.get(citationsAtom)).toEqual([]);
    });

    it('settles a run it abandons rather than leaving it spinning', async () => {
        // The load that changed the thread may fail, in which case these runs
        // stay on screen with nobody waiting for them. A run left `in_progress`
        // there renders as though it were still generating, forever.
        getRunMock.mockResolvedValue({ run: makeRun('canceled'), agent_actions: null });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        store.set(currentThreadIdAtom, 'a-different-thread');
        await runTimers();
        await done;

        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('canceled');
    });

    it('leaves an abandoned run alone when a later load has taken it over', async () => {
        // A generation bump means a newer load owns this thread's state and has
        // scheduled its own wait; settling the run would pull it out from under
        // that wait.
        getRunMock.mockResolvedValue({ run: makeRun('canceled'), agent_actions: null });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        store.set(threadLoadGenerationAtom, g => g + 1);
        await runTimers();
        await done;

        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('in_progress');
    });

    it('does not resurrect a run that was truncated away mid-flight', async () => {
        getRunMock.mockResolvedValue({ run: makeRun('canceled'), agent_actions: null });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        // A regenerate or resume slices the tail off the thread.
        store.set(threadRunsAtom, []);
        await runTimers();
        await done;

        expect(store.get(threadRunsAtom)).toEqual([]);
    });

    it('stands down when a live stream takes the run over', async () => {
        getRunMock.mockResolvedValue({ run: makeRun('canceled'), agent_actions: null });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        store.set(activeRunAtom, makeRun('in_progress'));
        await runTimers();
        await done;

        expect(getRunMock).not.toHaveBeenCalled();
    });

    it('settles locally when the run does not exist', async () => {
        getRunMock.mockRejectedValue(new ApiError(404, 'Not Found'));

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(getRunMock).toHaveBeenCalledTimes(1);
        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('canceled');
    });

    it('keeps trying after a transient failure', async () => {
        getRunMock
            .mockRejectedValueOnce(new Error('network blip'))
            .mockResolvedValueOnce(makeFullySettledFetch());

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(getRunMock).toHaveBeenCalledTimes(2);
        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('canceled');
    });

    it('only waits once per run, however many windows ask', async () => {
        // Both Beaver windows share one store, so both would otherwise start
        // their own timer for the same run.
        getRunMock.mockResolvedValue(makeFullySettledFetch());

        const store = makeStore();
        const first = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        const second = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await Promise.all([first, second]);

        expect(getRunMock).toHaveBeenCalledTimes(1);
    });

    it('gives up on a request that never comes back', async () => {
        // The API layer has no request timeout, so without our own bound a
        // half-open connection would leave the spinner up forever.
        getRunMock.mockImplementation(() => new Promise(() => {}));

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('canceled');
        expect(store.get(recoveringRunIdsAtom).size).toBe(0);
    });

    it('settles the run locally when it cannot be rendered', async () => {
        getRunMock.mockResolvedValue({
            run: makeRun('canceled', {
                model_messages: [
                    { kind: 'request', parts: [{ part_kind: 'tool-return', tool_call_id: 't1' }] },
                ] as AgentRun['model_messages'],
            }),
            agent_actions: null,
        });
        processToolReturnResultsMock.mockRejectedValue(new Error('malformed tool result'));

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        // Not left `in_progress`: with the marker gone that renders as
        // "Generating" forever.
        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('canceled');
        expect(store.get(recoveringRunIdsAtom).size).toBe(0);
    });

    it('writes nothing when the thread changes after the fetch', async () => {
        // The checks that matter are the ones after the awaits — mutating state
        // before the first backoff never exercises them.
        const store = makeStore();
        getRunMock.mockImplementation(async () => {
            store.set(currentThreadIdAtom, 'a-different-thread');
            return { run: makeRun('canceled'), agent_actions: null };
        });

        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(getRunMock).toHaveBeenCalledTimes(1);
        // The fetched answer was not merged into the thread now on screen; the
        // abandoned run is only settled locally.
        expect(store.get(citationsAtom)).toEqual([]);
        expect((store.get(threadRunsAtom)[0] as AgentRun).model_messages).toEqual([]);
    });

    it('does not seed the next thread while preprocessing an old one', async () => {
        const store = makeStore();
        getRunMock.mockResolvedValue({
            run: makeRun('canceled', {
                model_messages: [
                    {
                        kind: 'request',
                        parts: [
                            { part_kind: 'tool-return', tool_call_id: 't1' },
                            { part_kind: 'tool-return', tool_call_id: 't2' },
                        ],
                    },
                ] as AgentRun['model_messages'],
            }),
            agent_actions: null,
        });
        // The user switches thread while the first tool result is being hydrated.
        processToolReturnResultsMock.mockImplementationOnce(async () => {
            store.set(currentThreadIdAtom, 'a-different-thread');
        });

        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(processToolReturnResultsMock).toHaveBeenCalledTimes(1);
        // Nothing of the old thread's run was merged, and it is settled rather
        // than left spinning in case the load that replaced us fails.
        expect((store.get(threadRunsAtom)[0] as AgentRun).model_messages).toEqual([]);
        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('canceled');
    });

    it('keeps citations the live stream already delivered', async () => {
        // Citations are attached by a second backend write that can land after
        // the status flips, so an empty list means "not yet", not "none".
        getRunMock.mockResolvedValue({
            run: makeRun('canceled', { metadata: { citations: [] } as AgentRun['metadata'] }),
            agent_actions: null,
        });

        const store = makeStore();
        store.set(citationsAtom, [{ citation_id: 'streamed', run_id: RUN_ID }]);

        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(store.get(citationsAtom)).toEqual([{ citation_id: 'streamed', run_id: RUN_ID }]);
    });

    it('picks up citations the backend writes after the status', async () => {
        // The backend writes the run and its citations separately, so a run can
        // read as settled before its sources land. Merging the text and stopping
        // there leaves a reopened turn with raw citation markup until reload.
        getRunMock
            .mockResolvedValueOnce({ run: makeRun('canceled'), agent_actions: null })
            .mockResolvedValueOnce({
                run: makeRun('canceled', {
                    metadata: { citations: [{ citation_id: 'late' }] } as AgentRun['metadata'],
                }),
                agent_actions: [{ id: 'a1', run_id: RUN_ID }],
            });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(getRunMock).toHaveBeenCalledTimes(2);
        expect(store.get(citationsAtom)).toEqual([{ citation_id: 'late', run_id: RUN_ID }]);
        expect(store.get(threadAgentActionsAtom)).toEqual([{ id: 'a1', run_id: RUN_ID }]);
    });

    it('picks up a note proposal that arrives without any citation', async () => {
        // An answer can propose a note while citing nothing, and the backend
        // writes the actions after the citations — so neither may gate the other.
        getRunMock
            .mockResolvedValueOnce({ run: makeRun('canceled'), agent_actions: null })
            .mockResolvedValueOnce({
                run: makeRun('canceled'),
                agent_actions: [{ id: 'a1', run_id: RUN_ID }],
            });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(store.get(threadAgentActionsAtom)).toEqual([{ id: 'a1', run_id: RUN_ID }]);
    });

    it('does not overwrite a live stream that took the run over mid-follow-up', async () => {
        // The follow-up outlives the merge, so its guard has to keep rejecting a
        // run a new stream is now driving — that stream's citations are the real
        // ones. Relaxing the settled-status check must not relax this one.
        getRunMock
            .mockResolvedValueOnce({ run: makeRun('canceled'), agent_actions: null })
            .mockResolvedValue({
                run: makeRun('canceled', {
                    metadata: { citations: [{ citation_id: 'stale' }] } as AgentRun['metadata'],
                }),
                agent_actions: null,
            });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });

        // Let the settle fetch and merge land, then have a new stream claim the
        // run while the follow-up is still waiting.
        await vi.advanceTimersByTimeAsync(1000);
        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('canceled');
        store.set(activeRunAtom, makeRun('in_progress'));

        await runTimers();
        await done;

        expect(store.get(citationsAtom)).toEqual([]);
    });

    it('looks again when the settled run brought citations but no actions', async () => {
        // Absence is not distinguishable from "still coming" — the backend
        // writes actions after citations — so the settled fetch seeing only
        // citations must still start the follow-up.
        getRunMock
            .mockResolvedValueOnce({
                run: makeRun('canceled', {
                    metadata: { citations: [{ citation_id: 'c1' }] } as AgentRun['metadata'],
                }),
                agent_actions: null,
            })
            .mockResolvedValueOnce({
                run: makeRun('canceled', {
                    metadata: { citations: [{ citation_id: 'c1' }] } as AgentRun['metadata'],
                }),
                agent_actions: [{ id: 'a1', run_id: RUN_ID }],
            });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(store.get(threadAgentActionsAtom)).toEqual([{ id: 'a1', run_id: RUN_ID }]);
    });

    it('looks again when the settled run brought actions but no citations', async () => {
        getRunMock
            .mockResolvedValueOnce({
                run: makeRun('canceled'),
                agent_actions: [{ id: 'a1', run_id: RUN_ID }],
            })
            .mockResolvedValueOnce({
                run: makeRun('canceled', {
                    metadata: { citations: [{ citation_id: 'late' }] } as AgentRun['metadata'],
                }),
                agent_actions: [{ id: 'a1', run_id: RUN_ID }],
            });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(store.get(citationsAtom)).toEqual([{ citation_id: 'late', run_id: RUN_ID }]);
    });

    it('repairs and primes recovered actions the way a thread load does', async () => {
        // Same endpoint, so the same repair is needed: providers format tool call
        // ids differently and pydantic-ai rewrites them, and proposed items for
        // create_item render from the external-reference mapping.
        const action = {
            id: 'a1',
            run_id: RUN_ID,
            action_type: 'create_item',
            proposed_data: { item: { title: 'A proposed paper' } },
        };
        getRunMock.mockResolvedValue({
            run: makeRun('canceled', {
                metadata: { citations: [{ citation_id: 'c1' }] } as AgentRun['metadata'],
            }),
            agent_actions: [action],
        });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(reconcileToolcallIdsMock).toHaveBeenCalled();
        expect(addExternalReferencesMock).toHaveBeenCalledWith([{ title: 'A proposed paper' }]);
        expect(checkExternalReferencesMock).toHaveBeenCalledWith([{ title: 'A proposed paper' }]);
    });

    it('does not prime external references for actions that propose no item', async () => {
        getRunMock.mockResolvedValue(makeFullySettledFetch());

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(addExternalReferencesMock).not.toHaveBeenCalled();
    });

    it('does not undo an action the user changed while it was still looking', async () => {
        // Recovered actions are interactive as soon as they render, and the
        // follow-up look can return mid-click carrying the pre-change status.
        getRunMock
            .mockResolvedValueOnce({
                run: makeRun('canceled'),
                agent_actions: [{ id: 'a1', run_id: RUN_ID, status: 'pending' }],
            })
            .mockResolvedValue({
                run: makeRun('canceled', {
                    metadata: { citations: [{ citation_id: 'late' }] } as AgentRun['metadata'],
                }),
                agent_actions: [{ id: 'a1', run_id: RUN_ID, status: 'pending' }],
            });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });

        // The action is on screen and the follow-up look is still pending.
        await vi.advanceTimersByTimeAsync(1000);
        expect(store.get(threadAgentActionsAtom)).toHaveLength(1);
        store.set(threadAgentActionsAtom, (prev: any[]) =>
            prev.map(action => (action.id === 'a1' ? { ...action, status: 'applied' } : action))
        );

        await runTimers();
        await done;

        // The user's change survived, and the late citations still landed.
        expect(store.get(threadAgentActionsAtom)).toEqual([
            { id: 'a1', run_id: RUN_ID, status: 'applied' },
        ]);
        expect(store.get(citationsAtom)).toEqual([{ citation_id: 'late', run_id: RUN_ID }]);
    });

    it('keeps looking when only one metadata channel has arrived', async () => {
        // The backend writes citations first and actions second, so a follow-up
        // can catch the first without the second. Applying what arrived and
        // stopping would leave the note proposal missing until reload.
        getRunMock
            .mockResolvedValueOnce({ run: makeRun('canceled'), agent_actions: null })
            .mockResolvedValueOnce({
                run: makeRun('canceled', {
                    metadata: { citations: [{ citation_id: 'c1' }] } as AgentRun['metadata'],
                }),
                agent_actions: null,
            })
            .mockResolvedValueOnce({
                run: makeRun('canceled', {
                    metadata: { citations: [{ citation_id: 'c1' }] } as AgentRun['metadata'],
                }),
                agent_actions: [{ id: 'a1', run_id: RUN_ID }],
            });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(store.get(citationsAtom)).toEqual([{ citation_id: 'c1', run_id: RUN_ID }]);
        expect(store.get(threadAgentActionsAtom)).toEqual([{ id: 'a1', run_id: RUN_ID }]);
    });

    it('does not look again when the settled run brought both channels', async () => {
        getRunMock.mockResolvedValue(makeFullySettledFetch());

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(getRunMock).toHaveBeenCalledTimes(1);
    });

    it('leaves the turn alone when no citations ever arrive', async () => {
        getRunMock.mockResolvedValue({ run: makeRun('canceled'), agent_actions: null });

        const store = makeStore();
        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        // One settle fetch plus the bounded follow-up look, then it stops asking.
        expect(getRunMock).toHaveBeenCalledTimes(3);
        expect(store.get(citationsAtom)).toEqual([]);
        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('canceled');
    });

    it('abandons the citation follow-up if the thread changes', async () => {
        const store = makeStore();
        getRunMock.mockImplementation(async () => {
            // Called for the settle fetch; the user leaves before the follow-up.
            if (getRunMock.mock.calls.length === 1) {
                return { run: makeRun('canceled'), agent_actions: null };
            }
            throw new Error('the follow-up should not have been attempted');
        });

        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        // Let the settle fetch and merge complete, then navigate away.
        await vi.advanceTimersByTimeAsync(1000);
        store.set(currentThreadIdAtom, 'a-different-thread');
        await runTimers();
        await done;

        expect(getRunMock).toHaveBeenCalledTimes(1);
    });

    it('numbers a recovered run’s citations by transcript position', async () => {
        // Markers are assigned in array order, so a run that finished while we
        // were waiting must not push the recovered run's citations behind it.
        const laterRun = { ...makeRun('completed'), id: 'run-2' } as AgentRun;
        getRunMock.mockResolvedValue({
            run: makeRun('canceled', { metadata: { citations: [{ citation_id: 'older' }] } as AgentRun['metadata'] }),
            agent_actions: null,
        });

        const store = makeStore([makeRun('in_progress'), laterRun]);
        store.set(citationsAtom, [{ citation_id: 'newer', run_id: 'run-2' }]);

        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(store.get(citationsAtom)).toEqual([
            { citation_id: 'older', run_id: RUN_ID },
            { citation_id: 'newer', run_id: 'run-2' },
        ]);
    });

    it('stands down when a later thread load supersedes it', async () => {
        // Switching away and back reloads the same thread with the same run id,
        // so nothing but the load generation can tell the two waits apart. The
        // stale one must neither settle the run nor clear the fresh marker.
        getRunMock.mockResolvedValue({ run: makeRun('in_progress'), agent_actions: null });

        const store = makeStore();
        const stale = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });

        store.set(threadLoadGenerationAtom, g => g + 1);
        store.set(recoveringRunIdsAtom, new Set([RUN_ID]));

        await runTimers();
        await stale;

        expect((store.get(threadRunsAtom)[0] as AgentRun).status).toBe('in_progress');
        expect(store.get(recoveringRunIdsAtom).has(RUN_ID)).toBe(true);
    });

    it('replaces only this run’s citations and actions', async () => {
        const settled = makeRun('canceled', {
            metadata: { citations: [{ citation_id: 'new' }] } as AgentRun['metadata'],
        });
        getRunMock.mockResolvedValue({
            run: settled,
            agent_actions: [{ id: 'a1', run_id: RUN_ID }],
        });

        // An earlier turn in the same thread, whose citations and actions must
        // survive untouched.
        const earlier = { ...makeRun('completed'), id: 'run-other' } as AgentRun;
        const store = makeStore([earlier, makeRun('in_progress')]);
        store.set(citationsAtom, [{ citation_id: 'other', run_id: 'run-other' }]);
        store.set(threadAgentActionsAtom, [{ id: 'a0', run_id: 'run-other' }] as unknown as AgentAction[]);

        const done = store.set(recoverInterruptedRunAtom, { runId: RUN_ID, threadId: THREAD_ID });
        await runTimers();
        await done;

        expect(store.get(citationsAtom)).toEqual([
            { citation_id: 'other', run_id: 'run-other' },
            { citation_id: 'new', run_id: RUN_ID },
        ]);
        expect(store.get(threadAgentActionsAtom)).toEqual([
            { id: 'a0', run_id: 'run-other' },
            { id: 'a1', run_id: RUN_ID },
        ]);
    });
});
