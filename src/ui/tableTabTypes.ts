/**
 * The contract between the Beaver tab's two halves: `tableTab.ts` (esbuild),
 * which owns the Zotero tab, and `renderTableTab` in `react/index.tsx`
 * (webpack), which renders the table into it. The bundles cannot import each
 * other, so the esbuild side calls the window's `BeaverReact.renderTableTab`
 * and both name these types. Types only: nothing here may gain a value import.
 */

import type { TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableRef } from '../services/artifacts/tableItemIdentity';

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

export interface TableTabMountOptions {
    /** The spec the open just read, so the first paint needs no second read. */
    initial?: { spec: TableSpec; version: number };
    /** The spec's title changed; the tab and the window title follow it. */
    onTitle(title: string): void;
    onRendered?(report: TableTabRenderReport): void;
}

/** What the renderer hands back for one mounted tab. */
export interface TableTabHandle {
    /** Shows (or, with null, clears) a warning about the table above the grid. */
    setWarning(warning: string | null): void;
    /** Reads the table again: an open that reused the tab may have found newer content. */
    reload(): void;
}

export type RenderTableTab = (
    container: HTMLElement,
    ref: TableRef,
    options: TableTabMountOptions
) => TableTabHandle;
