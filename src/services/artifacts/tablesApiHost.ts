/**
 * Publishes the esbuild bundle's stored-table surfaces on the shared global.
 *
 * The counterpart to `tablesApi.ts`: that module is the seam both bundles may
 * hold (types and an accessor, no value imports), this one is the half only the
 * esbuild bundle may load, because it imports the modules that own the state —
 * the open-tab registry, the wrapped `ZoteroPane` handlers, the enhanced-reader
 * registry.
 *
 * Nothing here adds behaviour. It is a binding: every method forwards to the
 * module that already owns the surface, so there is exactly one registry per
 * surface and the dev endpoints observe the same one the product path writes.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    getTableShadowRestore,
    setTableShadowRestore,
    setTablesApi,
    TABLE_SHADOW_RESTORE_UNAVAILABLE,
    type TablesApi,
} from './tablesApi';
import { inspectTableShadow } from './recoveryShadow';
import { openTable, resolveTableTarget } from '../../ui/openTable';
import { closeTableTab, listTableTabViews, openTableTab } from '../../ui/tableTab';
import { listReaderTableViews, openTableInReader } from './view/readerTableView';
import {
    isTableDoubleClickInstalled,
    lastTableDoubleClick,
    warmTableItems,
    whenTableDoubleClickSettles,
} from '../../ui/tableDoubleClick';
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
        resolveTableTarget,
        openSpecInTab: (spec, options) => openTableTab(spec, options),
        closeTab: (id) => closeTableTab(id),
        // Both hosts in one list, because "which table documents are live" is
        // one question and answering half of it is how a leak stays hidden.
        listViews: () => [...listTableTabViews(), ...listReaderTableViews()],
        openInReader: (item, options) => openTableInReader(item, options),
        doubleClick: {
            isInstalled: (win?: Window) => isTableDoubleClickInstalled(win),
            last: () => lastTableDoubleClick(),
            warm: (items) => warmTableItems(items),
            settled: () => whenTableDoubleClickSettles(),
        },
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
    unregisterTableShadowRestore();
}

/**
 * Withdraws the shadow's write half on its own.
 *
 * The React bundle publishes it from its entry point and has no teardown of its
 * own, so the closure — which holds that bundle's `tableStore` module and
 * therefore its whole realm — has to be dropped by the window teardown that
 * outlives it. That is not only plugin shutdown: on macOS the last window can
 * close while the app keeps running, and the slot would otherwise pin the dead
 * realm indefinitely. The next window's bundle re-publishes it on load.
 */
export function unregisterTableShadowRestore(): void {
    setTableShadowRestore(null);
}
