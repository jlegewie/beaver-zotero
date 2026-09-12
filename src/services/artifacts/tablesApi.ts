/**
 * The one instance of the stored-table surfaces, shared across both bundles.
 *
 * ## Why this exists
 *
 * `view/readerTableView.ts` and `src/ui/tableItemPane.ts` keep **module-level
 * state**: the enhanced-reader registry and the registered pane id.
 * `src/hooks.ts` imports them, so esbuild compiles them into `beaver.js`. If
 * anything under `react/` imports them too, webpack compiles a *second* copy
 * into `reactBundle.js` — and the two copies never see each other. CLAUDE.md
 * states the rule this violates: "The two bundles cannot import from each
 * other … cross-bundle communication goes through `__beaver*` properties".
 *
 * The failure is quiet and specific. The webpack copy's registries stay empty
 * while the esbuild copy does the real work, so a dev endpoint reports an empty
 * view list for readers that are demonstrably enhanced — and a view registered
 * through the webpack copy is invisible to `cleanupReaderTableViews()`, which
 * runs from `hooks.ts` against the esbuild copy, leaking the reader's document
 * and its window.
 *
 * ## The seam
 *
 * The **esbuild bundle owns these surfaces**, because that is where `hooks.ts`
 * runs and where the reader integration and the item-pane section actually
 * live. It publishes them here at startup; the webpack side reaches them
 * through {@link getTablesApi} instead of importing the modules.
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

import type { TableRef } from './tableItemIdentity';
import type { TableShadowReport, TableShadowObservation } from './recoveryShadow';
import type { TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableVersionEntry } from './tableItemIdentity';
import type { TableWriteResult, TableShadowRestoreResult } from './tableStore';
import type { TableViewSummary } from './view/enhanceTableDocument';
import type { ReaderTableDiagnostics } from './view/readerTableView';
import type { OpenTableOutcome } from '../../ui/openTable';
import type { TableItemPaneReport } from '../../ui/tableItemPane';

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
 * The plugin owns both detection and restoration. Restoration enters the
 * instance mutation queue before acquiring the table lock, and remains
 * available when no renderer is attached.
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

/** What {@link TablesShadowApi.restore} answers when the plugin service is absent. */
export interface TableShadowUnavailable {
    ok: false;
    code: 'store_unavailable';
    error: string;
}

export interface TablesApi {
    /** The single entry point for showing a stored table: the reader. */
    openTable(ref: TableRef): Promise<OpenTableOutcome>;

    /** Every table document currently enhanced. */
    listViews(): TableViewSummary[];

    /**
     * Opens a stored table in the reader and reports what the enhancer
     * attached. {@link openTable} is the product path; this one waits for the
     * enhancement and describes it, which is what a dev endpoint needs.
     */
    openInReader(
        item: Zotero.Item,
        options?: { timeoutMs?: number }
    ): Promise<ReaderTableDiagnostics>;

    /** Marks open snapshots as outdated after a persisted write. */
    tableChanged(ref: TableRef): void;
    local: {
        commands(win: Window): TableLocalCommands;
    };
    itemPane: TablesItemPaneApi;
    shadow: TablesShadowApi;
}

/** The plugin-owned recovery operation. */
export type TableShadowRestore = (
    ref: TableRef
) => Promise<TableShadowRestoreResult>;

/**
 * The plugin's restore function, published at startup and withdrawn at disposal.
 * Renderer attachment and teardown never replace this binding.
 */
export function getTableShadowRestore(): TableShadowRestore | null {
    return Zotero.__beaverTableShadowRestore ?? null;
}

/** Publishes (or, with null, withdraws) it. */
export function setTableShadowRestore(restore: TableShadowRestore | null): void {
    Zotero.__beaverTableShadowRestore = restore ?? undefined;
}

/** What a caller reports when the plugin recovery service has not registered. */
export const TABLE_SHADOW_RESTORE_UNAVAILABLE =
    'Beaver\'s table recovery service is unavailable. Reload Beaver and try again.';

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
 * Single-flight write locks for stored tables: one promise chain per table,
 * keyed `<libraryID>/<key>`. Only `tableStore.ts` takes one.
 *
 * Lives on the shared global rather than in `tableStore.ts` because module
 * state is per *bundle* and the lock has to be per *process*. A map in the
 * store would split the moment that module also reached the esbuild bundle:
 * two chains, no serialisation between a user edit and an agent write, and
 * every test still green.
 *
 * The map belongs to the **plugin realm**: `registerTablesApi()` seeds it at
 * startup, and {@link clearTableWriteLocks} drops it at teardown, so a reload
 * never inherits the previous realm's map. This function self-initialises if
 * called first, which is why the seed exists — otherwise the first window
 * bundle to take a lock would own the map.
 *
 * Entries are plugin-owned promises, acquired after the instance mutation
 * queue. They release only when the write settles; closing a window must
 * never clear a lock protecting an active write.
 */
export function tableWriteLocks(): Map<string, Promise<unknown>> {
    const existing = Zotero.__beaverTableWriteLocks;
    if (existing) return existing;
    const created = new Map<string, Promise<unknown>>();
    Zotero.__beaverTableWriteLocks = created;
    return created;
}

/** Drops the registry. Plugin teardown only — no write may be in flight. */
export function clearTableWriteLocks(): void {
    Zotero.__beaverTableWriteLocks = undefined;
}

/**
 * The message a caller shows when the esbuild half is not up. Named here so
 * every dev endpoint reports the same thing, and reports it rather than
 * quietly substituting a copy of its own.
 */
export const TABLES_API_UNAVAILABLE =
    "Beaver's table surfaces are not registered (Zotero.__beaverTables is unset). " +
    'The esbuild bundle either failed to load or has already been torn down.';

/** Local document commands supplied by a live renderer; dialogs stay with the caller. */
export interface TableLocalCommands {
    read(ref: TableRef): Promise<{ spec: TableSpec; version: number }>;
    history(ref: TableRef): Promise<TableVersionEntry[]>;
    revert(ref: TableRef, version: number): Promise<TableWriteResult>;
    restoreShadow: TableShadowRestore;
}

/** Seeded by the plugin realm, released as each renderer detaches. */
export function tableLocalCommands(): Map<Window, TableLocalCommands> {
    return Zotero.__beaverTableLocalCommands ??= new Map();
}

export function getTableLocalCommands(win: Window): TableLocalCommands {
    const entries = tableLocalCommands();
    if (win.closed) throw new Error('The originating window is closed.');
    const owner = win.__beaverOwnerWindowRef?.deref() ?? win;
    const direct = entries.get(owner);
    if (direct && !owner.closed) return direct;
    // A standalone reader window has no renderer of its own.
    for (const [owner, commands] of entries) if (!owner.closed) return commands;
    throw new Error('Table document actions are unavailable. Reopen a Zotero library window with Beaver loaded.');
}
