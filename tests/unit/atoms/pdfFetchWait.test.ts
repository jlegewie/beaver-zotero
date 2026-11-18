import { describe, expect, it } from 'vitest';

import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { isRunWaitingOnlyOnPdfFetches } from '../../../react/atoms/pdfFetchWait';

const RUN = 'run-1';

function toolCall(id: string, toolName = 'create_items') {
    return { part_kind: 'tool-call', tool_call_id: id, tool_name: toolName, args: {} };
}

function toolReturn(id: string, toolName = 'create_items') {
    return { part_kind: 'tool-return', tool_call_id: id, tool_name: toolName, content: {} };
}

function run(parts: any[], returns: any[] = [], status: AgentRun['status'] = 'in_progress'): AgentRun {
    return {
        id: RUN,
        status,
        model_messages: [
            { kind: 'response', parts },
            ...(returns.length ? [{ kind: 'request', parts: returns }] : []),
        ],
    } as unknown as AgentRun;
}

function item(
    id: string,
    attachmentStatus: string,
    { status = 'applied', toolcallId = 'call-1', runId = RUN }: { status?: string; toolcallId?: string; runId?: string } = {},
): AgentAction {
    return {
        id,
        run_id: runId,
        toolcall_id: toolcallId,
        action_type: 'import_item',
        status,
        proposed_data: { item: { title: id } },
        result_data: status === 'applied'
            ? { library_id: 1, zotero_key: `KEY${id}`, attachment_status: attachmentStatus }
            : undefined,
    } as unknown as AgentAction;
}

describe('isRunWaitingOnlyOnPdfFetches', () => {
    it('holds while an open create_items call waits on a PDF fetch for an applied item', () => {
        const actions = [item('a', 'pending'), item('b', 'available')];
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')]), actions)).toBe(true);
    });

    it('holds when some items failed to be created', () => {
        const actions = [item('a', 'pending'), item('b', 'none', { status: 'error' })];
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')]), actions)).toBe(true);
    });

    it('holds while the approval of the waiting call is still held', () => {
        const actions = [item('a', 'pending')];
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')]), actions, ['call-1'])).toBe(true);
    });

    it('does not hold while an answer to another call is held', () => {
        const actions = [item('a', 'pending')];
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')]), actions, ['call-2'])).toBe(false);
    });

    it('does not hold before the items exist', () => {
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')]), [])).toBe(false);
    });

    it('does not hold while an item still waits to be applied', () => {
        const actions = [item('a', 'pending'), item('b', 'none', { status: 'pending' })];
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')]), actions)).toBe(false);
    });

    it('does not hold once no fetch is pending', () => {
        const actions = [item('a', 'available'), item('b', 'failed')];
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')]), actions)).toBe(false);
    });

    it('does not hold while another tool call is open', () => {
        const actions = [item('a', 'pending')];
        const parts = [toolCall('call-1'), toolCall('call-2', 'edit_metadata')];
        expect(isRunWaitingOnlyOnPdfFetches(run(parts), actions)).toBe(false);
    });

    it('ignores calls that already returned', () => {
        const actions = [item('a', 'pending', { toolcallId: 'call-2' })];
        const parts = [toolCall('call-1', 'edit_metadata'), toolCall('call-2')];
        expect(isRunWaitingOnlyOnPdfFetches(run(parts, [toolReturn('call-1', 'edit_metadata')]), actions)).toBe(true);
    });

    it('does not hold once the create_items call returned', () => {
        const actions = [item('a', 'pending')];
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')], [toolReturn('call-1')]), actions)).toBe(false);
    });

    it('only counts actions of this run', () => {
        const actions = [item('a', 'pending', { runId: 'run-0' })];
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')]), actions)).toBe(false);
    });

    it('does not hold for a run that is not streaming', () => {
        const actions = [item('a', 'pending')];
        expect(isRunWaitingOnlyOnPdfFetches(run([toolCall('call-1')], [], 'awaiting_deferred'), actions)).toBe(false);
    });
});
