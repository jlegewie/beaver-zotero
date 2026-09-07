/**
 * The closed-sidebar status popup's copy, derived from run state.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import type { AgentRun, ModelResponse, ToolCallPart, ToolReturnPart } from '@beaver/agent-core/agents/types';
import type { ToolResult } from '@beaver/agent-core/run-state/atoms';
import type { PendingApproval } from '@beaver/agent-ui/host';
import {
    deriveRunActivity,
    describePendingApprovals,
    threadDisplayName,
} from '../../../../react/components/runStatusPopup/runStatusPopupModel';

function toolCall(id: string, toolName = 'read', args: Record<string, any> = {}): ToolCallPart {
    return { part_kind: 'tool-call', tool_name: toolName, args, tool_call_id: id };
}

function toolReturn(id: string, toolName = 'read'): ToolReturnPart {
    return { part_kind: 'tool-return', tool_name: toolName, content: {}, tool_call_id: id };
}

function response(parts: ModelResponse['parts']): ModelResponse {
    return { kind: 'response', run_id: 'run-1', parts };
}

function run(messages: AgentRun['model_messages'], status: AgentRun['status'] = 'in_progress'): AgentRun {
    return {
        id: 'run-1',
        user_id: 'user-1',
        thread_id: 'thread-1',
        agent_name: 'beaver',
        user_prompt: { content: 'Summarize the neighborhood effects literature', attachments: [] } as any,
        status,
        model_messages: messages,
        model_name: 'test',
        created_at: '2026-09-06T10:00:00.000Z',
        consent_to_share: false,
    };
}

function results(...parts: ToolReturnPart[]): ReadonlyMap<string, ToolResult> {
    return new Map(parts.map((part) => [part.tool_call_id, part]));
}

describe('deriveRunActivity', () => {
    it('reads as thinking before the run has produced anything', () => {
        expect(deriveRunActivity(run([]), results())).toEqual({ kind: 'thinking' });
    });

    it('reads as thinking while reasoning is the only thing in the response', () => {
        const r = run([response([{ part_kind: 'thinking', content: 'Let me see' }])]);
        expect(deriveRunActivity(r, results())).toEqual({ kind: 'thinking' });
    });

    it('reads as generating while the newest part is streamed text', () => {
        const r = run([response([
            { part_kind: 'thinking', content: 'Let me see' },
            { part_kind: 'text', content: 'Neighborhood effects are' },
        ])]);
        expect(deriveRunActivity(r, results())).toEqual({ kind: 'generating' });
    });

    it('names a tool call that is still waiting on its result', () => {
        const call = toolCall('tc-1', 'fulltext_search');
        const r = run([response([{ part_kind: 'text', content: 'Searching.' }, call])]);
        expect(deriveRunActivity(r, results())).toEqual({ kind: 'tool', part: call });
    });

    it('names the newest of several parallel calls', () => {
        const first = toolCall('tc-1', 'read');
        const second = toolCall('tc-2', 'read_note');
        const r = run([response([first, second])]);
        expect(deriveRunActivity(r, results())).toEqual({ kind: 'tool', part: second });
    });

    it('goes back to thinking once every call has returned and the model has not answered', () => {
        const call = toolCall('tc-1');
        const r = run([
            response([call]),
            { kind: 'request', run_id: 'run-1', parts: [toolReturn('tc-1')], instructions: '' },
        ]);
        expect(deriveRunActivity(r, results(toolReturn('tc-1')))).toEqual({ kind: 'thinking' });
    });

    it('ignores auto-loading calls and suggestion chips', () => {
        const r = run([response([
            { part_kind: 'text', content: 'Done.' },
            toolCall('auto_load_1', 'load_tool_results'),
            toolCall('tc-9', 'return_suggestions'),
        ])]);
        expect(deriveRunActivity(r, results())).toEqual({ kind: 'generating' });
    });
});

describe('threadDisplayName', () => {
    it('prefers the backend name', () => {
        expect(threadDisplayName('Neighborhood effects', run([]))).toBe('Neighborhood effects');
    });

    it('falls back to the prompt, cut to a title length', () => {
        const r = run([]);
        r.user_prompt.content = 'A'.repeat(80);
        expect(threadDisplayName(null, r)).toBe(`${'A'.repeat(59)}…`);
        expect(threadDisplayName('  ', run([]))).toBe('Summarize the neighborhood effects literature');
    });

    it('has a name for a thread with nothing yet', () => {
        expect(threadDisplayName(null, null)).toBe('New chat');
    });
});

function approval(actionId: string, actionType: string, actionData: Record<string, any> = {}): PendingApproval {
    return { actionId, toolcallId: `tc-${actionId}`, actionType: actionType as any, actionData };
}

describe('describePendingApprovals', () => {
    it('labels one request like its card, with the title when known', () => {
        expect(describePendingApprovals([approval('a', 'edit_metadata')], 'Smith 2014')).toEqual({
            label: 'Edit · Smith 2014',
            count: 1,
            confirmOnly: false,
        });
        expect(describePendingApprovals([approval('a', 'create_note')], null).label).toBe('Create Note');
    });

    it('tallies several requests behind a count', () => {
        const summary = describePendingApprovals([
            approval('a', 'edit_metadata'),
            approval('b', 'edit_metadata'),
            approval('c', 'create_note'),
        ], null);
        expect(summary).toEqual({ label: '3 changes · Edit ×2, Create Note', count: 3, confirmOnly: false });
    });

    it('knows when every request is a confirmation rather than a change', () => {
        expect(describePendingApprovals([approval('a', 'confirm_extraction', { attachment_count: 12 })], null)).toEqual({
            label: 'Extract',
            count: 1,
            confirmOnly: true,
        });
        // The confirmation's title carries the whole line; no verb in front.
        expect(describePendingApprovals(
            [approval('a', 'confirm_extraction', { attachment_count: 12 })],
            'Confirm 12 Item Batch Processing',
        ).label).toBe('Confirm 12 Item Batch Processing');
        const both = describePendingApprovals([
            approval('a', 'confirm_extraction'),
            approval('b', 'confirm_external_search'),
        ], null);
        expect(both.label).toBe('2 confirmations · Extract, Search');
        expect(both.confirmOnly).toBe(true);
    });
});
