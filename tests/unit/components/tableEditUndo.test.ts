// @vitest-environment jsdom

/**
 * Undo on the `edit_table` tool display: it asks the host to take back the
 * version the call committed, for the run that made it, and then says what
 * happened instead of offering Undo again.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../../react/components/agentRuns/ToolResultView', () => ({ tableMessages: () => [] }));

import { setHost } from '@beaver/agent-ui/host';
import { TableToolCallView } from '../../../react/components/agentRuns/TableToolCallView';
import { setToolExpandedAtom } from '../../../react/atoms/messageUIState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const undoTableEdit = vi.fn();

const record = (tool: string, edits: unknown[]) => ({
    part_kind: 'tool-return',
    tool_name: tool,
    tool_call_id: 'call',
    content: { ok: true },
    metadata: {
        view: {
            view_type: 'table',
            record: {
                reference: { kind: 'table', key: 'u-TABLEKEY', title: 'Cash transfers' },
                change: 'Edited table',
                summary: { rows: 2 },
                version: 7,
                edits,
            },
        },
    },
});

function mount(tool: string, edits: unknown[]) {
    const store = createStore();
    store.set(setToolExpandedAtom, { key: 'run-1:0:call', expanded: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
        root!.render(
            h(
                Provider,
                { store },
                h(TableToolCallView, {
                    part: { part_kind: 'tool-call', tool_name: tool, tool_call_id: 'call', args: {} } as never,
                    result: record(tool, edits) as never,
                    runId: 'run-1',
                    responseIndex: 0,
                    runStatus: 'completed' as never,
                }),
            ),
        ),
    );
}

const undoButton = () => Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Undo');

beforeEach(() => {
    undoTableEdit.mockReset();
    setHost({ navigation: { undoTableEdit, openTable: vi.fn(), revealInLibrary: vi.fn() } as never });
});

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
});

it('takes back the version the call committed, for its run, and says so', async () => {
    undoTableEdit.mockResolvedValue({ ok: true });
    mount('edit_table', [{ op: 'remove_rows', rows: 2 }]);
    await act(async () => undoButton()!.click());
    expect(undoTableEdit).toHaveBeenCalledWith('u-TABLEKEY', { version: 7, runId: 'run-1' }, window);
    expect(undoButton()).toBeUndefined();
    expect(container!.textContent).toContain('Undone. The table is back to the version before this edit.');
});

it('shows why Undo was refused, and keeps it for a later try', async () => {
    undoTableEdit.mockResolvedValue({ error: 'Undo is available when the fill ends.' });
    mount('edit_table', [{ op: 'remove_rows', rows: 2 }]);
    await act(async () => undoButton()!.click());
    expect(container!.textContent).toContain('Undo is available when the fill ends.');
    expect(undoButton()).toBeDefined();
});

it('offers no Undo for a call that changed nothing, or for another table tool', () => {
    mount('edit_table', []);
    expect(undoButton()).toBeUndefined();
    act(() => root?.unmount());
    container?.remove();
    mount('create_table', [{ op: 'title', title: 'X' }]);
    expect(undoButton()).toBeUndefined();
});
