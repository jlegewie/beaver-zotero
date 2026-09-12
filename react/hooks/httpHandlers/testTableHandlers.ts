import { DEMO_ROW_LIMIT, TABLES_API_MISSING, OpenTableRequest, DemoItem, collectDemoItems, yearOf, citationTag, sentence, textCell, typeColumn, typeLabelFor, typeCell, buildDemoTable, referenceRow, buildSearchDemo, buildExtractionDemo, selectLabelFor, TableCreateRequest, handleTestTableCreateHttpRequest, TableReadRequest, handleTestTableReadHttpRequest, handleTestTableListHttpRequest, errorResponse, TableStoreRequest, tableRefFrom, writeMetaFrom, MISSING_KEY, writeResponse, TableWriteRequest, handleTestTableWriteHttpRequest, TableEditRequest, handleTestTableEditHttpRequest, handleTestTableVersionsHttpRequest, TableRevertRequest, handleTestTableRevertHttpRequest, TableDeleteRequest, handleTestTableDeleteHttpRequest, handleTestTableOpenHttpRequest, TableCorruptRequest, handleTestTableCorruptHttpRequest, rollBackWholeDirectory, handleTestTableShadowHttpRequest, handleTestTableRestoreShadowHttpRequest, handleTestTableViewStateHttpRequest, handleTestTableItemPaneHttpRequest, handleTestTableTrimHttpRequest } from '../../../src/services/localEndpoints/handlers/testTableHandlers';
export { handleTestTableCreateHttpRequest, handleTestTableReadHttpRequest, handleTestTableListHttpRequest, handleTestTableWriteHttpRequest, handleTestTableEditHttpRequest, handleTestTableVersionsHttpRequest, handleTestTableRevertHttpRequest, handleTestTableDeleteHttpRequest, handleTestTableOpenHttpRequest, handleTestTableCorruptHttpRequest, handleTestTableShadowHttpRequest, handleTestTableRestoreShadowHttpRequest, handleTestTableTrimHttpRequest, handleTestTableViewStateHttpRequest, handleTestTableItemPaneHttpRequest } from '../../../src/services/localEndpoints/handlers/testTableHandlers';
import { isTableItemError } from '../../../src/services/artifacts/tableItemIdentity';
/**
 * Dev-only HTTP handlers for looking at the table renderer.
 *
 * `/beaver/test/open-table` puts a `TableSpec` on `windowSurfaceAtom` and opens
 * the separate Beaver window at a width a table can actually use. Nothing in
 * the product routes to that surface yet — this is how it gets driven until
 * something does.
 *
 * Given no spec, it builds one from real items in the user's library, so the
 * host-backed row verbs (reveal, open) act on items that exist rather than on
 * fabricated keys. The demo covers every `ColumnType` and every cell state
 * deliberately: an empty value, a pending cell under a filling column, a failed
 * cell, a hand-edited one and a failed row.
 *
 * `/beaver/test/table-create`, `-read` and `-list` drive the stored side: the
 * same spec written to the library as a snapshot attachment, read back out of
 * the file, and enumerated. `-write`, `-edit`, `-versions`, `-revert`,
 * `-delete` and `-open` drive the versioned store on top of it, and `-corrupt`
 * damages a table's storage directory on purpose so crash recovery can be
 * exercised without staging a real crash — including its `sync_conflict` mode,
 * which rolls the whole directory back to an earlier version the way a resolved
 * Zotero file conflict does. `-table-shadow` and `-table-restore-shadow` are the
 * other side of that: what this device last wrote, and putting it back.
 *
 * `-open-reader` and `-view-state` drive the reader host, which is the only
 * surface a *stored* table has: the first opens one in Zotero's reader and
 * reports which of the enhancer's seams attached, the second lists what is
 * currently enhanced. `/beaver/test/open-stored-table` is the plainer one next
 * to them — it takes the product path the item-pane button takes and reports
 * only whether the table got there.
 *
 * Everything that touches a live table surface — the reader views and the
 * item-pane section — goes through `Zotero.__beaverTables` rather than importing
 * the owning module. Those modules keep registries and are compiled into the
 * esbuild bundle; importing them here would give this bundle a second,
 * permanently empty copy, and the endpoint would report on that. A handler that
 * finds no namespace answers `tables_api_unavailable` instead of guessing.
 */

import type {
    Cell,
    Column,
    Row,
    TableSpec,
} from '@beaver/agent-core/layouts/table';
import {
    rowIdFor,
    validateTableSpec,
    type RowRef,
} from '@beaver/agent-core/layouts/table';
import {
    zoteroLinkScope,
    zoteroLinksFor,
} from '../../../src/services/artifacts/view/tableLinks';
import { BeaverUIFactory } from '../../../src/ui/ui';
import { showTableInWindowAtom, windowSurfaceAtom } from '../../atoms/windowSurface';
import { store } from '../../store';
import { openBeaverWindow } from '../../ui/openBeaverWindow';
import { borrowedWindowCommandError } from './borrowedWindowCommand';
// The reader views and the item-pane section keep module state and are compiled
// into the *esbuild* bundle by `src/hooks.ts`. Importing them here would give
// this bundle a second, permanently empty copy — the endpoint would then report
// on a registry nothing ever writes. They are reached through the shared
// namespace instead; see `tablesApi.ts`.
import type { TableMutation } from '@beaver/agent-core/layouts/tableMutations';
import { summarize } from '@beaver/agent-core/layouts/tableMutations';
import { getSearchableLibraryIds } from '../../../src/services/agentDataProvider/utils';
import {
    inspectTableShadow,
    TABLE_SHADOW_MAX_PAYLOAD_BYTES,
    TABLE_SHADOW_RETENTION,
} from '../../../src/services/artifacts/recoveryShadow';
import { buildTableDocument } from '../../../src/services/artifacts/tableDocument';
import {
    isTableItem,
    loadTableItemFields,
    readTableItemSpec,
    TABLE_TAG,
    tableHistoryPath,
    tableSidecarDirectory,
    tableStorageDirectory,
    tableVersionPath
} from '../../../src/services/artifacts/tableItem';
import {
    getTablesApi,
    TABLES_API_UNAVAILABLE,
} from '../../../src/services/artifacts/tablesApi';
import {
    createTable,
    deleteTable,
    editTable,
    listVersions,
    openTable,
    readTable,
    restoreShadowVersion,
    restoreTable,
    revertTable,
    trimTable,
    writeTable,
    type TableRef,
    type TableWriteMeta,
} from '../../../src/services/artifacts/tableStore';
import { safeAttachmentFilename } from '../../../src/utils/attachmentFiles';
import { sha256Hex } from '../../../src/utils/hash';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';

/** Wide enough for the demo's columns; the window grows to it and no further. */
const TABLE_WINDOW_SIZE = { width: 1180, height: 780 };

export async function handleTestOpenTableHttpRequest(
    request: OpenTableRequest = {}
): Promise<any> {
    const initialError = borrowedWindowCommandError();
    if (initialError) return initialError;
    const variant = request.variant === 'extraction' ? 'extraction' : 'search';
    const table =
        request.table ??
        (await buildDemoTable(variant, request.limit ?? DEMO_ROW_LIMIT));

    // Building the demo may yield while another renderer opens the singleton.
    const ownerError = borrowedWindowCommandError();
    if (ownerError) return ownerError;
    store.set(showTableInWindowAtom, {
        variant,
        table,
        title: request.title,
        subtitle: request.subtitle,
    });

    if (request.open !== false) {
        openBeaverWindow(TABLE_WINDOW_SIZE);
    }

    return {
        ok: true,
        variant,
        table_id: table.id,
        columns: table.columns.map((c) => c.id),
        rows: table.rows.length,
        window_open: !!BeaverUIFactory.findBeaverWindow(),
    };
}

/**
 * `openTable` itself: the product path the item-pane button takes.
 *
 * A stored table has one surface — Zotero's reader — so this reports only
 * whether it got there. `-open-reader` is the richer probe: it waits for the
 * enhancement and describes which of the enhancer's seams attached.
 */
export async function handleTestOpenStoredTableHttpRequest(
    request: { key?: string; libraryID?: number } = {}
): Promise<any> {
    if (!request.key) return MISSING_KEY;
    const api = getTablesApi();
    if (!api) return TABLES_API_MISSING;
    const ref: TableRef = {
        libraryID: request.libraryID ?? Zotero.Libraries.userLibraryID,
        key: request.key,
    };
    const outcome = await api.openTable(ref);
    if ('error' in outcome) {
        return { ok: false, key: ref.key, library_id: ref.libraryID, error: outcome.error };
    }
    return {
        ok: true,
        key: ref.key,
        library_id: ref.libraryID,
        views: api.listViews(),
    };
}

/** Hands the window back to the thread. */
export async function handleTestCloseTableHttpRequest(): Promise<any> {
    const ownerError = borrowedWindowCommandError();
    if (ownerError) return ownerError;
    store.set(windowSurfaceAtom, { kind: 'thread' });
    return { ok: true, window_open: !!BeaverUIFactory.findBeaverWindow() };
}

// ---------------------------------------------------------------------------
// The reader host (dev-only)
// ---------------------------------------------------------------------------

/**
 * Opens a stored table in the reader and reports what the enhancer attached.
 *
 * The report is deliberately literal: every step has its own field, and
 * `failures` names the ones that did not come up. A table that renders as a
 * plain static page is a supported outcome, so `ok: true` here means "the
 * attempt ran", not "everything attached" — read `enhanced`. `tab_id` is null
 * for a table opened in a reader *window* rather than a tab.
 */
export async function handleTestTableOpenReaderHttpRequest(
    request: { key?: string; libraryID?: number; timeoutMs?: number } = {}
): Promise<any> {
    if (!request.key) return MISSING_KEY;
    const api = getTablesApi();
    if (!api) return TABLES_API_MISSING;

    const libraryID = request.libraryID ?? Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, request.key) as
        | Zotero.Item
        | false;
    if (!item) {
        return {
            ok: false,
            code: 'not_found',
            error: `No item ${request.key} in library ${libraryID}`,
        };
    }
    await loadTableItemFields([item]);
    if (!isTableItem(item)) {
        return {
            ok: false,
            code: 'not_a_table',
            error: `Item ${request.key} is not a Beaver table.`,
        };
    }

    const report = await api.openInReader(item, { timeoutMs: request.timeoutMs });
    return {
        ok: true,
        key: report.itemKey,
        library_id: report.libraryID,
        enhanced: report.enhanced,
        reader_type: report.readerType,
        tab_id: report.tabID,
        is_table_item: report.isTableItem,
        // The document's own mark, carrying the format version it was written
        // with; null means the document was not one of ours (or not found).
        data_beaver_table: report.beaverTableAttribute,
        internal_reader_found: report.internalReaderFound,
        primary_view_found: report.primaryViewFound,
        view_initialized: report.viewInitialized,
        document_found: report.documentFound,
        card_mounted: report.cardMounted,
        listeners_attached: report.listenersAttached,
        // False can mean either "already read-only" or "this build has no
        // setReadOnly"; `failures` says which.
        annotations_disabled: report.annotationsDisabled,
        markers: report.markers,
        links: report.links,
        failures: report.failures,
        views: api.listViews(),
    };
}
