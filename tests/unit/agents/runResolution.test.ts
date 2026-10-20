import { describe, expect, it } from 'vitest';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import {
    REATTACH_RESOLUTION_WINDOW_MS,
    isCutOffMidText,
    reattachResolutionView,
    replacementNotes,
} from '@beaver/agent-core/run-state/runResolution';
import {
    RUN_FINISHED_BEFORE_STOP_NOTE,
    RUN_FINISHED_WHILE_DISCONNECTED_NOTE,
} from '@beaver/agent-core/transport/connectionFailure';

const resolution = { threadId: 'thread', runId: 'run', since: 1_000 };
const view = (overrides: Partial<Parameters<typeof reattachResolutionView>[0]> = {}) =>
    reattachResolutionView({
        resolution,
        runId: 'run',
        currentThreadId: 'thread',
        activityState: 'unknown',
        unreachable: false,
        now: 2_000,
        ...overrides,
    });

describe('a failed reattach while the server reports how the run ended', () => {
    it('checks instead of showing the error while the server has not answered', () => {
        expect(view()).toBe('checking');
    });

    it('says the response is still running once the server reports it active', () => {
        expect(view({ activityState: 'active' })).toBe('still_running');
        // Even past the checking window: the run has not failed.
        expect(view({ activityState: 'active', now: 1_000 + REATTACH_RESOLUTION_WINDOW_MS * 3 })).toBe('still_running');
    });

    it('does not take a successor run for the lost one', () => {
        expect(view({ activityState: 'active', activityRunId: 'run' })).toBe('still_running');
        expect(view({ activityState: 'active', activityRunId: 'successor' })).toBe('checking');
        expect(view({
            activityState: 'active',
            activityRunId: 'successor',
            now: 1_000 + REATTACH_RESOLUTION_WINDOW_MS,
        })).toBeNull();
    });

    it('falls back to the error once the window passes without an answer', () => {
        expect(view({ now: 1_000 + REATTACH_RESOLUTION_WINDOW_MS - 1 })).toBe('checking');
        expect(view({ now: 1_000 + REATTACH_RESOLUTION_WINDOW_MS })).toBeNull();
    });

    it('shows the error when the server cannot be reached', () => {
        expect(view({ unreachable: true })).toBeNull();
        expect(view({ unreachable: true, activityState: 'active' })).toBeNull();
    });

    it('only applies to the run and chat being resolved', () => {
        expect(view({ runId: 'other' })).toBeNull();
        expect(view({ currentThreadId: 'other' })).toBeNull();
        expect(view({ resolution: null })).toBeNull();
    });
});

const run = (id: string, status: AgentRun['status'], errorType?: string): AgentRun => ({
    id,
    status,
    ...(errorType ? { error: { type: errorType, message: '' } } : {}),
} as unknown as AgentRun);

describe('notes on runs the server replaced', () => {
    it('notes a stopped run the server completed before the stop arrived', () => {
        const notes = replacementNotes([run('a', 'canceled')], [run('a', 'completed')]);
        expect(notes.get('a')).toBe(RUN_FINISHED_BEFORE_STOP_NOTE);
    });

    it('notes a run shown as disconnected that the server completed', () => {
        const notes = replacementNotes([run('a', 'error', 'connection_error')], [run('a', 'completed')]);
        expect(notes.get('a')).toBe(RUN_FINISHED_WHILE_DISCONNECTED_NOTE);
    });

    it('says nothing when the outcome did not change for the better', () => {
        expect(replacementNotes([run('a', 'completed')], [run('a', 'completed')]).size).toBe(0);
        expect(replacementNotes([run('a', 'canceled')], [run('a', 'canceled')]).size).toBe(0);
        expect(replacementNotes([run('a', 'error', 'connection_error')], [run('a', 'canceled')]).size).toBe(0);
        expect(replacementNotes([run('a', 'error', 'server_error')], [run('a', 'completed')]).size).toBe(0);
        expect(replacementNotes([], [run('a', 'completed')]).size).toBe(0);
    });
});

describe('a response cut off partway', () => {
    const interrupted = (parts: unknown[], reasonCode = 'connection_lost'): AgentRun => ({
        id: 'a',
        status: 'canceled',
        error: { type: 'canceled', message: '', reason_code: reasonCode },
        model_messages: [{ kind: 'response', parts }],
    } as unknown as AgentRun);
    const text = (content: string) => ({ part_kind: 'text', content });
    const toolCall = { part_kind: 'tool-call', tool_name: 'ask_user_question', tool_call_id: 't', args: {} };

    it('is flagged when it stopped while writing', () => {
        expect(isCutOffMidText(interrupted([text('The first finding is')]))).toBe(true);
    });

    it('is not flagged when it stopped at a tool call after complete text', () => {
        expect(isCutOffMidText(interrupted([text('I will ask you a question.'), toolCall]))).toBe(false);
    });

    it('is not flagged without text, or for a stop the user chose', () => {
        expect(isCutOffMidText(interrupted([text('  ')]))).toBe(false);
        expect(isCutOffMidText(interrupted([text('Partial')], 'client_cancel'))).toBe(false);
    });
});
