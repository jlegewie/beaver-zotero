/**
 * The contract between the Beaver tab's two halves: `tableTab.ts` (esbuild),
 * which owns the Zotero tab, and `renderTableTab` in `react/index.tsx`
 * (webpack), which renders the table into it. The bundles cannot import each
 * other, so the esbuild side calls the window's `BeaverReact.renderTableTab`
 * and both name these types. Types only: nothing here may gain a value import.
 */

import type { TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableFillViewRequest } from '@beaver/agent-core/protocol/tableFillProtocol';
import type { TableRef } from '../services/artifacts/tableItemIdentity';

/** A row (and a cell, with a column) to bring into view: a citation's target. */
export interface TableFocusTarget {
    rowId: string;
    columnId?: string;
}

/** A fill's failed rows for the tab to show. */
export type TableTabRequest = TableFillViewRequest;

/** What one committed load of the table cost, for diagnostics. */
export interface TableTabRenderReport {
    /** `open` for the first load, `update` for a re-read after a store update. */
    reason: 'open' | 'update';
    version: number;
    rows: number;
    /** Reading and parsing `table.json`; 0 when the open handed the spec over. */
    readMs: number;
    /** From the start of the load to the React commit, layout forced. */
    commitMs: number;
    /** Rows in the DOM after the commit (windowed, so not `rows`). */
    rowsInDom: number;
}

/** Where a table is mounted: a Beaver tab of a main window, or its own window. */
export type TableSurface = 'tab' | 'window';

/** A command from a host's native menus or shortcuts, for the mounted table. */
export type TableViewCommand =
    | 'show-in-library'
    | 'export-xlsx'
    | 'export-csv'
    | 'copy-text'
    | 'undo'
    | 'copy-selection'
    | 'select-all-rows'
    | 'find'
    | 'density-compact'
    | 'density-cozy'
    | 'density-tall'
    | 'show-hidden-columns'
    | 'clear-filters'
    | 'clear-sort'
    | 'version-history'
    | 'sources'
    | 'add-items'
    | 'add-column'
    | 'add-new-items'
    | 'fill-pending'
    | 'fill-trial'
    | 'fill-selected'
    | 'fill-retry'
    | 'fill-stop'
    | 'remove-selected'
    | 'ask-beaver';

/** What a host's menus show for the mounted table. */
export interface TableViewMenuState {
    /** Which commands can run now. */
    enabled: Record<TableViewCommand, boolean>;
    /** The row height in view; null before the table has rendered. */
    density: 'compact' | 'cozy' | 'tall' | null;
}

export interface TableTabMountOptions {
    /** Where the table is mounted; a tab when absent. */
    surface?: TableSurface;
    /** The spec the open just read, so the first paint needs no second read. */
    initial?: { spec: TableSpec; version: number };
    /** A row or cell to bring into view once the table is on screen. */
    focus?: TableFocusTarget;
    /** A fill's failed rows, shown once the table is on screen. */
    request?: TableTabRequest;
    /** The spec's title changed; the tab and the window title follow it. */
    onTitle(title: string): void;
    onRendered?(report: TableTabRenderReport): void;
    /** Whether the tab is the selected one in its window. */
    isSelected?(): boolean;
    /** Moves the table to a window of its own, closing the tab; a tab only. */
    moveToNewWindow?(): void;
}

/** What the renderer hands back for one mounted tab. */
export interface TableTabHandle {
    /** Shows (or, with null, clears) a warning about the table above the grid. */
    setWarning(warning: string | null): void;
    /** Reads the table again: an open that reused the tab may have found newer content. */
    reload(): void;
    /** Brings a row or cell into view, clearing filters that hide it. */
    focus(target: TableFocusTarget): void;
    /** Shows a fill's failed rows. */
    request(request: TableTabRequest): void;
    /** The window's selected tab changed: the tab may have been shown or hidden. */
    selectionChanged(): void;
    /** Runs a menu command; false when the table cannot run it now. */
    command(command: TableViewCommand): boolean;
    /** The state the menus show, or null before the table has mounted. */
    menuState(): TableViewMenuState | null;
}

export type RenderTableTab = (
    container: HTMLElement,
    ref: TableRef,
    options: TableTabMountOptions
) => TableTabHandle;
