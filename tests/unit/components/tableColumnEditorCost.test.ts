// @vitest-environment jsdom

/**
 * The tab's column editor says what filling the column it adds, or asks
 * anew, would read and cost at most, before any fill card does.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row, TableSpec } from '@beaver/agent-core/layouts/table';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../react/runtime/SurfaceWindowContext', () => ({
    useSurfaceWindow: () => window,
}));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return {
        profileWithPlanAtom: atom({}),
        remainingBeaverCreditsAtom: atom(6),
    };
});

import { TableColumnEditor } from '../../../react/components/tables/TableColumnEditor';
import { columnEditorDraft, newColumnDraft } from '../../../react/components/tables/tableTabEdits';

const answered = { outcome: 'answered', provenance: 'model', value: { kind: 'text', text: 'x' }, documents: ['u-A'] } as const;
const byUser = { outcome: 'answered', provenance: 'user', value: { kind: 'text', text: 'y' } } as const;

function spec(rows: Row[]): TableSpec {
    return {
        id: 't',
        title: 'Trials',
        columns: [
            { id: 'method', header: 'Method', type: 'text', description: 'Which method?' },
            { id: 'sample', header: 'Sample', type: 'text', description: 'How many?' },
        ],
        rows,
    };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as any).Zotero = {
        Beaver: { tableFills: { pricing: async () => ({ document: 0.35, title_abstract: 0.1 }) } },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

let opened = 0;

/** Opens the editor afresh: a new key, so no draft or choice carries over. */
async function open(props: Partial<React.ComponentProps<typeof TableColumnEditor>> & { spec: TableSpec }) {
    await act(async () => {
        root.render(
            React.createElement(TableColumnEditor, {
                key: ++opened,
                initial: newColumnDraft(),
                saving: false,
                onCancel: () => {},
                onSave: () => {},
                ...props,
            }),
        );
    });
}

const note = () => container.querySelector('.rt-hint[role="note"]')?.textContent ?? null;

describe('the column editor cost line', () => {
    it('prices a new column on a filled table as reading every item again', async () => {
        await open({ spec: spec([{ id: 'a', cells: { method: answered } }, { id: 'b', cells: { method: answered } }]) });
        expect(note()).toBe(
            'Filling this column reads up to 2 items again, at most 0.7 credits. Add your other columns first; one fill answers them all.',
        );
    });

    it('reads "again" from the filler\'s answers only, the edited column\'s own included', async () => {
        // Only the column being asked anew holds answers: its papers were read.
        const table = spec([{ id: 'a', cells: { method: answered } }, { id: 'b', cells: { method: answered } }]);
        const column = table.columns[0];
        const draft = columnEditorDraft(column);
        await open({ spec: table, column, initial: { ...draft, column: { ...draft.column, description: 'Which design?' } } });
        expect(note()).toContain('reads up to 2 items again');
        // Only some papers read (a trial): no "again".
        await open({ spec: spec([{ id: 'a', cells: { method: answered } }, { id: 'b', cells: {} }]) });
        expect(note()).toContain('Filling this column reads up to 2 items, at most');
        // An answer the user typed is no sign the paper was read.
        await open({ spec: spec([{ id: 'a', cells: { sample: byUser } }]) });
        expect(note()).toContain('Filling this column reads up to 1 item, at most');
    });

    it('drops "again" on a table never filled, and says nothing without rows', async () => {
        await open({ spec: spec([{ id: 'a', cells: {} }]) });
        expect(note()).toContain('Filling this column reads up to 1 item, at most 0.35 credits.');
        await open({ spec: spec([]) });
        expect(note()).toBeNull();
    });

    it('prices a new question only when its answers go out of date, leaving the user\'s own answers out', async () => {
        const table = spec([
            { id: 'a', cells: { method: answered, sample: answered } },
            { id: 'b', cells: { method: byUser, sample: answered } },
            { id: 'c', cells: { sample: answered } },
        ]);
        const column = table.columns[0];
        const draft = columnEditorDraft(column);
        await open({ spec: table, column, initial: { ...draft, column: { ...draft.column, description: 'Which design?' } } });
        // Mark out of date is preselected: every row but the user's answer is read again.
        expect(note()).toContain('Filling this column reads up to 2 items again');
        await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
        expect(note()).toBeNull();
        // Only the header: nothing to fill.
        await open({ spec: table, column, initial: { ...draft, column: { ...draft.column, header: 'Approach' } } });
        expect(note()).toBeNull();
    });
});
