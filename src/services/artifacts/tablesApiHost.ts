/**
 * Publishes the esbuild bundle's stored-table surfaces on the shared global.
 *
 * The counterpart to `tablesApi.ts`: that module is the seam both bundles may
 * hold (types and an accessor, no value imports), this one is the half only the
 * esbuild bundle may load, because it imports the modules that own the state —
 * the enhanced-reader registry and the item-pane registration.
 *
 * Nothing here adds behaviour. It is a binding: every method forwards to the
 * module that already owns the surface, so there is exactly one registry per
 * surface and the dev endpoints observe the same one the product path writes.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    clearTableWriteLocks,
    tableLocalCommands,
    getTableLocalCommands,
    getTableShadowRestore,
    setTableShadowRestore,
    setTablesApi,
    tableWriteLocks,
    TABLE_SHADOW_RESTORE_UNAVAILABLE,
    type TablesApi,
} from './tablesApi';
import { inspectTableShadow } from './recoveryShadow';
import { openTable } from '../../ui/openTable';
import { listReaderTableViews, openTableInReader, markTableReadersStale } from './view/readerTableView';
import {
    describeTableItemPane,
    isTableItemPaneRegistered,
    tableItemPaneID,
} from '../../ui/tableItemPane';

/**
 * Registers the namespace. Safe to call twice — a plugin reload replaces the
 * binding rather than accumulating one.
 */
export function registerTablesApi(): void {
    const api: TablesApi = {
        openTable,
        tableChanged: markTableReadersStale,
        local: { commands: getTableLocalCommands },
        listViews: () => listReaderTableViews(),
        openInReader: (item, options) => openTableInReader(item, options),
        itemPane: {
            isRegistered: () => isTableItemPaneRegistered(),
            paneID: () => tableItemPaneID(),
            describe: (ref) => describeTableItemPane(ref),
        },
        shadow: {
            // Reading the shadow is esbuild-safe, so it is answered here.
            inspect: (ref, observed) => inspectTableShadow(ref, observed ?? null),
            // Writing is not: every write goes through `tableStore.ts`, which
            // is webpack-only so its single-flight lock stays single. A missing
            // registration is reported rather than worked around.
            restore: async (ref) => {
                const restore = getTableShadowRestore();
                if (!restore) {
                    return {
                        ok: false,
                        code: 'store_unavailable',
                        error: TABLE_SHADOW_RESTORE_UNAVAILABLE,
                    };
                }
                return restore(ref);
            },
        },
    };
    setTablesApi(api);
    // Seed the registry in the plugin realm (`onShutdown` tears it down), not
    // in whichever window bundle first takes a lock.
    tableWriteLocks();
    tableLocalCommands();
    logger('tablesApiHost: registered Zotero.__beaverTables', 3);
}

/**
 * Withdraws it, so a torn-down bundle's closures are not reachable from the
 * global and a caller sees "not up" instead of calling into a dead realm.
 *
 * Plugin teardown only. The esbuild half is registered once, at startup, so a
 * window closing while the app keeps running must *not* come through here —
 * that path withdraws only the React half, {@link unregisterTableShadowRestore}.
 */
export function unregisterTablesApi(): void {
    setTablesApi(null);
    Zotero.__beaverTableLocalCommands?.clear();
    Zotero.__beaverTableLocalCommands = undefined;
    unregisterTableShadowRestore();
    // Dropped with the realm that created it. Teardown means no write is in
    // flight to lose its turn.
    clearTableWriteLocks();
}

/** Clears the recovery callback during last-window or plugin teardown. */
export function unregisterTableShadowRestore(): void {
    setTableShadowRestore(null);
}
