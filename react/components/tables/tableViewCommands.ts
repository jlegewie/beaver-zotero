/**
 * The table view's native menu commands and menu state, for a host whose menus
 * live outside the table (the table window's menu bar).
 *
 * Pure: the view hands over what it shows now ({@link TableViewCommandContext})
 * and these read or act on it. {@link tableViewAvailability} is the one place
 * that says which commands can run: the menus show it, and
 * {@link runTableViewCommand} refuses anything it rules out, since a shortcut
 * can arrive while a menu's state is stale.
 */

import type { TableFillScope } from '@beaver/agent-core/protocol/tableFillProtocol';
import type { ResearchTableHandle } from '@beaver/agent-ui/layouts';
import type { TableViewCommand, TableViewMenuState } from '../../../src/ui/tableTabTypes';
import { TRIAL_ROWS } from './TableFillControl';

export interface TableViewCommandContext {
    /** The research table's handle; null before it has rendered. */
    view: ResearchTableHandle | null;
    /** The table's DOM, for the toolbar's + Items control. */
    host: HTMLElement | null;
    /** Edits are refused now (read-only library, fill running). */
    editDisabled: boolean;
    /** The sources can be changed (not a read-only library). */
    sourcesEditable: boolean;
    canUndo: boolean;
    undo(): void;
    /** Adding a column is possible now (the table's limits allow one). */
    canAddColumn: boolean;
    addColumn?(): void;
    newItems: number;
    addNewItems?(): void;
    removeRows(rowIds: string[]): void;
    fillAvailable: boolean;
    fillRunning: boolean;
    /** Opens the Fill button's plan. */
    openFillPlan(scope: TableFillScope): void;
    stopFill(): void;
    showInLibrary?(): void;
    askBeaver?(): void;
}

/** The toolbar's + Items control, when it can be used now. */
function addItemsControl(host: HTMLElement | null): HTMLButtonElement | null {
    return host?.querySelector<HTMLButtonElement>('button.rt-add-papers:not([disabled])') ?? null;
}

/** Which commands the table can run now; nothing before it has rendered. */
export function tableViewAvailability(context: TableViewCommandContext): Record<TableViewCommand, boolean> {
    const view = context.view?.viewState();
    const loaded = !!view;
    const editable = loaded && !context.editDisabled;
    const fill = editable && context.fillAvailable;
    const selected = (view?.selectedRowIds.length ?? 0) > 0;
    const rows = (view?.rows ?? 0) > 0;
    return {
        'show-in-library': loaded && !!context.showInLibrary,
        'export-xlsx': loaded && view.canExport,
        'export-csv': loaded && view.canExport,
        'copy-text': loaded && view.canCopy,
        undo: loaded && context.canUndo,
        'copy-selection': loaded && view.hasSelectedText,
        'select-all-rows': rows,
        find: loaded && view.searchable,
        'density-compact': loaded,
        'density-cozy': loaded,
        'density-tall': loaded,
        'show-hidden-columns': loaded && view.hiddenColumns > 0,
        'clear-filters': loaded && view.filtered,
        'clear-sort': loaded && view.sorted,
        'version-history': loaded && view.hasVersionHistory,
        sources: loaded && view.canEditSources && context.sourcesEditable,
        'add-items': editable && !!addItemsControl(context.host),
        'add-column': editable && context.canAddColumn && !!context.addColumn,
        'add-new-items': editable && context.newItems > 0 && !!context.addNewItems,
        'fill-pending': fill,
        'fill-trial': fill,
        'fill-selected': fill && selected,
        'fill-retry': fill,
        'fill-stop': loaded && context.fillAvailable && context.fillRunning,
        'remove-selected': editable && selected,
        'ask-beaver': loaded && !!context.askBeaver,
    };
}

export function tableViewMenuState(context: TableViewCommandContext): TableViewMenuState {
    return {
        enabled: tableViewAvailability(context),
        density: context.view?.viewState().density ?? null,
        fillAvailable: context.fillAvailable,
    };
}

/** Runs `command` when the table can run it now; returns whether it ran. */
export function runTableViewCommand(command: TableViewCommand, context: TableViewCommandContext): boolean {
    const view = context.view;
    if (!view || !tableViewAvailability(context)[command]) return false;
    const selected = () => view.viewState().selectedRowIds;
    switch (command) {
        case 'show-in-library': context.showInLibrary!(); break;
        case 'export-xlsx': view.exportTable('xlsx'); break;
        case 'export-csv': view.exportTable('csv'); break;
        case 'copy-text': view.copyAsText(); break;
        case 'copy-selection': return view.copySelection();
        case 'undo': context.undo(); break;
        case 'select-all-rows': view.selectAllRows(); break;
        case 'find': view.focusSearch(); break;
        case 'density-compact': view.setDensity('compact'); break;
        case 'density-cozy': view.setDensity('cozy'); break;
        case 'density-tall': view.setDensity('tall'); break;
        case 'show-hidden-columns': view.showHiddenColumns(); break;
        case 'clear-filters': view.clearFilters(); break;
        case 'clear-sort': view.clearSort(); break;
        case 'version-history': view.showVersionHistory(); break;
        case 'sources': view.openSources(); break;
        case 'add-items': addItemsControl(context.host)!.click(); break;
        case 'add-column': context.addColumn!(); break;
        case 'add-new-items': context.addNewItems!(); break;
        case 'fill-pending': context.openFillPlan({ kind: 'pending' }); break;
        case 'fill-trial': context.openFillPlan({ kind: 'pending', limit: TRIAL_ROWS }); break;
        case 'fill-selected': context.openFillPlan({ kind: 'cells', rows: selected() }); break;
        case 'fill-retry': context.openFillPlan({ kind: 'retry_failed' }); break;
        case 'fill-stop': context.stopFill(); break;
        case 'remove-selected': context.removeRows(selected()); break;
        case 'ask-beaver': context.askBeaver!(); break;
    }
    return true;
}
