/**
 * The open parked run and what a parked run means for the rest of the run
 * state: the cards that stay answerable, the calls that render as waiting, the
 * resume chain that reads as one answer.
 */
import { describe, expect, it } from 'vitest';
import type { AgentRun, ModelMessage, ParkedDeferral, ParkedRun } from '@beaver/agent-core/agents/types';
import { isRunFinished } from '@beaver/agent-core/agents/types';
import { findOpenParkedRun, parkedCardRequests } from '@beaver/agent-core/run-state/parkedRun';
import {
    collectResumeChain,
    findResumeChainRoot,
    lingeringCompletedRun,
    wasRunContinued,
} from '@beaver/agent-core/run-state/runResumeHelpers';
import { getToolCallStatusFromResult, updateRunComplete } from '@beaver/agent-core/run-state/atoms';
import { replacementNotes } from '@beaver/agent-core/run-state/runResolution';

function deferral(toolCallId: string, kind = 'agent_action_approval', request: Record<string, any> = {}): ParkedDeferral {
    return {
        kind,
        tool_call_id: toolCallId,
        tool_name: 'edit_metadata',
        correlation_id: `corr-${toolCallId}`,
        request: { toolcall_id: toolCallId, action_id: `action-${toolCallId}`, ...request },
    };
}

function parkedRecord(deferrals: ParkedDeferral[], version = 1): ParkedRun {
    return { version, parked_at: '2026-11-08T10:00:00Z', reason: 'timeout', requests: deferrals };
}

function callsResponse(runId: string, ...toolCallIds: string[]): ModelMessage {
    return {
        kind: 'response',
        run_id: runId,
        parts: toolCallIds.map((id) => ({ part_kind: 'tool-call', tool_name: 'edit_metadata', args: {}, tool_call_id: id })),
    } as ModelMessage;
}

function returnsRequest(runId: string, ...toolCallIds: string[]): ModelMessage {
    return {
        kind: 'request',
        run_id: runId,
        instructions: '',
        parts: toolCallIds.map((id) => ({
            part_kind: 'tool-return',
            tool_name: 'edit_metadata',
            tool_call_id: id,
            content: 'ok',
        })),
    } as ModelMessage;
}

function run(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id,
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: 'hello' },
        status: 'completed',
        model_messages: [],
        model_name: 'model',
        created_at: '2026-11-08T10:00:00Z',
        consent_to_share: false,
        ...overrides,
    };
}

describe('findOpenParkedRun', () => {
    it('names the last run with a transcript when it parked, with its open cards', () => {
        const runs = [
            run('earlier'),
            run('parked', {
                status: 'parked',
                model_messages: [callsResponse('parked', 'call-1', 'call-2')],
                parked: parkedRecord([deferral('call-1'), deferral('call-2', 'ask_user_question')]),
            }),
        ];

        const open = findOpenParkedRun(runs);

        expect(open?.runId).toBe('parked');
        expect(open?.threadId).toBe('thread-1');
        expect([...open!.toolCallIds]).toEqual(['call-1', 'call-2']);
    });

    it('lists only the cards of a partial resume, whose calls sit in an earlier run', () => {
        const runs = [
            run('parked', {
                status: 'parked',
                model_messages: [callsResponse('parked', 'call-1', 'call-2', 'call-3')],
                parked: parkedRecord([deferral('call-1'), deferral('call-2'), deferral('call-3')]),
            }),
            run('partial', {
                status: 'parked',
                user_prompt: { content: '', resumes_run_id: 'parked', deferred_results: { 'call-1': { type: 'deferred_approval_response' } } },
                model_messages: [returnsRequest('partial', 'call-1')],
                parked: parkedRecord([deferral('call-2'), deferral('call-3')]),
            }),
        ];

        const open = findOpenParkedRun(runs);

        expect(open?.runId).toBe('partial');
        expect([...open!.toolCallIds]).toEqual(['call-2', 'call-3']);
    });

    it('keeps naming the parked run while a resume of it is running', () => {
        const runs = [
            run('parked', {
                status: 'parked',
                model_messages: [callsResponse('parked', 'call-1', 'call-2')],
                parked: parkedRecord([deferral('call-1'), deferral('call-2')]),
            }),
            run('resume', {
                status: 'in_progress',
                user_prompt: { content: '', resumes_run_id: 'parked' },
                model_messages: [returnsRequest('resume', 'call-1')],
            }),
        ];

        const open = findOpenParkedRun(runs);

        // The answered call has its result; the other card is still open.
        expect(open?.runId).toBe('parked');
        expect([...open!.toolCallIds]).toEqual(['call-2']);
    });

    it('passes over a later run without a transcript, as a resume that failed before its tools ran', () => {
        const runs = [
            run('parked', {
                status: 'parked',
                model_messages: [callsResponse('parked', 'call-1')],
                parked: parkedRecord([deferral('call-1')]),
            }),
            run('failed-resume', { status: 'error', user_prompt: { content: '', resumes_run_id: 'parked' } }),
        ];

        expect(findOpenParkedRun(runs)?.runId).toBe('parked');
    });

    it('is closed by a later run with a transcript, such as a message that superseded the cards', () => {
        const runs = [
            run('parked', {
                status: 'parked',
                model_messages: [callsResponse('parked', 'call-1')],
                parked: parkedRecord([deferral('call-1')]),
            }),
            run('superseding', { model_messages: [returnsRequest('superseding', 'call-1')] }),
        ];

        expect(findOpenParkedRun(runs)).toBeNull();
    });

    it('ignores a record of a version this client cannot read', () => {
        const runs = [
            run('parked', {
                status: 'parked',
                model_messages: [callsResponse('parked', 'call-1')],
                parked: parkedRecord([deferral('call-1')], 2),
            }),
        ];

        expect(findOpenParkedRun(runs)).toBeNull();
    });

    it('is null when every listed call already has a result', () => {
        const runs = [
            run('parked', {
                status: 'parked',
                model_messages: [callsResponse('parked', 'call-1'), returnsRequest('parked', 'call-1')],
                parked: parkedRecord([deferral('call-1')]),
            }),
        ];

        expect(findOpenParkedRun(runs)).toBeNull();
    });
});

describe('parkedCardRequests', () => {
    it('groups the open cards by how they are shown, leaving out answered ones', () => {
        const requests = parkedCardRequests([
            deferral('call-1'),
            deferral('call-2', 'ask_user_question'),
            deferral('call-3', 'batch_approval'),
            deferral('call-4', 'table_card'),
            deferral('call-5'),
        ], new Set(['call-5']));

        expect(requests.approvals.map((request) => request.toolcall_id)).toEqual(['call-1']);
        expect(requests.questions.map((request) => request.toolcall_id)).toEqual(['call-2']);
        expect(requests.batchApprovals.map((request) => request.toolcall_id)).toEqual(['call-3']);
        expect(requests.tableCards.map((request) => request.toolcall_id)).toEqual(['call-4']);
    });

    it('skips a card kind this client does not know', () => {
        const requests = parkedCardRequests([deferral('call-1', 'fill_job')]);

        expect(requests).toEqual({ approvals: [], questions: [], batchApprovals: [], tableCards: [] });
    });
});

describe('a parked run in the rest of the run state', () => {
    it('counts as a finished run', () => {
        expect(isRunFinished({ status: 'parked' })).toBe(true);
        expect(isRunFinished({ status: 'completed' })).toBe(true);
        expect(isRunFinished({ status: 'canceled' })).toBe(false);
    });

    it('renders an open call as waiting, not as an error', () => {
        expect(getToolCallStatusFromResult(undefined, 'parked')).toBe('in_progress');
        expect(getToolCallStatusFromResult(undefined, 'completed')).toBe('error');
    });

    it('takes its status and open cards from run_complete', () => {
        const parked = parkedRecord([deferral('call-1')]);
        const updated = updateRunComplete(run('live', { status: 'in_progress' }), {
            event: 'run_complete',
            run_id: 'live',
            usage: null,
            cost: null,
            citations: null,
            agent_actions: null,
            parked,
        });

        expect(updated.status).toBe('parked');
        expect(updated.parked).toBe(parked);
        expect(updateRunComplete(run('live', { status: 'in_progress' }), {
            event: 'run_complete', run_id: 'live', usage: null, cost: null, citations: null, agent_actions: null,
        }).status).toBe('completed');
    });

    it('is archived like a completed run when its done never arrived', () => {
        expect(lingeringCompletedRun(run('parked', { status: 'parked' }))?.id).toBe('parked');
    });

    it('chains the runs that answered it into one answer, following resumes_run_id alone', () => {
        const parked = run('parked', { status: 'parked' });
        const partial = run('partial', { status: 'parked', user_prompt: { content: '', resumes_run_id: 'parked' } });
        const last = run('last', { user_prompt: { content: '', resumes_run_id: 'partial' } });
        const all = [parked, partial, last];

        expect(collectResumeChain(last, all).map((entry) => entry.id)).toEqual(['parked', 'partial', 'last']);
        expect(findResumeChainRoot(last, all).id).toBe('parked');
    });

    it('gives way to the run that continued it', () => {
        const parked = run('parked', { status: 'parked' });

        expect(wasRunContinued(parked, new Set(['parked']))).toBe(true);
        expect(wasRunContinued(parked, new Set())).toBe(false);
    });

    it('notes a run shown as stopped that the server saved as parked', () => {
        const notes = replacementNotes(
            [run('run-1', { status: 'canceled' })],
            [run('run-1', { status: 'parked' })],
        );

        expect(notes.has('run-1')).toBe(true);
    });
});
