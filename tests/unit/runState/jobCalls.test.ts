import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai/vanilla';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { JobResult } from '@beaver/agent-core/protocol/jobCallProtocol';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    fillStateFromRecord,
    fillStateFromResult,
    fillStateFromSnapshot,
    isStoppedJobResult,
    openJobCallsAtom,
    tableCallLine,
    tableCallText,
    withStoredJobResult,
} from '@beaver/agent-core/run-state/jobCalls';

const fill: JobResult = {
    kind: 'table_fill',
    job_id: 'job-1',
    status: 'done',
    progress: { state: 'done', rows_total: 12, rows_done: 12, rows_failed: 0, in_flight: 0, credits_charged: 2.4, credits_planned: 2.4, seconds_left: null },
    result: {
        rows_answered: 12, answered: 24, not_reported: 0, from_title_abstract: 0, documents_read: 12, credits_charged: 2.4,
        row_failures: {}, failed_row_ids: [], not_started: {}, not_written: 0, skipped_cells: {}, pending: null,
    },
};

function parkedRun(requests: Record<string, unknown>[]): AgentRun {
    return {
        id: 'run-1',
        thread_id: 'thread-1',
        status: 'completed',
        model_messages: [
            { kind: 'response', parts: requests.map((r) => ({ part_kind: 'tool-call', tool_name: r.tool_name, tool_call_id: r.tool_call_id, args: {} })) },
        ],
        parked: { version: 1, parked_at: '2026-11-15T12:00:00Z', reason: 'timeout', requests },
        user_prompt: { content: 'Fill it' },
    } as unknown as AgentRun;
}

const jobCall = {
    kind: 'table_fill',
    tool_call_id: 'call-1',
    tool_name: 'fill_table',
    correlation_id: 'job-1',
    request: { type: 'background_job', kind: 'table_fill', job_id: 'job-1' },
    state: { job_id: 'job-1', title: 'Trials', device_key: 'k' },
};
const question = {
    kind: 'ask_user_question',
    tool_call_id: 'call-2',
    tool_name: 'ask_user_question',
    correlation_id: 'q-1',
    request: { question_id: 'q-1' },
};

describe('job calls of the open thread', () => {
    it('are the open parked run calls of a job kind', () => {
        const store = createStore();
        store.set(threadRunsAtom, [parkedRun([jobCall, question])]);
        expect(store.get(openJobCallsAtom).map((call) => call.tool_call_id)).toEqual(['call-1']);
        expect(store.get(openJobCallsAtom)[0].result).toBeUndefined();
    });

    it('carry the result once it is stored on the parked call', () => {
        const store = createStore();
        const runs = [parkedRun([jobCall, question])];
        const patched = withStoredJobResult(runs, 'call-1', fill)!;
        expect(patched).not.toBeNull();
        expect(patched[0].parked!.requests[1]).toBe(runs[0].parked!.requests[1]);
        store.set(threadRunsAtom, patched);
        expect(store.get(openJobCallsAtom)[0].result).toEqual(fill);
    });

    it('read a result the user stopped as stopped', () => {
        expect(isStoppedJobResult({ ...fill, stopped: true })).toBe(true);
        expect(isStoppedJobResult(fill)).toBe(false);
        expect(isStoppedJobResult(null)).toBe(false);
    });

    it('patch nothing for a call no run parks, or a card', () => {
        const runs = [parkedRun([jobCall, question])];
        expect(withStoredJobResult(runs, 'nope', fill)).toBeNull();
        expect(withStoredJobResult(runs, 'call-2', fill)).toBeNull();
    });
});

describe('the table tool call line', () => {
    const snapshot = (overrides: Partial<TableFillJobSnapshot>): TableFillJobSnapshot => ({
        job_id: 'job-1',
        plan_id: 'plan-1',
        table: { libraryID: 1, key: 'TABLE001', title: 'Soil carbon studies' },
        origin: { kind: 'agent' },
        state: 'running',
        rows_total: 150,
        rows_done: 48,
        rows_failed: 3,
        in_flight: 2,
        credits_charged: 9,
        credits_planned: 30,
        balance: null,
        started_at: 0,
        seconds_left: null,
        ...overrides,
    });
    const result = (overrides: Record<string, unknown>) => ({ ...fill.result, ...overrides }) as any;
    const text = (state: Parameters<typeof tableCallLine>[1], tool = 'fill_table') =>
        tableCallText(tableCallLine(tool, state, 'Soil carbon studies'));

    it('names the tool and the table for a call without a fill', () => {
        expect(text(null, 'create_table')).toBe('Create Table Soil carbon studies');
        expect(text(null, 'edit_table')).toBe('Edit Table Soil carbon studies');
        expect(tableCallLine('edit_table', null, null)).toEqual({ label: 'Edit Table', text: null });
    });

    it('counts complete items, failed ones included, while this device runs the fill', () => {
        expect(text(fillStateFromSnapshot(snapshot({})))).toBe('Fill Table: 48 of 150 items complete (3 failed)');
        expect(text(fillStateFromSnapshot(snapshot({ rows_failed: 0 })), 'create_table')).toBe('Create Table: 48 of 150 items complete');
        expect(text(fillStateFromSnapshot(snapshot({ state: 'stopping' })))).toBe('Fill Table: 48 of 150 items complete (stopping, 3 failed)');
    });

    it('names the device that runs a fill elsewhere, without counts', () => {
        expect(text({ kind: 'elsewhere', device: 'Office iMac' })).toBe('Fill Table: running on Office iMac');
        expect(text({ kind: 'elsewhere' })).toBe('Fill Table: running');
        expect(text({ kind: 'started' })).toBe('Fill Table: running');
    });

    it('shows the title again once every item is complete without failures', () => {
        const clean = snapshot({ state: 'done', rows_done: 150, rows_failed: 0, result: result({ rows_answered: 150 }) });
        expect(text(fillStateFromSnapshot(clean))).toBe('Fill Table Soil carbon studies');
        expect(tableCallLine('fill_table', fillStateFromSnapshot(clean), 'Soil carbon studies')).toEqual({ label: 'Fill Table', text: 'Soil carbon studies' });
    });

    it('reads a finished fill with failures, a stopped one and an interrupted one', () => {
        const done = snapshot({ state: 'done', rows_done: 150, rows_failed: 3, result: result({ rows_answered: 147 }) });
        expect(text(fillStateFromSnapshot(done))).toBe('Fill Table: 150 of 150 items complete (3 failed)');
        const stopped = snapshot({ state: 'done', rows_done: 60, rows_failed: 0, result: result({ rows_answered: 60, stopped_by: 'stopped', not_started: { stopped: 90 } }) });
        expect(text(fillStateFromSnapshot(stopped))).toBe('Fill Table: 60 of 150 items complete (stopped)');
        const interrupted: JobResult = {
            ...fill,
            interrupted: true,
            progress: { ...fill.progress, rows_total: 150, rows_done: 62, rows_failed: 2 },
            result: result({ rows_answered: 60, stopped_by: 'shutdown' }),
        };
        expect(text(fillStateFromResult(interrupted), 'create_table')).toBe('Create Table: 62 of 150 items complete (interrupted, 2 failed)');
    });

    it('reads a Stop that came once every paper had started as filled', () => {
        const late = snapshot({ state: 'done', rows_done: 150, rows_failed: 0, result: result({ rows_answered: 150, stopped_by: 'stopped', not_started: {} }) });
        expect(fillStateFromSnapshot(late).kind).toBe('done');
    });

    it('reads a returned call from its recorded fill, counting items without input as failed', () => {
        const record = { rows: 150, rows_filled: 146, rows_failed: 3, rows_without_input: 1, rows_not_started: {}, stopped_by: null } as any;
        expect(text(fillStateFromRecord(record))).toBe('Fill Table: 150 of 150 items complete (4 failed)');
        const stopped = { ...record, rows_filled: 50, rows_failed: 0, rows_without_input: 0, stopped_by: 'stopped', rows_not_started: { stopped: 100 } };
        expect(text(fillStateFromRecord(stopped))).toBe('Fill Table: 50 of 150 items complete (stopped)');
        expect(fillStateFromRecord({ ...record, stopped_by: 'shutdown' }).kind).toBe('interrupted');
    });

});
