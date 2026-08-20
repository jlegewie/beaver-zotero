import { describe, expect, it } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';
import {
    appendRunIfMissing,
    findResumeChainRoot,
    findRunForResume,
    hasOnlyThinkingParts,
    isInterruptedRun,
    lingeringCompletedRun,
    shouldOfferResume,
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
