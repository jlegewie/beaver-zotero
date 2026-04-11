import { describe, expect, it } from 'vitest';

import type { AgentRun } from '../../../react/agents/types';
import {
    appendRunIfMissing,
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
