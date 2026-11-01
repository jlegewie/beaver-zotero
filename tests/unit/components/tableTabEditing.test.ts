// @vitest-environment jsdom

/**
 * The table tab's structural edits from the controls to the write: each UI
 * path hands the plugin's table commands the edit it means (sealed when it
 * is destructive, in the tab's session otherwise), asks before clearing the
 * user's answers, and shows the Undo toast, whose Undo is refused once the
 * table has moved on.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';
import type { Cell, TableSpec } from '@beaver/agent-core/layouts/table';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    targets: [] as any[],
}));

vi.mock('../../../src/utils/itemDisplayName', () => ({ getItemDisplayName: (item: any) => `Paper ${item.key}` }));
vi.mock('../../../react/components/ui/menus/AddSourcesMenu', () => ({
    default: React.forwardRef((props: any, _ref) => {
        mocks.targets.push(props.target);
        return React.createElement('button', { type: 'button', className: props.triggerClassName, disabled: props.disabled }, props.triggerLabel);
    }),
}));
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { searchableLibraryIdsAtom: atom([1]) };
});
vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveLibraryRef: (ref: { library_ref?: string }) => (ref.library_ref === 'u' ? 1 : null),
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : null),
}));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: (item: any) => item.kind ?? null,
}));
vi.mock('../../../src/ui/tableDocumentActions', () => ({
    tableActionErrorMessage: (error: any) => String(error?.message ?? error),
}));

import { setHost } from '@beaver/agent-ui/host';
import { ResearchTable } from '@beaver/agent-ui/layouts/research/ResearchTable';
import { useTableEditing } from '../../../react/components/tables/useTableEditing';

const h = React.createElement;
const ref = { libraryID: 1, key: 'TABLEKEY' };

const answer = (text: string, provenance: 'model' | 'user' = 'model'): Cell =>
    ({ outcome: 'answered', provenance, value: { kind: 'text', text } }) as Cell;
const reference = (name: string) =>
    ({ outcome: 'answered', provenance: 'system', value: { kind: 'reference', display_name: name, title: name } }) as Cell;

function spec(): TableSpec {
    return {
        id: 't',
        key: 'TABLEKEY',
        title: 'Cash transfers',
        anchor_column_id: '_reference',
        sources: [
            { id: 's1', type: 'items', ids: ['u-AAAA1111'] },
            { id: 's2', type: 'library', scope: { kind: 'collection', library_ref: 'u', key: 'COLL0001', name: 'Trials' } },
        ],
        removed: [{ ref: { kind: 'item', library_ref: 'u', zotero_key: 'GONE0001' }, removed_at: '2026-10-31T00:00:00Z' }],
        columns: [
            { id: '_reference', header: 'Reference', type: 'reference', system: true },
            { id: 'effect', header: 'Effect', type: 'text', description: 'What effect?' },
            { id: 'notes', header: 'Notes', type: 'text', description: 'Anything else?' },
        ],
        rows: [
            {
                id: 'r1',
                ref: { kind: 'item', library_ref: 'u', zotero_key: 'AAAA1111' },
                origin: [{ source: 's1', date: '2026-10-30' }],
                cells: { _reference: reference('Baird'), effect: answer('Enrollment rose.') },
            },
            {
                id: 'r2',
                ref: { kind: 'item', library_ref: 'u', zotero_key: 'BBBB2222' },
                origin: [{ source: 's2', date: '2026-10-30' }],
                cells: { _reference: reference('Haushofer'), effect: answer('My reading.', 'user'), notes: answer('A note.') },
            },
        ],
    } as TableSpec;
}

const commands = {
    edit: vi.fn(),
    editCells: vi.fn(),
    undo: vi.fn(),
};
const confirm = vi.fn(() => true);

function Harness({ table, readOnly, fillRunning }: { table: TableSpec; readOnly?: boolean; fillRunning?: boolean }) {
    const edits = useTableEditing({
        tableRef: ref,
        spec: table,
        disabledReason: readOnly ? 'This library is read-only.' : undefined,
        fillRunning: !!fillRunning,
        surfaceWindow: window,
        portalContainer: null,
        newBySource: new Map([['s2', 3]]),
    });
    return h(
        'div',
        null,
        h(ResearchTable, {
            table,
            editing: edits.editing,
            cellEditing: edits.cellEditing,
            selectionActions: edits.selectionActions,
            rowMenuItems: edits.rowMenuItems,
            banner: edits.toast ?? undefined,
            notice: edits.error ?? undefined,
        }),
        edits.overlay,
    );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(props: { table?: TableSpec; readOnly?: boolean; fillRunning?: boolean } = {}) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(h(Provider, { store: createStore() }, h(Harness, { table: props.table ?? spec(), ...props }))));
}

const $ = <T extends Element = HTMLElement>(selector: string) => container!.querySelector<T>(selector);
const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('nothing to click');
    await act(async () => (el as HTMLElement).click());
};
const menuItem = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>('*')).find((el) => el.textContent === label && el.children.length === 0);
const openColumnMenu = (header: string) => click($(`button[aria-label="Column menu: ${header}"]`));
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
const committed = (changes: unknown[], version = 5) => ({ ok: true, committed: true, version, sha256: 'hash-5', spec: spec(), changes });

beforeEach(() => {
    mocks.targets = [];
    commands.edit.mockReset();
    commands.editCells.mockReset();
    commands.undo.mockReset();
    confirm.mockReset();
    confirm.mockReturnValue(true);
    (globalThis as any).Zotero = {
        __beaverTables: { local: { commands: () => commands } },
        Libraries: { get: () => ({ name: 'My Library' }) },
        Collections: { getByLibraryAndKey: () => false, get: () => false },
        Tags: { getID: () => null },
        Items: { getByLibraryAndKeyAsync: async (_library: number, key: string) => ({ key, loadDataType: async () => {} }) },
    };
    setHost({ dialogs: { confirm } } as never);
});

afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    delete (globalThis as any).Zotero;
});

describe('ordinary edits', () => {
    it('renames the table in the tab session, without sealing or a toast', async () => {
        commands.edit.mockResolvedValue({ ...committed([{ op: 'title', title: 'New' }]) });
        mount();
        await click($('button[aria-label="Rename table"]'));
        const field = $<HTMLInputElement>('input[aria-label="Rename table"]')!;
        type(field, 'New');
        await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(commands.edit).toHaveBeenCalledWith(ref, { title: 'New' }, expect.objectContaining({ seal: false, session: expect.any(String) }));
        expect($('.rt-toast')).toBeNull();
    });

    it('adds a paper picked in + Papers and says what it added', async () => {
        commands.edit.mockResolvedValue(
            committed([{ op: 'add_source', source: 's1', type: 'items', rows_added: 1, rows_restored: 0, duplicates: 0, rejected: [] }]),
        );
        mount();
        const target = mocks.targets.at(-1);
        expect(target.isAttached({ isRegularItem: () => true, libraryID: 1, key: 'AAAA1111' })).toBe(true);
        await act(async () => target.addItem({ isRegularItem: () => true, libraryID: 1, key: 'CCCC3333', deleted: false }));
        expect(commands.edit).toHaveBeenCalledWith(ref, { add_sources: [{ type: 'items', ids: ['u-CCCC3333'] }] }, expect.objectContaining({ seal: false }));
        expect($('.rt-toast')?.textContent).toContain('Added 1 paper');
        expect($('.rt-toast-action')).toBeNull();
    });

    it('does not add a collection the table already has', async () => {
        mount();
        const target = mocks.targets.at(-1);
        (globalThis as any).Zotero.Collections.get = () => ({ libraryID: 1, key: 'COLL0001', name: 'Trials' });
        await act(async () => target.pickCollection(7));
        expect(commands.edit).not.toHaveBeenCalled();
        expect($('.rt-toast')?.textContent).toContain('Already in the table');
    });
});

describe('destructive edits and Undo', () => {
    it('removes a column without asking when no answer is the user’s, then undoes it', async () => {
        commands.edit.mockResolvedValue(committed([{ op: 'remove_column', column: 'notes', header: 'Notes', cleared: 1, user_cleared: 0 }]));
        commands.undo.mockResolvedValue({ ok: true, version: 6 });
        mount();
        await openColumnMenu('Notes');
        await click(menuItem('Remove column'));
        expect(confirm).not.toHaveBeenCalled();
        expect(commands.edit).toHaveBeenCalledWith(ref, { remove_columns: ['notes'] }, expect.objectContaining({ seal: true }));
        expect($('.rt-toast-text')?.textContent).toBe('Removed column “Notes” · 1 answer');
        await click($('.rt-toast-action'));
        expect(commands.undo).toHaveBeenCalledWith(ref, { version: 5, sha256: 'hash-5' });
        expect($('.rt-toast-text')?.textContent).toBe('Undone: Removed column “Notes” · 1 answer');
        expect($('.rt-toast-action')).toBeNull();
    });

    it('says Undo was refused once the table changed since', async () => {
        commands.edit.mockResolvedValue(committed([{ op: 'remove_rows', rows: 1 }]));
        commands.undo.mockResolvedValue({ ok: false, code: 'changed', message: 'The table has changed since; use version history.' });
        mount();
        await click($('tr[data-row-id="r1"] button[aria-label="Row actions"]'));
        await click(menuItem('Remove from table'));
        expect(commands.edit).toHaveBeenCalledWith(ref, { remove_rows: ['r1'] }, expect.objectContaining({ seal: true }));
        await click($('.rt-toast-action'));
        expect($('.rt-toast-text')?.textContent).toContain('The table has changed since; use version history.');
    });

    it('waits for a running fill before Undo', async () => {
        commands.edit.mockResolvedValue(committed([{ op: 'remove_rows', rows: 1 }]));
        mount({ fillRunning: true });
        await click($('tr[data-row-id="r1"] button[aria-label="Row actions"]'));
        await click(menuItem('Remove from table'));
        const undo = $<HTMLButtonElement>('.rt-toast-action')!;
        expect(undo.disabled).toBe(true);
        expect(undo.title).toBe('Undo is available when the fill ends.');
    });

    it('asks before removing rows that hold the user’s answers, and writes nothing when declined', async () => {
        confirm.mockReturnValue(false);
        mount();
        await click($('tr[data-row-id="r2"] button[aria-label="Select row"]'));
        await click($('.rt-selection-remove'));
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ text: 'They hold 1 answer you edited. They are removed with the rows.' }));
        expect(commands.edit).not.toHaveBeenCalled();
    });

    it('confirms a type change with what it clears and seals it', async () => {
        commands.edit.mockResolvedValue(committed([{ op: 'update_column', column: 'effect', header: 'Effect', fields: ['type'], stale: 0, cleared: 2, user_cleared: 1, relabelled: 0 }]));
        mount();
        await openColumnMenu('Effect');
        await act(async () => menuItem('Change type')!.click());
        await click(menuItem('Date'));
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Change “Effect” to Date?' }));
        expect(commands.edit).toHaveBeenCalledWith(ref, { update_columns: [{ id: 'effect', type: 'date' }] }, expect.objectContaining({ seal: true }));
    });

    it('opens the editor on the options when the new type is a category', async () => {
        mount();
        await openColumnMenu('Effect');
        await act(async () => menuItem('Change type')!.click());
        await click(menuItem('Category'));
        expect(commands.edit).not.toHaveBeenCalled();
        expect($('[role="dialog"][aria-label="Edit column"]')).not.toBeNull();
        expect($('.column-type-segments button[aria-pressed="true"]')?.textContent).toBe('Category');
    });
});

describe('the column editor', () => {
    it('asks what happens to existing answers when the question changes, and keeps them when told', async () => {
        commands.edit.mockResolvedValue(committed([]));
        mount();
        await openColumnMenu('Effect');
        await click(menuItem('Edit column…'));
        const question = $<HTMLTextAreaElement>('textarea[aria-label="Column question"]')!;
        type(question, 'What effect on attendance?');
        const fieldset = $('.rt-existing-answers')!;
        expect(fieldset.textContent).toContain('Mark out of date · 1 answer');
        expect(fieldset.textContent).toContain('Your 1 edited answer is kept.');
        // Preselected by the question hash: mark out of date.
        expect(fieldset.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].checked).toBe(true);
        await click(fieldset.querySelectorAll('input[type="radio"]')[0]);
        await click(Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Save'));
        expect(commands.edit).toHaveBeenCalledWith(
            ref,
            { update_columns: [{ id: 'effect', description: 'What effect on attendance?', existing_answers: 'keep' }] },
            expect.objectContaining({ seal: false }),
        );
        expect($('[aria-label="Edit column"]')).toBeNull();
    });

    it('does not promise "Nothing to fill" when the answers are already out of date', async () => {
        const table = spec();
        table.rows[0].cells.effect = { ...table.rows[0].cells.effect, stale: true } as Cell;
        mount({ table });
        await openColumnMenu('Effect');
        await click(menuItem('Edit column…'));
        type($<HTMLTextAreaElement>('textarea[aria-label="Column question"]')!, 'What effect on attendance?');
        expect($('.rt-existing-answers')!.textContent).toContain('Answers already out of date stay out of date.');
        expect($('.rt-existing-answers')!.textContent).not.toContain('Nothing to fill');
    });

    it('adds a column from (+), and keeps the editor open with the refusal', async () => {
        commands.edit.mockResolvedValue({ ok: false, code: 'invalid_edit', message: 'add_columns[0]: no room' });
        mount();
        await click($('button[aria-label="Add column"]'));
        type($<HTMLInputElement>('input[aria-label="Column name"]')!, 'Sample');
        type($<HTMLTextAreaElement>('textarea[aria-label="Column question"]')!, 'How many?');
        await click(Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Add column' && b.closest('.rt-dialog')));
        expect(commands.edit).toHaveBeenCalledWith(
            ref,
            { add_columns: [{ header: 'Sample', type: 'text', description: 'How many?' }] },
            expect.objectContaining({ seal: false }),
        );
        expect($('.rt-dialog-error')?.textContent).toBe('add_columns[0]: no room');
    });
});

describe('the sources popover', () => {
    it('adds new papers, removes a source and restores a removed paper', async () => {
        commands.edit.mockResolvedValue(committed([]));
        mount();
        await click($('.rt-sources-button'));
        const trials = $('[data-source-id="s2"]')!;
        expect(trials.textContent).toContain('Collection · My Library · 1 paper');
        expect(trials.textContent).toContain('3 new papers');
        await click(trials.querySelector('.rt-source-add'));
        expect(commands.edit).toHaveBeenLastCalledWith(ref, { refresh_sources: ['s2'] }, expect.objectContaining({ seal: false }));

        // The popover stays open through its own actions.
        await click($('button[aria-label="Remove source Trials"]'));
        // Its only row holds one of the user's answers.
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove “Trials”?' }));
        expect(commands.edit).toHaveBeenLastCalledWith(ref, { remove_sources: ['s2'] }, expect.objectContaining({ seal: true }));

        await act(async () => {});
        expect($('.rt-removed-title')?.textContent).toBe('Paper GONE0001');
        await click($('.rt-removed-restore'));
        expect(commands.edit).toHaveBeenLastCalledWith(ref, { add_sources: [{ type: 'items', ids: ['u-GONE0001'] }] }, expect.objectContaining({ seal: false }));
    });

    it("adds every source's new papers from the toolbar notice", async () => {
        commands.edit.mockResolvedValue(committed([]));
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        function WithNotice() {
            const edits = useTableEditing({
                tableRef: ref,
                spec: spec(),
                fillRunning: false,
                surfaceWindow: window,
                portalContainer: null,
                newBySource: new Map([['s2', 3]]),
            });
            return h(ResearchTable, { table: spec(), editing: edits.editing, newPapers: { count: 3, sources: 1, sourceName: 'Trials' } });
        }
        act(() => root!.render(h(Provider, { store: createStore() }, h(WithNotice))));
        await click($('.rt-new-papers-add'));
        expect(commands.edit).toHaveBeenCalledWith(ref, { refresh_sources: ['s2'] }, expect.objectContaining({ seal: false }));
    });
});

describe('a read-only library', () => {
    it('disables every edit control with the reason and writes nothing', async () => {
        mount({ readOnly: true });
        expect($<HTMLButtonElement>('button[aria-label="Rename table"]')!.disabled).toBe(true);
        expect($<HTMLButtonElement>('button[aria-label="Add column"]')!.disabled).toBe(true);
        expect($<HTMLButtonElement>('.rt-add-papers')!.disabled).toBe(true);
        await click($('.rt-sources-button'));
        expect($<HTMLButtonElement>('button[aria-label="Remove source Trials"]')!.disabled).toBe(true);
        expect($<HTMLButtonElement>('.rt-removed-restore')!.disabled).toBe(true);
        await click($('tr[data-row-id="r1"] button[aria-label="Select row"]'));
        expect($<HTMLButtonElement>('.rt-selection-remove')!.disabled).toBe(true);
        expect(commands.edit).not.toHaveBeenCalled();
    });
});

describe('cell edits', () => {
    const cellAt = (row: string, column: string) => $(`tr[data-row-id="${row}"] td[data-column-id="${column}"]`);
    const written = { ok: true, committed: true, version: 6, sha256: 'hash-6', spec: spec(), changes: [] };

    it("writes the user's answer in the tab session, with no toast", async () => {
        commands.editCells.mockResolvedValue(written);
        mount();
        await click(cellAt('r1', 'effect')!.querySelector('button[aria-label="Edit Effect"]'));
        type($<HTMLTextAreaElement>('.rt-cell-editor textarea')!, 'Enrollment rose 3.4 points.');
        await click(Array.from(container!.querySelectorAll('.rt-cell-editor button')).find((b) => b.textContent === 'Save'));
        expect(commands.editCells).toHaveBeenCalledWith(
            ref,
            [{ op: 'answer', row: 'r1', column: 'effect', value: { kind: 'text', text: 'Enrollment rose 3.4 points.' }, note: undefined }],
            { session: expect.any(String), change: 'Edited a cell in “Effect”' },
        );
        expect($('.rt-cell-editor')).toBeNull();
        expect($('.rt-toast')).toBeNull();
    });

    it("restores Beaver's answer from the inspector, and shows a refusal over the table", async () => {
        commands.editCells.mockResolvedValue({ ok: false, code: 'unknown_row', message: 'This row is no longer in the table.' });
        mount();
        await click(cellAt('r2', 'effect'));
        await click(Array.from(container!.querySelectorAll('.rt-inspector-action')).find((b) => b.textContent === 'Reset'));
        expect(commands.editCells).toHaveBeenCalledWith(ref, [{ op: 'restore', row: 'r2', column: 'effect' }], expect.objectContaining({ session: expect.any(String) }));
        expect(container!.textContent).toContain('This row is no longer in the table.');
    });

    it("chooses a row's document among the paper's readable attachments, guarded by the documents it showed", async () => {
        commands.editCells.mockResolvedValue(written);
        const attachments = [
            { id: 11, key: 'PDF00001', kind: 'pdf', attachmentFilename: 'Baird_2011.pdf', deleted: false, getField: () => '' },
            { id: 12, key: 'PDF00002', kind: 'pdf', attachmentFilename: 'Baird_2011_appendix.pdf', deleted: false, getField: () => '' },
            { id: 13, key: 'NOTE0001', kind: null, attachmentFilename: 'link', deleted: false, getField: () => '' },
        ];
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: async () => ({
                libraryID: 1,
                isRegularItem: () => true,
                getAttachments: () => [11, 12, 13],
                getBestAttachment: async () => attachments[0],
            }),
            getAsync: async () => attachments,
            loadDataTypes: async () => {},
        };
        const table = spec();
        table.rows[0].documents = ['u-PDF00001'];
        mount({ table });
        await click(container!.querySelector('tr[data-row-id="r1"] button[aria-label="Row actions"]'));
        await click(menuItem('Choose document…'));
        await act(async () => {});
        const dialog = $('.rt-document-chooser')!;
        expect(Array.from(dialog.querySelectorAll('.rt-document-choice-name')).map((n) => n.textContent)).toEqual([
            'Baird_2011.pdf',
            'Baird_2011_appendix.pdf',
        ]);
        expect(dialog.textContent).toContain('PDF · Current');
        await click(dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]);
        await click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Use this document'));
        expect(commands.editCells).toHaveBeenCalledWith(
            ref,
            [{ op: 'document', row: 'r1', document: 'u-PDF00002', expected: ['u-PDF00001'] }],
            expect.objectContaining({ session: expect.any(String) }),
        );
        expect($('.rt-document-chooser')).toBeNull();
        expect($('.rt-toast')?.textContent).toContain('Baird_2011_appendix.pdf');
    });
});
