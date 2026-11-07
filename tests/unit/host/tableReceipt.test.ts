import { describe, expect, it } from 'vitest';
import type { TableRecord } from '@beaver/agent-core/protocol/artifactProtocol';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import {
    editHeadline,
    tableReceiptModel,
    type TableReceiptInput,
    type TableReceiptLive,
} from '../../../react/host/zotero/components/reviewChanges/tableReceipt';

const record = (overrides: Partial<TableRecord> = {}): TableRecord => ({
    reference: { kind: 'table', key: 'u-TABLE001', title: 'Recorded title' },
    change: 'Created table',
    summary: { rows: 12 },
    ...overrides,
});

const live = (overrides: Partial<Extract<TableReceiptLive, { status: 'available' }>> = {}): TableReceiptLive => ({
    status: 'available',
    title: 'Legewie Research Publications',
    rows: 12,
    columns: 6,
    questions: 4,
    readRows: 12,
    failedRows: 0,
    fillRows: 0,
    emptyCells: 0,
    version: 3,
    blocked: null,
    ...overrides,
});

function model(overrides: Partial<TableReceiptInput> = {}) {
    return tableReceiptModel({
        record: record(),
        created: true,
        live: live(),
        job: null,
        undoAvailable: true,
        ...overrides,
    });
}

function job(overrides: Partial<TableFillJobSnapshot> = {}): TableFillJobSnapshot {
    return {
        job_id: 'job-1',
        plan_id: 'plan-1',
        table: { libraryID: 1, key: 'TABLE001', title: 'Trials' },
        origin: { kind: 'user' },
        state: 'running',
        rows_total: 12,
        rows_done: 5,
        rows_failed: 1,
        in_flight: 3,
        credits_charged: 1,
        credits_planned: 2.4,
        balance: 10,
        started_at: 1,
        seconds_left: 30,
        ...overrides,
    };
}

describe('the table receipt', () => {
    it('names a filled table with its size and offers Export and Open', () => {
        expect(model()).toMatchObject({
            headline: 'Legewie Research Publications',
            condition: '12 rows · 6 columns',
            warning: null,
            stop: false,
            export: true,
            open: true,
            undo: false,
        });
    });

    it('says a table nothing has read yet is unread, and offers Open but no Export', () => {
        const m = model({ live: live({ readRows: 0, fillRows: 12, emptyCells: 48 }) });
        expect(m).toMatchObject({ condition: '12 rows · nothing read yet', stop: false, export: false, open: true });
    });

    it('leads an edit with what changed, names the table and what is left to fill on line two, and offers Undo', () => {
        const edit = record({ edits: [{ op: 'add_column', column: 'c9', header: 'Limitation or caveat' }], version: 3 });
        const m = model({ record: edit, created: false, live: live({ fillRows: 12, emptyCells: 12 }) });
        expect(m.headline).toBe('Added column “Limitation or caveat”');
        expect(m.condition).toBe('Legewie Research Publications · 12 cells to fill');
        expect(m).toMatchObject({ undo: true, export: true, open: true });
    });

    it('offers Undo only while the table is as the edit left it', () => {
        const edit = record({ edits: [{ op: 'remove_rows', rows: 2 }], version: 3 });
        expect(model({ record: edit, created: false }).undo).toBe(true);
        expect(model({ record: edit, created: false, live: live({ version: 4 }) }).undo).toBe(false);
        expect(model({ record: edit, created: false, undoAvailable: false }).undo).toBe(false);
        expect(model({ record: edit, created: true }).undo).toBe(false);
    });

    it('reads as the fill runs, with Stop and Open but no Export of the half-filled table', () => {
        const m = model({ live: live({ fillRows: 12 }), job: job() });
        expect(m).toMatchObject({ condition: 'Reading 5 of 12 items', warning: '1 failed', stop: true, export: false, open: true });
        // A finished job leaves the table's own state to speak.
        expect(model({ job: job({ state: 'done' }) })).toMatchObject({ stop: false, export: true });
    });

    it('says how many items could not be read, with no retry', () => {
        const m = model({ live: live({ readRows: 9, failedRows: 3 }) });
        expect(m).toMatchObject({ condition: '9 of 12 items read', warning: "3 couldn't be read", stop: false, open: true });
    });

    it('puts the reason a table cannot be filled on line two', () => {
        const excluded = model({ live: live({ fillRows: 12, readRows: 0, blocked: 'library_excluded' }) });
        expect(excluded).toMatchObject({ condition: "12 rows · in a library Beaver can't read", open: true });
        const readOnly = model({ live: live({ fillRows: 12, readRows: 0, blocked: 'read_only' }) });
        expect(readOnly).toMatchObject({ condition: '12 rows · in a read-only library', open: true });
    });

    it('greys out a table that is gone and offers nothing', () => {
        expect(model({ live: { status: 'unavailable', reason: 'Table is in the trash.' } })).toMatchObject({
            headline: 'Recorded title',
            condition: 'Table is in the trash.',
            export: false,
            open: false,
            muted: true,
        });
    });

    it('keeps Open, but not Export, for a table whose files are not here yet', () => {
        const reason = 'Table files are not on this device yet. Opening the table downloads them.';
        expect(model({ live: { status: 'unavailable', reason, openable: true } })).toMatchObject({
            condition: reason,
            export: false,
            open: true,
            muted: false,
        });
    });

    it('shows the recorded size until the table has been read', () => {
        expect(model({ live: undefined })).toMatchObject({ headline: 'Recorded title', condition: '12 rows', export: false, open: false });
    });
});

describe('editHeadline', () => {
    it('words the first change and counts the rest', () => {
        expect(editHeadline({ edits: [{ op: 'remove_rows', rows: 2 }] })).toBe('Removed 2 rows');
        expect(
            editHeadline({
                edits: [
                    { op: 'title', title: 'New' },
                    { op: 'description' },
                    { op: 'remove_rows', rows: 1 },
                ],
            }),
        ).toBe('Renamed the table to “New” and 2 more changes');
        expect(editHeadline({ edits: [] })).toBeNull();
        expect(editHeadline({})).toBeNull();
    });
});
