/**
 * The one instance of the stored-table surfaces, shared across both bundles.
 *
 * ## Why this exists
 *
 * `src/ui/tableTab.ts`, `src/ui/tableDoubleClick.ts` and
 * `view/readerTableView.ts` all keep **module-level state**: the open-tab
 * registry, the wrapped `ZoteroPane` handlers and their last decision, the
 * enhanced-reader registry. `src/hooks.ts` imports them, so esbuild compiles
 * them into `beaver.js`. If anything under `react/` imports them too, webpack
 * compiles a *second* copy into `reactBundle.js` — and the two copies never
 * see each other. CLAUDE.md states the rule this violates: "The two bundles
 * cannot import from each other … cross-bundle communication goes through
 * `__beaver*` properties".
 *
 * The failure is quiet and specific. The webpack copy's registries stay empty
 * while the esbuild copy does the real work, so a dev endpoint reports
 * `installed: false` on a `ZoteroPane` that is demonstrably wrapped. Worse, a
 * tab opened through the webpack copy is invisible to `closeAllTableTabs()` —
 * which runs from `hooks.ts`, i.e. against the esbuild copy — and leaks a
 * detached iframe holding its whole rendered document.
 *
 * ## The seam
 *
 * The **esbuild bundle owns these surfaces**, because that is where `hooks.ts`
 * runs and where the wrapping, the tab deck and the reader integration
 * actually live. It publishes them here at startup; the webpack side reaches
 * them through {@link getTablesApi} instead of importing the modules.
 *
 * **This module must never gain a value import.** Types are erased, so the
 * interface below can name anything; a real import would put the very modules
 * this protects back into whichever bundle loads it. `eslint.config.mjs`
 * enforces the other half of the rule — that `react/` does not import them
 * directly.
 *
 * Absent means absent: a caller that finds no API must say the esbuild half is
 * not up, rather than fall back to a private copy that will always look idle.
 */

import type { TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableRef } from './tableItemIdentity';
import type { TableShadowReport, TableShadowObservation } from './recoveryShadow';
import type { TableShadowRestoreResult } from './tableStore';
import type { TableViewSummary } from './view/enhanceTableDocument';
import type { ReaderTableDiagnostics } from './view/readerTableView';
import type { OpenTableTabOptions } from '../../ui/tableTab';
import type {
    OpenTableOptions,
    OpenTableOutcome,
    TableTarget,
} from '../../ui/openTable';
import type { TableDoubleClickRecord } from '../../ui/tableDoubleClick';
import type { TableItemPaneReport } from '../../ui/tableItemPane';

/** The double-click guard, as the dev endpoints need to see it. */
export interface TablesDoubleClickApi {
    /** Whether this window's `ZoteroPane` handlers are currently wrapped. */
    /** Absent `win` means the main window. */
    isInstalled(win?: Window): boolean;
    /** The most recent decision the guard made, or null if it has made none. */
    last(): TableDoubleClickRecord | null;
    /** Loads the item data the synchronous decision depends on. */
    warm(items: Zotero.Item[]): Promise<number>;
    /** Resolves once the open started by the most recent decision has settled. */
    settled(): Promise<void>;
}

/** The item-pane section, as the dev endpoint needs to see it. */
export interface TablesItemPaneApi {
    /** Whether the section is registered with Zotero right now. */
    isRegistered(): boolean;
    /** The namespaced pane id Zotero assigned, or null. */
    paneID(): string | null;
    /** What the section would render for one table. */
    describe(ref: TableRef): Promise<TableItemPaneReport>;
}

/**
 * The recovery shadow, as the item-pane section and the dev endpoints need it.
 *
 * Split across the bundles for a reason neither half can avoid. Detection is
 * esbuild-side (`recoveryShadow.ts` is compiled into `beaver.js` so the section
 * can read it), but the restore is a *write*, and every write goes through
 * `tableStore.ts`, which is webpack-only so that its single-flight lock stays
 * single. So {@link TablesShadowApi.restore} forwards to a function the webpack
 * bundle publishes ({@link setTableShadowRestore}) and answers
 * `store_unavailable` when it has not — which is the honest report, not a
 * fallback that would write around the lock.
 */
export interface TablesShadowApi {
    /**
     * What this device last wrote to a table, and whether the table has gone
     * backwards under it. `observed` is the table as the caller sees it now;
     * pass null to read the shadow without judging it.
     */
    inspect(
        ref: TableRef,
        observed?: TableShadowObservation | null
    ): Promise<TableShadowReport>;
    /** Writes the retained spec back as a new version. */
    restore(ref: TableRef): Promise<TableShadowRestoreResult | TableShadowUnavailable>;
}

/** What {@link TablesShadowApi.restore} answers with no webpack half up. */
export interface TableShadowUnavailable {
    ok: false;
    code: 'store_unavailable';
    error: string;
}

export interface TablesApi {
    /** The single entry point for showing a stored table. */
    openTable(ref: TableRef, options?: OpenTableOptions): Promise<OpenTableOutcome>;
    /** Which surface {@link openTable} would try first. */
    resolveTableTarget(where?: TableTarget): TableTarget;

    /** Renders an unsaved spec into a tab. Returns the tab id, or null. */
    openSpecInTab(spec: TableSpec, options?: OpenTableTabOptions): string | null;
    /** Closes one table tab and releases what was mounted into it. */
    closeTab(id: string): void;

    /** Every table document currently enhanced, in either host. */
    listViews(): TableViewSummary[];

    /** Opens a stored table in the reader and reports what the enhancer attached. */
    openInReader(
        item: Zotero.Item,
        options?: { timeoutMs?: number }
    ): Promise<ReaderTableDiagnostics>;

    doubleClick: TablesDoubleClickApi;
    itemPane: TablesItemPaneApi;
    shadow: TablesShadowApi;
}

/** The write half of the shadow, as the webpack bundle publishes it. */
export type TableShadowRestore = (
    ref: TableRef
) => Promise<TableShadowRestoreResult>;

/**
 * The webpack bundle's restore function, or null before it is up.
 *
 * Its own slot rather than a field on {@link TablesApi}, because the two halves
 * are published by different bundles at different times: the esbuild half
 * registers at plugin startup and re-registers on every reload, and a field it
 * rebuilt would silently drop whatever the React bundle had put there.
 */
export function getTableShadowRestore(): TableShadowRestore | null {
    return Zotero.__beaverTableShadowRestore ?? null;
}

/** Publishes (or, with null, withdraws) it. */
export function setTableShadowRestore(restore: TableShadowRestore | null): void {
    Zotero.__beaverTableShadowRestore = restore ?? undefined;
}

/** What a caller reports when the webpack half has not registered. */
export const TABLE_SHADOW_RESTORE_UNAVAILABLE =
    'Restoring a table version needs Beaver\'s React bundle, which has not registered ' +
    '(Zotero.__beaverTableShadowRestore is unset).';

/**
 * The shared slot. `__beaver`-prefixed on `Zotero` to match
 * `__beaverJotaiStore` and the other cross-bundle globals, and because a `let`
 * in the ambient `Zotero` namespace is assignable where `Zotero.Beaver`'s
 * `const` members are not.
 */
export function getTablesApi(): TablesApi | null {
    return Zotero.__beaverTables ?? null;
}

/** Publishes (or, with null, withdraws) the esbuild bundle's implementation. */
export function setTablesApi(api: TablesApi | null): void {
    Zotero.__beaverTables = api ?? undefined;
}

/**
 * The message a caller shows when the esbuild half is not up. Named here so
 * every dev endpoint reports the same thing, and reports it rather than
 * quietly substituting a copy of its own.
 */
export const TABLES_API_UNAVAILABLE =
    "Beaver's table surfaces are not registered (Zotero.__beaverTables is unset). " +
    'The esbuild bundle either failed to load or has already been torn down.';
