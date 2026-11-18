import { describe, expect, it } from 'vitest';
import { createStore } from 'jotai/vanilla';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import type { JobResult, PdfRetrievalJobResult } from '@beaver/agent-core/protocol/jobCallProtocol';
import { threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import {
    fillLabel,
    fillResultLine,
    fillSnapshotFromResult,
    fillTone,
    hasReadyJobCallAtom,
    isStoppedJobResult,
    pdfLabel,
    openJobCallsAtom,
    pdfResultSummary,
    pdfResultTone,
    withStoredJobResult,
} from '@beaver/agent-core/run-state/jobCalls';
import { resultSummary } from '@beaver/agent-core/run-state/tableFillCopy';

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
        expect(store.get(hasReadyJobCallAtom)).toBe(false);
    });

    it('become ready once a result is stored on the parked call', () => {
        const store = createStore();
        const runs = [parkedRun([jobCall, question])];
        const patched = withStoredJobResult(runs, 'call-1', fill)!;
        expect(patched).not.toBeNull();
        expect(patched[0].parked!.requests[1]).toBe(runs[0].parked!.requests[1]);
        store.set(threadRunsAtom, patched);
        expect(store.get(hasReadyJobCallAtom)).toBe(true);
        expect(store.get(openJobCallsAtom)[0].result).toEqual(fill);
    });

    it('do not continue the chat with a result the user stopped', () => {
        const store = createStore();
        store.set(threadRunsAtom, withStoredJobResult([parkedRun([jobCall, question])], 'call-1', { ...fill, stopped: true })!);
        expect(store.get(openJobCallsAtom)[0].result).toBeTruthy();
        expect(store.get(hasReadyJobCallAtom)).toBe(false);
    });

    it('patch nothing for a call no run parks, or a card', () => {
        const runs = [parkedRun([jobCall, question])];
        expect(withStoredJobResult(runs, 'nope', fill)).toBeNull();
        expect(withStoredJobResult(runs, 'call-2', fill)).toBeNull();
    });
});

describe('job results as the bar reads them', () => {
    it('reads a stored fill result with the fill copy', () => {
        if (fill.kind !== 'table_fill') throw new Error('fill');
        const snapshot = fillSnapshotFromResult(fill, { job_id: 'job-1', title: 'Trials' });
        expect(snapshot).toMatchObject({ state: 'done', rows_total: 12, table: { title: 'Trials' } });
        expect(resultSummary(snapshot)).toMatch(/12/);
    });

    it('summarizes PDF retrieval', () => {
        const pdf = (statuses: Array<'available' | 'failed' | 'pending'>, extra: Partial<PdfRetrievalJobResult> = {}, reason?: string): PdfRetrievalJobResult => ({
            kind: 'pdf_retrieval',
            job_id: 'job-2',
            status: 'done',
            items: statuses.map((attachment_status, index) => ({
                library_id: 1,
                zotero_key: `KEY0000${index}`,
                attachment_status,
                ...(attachment_status === 'failed' && reason ? { failure_reason: reason } : {}),
            })),
            ...extra,
        });
        expect(pdfResultSummary(pdf(['available', 'available']))).toBe('Found 2 PDFs');
        expect(pdfResultSummary(pdf(['available']))).toBe('Found 1 PDF');
        expect(pdfResultSummary(pdf(['available', 'failed', 'pending']))).toBe('Found 1 of 3 PDFs');
        expect(pdfResultSummary(pdf(['failed'], { interrupted: true }))).toBe('Zotero closed after 0 of 1 PDF');
        expect(pdfResultSummary(pdf(['available', 'failed'], { stopped: true }, 'cancelled'))).toBe('Stopped after 1 of 2 PDFs');
        expect(pdfLabel(pdf(['available', 'failed'], { stopped: true }, 'cancelled'))).toBe('PDF fetch stopped');
        expect(pdfLabel(pdf(['available']))).toBe('PDFs fetched');
        expect(pdfLabel()).toBe('Fetching PDFs');
        expect(pdfResultTone(pdf(['available']))).toBe('clean');
        expect(pdfResultTone(pdf(['available', 'failed']))).toBe('warning');
        expect(pdfResultTone(pdf(['failed']))).toBe('error');
        expect(isStoppedJobResult(pdf(['failed'], { stopped: true }, 'cancelled'))).toBe(true);
        // Only the user's Stop counts: a cancelled fetch alone does not.
        expect(isStoppedJobResult(pdf(['failed'], {}, 'cancelled'))).toBe(false);
    });

    it('reads a fill result as the bar says it, counting filled items', () => {
        if (fill.kind !== 'table_fill') throw new Error('fill');
        const result = (overrides: Record<string, unknown>) => ({ ...fill.result, ...overrides }) as any;
        expect(fillLabel()).toBe('Filling table');
        expect(fillLabel(fill.result)).toBe('Table filled');
        expect(fillResultLine(fill.result, 12)).toBe('Filled 12 items');
        expect(fillResultLine(result({ rows_answered: 11 }), 12)).toBe('Filled 11 of 12 items');
        expect(fillResultLine(result({ rows_answered: 6, stopped_by: 'stopped', not_started: { stopped: 4 } }), 12)).toBe('Stopped after 6 of 12 items');
        // A Stop that came once every item had started left nothing undone.
        expect(fillResultLine(result({ rows_answered: 10, stopped_by: 'stopped', not_started: {} }), 12)).toBe('Filled 10 of 12 items');
        expect(fillLabel(result({ stopped_by: 'stopped', not_started: {} }))).toBe('Table filled');
        expect(fillResultLine(result({ rows_answered: 6, stopped_by: 'insufficient_credits' }), 12)).toBe('Out of credits after 6 of 12 items');
        expect(fillResultLine(result({ rows_answered: 6, stopped_by: 'shutdown' }), 12)).toBe('Zotero closed after 6 of 12 items');
        expect(fillLabel(result({ stopped_by: 'stopped', not_started: { stopped: 4 } }))).toBe('Fill stopped');
        expect(fillTone(fill.result)).toBe('clean');
        expect(fillTone(result({ failed_row_ids: ['r1'] }))).toBe('warning');
        expect(isStoppedJobResult({ ...fill, result: result({ stopped_by: 'stopped' }), stopped: true })).toBe(true);
        expect(isStoppedJobResult({ ...fill, result: result({ stopped_by: 'shutdown' }) })).toBe(false);
    });
});
