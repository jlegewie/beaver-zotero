import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai/vanilla';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { JobResult } from '@beaver/agent-core/protocol/jobCallProtocol';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    fillCallLine,
    fillCallText,
    fillStateFromRecord,
    fillStateFromResult,
    fillStateFromSnapshot,
    isStoppedJobResult,
    openJobCallsAtom,
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

describe('the fill tool call line', () => {
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
    const text = (state: Parameters<typeof fillCallLine>[0]) => fillCallText(fillCallLine(state, 'Soil carbon studies'));

    it('counts filled items while this device runs the fill', () => {
        expect(text(fillStateFromSnapshot(snapshot({})))).toBe('Filling Soil carbon studies: 45 of 150 items · 3 failed');
        expect(text(fillStateFromSnapshot(snapshot({ rows_done: 45, rows_failed: 0 })))).toBe('Filling Soil carbon studies: 45 of 150 items');
    });

    it('names the device that runs a fill elsewhere, without counts', () => {
        expect(text({ kind: 'elsewhere', device: 'Office iMac' })).toBe('Filling Soil carbon studies on Office iMac');
        expect(text({ kind: 'elsewhere' })).toBe('Filling Soil carbon studies');
    });

    it('reads a finished, stopped and interrupted fill', () => {
        const done = snapshot({ state: 'done', rows_done: 150, rows_failed: 3, result: result({ rows_answered: 147 }) });
        expect(text(fillStateFromSnapshot(done))).toBe('Filled Soil carbon studies: 147 of 150 items · 3 failed');
        const stopped = snapshot({ state: 'done', rows_done: 60, rows_failed: 0, result: result({ rows_answered: 60, stopped_by: 'stopped', not_started: { stopped: 90 } }) });
        expect(text(fillStateFromSnapshot(stopped))).toBe('Stopped filling Soil carbon studies: 60 of 150 items');
        const interrupted: JobResult = {
            ...fill,
            interrupted: true,
            progress: { ...fill.progress, rows_total: 150, rows_done: 60, rows_failed: 0 },
            result: result({ rows_answered: 60, stopped_by: 'shutdown' }),
        };
        expect(text(fillStateFromResult(interrupted))).toBe('Fill interrupted: 60 of 150 items');
    });

    it('reads a Stop that came once every paper had started as filled', () => {
        const late = snapshot({ state: 'done', rows_done: 150, rows_failed: 0, result: result({ rows_answered: 150, stopped_by: 'stopped', not_started: {} }) });
        expect(fillStateFromSnapshot(late).kind).toBe('done');
    });

    it('reads a returned call from its recorded fill', () => {
        const record = { rows: 150, rows_filled: 147, rows_failed: 3, rows_not_started: {}, stopped_by: null } as any;
        expect(text(fillStateFromRecord(record))).toBe('Filled Soil carbon studies: 147 of 150 items · 3 failed');
        expect(fillStateFromRecord({ ...record, stopped_by: 'stopped', rows_not_started: { stopped: 2 } }).kind).toBe('stopped');
        expect(fillStateFromRecord({ ...record, stopped_by: 'shutdown' }).kind).toBe('interrupted');
    });

});
