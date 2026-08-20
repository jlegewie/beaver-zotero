import { describe, expect, it } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';
import {
    appendRunIfMissing,
    collectResumeChain,
    findResumeChainRoot,
    findRunForResume,
    hasOnlyThinkingParts,
    isInterruptedRun,
    lingeringCompletedRun,
    shouldOfferResume,
    sumChainUsage,
    wasRunContinued,
    resolveErrorRunId,
    toRunError,
} from '@beaver/agent-core/run-state/runResumeHelpers';
import type { WSErrorEvent } from '@beaver/agent-core/protocol/agentProtocol';

function makeRun(id: string, status: AgentRun['status'] = 'error'): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: {
            content: '',
            is_resume: false,
        },
        status,
        model_messages: [],
        created_at: new Date().toISOString(),
        consent_to_share: false,
        model_name: 'gpt-5',
    };
}

function makeResumeRun(id: string, resumesRunId: string, status: AgentRun['status'] = 'completed'): AgentRun {
    const run = makeRun(id, status);
    run.user_prompt = {
        content: '',
        is_resume: true,
        resumes_run_id: resumesRunId,
    };
    return run;
}

describe('runResumeHelpers', () => {
    it('appendRunIfMissing adds active failed run once', () => {
        const failedRun = makeRun('run-1');

        expect(appendRunIfMissing([], failedRun)).toEqual([failedRun]);
        expect(appendRunIfMissing([failedRun], failedRun)).toEqual([failedRun]);
    });

    it('findRunForResume prefers thread runs and falls back to the active run', () => {
        const threadRun = makeRun('thread-run');
        const activeRun = makeRun('active-run');

        expect(findRunForResume([threadRun], activeRun, 'thread-run')).toBe(threadRun);
        expect(findRunForResume([], activeRun, 'active-run')).toBe(activeRun);
        expect(findRunForResume([], activeRun, 'missing')).toBeNull();
    });

    it('resolveErrorRunId prefers the websocket run_id and falls back to the active run', () => {
        const activeRun = makeRun('active-run', 'in_progress');
        const event: WSErrorEvent = {
            event: 'error',
            type: 'llm_connection_error',
            message: 'Connection interrupted',
            run_id: 'event-run',
        };

        expect(resolveErrorRunId(event, activeRun)).toBe('event-run');
        expect(resolveErrorRunId({ ...event, run_id: undefined }, activeRun)).toBe('active-run');
    });

    describe('findResumeChainRoot', () => {
        it('returns the run itself when it is not a resume', () => {
            const original = makeRun('run-original', 'completed');
            original.user_prompt.content = 'original question';

            expect(findResumeChainRoot(original, [original])).toBe(original);
        });

        it('walks a single-step resume chain back to the original run', () => {
            const original = makeRun('run-original', 'error');
            original.user_prompt.content = 'original question';
            const resume = makeResumeRun('run-resume', 'run-original', 'completed');

            expect(findResumeChainRoot(resume, [original, resume])).toBe(original);
        });

        it('walks a multi-step resume chain back to the root', () => {
            const original = makeRun('run-a', 'error');
            original.user_prompt.content = 'original question';
            const resumeB = makeResumeRun('run-b', 'run-a', 'error');
            const resumeC = makeResumeRun('run-c', 'run-b', 'completed');

            expect(findResumeChainRoot(resumeC, [original, resumeB, resumeC])).toBe(original);
        });

        it('stops walking when the referenced parent run is missing', () => {
            const resume = makeResumeRun('run-resume', 'run-missing', 'completed');

            expect(findResumeChainRoot(resume, [resume])).toBe(resume);
        });

        it('guards against cycles in the resume chain', () => {
            const runA = makeResumeRun('run-a', 'run-b', 'completed');
            const runB = makeResumeRun('run-b', 'run-a', 'completed');

            // Should not infinite-loop; it returns whichever run it ends on when
            // it detects the cycle.
            const root = findResumeChainRoot(runA, [runA, runB]);
            expect([runA, runB]).toContain(root);
        });
    });

    describe('hasOnlyThinkingParts', () => {
        it('returns false for a null run', () => {
            expect(hasOnlyThinkingParts(null)).toBe(false);
        });

        it('returns true when the run has no model messages', () => {
            expect(hasOnlyThinkingParts(makeRun('run-1'))).toBe(true);
        });

        it('returns true when only thinking parts have streamed', () => {
            const run = makeRun('run-1');
            run.model_messages = [
                {
                    kind: 'response',
                    run_id: run.id,
                    parts: [{ part_kind: 'thinking', content: 'hmm' }],
                },
            ];
            expect(hasOnlyThinkingParts(run)).toBe(true);
        });

        it('returns false once any text part has streamed', () => {
            const run = makeRun('run-1');
            run.model_messages = [
                {
                    kind: 'response',
                    run_id: run.id,
                    parts: [
                        { part_kind: 'thinking', content: 'hmm' },
                        { part_kind: 'text', content: 'partial answer' },
                    ],
                },
            ];
            expect(hasOnlyThinkingParts(run)).toBe(false);
        });

        it('returns false once any tool call has streamed', () => {
            const run = makeRun('run-1');
            run.model_messages = [
                {
                    kind: 'response',
                    run_id: run.id,
                    parts: [
                        {
                            part_kind: 'tool-call',
                            tool_name: 'rag_search',
                            args: {},
                            tool_call_id: 'tc-1',
                        },
                    ],
                },
            ];
            expect(hasOnlyThinkingParts(run)).toBe(false);
        });

        it('ignores request-kind messages (tool returns, user prompts)', () => {
            const run = makeRun('run-1');
            run.model_messages = [
                {
                    kind: 'request',
                    run_id: run.id,
                    parts: [{ part_kind: 'user-prompt', content: 'question' }],
                    instructions: '',
                },
                {
                    kind: 'response',
                    run_id: run.id,
                    parts: [{ part_kind: 'thinking', content: 'hmm' }],
                },
            ];
            expect(hasOnlyThinkingParts(run)).toBe(true);
        });
    });

    describe('lingeringCompletedRun', () => {
        it('returns null for a null active run', () => {
            expect(lingeringCompletedRun(null)).toBeNull();
        });

        it('returns null for a run still in progress', () => {
            expect(lingeringCompletedRun(makeRun('run-1', 'in_progress'))).toBeNull();
        });

        it('returns null for an errored run', () => {
            expect(lingeringCompletedRun(makeRun('run-1', 'error'))).toBeNull();
        });

        it('returns null for a canceled run', () => {
            expect(lingeringCompletedRun(makeRun('run-1', 'canceled'))).toBeNull();
        });

        it('returns null for a run awaiting deferred approval', () => {
            expect(lingeringCompletedRun(makeRun('run-1', 'awaiting_deferred'))).toBeNull();
        });

        it('archives a completed run and backfills completed_at when missing', () => {
            const run = makeRun('run-1', 'completed');
            expect(run.completed_at).toBeUndefined();

            const finalized = lingeringCompletedRun(run);

            expect(finalized).not.toBeNull();
            expect(finalized!.id).toBe('run-1');
            expect(finalized!.status).toBe('completed');
            expect(typeof finalized!.completed_at).toBe('string');
            expect(finalized!.completed_at).not.toBe('');
        });

        it('preserves an existing completed_at on a completed run', () => {
            const run = makeRun('run-1', 'completed');
            run.completed_at = '2020-01-01T00:00:00.000Z';

            const finalized = lingeringCompletedRun(run);

            expect(finalized!.completed_at).toBe('2020-01-01T00:00:00.000Z');
        });

        it('keeps every other field of the archived run unchanged', () => {
            const run = makeRun('run-1', 'completed');
            run.completed_at = '2020-01-01T00:00:00.000Z';

            expect(lingeringCompletedRun(run)).toEqual(run);
        });
    });

    it('toRunError keeps only persisted/manual-resume fields', () => {
        const event: WSErrorEvent = {
            event: 'error',
            type: 'llm_connection_error',
            message: 'Connection interrupted',
            details: 'ReadError',
            is_retryable: true,
            retry_after: 1,
            is_resumable: false,
            try_auto_resume: true,
            has_beaver_fallback: true,
        };

        expect(toRunError(event)).toEqual({
            type: 'llm_connection_error',
            message: 'Connection interrupted',
            details: 'ReadError',
            is_retryable: true,
            retry_after: 1,
            is_resumable: false,
            has_beaver_fallback: true,
        });
    });
});

describe('isInterruptedRun', () => {
    /** A canceled run as the backend stores it, with the cause it recorded. */
    function canceledRun(reasonCode?: string): AgentRun {
        const run = makeRun('run-1', 'canceled');
        run.error = reasonCode
            ? { type: 'canceled', message: 'Ended', reason_code: reasonCode }
            : undefined;
        return run;
    }

    it.each([
        ['the client closed the socket', 'client_closed'],
        ['the connection died', 'connection_lost'],
        ['the server restarted', 'server_shutdown'],
    ])('counts a run cut off because %s', (_label, reasonCode) => {
        expect(isInterruptedRun(canceledRun(reasonCode))).toBe(true);
    });

    it('does not count a run the user stopped', () => {
        expect(isInterruptedRun(canceledRun('client_cancel'))).toBe(false);
    });

    it('does not count a canceled run that never said why it ended', () => {
        expect(isInterruptedRun(canceledRun())).toBe(false);
    });

    it('does not count an unrecognized cause', () => {
        expect(isInterruptedRun(canceledRun('something_new'))).toBe(false);
    });

    it.each(['completed', 'error', 'in_progress'] as const)(
        'does not count a %s run whatever its error says',
        (status) => {
            const run = makeRun('run-1', status);
            run.error = { type: 'canceled', message: 'Ended', reason_code: 'client_closed' };
            expect(isInterruptedRun(run)).toBe(false);
        },
    );

    it('counts nothing when there is no run', () => {
        expect(isInterruptedRun(null)).toBe(false);
        expect(isInterruptedRun(undefined)).toBe(false);
    });
});

describe('shouldOfferResume', () => {
    function interruptedRun(id = 'run-1'): AgentRun {
        const run = makeRun(id, 'canceled');
        run.error = { type: 'canceled', message: 'Ended', reason_code: 'client_closed' };
        return run;
    }

    const noneResumed: ReadonlySet<string> = new Set<string>();

    it('offers to continue the newest cut-off run', () => {
        expect(shouldOfferResume(interruptedRun(), { isLastRun: true, resumedRunIds: noneResumed })).toBe(true);
    });

    it('says nothing about a cut-off run the conversation moved past', () => {
        expect(shouldOfferResume(interruptedRun(), { isLastRun: false, resumedRunIds: noneResumed })).toBe(false);
    });

    it('stops offering once the run has been resumed', () => {
        const run = interruptedRun();

        expect(shouldOfferResume(run, {
            isLastRun: true,
            resumedRunIds: new Set([run.id]),
        })).toBe(false);
    });

    it('says nothing about a run that ended normally', () => {
        expect(shouldOfferResume(makeRun('run-1', 'completed'), {
            isLastRun: true,
            resumedRunIds: noneResumed,
        })).toBe(false);
    });

    it('leaves a failed run to the error card', () => {
        const run = makeRun('run-1', 'error');
        run.error = { type: 'llm_error', message: 'boom', is_resumable: true };

        expect(shouldOfferResume(run, { isLastRun: true, resumedRunIds: noneResumed })).toBe(false);
    });
});

describe('wasRunContinued', () => {
    function interrupted(id = 'run-1'): AgentRun {
        const run = makeRun(id, 'canceled');
        run.error = { type: 'canceled', message: 'Ended', reason_code: 'client_closed' };
        return run;
    }

    it('counts a failed run a later run resumed', () => {
        const run = makeRun('run-1', 'error');

        expect(wasRunContinued(run, new Set(['run-1']))).toBe(true);
    });

    it('counts an interrupted run a later run continued', () => {
        const run = interrupted();

        expect(wasRunContinued(run, new Set([run.id]))).toBe(true);
    });

    it('counts nothing when no run continued it', () => {
        expect(wasRunContinued(interrupted(), new Set<string>())).toBe(false);
        expect(wasRunContinued(makeRun('run-1', 'error'), new Set(['other']))).toBe(false);
    });

    it('does not count a run the user stopped', () => {
        const run = makeRun('run-1', 'canceled');
        run.error = { type: 'canceled', message: 'Stopped', reason_code: 'client_cancel' };

        expect(wasRunContinued(run, new Set([run.id]))).toBe(false);
    });

    it('does not count a completed run', () => {
        expect(wasRunContinued(makeRun('run-1', 'completed'), new Set(['run-1']))).toBe(false);
    });
});

describe('collectResumeChain', () => {
    it('returns a run that continued nothing on its own', () => {
        const run = makeRun('run-1', 'completed');

        expect(collectResumeChain(run, [run]).map(r => r.id)).toEqual(['run-1']);
    });

    it('returns the whole chain oldest first', () => {
        const first = makeRun('first', 'error');
        const second = makeResumeRun('second', 'first', 'error');
        const third = makeResumeRun('third', 'second', 'completed');

        expect(collectResumeChain(third, [first, second, third]).map(r => r.id))
            .toEqual(['first', 'second', 'third']);
    });

    it('stops where the history it was given stops', () => {
        // A run whose parent is not loaded: the chain is what can be shown.
        const orphan = makeResumeRun('orphan', 'missing', 'completed');

        expect(collectResumeChain(orphan, [orphan]).map(r => r.id)).toEqual(['orphan']);
    });

    it('does not loop on a cycle', () => {
        const a = makeResumeRun('a', 'b', 'completed');
        const b = makeResumeRun('b', 'a', 'error');

        expect(collectResumeChain(a, [a, b]).map(r => r.id)).toEqual(['b', 'a']);
    });

    it('agrees with findResumeChainRoot', () => {
        const first = makeRun('first', 'error');
        const second = makeResumeRun('second', 'first', 'completed');

        expect(collectResumeChain(second, [first, second])[0])
            .toBe(findResumeChainRoot(second, [first, second]));
    });
});

describe('sumChainUsage', () => {
    function usage(overrides: Partial<AgentRun['total_usage']> = {}) {
        return {
            requests: 1,
            tool_calls: 0,
            input_tokens: 100,
            cache_write_tokens: 0,
            cache_read_tokens: 0,
            input_audio_tokens: 0,
            cache_audio_read_tokens: 0,
            output_tokens: 10,
            ...overrides,
        } as NonNullable<AgentRun['total_usage']>;
    }

    function runWith(id: string, total_usage?: AgentRun['total_usage'], total_cost?: number): AgentRun {
        const run = makeRun(id, 'completed');
        run.total_usage = total_usage;
        run.total_cost = total_cost;
        return run;
    }

    it('adds up what every run in the chain spent', () => {
        const chain = [
            runWith('first', usage({ requests: 2, input_tokens: 100, output_tokens: 10 }), 0.5),
            runWith('second', usage({ requests: 3, input_tokens: 250, output_tokens: 40 }), 0.25),
        ];

        const { usage: summed, cost } = sumChainUsage(chain);

        expect(summed).toMatchObject({ requests: 5, input_tokens: 350, output_tokens: 50 });
        expect(cost).toBeCloseTo(0.75);
    });

    it('leaves a single run reporting exactly what it did', () => {
        const only = runWith('only', usage({ input_tokens: 42 }), 0.1);

        const { usage: summed, cost } = sumChainUsage([only]);

        expect(summed).toMatchObject({ input_tokens: 42 });
        expect(cost).toBe(0.1);
    });

    it('ignores a run that reported nothing', () => {
        // An interrupted run never reports its usage.
        const chain = [runWith('interrupted'), runWith('continuation', usage({ input_tokens: 70 }), 0.2)];

        const { usage: summed, cost } = sumChainUsage(chain);

        expect(summed).toMatchObject({ input_tokens: 70 });
        expect(cost).toBe(0.2);
    });

    it('reports nothing when no run in the chain did', () => {
        expect(sumChainUsage([runWith('a'), runWith('b')])).toEqual({ usage: null, cost: null });
    });

    it('merges the per-request entries and the details map', () => {
        const chain = [
            runWith('first', { ...usage(), model_requests: [{ input_tokens: 1 } as any], details: { reasoning: 5 } }),
            runWith('second', { ...usage(), model_requests: [{ input_tokens: 2 } as any], details: { reasoning: 7 } }),
        ];

        const { usage: summed } = sumChainUsage(chain);

        expect(summed?.model_requests).toHaveLength(2);
        expect(summed?.details).toEqual({ reasoning: 12 });
    });
});
