export { handleTestTableCreateHttpRequest, handleTestTableReadHttpRequest, handleTestTableListHttpRequest, handleTestTableWriteHttpRequest, handleTestTableEditHttpRequest, handleTestTableVersionsHttpRequest, handleTestTableRevertHttpRequest, handleTestTableDeleteHttpRequest, handleTestTableOpenHttpRequest, handleTestTableCorruptHttpRequest, handleTestTableShadowHttpRequest, handleTestTableRestoreShadowHttpRequest, handleTestTableTrimHttpRequest, handleTestTableItemPaneHttpRequest } from '../../../src/services/localEndpoints/handlers/testTableHandlers';
/**
 * Dev-only HTTP handlers for stored tables, registered by this renderer.
 *
 * The store handlers (`/beaver/test/table-create`, `-read`, `-write`, …) live
 * in the esbuild bundle and are re-exported here. `/beaver/test/open-stored-table`
 * takes the product path the item-pane button and the chat cards take, from
 * this renderer's window, and reports only whether the table got there.
 */

import { getHost } from '@beaver/agent-ui/host';
import { MISSING_KEY, TABLES_API_MISSING } from '../../../src/services/localEndpoints/handlers/testTableHandlers';
import { getTablesApi } from '../../../src/services/artifacts/tablesApi';
import type { TableRef } from '../../../src/services/artifacts/tableStore';
import { tryGetWindowRuntime } from '../../runtime/windowRuntime';

/**
 * `openTable` itself: the product path the item-pane button takes, from this
 * renderer's window. Reports the Beaver tab it landed in;
 * `/beaver/test/table-tab` inspects the tab.
 */
export async function handleTestOpenStoredTableHttpRequest(
    request: { key?: string; libraryID?: number; via?: 'api' | 'card' } = {}
): Promise<any> {
    if (!request.key) return MISSING_KEY;
    const api = getTablesApi();
    if (!api) return TABLES_API_MISSING;
    const ref: TableRef = {
        libraryID: request.libraryID ?? Zotero.Libraries.userLibraryID,
        key: request.key,
    };
    // `card`: the host navigation the chat cards and table chips call, with
    // the item reference they carry and this renderer's window as the origin.
    const open = getHost().navigation?.openTable;
    const origin = tryGetWindowRuntime()?.hostWindow ?? null;
    const outcome = request.via === 'card'
        ? open
            ? await open(`${ref.libraryID}-${ref.key}`, origin)
            : { error: 'Host navigation has no openTable.' }
        : await api.openTable(ref, { window: origin });
    if ('error' in outcome) {
        return { ok: false, key: ref.key, library_id: ref.libraryID, error: outcome.error };
    }
    return {
        ok: true,
        key: ref.key,
        library_id: ref.libraryID,
        // The host contract does not name the tab; `openTable` returns it.
        tab_id: (outcome as { tabID?: string }).tabID ?? null,
        reused: (outcome as { reused?: boolean }).reused ?? null,
        ...(outcome.warning ? { warning: outcome.warning } : {}),
    };
}
