// @vitest-environment jsdom

/**
 * The table receipt under an answer, and the stream line it replaces as the
 * place to act: Undo, Stop, then Export and Open as icons; no Fill. Undo
 * takes back the version the edit committed for the run that made it, and
 * the stream line carries no actions.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableArtifact } from '@beaver/agent-core/run-state/tableResults';
import type { TableReceiptState } from '../../../react/host/zotero/components/reviewChanges/useTableReceiptState';

const state = vi.hoisted(() => ({ current: null as unknown as TableReceiptState }));
vi.mock('../../../react/host/zotero/components/reviewChanges/useTableReceiptState', () => ({
    useTableReceiptState: () => state.current,
}));
vi.mock('../../../react/components/agentRuns/ToolResultView', () => ({ tableMessages: () => [] }));
const exportTable = vi.hoisted(() => vi.fn());
vi.mock('../../../src/ui/tableDocumentActions', () => ({
    exportTable,
    tableActionErrorMessage: (error: { message?: string }) => error?.message ?? String(error),
}));
const commands = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../../src/services/artifacts/tablesApi', () => ({
    getTablesApi: () => ({ local: { commands: () => commands } }),
}));

import { setHost } from '@beaver/agent-ui/host';
import { TableArtifactRow } from '../../../react/host/zotero/components/reviewChanges/TableArtifactRow';
import { TableToolCallView } from '../../../react/components/agentRuns/TableToolCallView';
import { setToolExpandedAtom } from '../../../react/atoms/messageUIState';
import { SurfaceWindowContext } from '../../../react/runtime/SurfaceWindowContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const undoTableEdit = vi.fn();
const openTable = vi.fn();
const stop = vi.fn();

const available = {
    status: 'available' as const,
    title: 'Cash transfers',
    rows: 12,
    columns: 6,
    questions: 4,
    readRows: 12,
    failedRows: 0,
    fillRows: 0,
    emptyCells: 0,
    version: 7,
    blocked: null,
};

function artifact(overrides: Partial<TableArtifact['record']> = {}, created = false): TableArtifact {
    return {
        runId: 'run-1',
        toolcallId: 'call',
        recordRunId: 'run-2',
        created,
        record: {
            reference: { kind: 'table', key: 'u-TABLEKEY', title: 'Cash transfers' },
            change: 'Edited table',
            summary: { rows: 12 },
            version: 7,
            edits: [{ op: 'remove_rows', rows: 2 }],
            ...overrides,
        },
    };
}

function mount(element: React.ReactElement, store = createStore()) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(h(Provider, { store }, h(SurfaceWindowContext.Provider, { value: window }, element))));
}

/** The receipt's actions, by their text or, for icons, their label. */
const buttons = () =>
    Array.from(container!.querySelectorAll('.table-receipt-actions button')).map(
        (b) => b.textContent?.trim() || b.getAttribute('aria-label'),
    );
const button = (label: string) =>
    Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

beforeEach(() => {
    vi.clearAllMocks();
    setHost({ navigation: { undoTableEdit, openTable, revealInLibrary: vi.fn() } as never });
    openTable.mockResolvedValue({ ok: true });
    exportTable.mockResolvedValue('Cash transfers.xlsx');
    state.current = { ref: { libraryID: 1, key: 'TABLEKEY' }, live: available, job: null };
    (globalThis as any).Zotero.Beaver = { tableFills: { stop } };
});

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    delete (globalThis as any).Zotero.Beaver;
});

describe('the table receipt', () => {
    it('offers Export and Open icons on a filled table, and opens from its lines too', async () => {
        mount(h(TableArtifactRow, { row: artifact({ edits: null }, true) }));
        expect(buttons()).toEqual(['Export', 'Open table']);
        await act(async () => (container!.querySelector('button[aria-label="Open table"]') as HTMLButtonElement).click());
        await act(async () => (container!.querySelector('button.table-receipt-target') as HTMLButtonElement).click());
        expect(openTable).toHaveBeenCalledTimes(2);
        expect(openTable.mock.calls[0][0]).toBe('u-TABLEKEY');
    });

    it('exports the table as Excel or CSV through the table\'s own export', async () => {
        mount(h(TableArtifactRow, { row: artifact({ edits: null }, true) }));
        await act(async () => (container!.querySelector('button[aria-label="Export"]') as HTMLButtonElement).click());
        const item = (text: string) =>
            [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.startsWith(text));
        expect(item('Excel…')).toBeTruthy();
        expect(item('CSV…')).toBeTruthy();
        await act(async () => item('CSV…')!.click());
        expect(exportTable).toHaveBeenCalledWith(window, { libraryID: 1, key: 'TABLEKEY' }, expect.any(Function), 'csv');
    });

    it('says why an export failed', async () => {
        exportTable.mockRejectedValue(new Error('Excel export is unavailable right now.'));
        mount(h(TableArtifactRow, { row: artifact({ edits: null }, true) }));
        await act(async () => (container!.querySelector('button[aria-label="Export"]') as HTMLButtonElement).click());
        const excel = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.startsWith('Excel…'));
        await act(async () => excel!.click());
        expect(container!.querySelector('[role="status"]')?.textContent).toBe('Excel export is unavailable right now.');
    });

    it('offers no Fill: an unread table says so, and leads to the table to fill it', () => {
        state.current = { ...state.current, live: { ...available, readRows: 0, fillRows: 12, emptyCells: 12 } };
        mount(h(TableArtifactRow, { row: artifact({ edits: [{ op: 'add_column', column: 'c', header: 'Limitation' }] }) }));
        expect(buttons()).toEqual(['Undo', 'Open table']);
        expect(container!.textContent).toContain('Added column “Limitation”');
        expect(container!.textContent).toContain('Cash transfers · 12 rows · nothing read yet');
    });

    it('takes back the version the edit committed, for the run that made it, and says so', async () => {
        undoTableEdit.mockResolvedValue({ ok: true });
        mount(h(TableArtifactRow, { row: artifact() }));
        expect(buttons()).toEqual(['Undo', 'Export', 'Open table']);
        await act(async () => button('Undo')!.click());
        expect(undoTableEdit).toHaveBeenCalledWith('u-TABLEKEY', { version: 7, runId: 'run-2' }, window);
        expect(button('Undo')).toBeUndefined();
        expect(container!.textContent).toContain('Undone. The table is back to the version before this edit.');
    });

    it('shows why Undo was refused, and keeps it for a later try', async () => {
        undoTableEdit.mockResolvedValue({ error: 'Undo is available when the fill ends.' });
        mount(h(TableArtifactRow, { row: artifact() }));
        await act(async () => button('Undo')!.click());
        expect(container!.textContent).toContain('Undo is available when the fill ends.');
        expect(button('Undo')).toBeDefined();
    });

    it('offers no Undo once the table has moved on from the edit, or for a creation', () => {
        state.current = { ...state.current, live: { ...available, version: 8 } };
        mount(h(TableArtifactRow, { row: artifact() }));
        expect(button('Undo')).toBeUndefined();
        act(() => root?.unmount());
        container?.remove();
        state.current = { ...state.current, live: available };
        mount(h(TableArtifactRow, { row: artifact({}, true) }));
        expect(button('Undo')).toBeUndefined();
    });

    it('stops a running fill from the receipt', async () => {
        state.current = {
            ...state.current,
            job: {
                job_id: 'job-1',
                plan_id: 'plan-1',
                table: { libraryID: 1, key: 'TABLEKEY', title: 'Cash transfers' },
                origin: { kind: 'user' },
                state: 'running',
                rows_total: 12,
                rows_done: 5,
                rows_failed: 0,
                in_flight: 2,
                credits_charged: 1,
                credits_planned: 2.4,
                balance: 10,
                started_at: 1,
                seconds_left: 30,
            },
        };
        mount(h(TableArtifactRow, { row: artifact({ edits: null }, true) }));
        expect(container!.textContent).toContain('Reading 5 of 12 items');
        expect(container!.querySelector('[role="progressbar"]')).toBeTruthy();
        expect(buttons()).toEqual(['Stop', 'Open table']);
        await act(async () => button('Stop')!.click());
        expect(stop).toHaveBeenCalledWith('job-1');
    });

    it('offers nothing for a table that is gone', () => {
        state.current = { ...state.current, live: { status: 'unavailable', reason: 'Table is in the trash.' } };
        mount(h(TableArtifactRow, { row: artifact({ edits: null }, true) }));
        expect(buttons()).toEqual([]);
        expect(container!.querySelector('button.table-receipt-target')).toBeNull();
        expect(container!.textContent).toContain('Table is in the trash.');
    });
});

describe('the stream line of a table write', () => {
    it('records what happened with no actions, and expands to the call summary', () => {
        const store = createStore();
        store.set(setToolExpandedAtom, { key: 'run-1:0:call', expanded: true });
        const result = {
            part_kind: 'tool-return',
            tool_name: 'edit_table',
            tool_call_id: 'call',
            content: { ok: true },
            metadata: { view: { view_type: 'table', record: artifact().record } },
        };
        mount(
            h(TableToolCallView, {
                part: { part_kind: 'tool-call', tool_name: 'edit_table', tool_call_id: 'call', args: {} } as never,
                result: result as never,
                runId: 'run-1',
                responseIndex: 0,
                runStatus: 'completed' as never,
            }),
            store,
        );
        expect(container!.textContent).toContain('Edited the table');
        expect(container!.textContent).toContain('Cash transfers');
        expect(button('Undo')).toBeUndefined();
        expect(button('Open table')).toBeUndefined();
        expect(container!.querySelector('[aria-label="Open table"]')).toBeNull();
        expect(container!.querySelector('#tool-result-call')).toBeTruthy();
    });
});
