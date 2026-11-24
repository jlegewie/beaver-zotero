// @vitest-environment jsdom
/**
 * The table view's native menu commands: what the menus show for the table on
 * screen, and each command reaching the control the toolbar would use, only
 * when that control could act now.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/components/tables/TableFillControl', () => ({ TRIAL_ROWS: 5 }));

import {
    runTableViewCommand,
    tableViewAvailability,
    tableViewMenuState,
    type TableViewCommandContext,
} from '../../../react/components/tables/tableViewCommands';

function view(overrides: Record<string, unknown> = {}) {
    return {
        viewState: vi.fn(() => ({
            density: 'compact',
            hiddenColumns: 1,
            filtered: true,
            sorted: true,
            selectedRowIds: ['r1', 'r2'],
            rows: 4,
            searchable: true,
            hasSelectedText: true,
            canCopy: true,
            canExport: true,
            hasVersionHistory: true,
            canEditSources: true,
            ...overrides,
        })),
        setDensity: vi.fn(),
        showHiddenColumns: vi.fn(),
        clearFilters: vi.fn(),
        clearSort: vi.fn(),
        showVersionHistory: vi.fn(),
        copyAsText: vi.fn(),
        exportTable: vi.fn(),
        focusSearch: vi.fn(),
        selectAllRows: vi.fn(),
        copySelection: vi.fn(() => true),
        openSources: vi.fn(),
    };
}

let context: TableViewCommandContext & { view: ReturnType<typeof view> };

beforeEach(() => {
    const host = document.createElement('div');
    const add = document.createElement('button');
    add.className = 'rt-add-papers';
    host.appendChild(add);
    context = {
        view: view(),
        host,
        editDisabled: false,
        sourcesEditable: true,
        canUndo: true,
        undo: vi.fn(),
        canAddColumn: true,
        addColumn: vi.fn(),
        newItems: 3,
        addNewItems: vi.fn(),
        removeRows: vi.fn(),
        fillRunning: false,
        openFillPlan: vi.fn(),
        stopFill: vi.fn(),
        showInLibrary: vi.fn(),
        askBeaver: vi.fn(),
    };
});

describe('the menu state', () => {
    it("offers what the table can do now, with the view's row height", () => {
        const state = tableViewMenuState(context);
        expect(state.density).toBe('compact');
        expect(state.enabled).toMatchObject({
            'export-csv': true,
            'copy-selection': true,
            'show-hidden-columns': true,
            'clear-filters': true,
            'clear-sort': true,
            undo: true,
            'add-items': true,
            'add-column': true,
            'add-new-items': true,
            'fill-pending': true,
            'fill-selected': true,
            'fill-stop': false,
            'remove-selected': true,
            'show-in-library': true,
            'ask-beaver': true,
        });
    });

    it('offers nothing before the table has rendered', () => {
        const state = tableViewMenuState({ ...context, view: null });
        expect(state.density).toBeNull();
        expect(Object.values(state.enabled).every((on) => !on)).toBe(true);
    });

    it('keeps reading and exporting but no edits or fills while edits are refused', () => {
        (context.host!.querySelector('button') as HTMLButtonElement).disabled = true;
        const enabled = tableViewAvailability({ ...context, editDisabled: true, fillRunning: true, sourcesEditable: false });
        expect(enabled).toMatchObject({
            'export-xlsx': true,
            'version-history': true,
            'add-items': false,
            'add-column': false,
            'remove-selected': false,
            'fill-pending': false,
            'fill-stop': true,
            sources: false,
        });
    });

    it('keeps Find while the search or filters hide every row', () => {
        context.view = view({ rows: 0, filtered: true });
        const enabled = tableViewAvailability(context);
        expect(enabled.find).toBe(true);
        expect(enabled['select-all-rows']).toBe(false);
        expect(tableViewAvailability({ ...context, view: view({ rows: 0, searchable: false }) }).find).toBe(false);
    });

    it('offers no Ask Beaver without a chat to ask in', () => {
        expect(tableViewAvailability({ ...context, askBeaver: undefined })['ask-beaver']).toBe(false);
    });
});

describe('running a command', () => {
    it.each([
        ['export-xlsx', (v: any) => expect(v.exportTable).toHaveBeenCalledWith('xlsx')],
        ['export-csv', (v: any) => expect(v.exportTable).toHaveBeenCalledWith('csv')],
        ['copy-text', (v: any) => expect(v.copyAsText).toHaveBeenCalled()],
        ['select-all-rows', (v: any) => expect(v.selectAllRows).toHaveBeenCalled()],
        ['find', (v: any) => expect(v.focusSearch).toHaveBeenCalled()],
        ['density-tall', (v: any) => expect(v.setDensity).toHaveBeenCalledWith('tall')],
        ['show-hidden-columns', (v: any) => expect(v.showHiddenColumns).toHaveBeenCalled()],
        ['clear-filters', (v: any) => expect(v.clearFilters).toHaveBeenCalled()],
        ['clear-sort', (v: any) => expect(v.clearSort).toHaveBeenCalled()],
        ['version-history', (v: any) => expect(v.showVersionHistory).toHaveBeenCalled()],
        ['sources', (v: any) => expect(v.openSources).toHaveBeenCalled()],
    ] as const)('%s acts on the view', (command, check) => {
        expect(runTableViewCommand(command, context)).toBe(true);
        check(context.view);
    });

    it('copies the selected text and says when there is none', () => {
        expect(runTableViewCommand('copy-selection', context)).toBe(true);
        context.view.copySelection.mockReturnValue(false);
        expect(runTableViewCommand('copy-selection', context)).toBe(false);
    });

    it('takes back the last destructive edit only while Undo is offered', () => {
        expect(runTableViewCommand('undo', context)).toBe(true);
        expect(context.undo).toHaveBeenCalledOnce();
        expect(runTableViewCommand('undo', { ...context, canUndo: false })).toBe(false);
        expect(context.undo).toHaveBeenCalledOnce();
    });

    it("opens the toolbar's + Items menu", () => {
        const click = vi.fn();
        context.host!.querySelector('button')!.addEventListener('click', click);
        expect(runTableViewCommand('add-items', context)).toBe(true);
        expect(click).toHaveBeenCalledOnce();
    });

    it('adds a column and the new items from the sources', () => {
        expect(runTableViewCommand('add-column', context)).toBe(true);
        expect(context.addColumn).toHaveBeenCalledOnce();
        expect(runTableViewCommand('add-new-items', context)).toBe(true);
        expect(context.addNewItems).toHaveBeenCalledOnce();
        expect(runTableViewCommand('add-new-items', { ...context, newItems: 0 })).toBe(false);
        expect(runTableViewCommand('add-column', { ...context, canAddColumn: false })).toBe(false);
    });

    it("opens the Fill button's plans", () => {
        runTableViewCommand('fill-pending', context);
        runTableViewCommand('fill-trial', context);
        runTableViewCommand('fill-selected', context);
        runTableViewCommand('fill-retry', context);
        expect((context.openFillPlan as any).mock.calls.map((call: any[]) => call[0])).toEqual([
            { kind: 'pending' },
            { kind: 'pending', limit: 5 },
            { kind: 'cells', rows: ['r1', 'r2'] },
            { kind: 'retry_failed' },
        ]);
    });

    it('fills selected rows only with rows selected', () => {
        context.view = view({ selectedRowIds: [] });
        expect(runTableViewCommand('fill-selected', context)).toBe(false);
        expect(context.openFillPlan).not.toHaveBeenCalled();
    });

    it('stops only a running fill', () => {
        expect(runTableViewCommand('fill-stop', context)).toBe(false);
        expect(runTableViewCommand('fill-stop', { ...context, fillRunning: true })).toBe(true);
        expect(context.stopFill).toHaveBeenCalledOnce();
    });

    it('removes the selected rows', () => {
        expect(runTableViewCommand('remove-selected', context)).toBe(true);
        expect(context.removeRows).toHaveBeenCalledWith(['r1', 'r2']);
    });

    it('runs no edit or fill while edits are refused, and still exports', () => {
        const refused = { ...context, editDisabled: true };
        for (const command of ['add-items', 'add-column', 'add-new-items', 'fill-pending', 'remove-selected'] as const) {
            expect(runTableViewCommand(command, refused)).toBe(false);
        }
        expect(context.addColumn).not.toHaveBeenCalled();
        expect(context.removeRows).not.toHaveBeenCalled();
        expect(context.openFillPlan).not.toHaveBeenCalled();
        expect(runTableViewCommand('export-csv', refused)).toBe(true);
    });

    it('shows the table in the library and asks Beaver about it, when the view can', () => {
        expect(runTableViewCommand('show-in-library', context)).toBe(true);
        expect(runTableViewCommand('ask-beaver', context)).toBe(true);
        expect(context.showInLibrary).toHaveBeenCalledOnce();
        expect(context.askBeaver).toHaveBeenCalledOnce();
        expect(runTableViewCommand('ask-beaver', { ...context, askBeaver: undefined })).toBe(false);
    });

    it('runs nothing before the table has rendered', () => {
        expect(runTableViewCommand('export-csv', { ...context, view: null })).toBe(false);
    });
});
