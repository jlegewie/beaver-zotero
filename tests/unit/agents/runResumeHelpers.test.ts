import { describe, expect, it } from 'vitest';

import type { AgentRun } from '../../../react/agents/types';
import {
    appendRunIfMissing,
    findResumeChainRoot,
    findRunForResume,
    resolveErrorRunId,
    toRunError,
} from '../../../react/agents/runResumeHelpers';
import type { WSErrorEvent } from '../../../src/services/agentProtocol';

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
