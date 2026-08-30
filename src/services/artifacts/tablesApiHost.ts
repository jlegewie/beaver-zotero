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
import { setTablesApi, type TablesApi } from './tablesApi';
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
    };
    setTablesApi(api);
    logger('tablesApiHost: registered Zotero.__beaverTables', 3);
}

/**
 * Withdraws it, so a torn-down bundle's closures are not reachable from the
 * global and a caller sees "not up" instead of calling into a dead realm.
 */
export function unregisterTablesApi(): void {
    setTablesApi(null);
}
