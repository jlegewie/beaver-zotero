import React from 'react';
import { isTitleAbstractOnly, type TableSpec } from '@beaver/agent-core/layouts/table';
import { logger } from '@beaver/agent-core/platform/logger';
import { ResearchTable, type ResearchTableFocus, type ResearchTableReveal } from '@beaver/agent-ui/layouts';
import { CitationReaderTargetContext } from '@beaver/agent-ui/chat/Citation';
import MarkdownRenderer from '../messages/MarkdownRenderer';
import {
    isTableItemError,
    readTable,
    tableFilesEditable,
    tableReadProblem,
    type TableRef,
} from '../../../src/services/artifacts/tableItemIdentity';
import { isTableChatEnabled } from '../../../src/services/tableCapability';
import { TableFillButton, useFillResultBanner, useTableFillJob, type TableFillButtonHandle } from './TableFillControl';
import type { TableFillScope } from '@beaver/agent-core/protocol/tableFillProtocol';
import type { ResearchTableFill } from '@beaver/agent-ui/layouts';
import { TABLE_UPDATED_EVENT, type TableUpdatedDetail } from '../../../src/services/artifacts/tableStore';
import type { TableFocusTarget, TableTabMountOptions, TableTabRenderReport, TableTabRequest } from '../../../src/ui/tableTabTypes';
import { getWindowRuntime } from '../../runtime/windowRuntime';
import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';
import { useDocumentVisible } from '../../hooks/useDocumentVisible';
import { selectItemById } from '../../utils/selectItem';
import { describeItems } from './card/liveSources';
import { libraryRefForLibraryID } from '../../../src/utils/libraryIdentity';
import { exportTable, tableActionErrorMessage } from '../../../src/ui/tableDocumentActions';
import { TableVersionHistory } from './TableVersionHistory';
import { getTablesApi } from '../../../src/services/artifacts/tablesApi';
import { useNewPapers, useTableDocuments } from './tableTabData';
import { FILL_RUNNING_REASON, useTableEditing } from './useTableEditing';
import TableCardDropZone from './card/TableCardDropZone';
import { useAtomValue } from 'jotai';
import { searchableLibraryIdsAtom } from '../../atoms/profile';

/** A value the tab's owner sets from outside React, read with `useSyncExternalStore`. */
export interface TableTabWarningSource {
    get(): string | null;
    subscribe(listener: () => void): () => void;
    /** Called when the tab is asked to read the table again. */
    onReload(listener: () => void): () => void;
    /** Called when the tab is asked to bring a row or cell into view. */
    onFocus(listener: (target: TableFocusTarget) => void): () => void;
    /** Called when the tab is asked to show a fill's failed rows. */
    onRequest(listener: (request: TableTabRequest) => void): () => void;
    /** Called when the window's selected tab changes. */
    onSelectionChange(listener: () => void): () => void;
}

type Loaded = { spec: TableSpec; version: number };
type ViewState =
    | { kind: 'loading' }
    | { kind: 'table'; table: Loaded; error?: string }
    | { kind: 'error'; message: string };

/** The load whose commit the next layout effect reports. */
interface PendingReport {
    reason: TableTabRenderReport['reason'];
    started: number;
    readMs: number;
}

/**
 * The item of each row answered from title and abstract that names no
 * document yet: the rows a document gained since would improve. Keyed by the
 * item's portable id. A row that already names documents is left out, since
 * a fill keeps reading those; its cells from title and abstract show as stale
 * instead.
 */
export function titleAbstractAnsweredItems(spec: TableSpec | null): Map<string, string[]> {
    const byItem = new Map<string, string[]>();
    for (const row of spec?.rows ?? []) {
        if (row.ref?.kind !== 'item' || row.documents?.length) continue;
        if (!Object.values(row.cells).some((cell) => isTitleAbstractOnly(cell))) continue;
        const id = `${row.ref.library_ref}-${row.ref.zotero_key}`;
        byItem.set(id, [...(byItem.get(id) ?? []), row.id]);
    }
    return byItem;
}

/**
 * Of those rows, the ones a fill now would answer from a document: their item
 * has one (`has_pdf` from the item display answer).
 */
export function improvableRowIds(
    candidates: Map<string, string[]>,
    items: ReadonlyArray<{ item_id: string; has_pdf?: boolean }>,
): Set<string> {
    const found = new Set<string>();
    for (const item of items) {
        if (!item.has_pdf) continue;
        for (const rowId of candidates.get(item.item_id) ?? []) found.add(rowId);
    }
    return found;
}

/**
 * Rows answered from title and abstract, naming no document yet, whose item
 * now has a PDF, EPUB or snapshot attachment: a fill now would pick it as the
 * row's document and answer them from it. The lookup skips excluded libraries
 * on purpose: the chip offers a fill, and a fill cannot read them. Worked out
 * from the items when the table is shown, never stored; looked up again when
 * the set of such rows changes or one of their items gains or loses an
 * attachment.
 */
function useImprovableRows(spec: TableSpec | null): ReadonlySet<string> {
    const candidates = React.useMemo(() => titleAbstractAnsweredItems(spec), [spec]);
    const key = React.useMemo(() => [...candidates.keys()].sort().join(','), [candidates]);
    // The rows themselves, so a row gaining or losing such answers looks again.
    const rowsKey = React.useMemo(() => JSON.stringify([...candidates.values()].flat()), [candidates]);
    const [improvable, setImprovable] = React.useState<ReadonlySet<string>>(new Set());
    const [attachmentsChanged, setAttachmentsChanged] = React.useState(0);
    const candidatesRef = React.useRef(candidates);
    candidatesRef.current = candidates;

    // An attachment added to, or trashed from, one of those items while the
    // tab is open changes the answer: look again, once a burst has settled.
    // The observer is an app-lifetime registry, so it leaves with the tab.
    React.useEffect(() => {
        if (!key) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observerID = Zotero.Notifier.registerObserver(
            {
                notify: (event: string, _type: string, ids: Array<string | number>) => {
                    if (!['add', 'modify', 'trash'].includes(event)) return;
                    const touched = ids.some((id) => {
                        const item = Zotero.Items.get(Number(id)) as Zotero.Item | false;
                        const parent = item && item.parentItemID ? (Zotero.Items.get(item.parentItemID) as Zotero.Item | false) : false;
                        const ref = parent ? libraryRefForLibraryID(parent.libraryID) : null;
                        return !!parent && !!ref && candidatesRef.current.has(`${ref}-${parent.key}`);
                    });
                    if (!touched) return;
                    if (timer) clearTimeout(timer);
                    timer = setTimeout(() => setAttachmentsChanged((n) => n + 1), 500);
                },
            },
            ['item'],
            'beaver-table-improvable',
        );
        return () => {
            if (timer) clearTimeout(timer);
            Zotero.Notifier.unregisterObserver(observerID);
        };
    }, [key]);

    React.useEffect(() => {
        if (!key) {
            setImprovable(new Set());
            return;
        }
        let live = true;
        describeItems(key.split(',')).then(
            (rows) => {
                if (!live) return;
                setImprovable(improvableRowIds(candidatesRef.current, rows));
            },
            () => {
                if (live) setImprovable(new Set());
            },
        );
        return () => {
            live = false;
        };
    }, [key, rowsKey, attachmentsChanged]);
    return improvable;
}

/**
 * The one message under the toolbar, the newest: a fill's result replaces an
 * edit's message, and an edit's message covers the result until dismissed.
 */
export function useTableMessage(
    toast: React.ReactElement | null,
    clearToast: () => void,
    fillBanner: React.ReactElement | null,
    fillJobId: string | null,
): React.ReactElement | null {
    React.useEffect(() => {
        if (fillJobId) clearToast();
    }, [fillJobId, clearToast]);
    return toast ?? fillBanner;
}

function sameTable(a: Loaded, b: Loaded): boolean {
    return a.version === b.version && JSON.stringify(a.spec) === JSON.stringify(b.spec);
}

/**
 * What the tab says when the table cannot be read. Over a table already on
 * screen, it also says that what is shown is the last version that loaded.
 */
function readFailure(error: unknown, onScreen: boolean): string {
    const problem = isTableItemError(error) ? tableReadProblem(error.code) : null;
    if (!problem) return String((error as Error)?.message ?? error);
    const message = `Beaver can't open this table. ${problem}`;
    return onScreen ? `${message} You're seeing the last version that loaded.` : message;
}

const renderCellText = (text: string) => (
    // `markdown` is what the chat's citation styling is scoped to.
    <MarkdownRenderer content={text} className="markdown bt-md" />
);

/**
 * A stored table in the Beaver tab of a main window.
 *
 * It renders the store's last committed `table.json` and nothing else: the
 * spec the open handed over first, then a fresh read on every update event
 * for this table. The store emits that event after the write's render, so the
 * snapshot on disk is current by the time the tab re-reads. Reads are
 * sequenced: a read overtaken by a newer one is dropped.
 *
 * The surface is the shared research table (`ResearchTable`): the header and
 * toolbar, the grid with its tags, peek and hover cards, and the cell
 * inspector. What it shows beyond the spec is looked up here and handed in:
 * the documents' names and kinds, papers new in a source, the fill. Evidence
 * opens through the chat's `Citation` activation with the citation assembled
 * from the row, so nothing is added to a thread's citation store.
 */
export default function TableTabView({
    tableRef,
    options,
    warnings,
}: {
    tableRef: TableRef;
    options: TableTabMountOptions;
    warnings: TableTabWarningSource;
}): React.ReactElement {
    const surfaceWindow = useSurfaceWindow();
    const [state, setState] = React.useState<ViewState>(() =>
        options.initial ? { kind: 'table', table: options.initial } : { kind: 'loading' },
    );
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const warning = React.useSyncExternalStore(warnings.subscribe, warnings.get);
    const hostRef = React.useRef<HTMLDivElement>(null);
    const pending = React.useRef<PendingReport | null>(
        options.initial ? { reason: 'open', started: performance.now(), readMs: 0 } : null,
    );
    // Callbacks come from the esbuild side with the mount; keep the latest.
    const optionsRef = React.useRef(options);
    optionsRef.current = options;
    // The row or cell a citation asked for; each request gets a new token, so
    // the same cell asked for again is focused again.
    const focusRequests = React.useRef(0);
    const [focus, setFocus] = React.useState<ResearchTableFocus | null>(() =>
        options.focus ? { ...options.focus, token: ++focusRequests.current } : null,
    );
    // Rows or columns the user just added, brought into view.
    const [reveal, setReveal] = React.useState<ResearchTableReveal | null>(null);

    React.useEffect(() => {
        let live = true;
        let sequence = 0;
        const load = async (reason: PendingReport['reason']) => {
            const mine = ++sequence;
            const started = performance.now();
            try {
                const read = await readTable(tableRef);
                if (!live || mine !== sequence) return;
                // A re-read that finds the table unchanged (a tab selected
                // again) keeps what is on screen rather than re-rendering it.
                const current = stateRef.current;
                if (current.kind === 'table' && !current.error && sameTable(current.table, read)) return;
                pending.current = { reason, started, readMs: performance.now() - started };
                setState({ kind: 'table', table: read });
            } catch (error) {
                if (!live || mine !== sequence) return;
                logger(`TableTabView: could not read ${tableRef.key}: ${String((error as Error)?.message ?? error)}`, 2);
                // A table already on screen stays; the failure is reported over it.
                setState((current) =>
                    current.kind === 'table'
                        ? { kind: 'table', table: current.table, error: readFailure(error, true) }
                        : { kind: 'error', message: readFailure(error, false) },
                );
            }
        };
        if (!options.initial) void load('open');
        const unsubscribe = Zotero.Beaver.runtime.subscribeWindow(
            getWindowRuntime(),
            TABLE_UPDATED_EVENT,
            (detail: TableUpdatedDetail) => {
                if (detail?.libraryID === tableRef.libraryID && detail?.key === tableRef.key) void load('update');
            },
        );
        const stopReloads = warnings.onReload(() => void load('update'));
        // A write that committed between the opener's read and the
        // subscription above sent its event to nobody: read once more. The
        // version alone cannot tell, since one run's writes share a version.
        if (options.initial) void load('update');
        return () => {
            live = false;
            unsubscribe();
            stopReloads();
        };
        // The tab is mounted for one table; `options.initial` is read once.
    }, [tableRef.libraryID, tableRef.key]);

    const table = state.kind === 'table' ? state.table : null;
    const improvableRows = useImprovableRows(table?.spec ?? null);
    const documents = useTableDocuments(table?.spec ?? null);
    const newPapers = useNewPapers(table?.spec ?? null);
    const [actionError, setActionError] = React.useState<string | null>(null);
    const fillEnabled = isTableChatEnabled();
    const fillJob = useTableFillJob(tableRef);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const library = Zotero.Libraries.get(tableRef.libraryID);
    const readOnly = library ? !tableFilesEditable(library) : false;
    const editDisabledReason = readOnly ? 'This library is read-only.' : undefined;
    const [dropNotice, setDropNotice] = React.useState<string | null>(null);
    // A plan asked for from a row, a column or the selection bar, shown by
    // the Fill button's popover.
    const fillButton = React.useRef<TableFillButtonHandle>(null);
    const requestFill = React.useCallback((scope: TableFillScope) => fillButton.current?.openPlan(scope), []);
    const fillRunning = !!fillJob && fillJob.state !== 'done';
    // On screen: the selected tab of a window that is not hidden. Unknown
    // (null) when the tab's owner cannot say which tab is selected.
    const tabSelected = React.useSyncExternalStore(warnings.onSelectionChange, () => options.isSelected?.() ?? null);
    const documentVisible = useDocumentVisible(surfaceWindow.document);
    const tabVisible = tabSelected === null ? null : tabSelected && documentVisible;
    const fillResult = useFillResultBanner(fillJob, tabVisible);
    // A fill commits one version; an edit between its commits would split it,
    // so the table is not editable while one runs.
    const tableDisabledReason = editDisabledReason ?? (fillRunning ? FILL_RUNNING_REASON : undefined);
    const fill = React.useMemo<ResearchTableFill | undefined>(
        () =>
            fillEnabled
                ? {
                      disabledReason: tableDisabledReason,
                      onFillRows: (rowIds) => requestFill({ kind: 'cells', rows: rowIds }),
                      onFillColumn: (column) => requestFill({ kind: 'cells', columns: [column.id] }),
                  }
                : undefined,
        [fillEnabled, tableDisabledReason, requestFill],
    );
    const edits = useTableEditing({
        tableRef,
        spec: table?.spec ?? EMPTY_SPEC,
        disabledReason: tableDisabledReason,
        fillRunning,
        surfaceWindow,
        portalContainer: hostRef.current,
        newBySource: newPapers.bySource,
        onEdit: fillResult.onActivity,
        onRowsAdded: (rowIds) => {
            // Rows outside "failed rows only" could not be shown.
            fillResult.showAllRows();
            setReveal({ rowIds, token: ++focusRequests.current });
        },
        onColumnsAdded: (columnIds) => setReveal({ columnIds, token: ++focusRequests.current }),
    });
    const { showAllRows, showFailedRows } = fillResult;
    const tableMessage = useTableMessage(
        edits.toast,
        edits.clearToast,
        fillEnabled ? fillResult.banner : null,
        fillResult.jobId,
    );
    // A fill's failed rows asked for from the chat, shown once the table is
    // on screen.
    const [request, setRequest] = React.useState<TableTabRequest | null>(() => options.request ?? null);
    React.useEffect(() => warnings.onRequest(setRequest), [warnings]);
    const tableShown = state.kind === 'table';
    React.useEffect(() => {
        if (!request || !tableShown) return;
        setRequest(null);
        showFailedRows(request.job_id, request.row_ids);
    }, [request, tableShown, showFailedRows]);
    React.useEffect(
        () =>
            warnings.onFocus((target) => {
                // A row outside "failed rows only" could not be shown.
                showAllRows();
                setFocus({ ...target, token: ++focusRequests.current });
            }),
        [warnings, showAllRows],
    );

    React.useEffect(() => {
        if (table) optionsRef.current.onTitle(table.spec.title || 'Table');
    }, [table?.spec.title]);

    // Report the commit that put a load on screen: layout forced, so the
    // number holds even where rAF is throttled (a window in the background).
    React.useLayoutEffect(() => {
        const report = pending.current;
        if (!table || !report) return;
        pending.current = null;
        const host = hostRef.current;
        void host?.offsetHeight;
        optionsRef.current.onRendered?.({
            reason: report.reason,
            version: table.version,
            rows: table.spec.rows.length,
            readMs: Math.round(report.readMs),
            commitMs: Math.round(performance.now() - report.started),
            rowsInDom: host?.querySelectorAll('tbody > tr[data-row-id]').length ?? 0,
        });
    }, [table]);

    if (state.kind === 'loading') {
        return <div className="p-4 font-color-secondary">Loading table…</div>;
    }
    if (state.kind === 'error') {
        return (
            <div role="alert" className="p-4">
                {state.message}
            </div>
        );
    }

    const notices = [warning, state.error, actionError, edits.error, dropNotice].filter(Boolean);
    const itemID = Zotero.Items.getIDFromLibraryAndKey(tableRef.libraryID, tableRef.key);

    return (
        // A citation opened from the table must not replace the tab it is in.
        <CitationReaderTargetContext.Provider value="window">
        <div
            ref={hostRef}
            className="display-flex flex-col h-full w-full min-w-0 min-h-0 relative"
            data-beaver-table-tab={tableRef.key}
        >
            <TableCardDropZone
                className="flex-1 min-h-0 min-w-0 relative"
                searchableLibraryIds={searchableLibraryIds}
                disabled={readOnly}
                onAddItems={edits.onDrop.onAddItems}
                onAddScopes={edits.onDrop.onAddScopes}
                onNotice={setDropNotice}
            >
                <ResearchTable
                    table={state.table.spec}
                    renderText={renderCellText}
                    documents={documents}
                    newPapers={newPapers.notice}
                    virtualize
                    editing={edits.editing}
                    cellEditing={edits.cellEditing}
                    fill={fill}
                    filling={fillJob?.cells}
                    selectionActions={edits.selectionActions}
                    rowMenuItems={edits.rowMenuItems}
                    notice={notices.length ? notices.join(' ') : undefined}
                    headerEnd={
                        fillEnabled
                            ? (selectedRowIds: string[]) => (
                                  <TableFillButton
                                      tableRef={tableRef}
                                      table={state.table.spec}
                                      job={fillJob}
                                      improvableRows={improvableRows}
                                      disabledReason={editDisabledReason}
                                      selectedRowIds={selectedRowIds}
                                      ref={fillButton}
                                  />
                              )
                            : undefined
                    }
                    banner={tableMessage ?? undefined}
                    onActivity={fillResult.onActivity}
                    onlyRows={fillResult.failedRows}
                    focus={focus}
                    reveal={reveal}
                    onCopy={(text) => Zotero.Utilities.Internal.copyTextToClipboard(text)}
                    onExport={(format, sort) => {
                        const win = surfaceWindow;
                        const api = getTablesApi();
                        if (!win || !api) {
                            setActionError('Export is unavailable right now.');
                            return;
                        }
                        setActionError(null);
                        exportTable(win, tableRef, () => api.local.commands(win), format, sort).catch((error) =>
                            setActionError(tableActionErrorMessage(error, tableRef)),
                        );
                    }}
                    onShowInLibrary={
                        itemID
                            ? () => void selectItemById(itemID, true, undefined, surfaceWindow)
                            : undefined
                    }
                    renderVersionHistory={() => (
                        <TableVersionHistory
                            tableRef={tableRef}
                            currentVersion={state.table.version}
                            reloadKey={state.table}
                            readOnly={readOnly}
                            restoreDisabledReason={fillRunning ? FILL_RUNNING_REASON : undefined}
                        />
                    )}
                />
            </TableCardDropZone>
            {edits.overlay}
        </div>
        </CitationReaderTargetContext.Provider>
    );
}

/** What the editing hook reads before the table has loaded. */
const EMPTY_SPEC: TableSpec = { spec_version: 2, id: '', title: '', columns: [], rows: [] } as unknown as TableSpec;
