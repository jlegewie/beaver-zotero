import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from 'jotai';
import {
    activeRunAtom,
    getRunToolResults,
    mergeRunToolResults,
    resetRunSelectorCaches,
    resumeChainAtom,
    resumedRunIdsAtom,
    runToolResultsAtom,
    threadRunsAtom,
    toolResultAtom,
    toolResultsMapAtom,
    updateRunWithPart,
} from '@beaver/agent-core/run-state/atoms';
import type { AgentRun, ModelMessage } from '@beaver/agent-core/agents/types';
import type { WSPartEvent } from '@beaver/agent-core/protocol/agentProtocol';

/**
 * Every selector here exists to keep a component out of a re-render it does not
 * need, and jotai skips notifying a subscriber only when the value it computes
 * is identical to the previous one. So these tests assert identity (`toBe`),
 * not equality — a structurally equal but freshly built value is the bug.
 */

function toolCall(id: string): ModelMessage {
    return {
        kind: 'response',
        run_id: 'run',
        parts: [{ part_kind: 'tool-call', tool_name: 'search', tool_call_id: id, args: {} }],
    } as unknown as ModelMessage;
}

function toolReturn(id: string, content: unknown = { ok: true }): ModelMessage {
    return {
        kind: 'request',
        run_id: 'run',
        instructions: '',
        parts: [{ part_kind: 'tool-return', tool_name: 'search', tool_call_id: id, content }],
    } as unknown as ModelMessage;
}

function run(id: string, messages: ModelMessage[], overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id,
        thread_id: 'thread-1',
        status: 'completed',
        model_messages: messages,
        user_prompt: { content: 'question', is_resume: false },
        ...overrides,
    } as unknown as AgentRun;
}

/** A streamed text part carrying the whole accumulated text, as the wire does. */
function textPart(runId: string, content: string, partIndex = 0): WSPartEvent {
    return {
        event: 'part',
        run_id: runId,
        message_index: 0,
        part_index: partIndex,
        part: { part_kind: 'text', content },
    } as unknown as WSPartEvent;
}

describe('scoped run selectors', () => {
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
        resetRunSelectorCaches();
        store = createStore();
    });

    describe('getRunToolResults', () => {
        it('returns the same map for a run whose messages have not changed', () => {
            const finished = run('run-1', [toolCall('call-1'), toolReturn('call-1')]);
            expect(getRunToolResults(finished)).toBe(getRunToolResults(finished));
        });

        it('keeps the map of a run that a copy shares messages with', () => {
            const finished = run('run-1', [toolCall('call-1'), toolReturn('call-1')]);
            const restamped = { ...finished, status: 'canceled' } as AgentRun;
            expect(getRunToolResults(restamped)).toBe(getRunToolResults(finished));
        });

        it('collects tool returns and retry prompts, and ignores other request parts', () => {
            const messages = [
                {
                    kind: 'request',
                    run_id: 'run-1',
                    instructions: '',
                    parts: [
                        { part_kind: 'user-prompt', content: 'hidden from the UI' },
                        { part_kind: 'tool-return', tool_name: 'search', tool_call_id: 'call-1', content: {} },
                        { part_kind: 'retry-prompt', tool_name: 'search', tool_call_id: 'call-2', content: 'retry' },
                    ],
                } as unknown as ModelMessage,
            ];

            const results = getRunToolResults(run('run-1', messages));

            expect([...results.keys()]).toEqual(['call-1', 'call-2']);
        });

        it('rebuilds when the run messages are replaced', () => {
            const before = run('run-1', [toolCall('call-1')]);
            const after = run('run-1', [toolCall('call-1'), toolReturn('call-1')]);

            expect(getRunToolResults(before).has('call-1')).toBe(false);
            expect(getRunToolResults(after).has('call-1')).toBe(true);
        });
    });

    describe('mergeRunToolResults', () => {
        it('merges the results of every run given, later runs winning', () => {
            const first = run('run-1', [toolReturn('call-1', { from: 'first' })]);
            const second = run('run-2', [toolReturn('call-1', { from: 'second' })]);

            const merged = mergeRunToolResults([first, second]);

            expect((merged.get('call-1') as { content: unknown }).content).toEqual({ from: 'second' });
        });
    });

    describe('runToolResultsAtom', () => {
        it('holds its value while a different run streams', () => {
            const finished = run('run-1', [toolCall('call-1'), toolReturn('call-1')]);
            store.set(threadRunsAtom, [finished]);
            store.set(activeRunAtom, run('run-2', [], { status: 'in_progress' }));

            const selector = runToolResultsAtom('run-1');
            const before = store.get(selector);

            store.set(activeRunAtom, (previous) =>
                updateRunWithPart(previous as AgentRun, textPart('run-2', 'streaming...')),
            );

            expect(store.get(selector)).toBe(before);
        });

        it('changes when this run receives a result', () => {
            const streaming = run('run-1', [toolCall('call-1')], { status: 'in_progress' });
            store.set(activeRunAtom, streaming);

            const selector = runToolResultsAtom('run-1');
            const before = store.get(selector);
            expect(before.size).toBe(0);

            store.set(activeRunAtom, run('run-1', [toolCall('call-1'), toolReturn('call-1')]));

            const after = store.get(selector);
            expect(after).not.toBe(before);
            expect(after.get('call-1')).toBeDefined();
        });

        it('is empty for a run that is not in the thread', () => {
            expect(store.get(runToolResultsAtom('missing')).size).toBe(0);
        });

        it('returns the same atom for the same run id', () => {
            expect(runToolResultsAtom('run-1')).toBe(runToolResultsAtom('run-1'));
        });
    });

    describe('toolResultAtom', () => {
        it('holds undefined while an unrelated run streams', () => {
            store.set(threadRunsAtom, [run('run-1', [toolCall('call-1')])]);
            store.set(activeRunAtom, run('run-2', [], { status: 'in_progress' }));

            const selector = toolResultAtom('call-1');
            expect(store.get(selector)).toBeUndefined();

            store.set(activeRunAtom, (previous) =>
                updateRunWithPart(previous as AgentRun, textPart('run-2', 'streaming...')),
            );

            expect(store.get(selector)).toBeUndefined();
        });

        it('yields the result once it arrives', () => {
            store.set(activeRunAtom, run('run-1', [toolCall('call-1')], { status: 'in_progress' }));
            const selector = toolResultAtom('call-1');
            expect(store.get(selector)).toBeUndefined();

            store.set(activeRunAtom, run('run-1', [toolCall('call-1'), toolReturn('call-1')]));

            expect(store.get(selector)?.tool_call_id).toBe('call-1');
        });
    });

    describe('resumeChainAtom', () => {
        const resumeRun = (id: string, resumes: string) =>
            run(id, [], {
                user_prompt: { content: '', is_resume: true, resumes_run_id: resumes },
            } as Partial<AgentRun>);

        it('holds its array while a different run streams', () => {
            store.set(threadRunsAtom, [run('run-1', []), resumeRun('run-2', 'run-1')]);
            store.set(activeRunAtom, run('run-3', [], { status: 'in_progress' }));

            const selector = resumeChainAtom('run-2');
            const before = store.get(selector);
            expect(before.map((entry) => entry.id)).toEqual(['run-1', 'run-2']);

            store.set(activeRunAtom, (previous) =>
                updateRunWithPart(previous as AgentRun, textPart('run-3', 'streaming...')),
            );

            expect(store.get(selector)).toBe(before);
        });

        it('changes when a run in the chain is replaced', () => {
            const first = run('run-1', []);
            store.set(threadRunsAtom, [first, resumeRun('run-2', 'run-1')]);

            const selector = resumeChainAtom('run-2');
            const before = store.get(selector);

            store.set(threadRunsAtom, [{ ...first }, resumeRun('run-2', 'run-1')]);

            expect(store.get(selector)).not.toBe(before);
        });

        it('is empty for a run that is not in the thread', () => {
            expect(store.get(resumeChainAtom('missing'))).toEqual([]);
        });

        it('holds one empty array, so an absent run does not re-render its caller', () => {
            const selector = resumeChainAtom('missing');
            expect(store.get(selector)).toBe(store.get(resumeChainAtom('also-missing')));
        });

        it('releases the runs of a chain that leaves the thread', () => {
            store.set(threadRunsAtom, [run('run-1', []), resumeRun('run-2', 'run-1')]);
            const selector = resumeChainAtom('run-2');
            expect(store.get(selector)).toHaveLength(2);

            // A retry truncates the thread back past both runs.
            store.set(threadRunsAtom, []);
            expect(store.get(selector)).toEqual([]);

            // The chain is rebuilt from scratch if those ids ever come back,
            // rather than served from a cache still holding the old runs.
            store.set(threadRunsAtom, [run('run-1', []), resumeRun('run-2', 'run-1')]);
            expect(store.get(selector)).toHaveLength(2);
        });
    });

    describe('resumedRunIdsAtom', () => {
        it('holds its set while a run streams', () => {
            store.set(threadRunsAtom, [run('run-1', [])]);
            store.set(activeRunAtom, run('run-2', [], { status: 'in_progress' }));

            const before = store.get(resumedRunIdsAtom);

            store.set(activeRunAtom, (previous) =>
                updateRunWithPart(previous as AgentRun, textPart('run-2', 'streaming...')),
            );

            expect(store.get(resumedRunIdsAtom)).toBe(before);
        });

        it('changes when a resume run appears', () => {
            store.set(threadRunsAtom, [run('run-1', [])]);
            const before = store.get(resumedRunIdsAtom);

            store.set(threadRunsAtom, [
                run('run-1', []),
                run('run-2', [], {
                    user_prompt: { content: '', is_resume: true, resumes_run_id: 'run-1' },
                } as Partial<AgentRun>),
            ]);

            const after = store.get(resumedRunIdsAtom);
            expect(after).not.toBe(before);
            expect(after.has('run-1')).toBe(true);
        });
    });

    describe('toolResultsMapAtom', () => {
        it('still covers every run in the thread', () => {
            store.set(threadRunsAtom, [run('run-1', [toolReturn('call-1')])]);
            store.set(activeRunAtom, run('run-2', [toolReturn('call-2')], { status: 'in_progress' }));

            const map = store.get(toolResultsMapAtom);

            expect([...map.keys()].sort()).toEqual(['call-1', 'call-2']);
        });
    });

    describe('resetRunSelectorCaches', () => {
        it('drops the cached atoms so a new thread starts clean', () => {
            const selector = runToolResultsAtom('run-1');
            resetRunSelectorCaches();
            expect(runToolResultsAtom('run-1')).not.toBe(selector);
        });

        it('drops the held resumed-run ids too', () => {
            store.set(threadRunsAtom, [
                run('run-1', []),
                run('run-2', [], {
                    user_prompt: { content: '', is_resume: true, resumes_run_id: 'run-1' },
                } as Partial<AgentRun>),
            ]);
            const before = store.get(resumedRunIdsAtom);
            expect(before.has('run-1')).toBe(true);

            resetRunSelectorCaches();
            const fresh = createStore();
            fresh.set(threadRunsAtom, [run('run-1', [])]);

            expect(fresh.get(resumedRunIdsAtom).size).toBe(0);
        });
    });
});
