import React from 'react';
import type { TableSpec, ZoteroRowReference } from '@beaver/agent-core/layouts/table';
import { ExtractionTable } from '@beaver/agent-ui/layouts';
import MarkdownRenderer from '../messages/MarkdownRenderer';
import {
    isTableItemError,
    readTable,
    unreadableTableRecovery,
    type TableRef,
} from '../../../src/services/artifacts/tableItemIdentity';
import { TABLE_UPDATED_EVENT, type TableUpdatedDetail } from '../../../src/services/artifacts/tableStore';
import type { TableTabMountOptions, TableTabRenderReport } from '../../../src/ui/tableTabTypes';
import { getWindowRuntime } from '../../runtime/windowRuntime';
import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';
import { selectItemById } from '../../utils/selectItem';
import { describeItems } from './card/liveSources';
import { libraryRefForLibraryID, resolveLibraryRef } from '../../../src/utils/libraryIdentity';
import { getContentKind } from '../../../src/services/documentExtraction/attachmentResolution';

/** A value the tab's owner sets from outside React, read with `useSyncExternalStore`. */
export interface TableTabWarningSource {
    get(): string | null;
    subscribe(listener: () => void): () => void;
    /** Called when the tab is asked to read the table again. */
    onReload(listener: () => void): () => void;
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

/** A row answered from title and abstract, and the attachment it names if any. */
export interface MetadataRow {
    rowId: string;
    attachment?: ZoteroRowReference;
}

/**
 * The item of each row with an answer from title and abstract: the rows a
 * document gained since would improve. Keyed by the item's portable id.
 */
export function metadataAnsweredItems(spec: TableSpec | null): Map<string, MetadataRow[]> {
    const byItem = new Map<string, MetadataRow[]>();
    for (const row of spec?.rows ?? []) {
        if (row.ref?.kind !== 'item') continue;
        if (!Object.values(row.cells).some((cell) => cell?.provenance === 'metadata')) continue;
        const id = `${row.ref.library_ref}-${row.ref.zotero_key}`;
        byItem.set(id, [...(byItem.get(id) ?? []), { rowId: row.id, attachment: row.ref.attachment }]);
    }
    return byItem;
}

/** The kinds of attachment a row reads. */
const ROW_DOCUMENT_KINDS: ReadonlySet<string> = new Set(['pdf', 'epub', 'snapshot']);

/** Whether the attachment a row names is still a document outside the trash. */
function namedDocumentPresent(attachment: ZoteroRowReference): boolean {
    const libraryID = resolveLibraryRef(attachment);
    if (!libraryID) return false;
    const item = Zotero.Items.getByLibraryAndKey(libraryID, attachment.zotero_key) as Zotero.Item | false;
    return !!item && !item.deleted && item.isAttachment() && ROW_DOCUMENT_KINDS.has(getContentKind(item));
}

/**
 * Of the metadata-answered rows, those a fill now would answer from a
 * document: the attachment the row names when it names one, otherwise any
 * document of its item (`has_pdf` from the item display answer).
 */
export function improvableRowIds(
    candidates: Map<string, MetadataRow[]>,
    items: ReadonlyArray<{ item_id: string; has_pdf?: boolean }>,
    namedPresent: (attachment: ZoteroRowReference) => boolean = namedDocumentPresent,
): Set<string> {
    const found = new Set<string>();
    for (const item of items) {
        for (const entry of candidates.get(item.item_id) ?? []) {
            if (entry.attachment ? namedPresent(entry.attachment) : !!item.has_pdf) found.add(entry.rowId);
        }
    }
    return found;
}

/**
 * Rows answered from title and abstract whose item now has a PDF, EPUB or
 * snapshot attachment, by the rule a fill uses to pick a row's document: a
 * fill now would answer them from it. A row that names an attachment keeps
 * reading that one, even once it is gone, so only it counts for that row.
 * The lookup skips excluded libraries on purpose: the chip offers a fill, and
 * a fill cannot read them. Worked out from the items when the table is shown,
 * never stored; looked up again when the set of such rows changes or one of
 * their items gains or loses an attachment.
 */
function useImprovableRows(spec: TableSpec | null): ReadonlySet<string> {
    const candidates = React.useMemo(() => metadataAnsweredItems(spec), [spec]);
    const key = React.useMemo(() => [...candidates.keys()].sort().join(','), [candidates]);
    // The rows and the attachments they name, so a change to either looks again.
    const rowsKey = React.useMemo(
        () => JSON.stringify([...candidates.values()].flat().map((row) => [row.rowId, row.attachment?.zotero_key ?? null])),
        [candidates],
    );
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

function sameTable(a: Loaded, b: Loaded): boolean {
    return a.version === b.version && JSON.stringify(a.spec) === JSON.stringify(b.spec);
}

/**
 * What the tab says when the table cannot be read, with the way back for a
 * damaged file when there is one.
 */
async function readFailure(error: unknown, ref: TableRef): Promise<string> {
    const message = String((error as Error)?.message ?? error).replace(/\.$/, '');
    const damaged = isTableItemError(error) && error.code !== 'file_missing' && error.code !== 'not_a_table';
    if (!damaged) return `${message}.`;
    const recovery = await unreadableTableRecovery(ref);
    return `This table could not be read — ${message}.${recovery ? ` ${recovery}` : ''}`;
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
 * The surface is the shared extraction table at full size — rows windowed,
 * tall rows that fit the tab's width, search, sort and filter in the
 * toolbar. Evidence renders through the chat's `Citation` component with the
 * citation assembled from the row (inside `DataTable`), so nothing is added to
 * a thread's citation store.
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
                const message = await readFailure(error, tableRef);
                if (!live || mine !== sequence) return;
                // A table already on screen stays; the failure is reported over it.
                setState((current) =>
                    current.kind === 'table'
                        ? { kind: 'table', table: current.table, error: message }
                        : { kind: 'error', message },
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

    const notices = [warning, state.error].filter(Boolean);
    const itemID = Zotero.Items.getIDFromLibraryAndKey(tableRef.libraryID, tableRef.key);

    return (
        <div
            ref={hostRef}
            className="display-flex flex-col h-full w-full min-w-0 min-h-0"
            data-beaver-table-tab={tableRef.key}
        >
            <div className="flex-1 min-h-0 min-w-0">
                <ExtractionTable
                    table={state.table.spec}
                    renderText={renderCellText}
                    improvableRows={improvableRows}
                    fullControls
                    virtualize
                    fitWidth
                    notice={notices.length ? notices.join(' ') : undefined}
                    footerNote={`Version ${state.table.version}`}
                    onCopy={(text) => Zotero.Utilities.Internal.copyTextToClipboard(text)}
                    onShowInLibrary={
                        itemID
                            ? () => void selectItemById(itemID, true, undefined, surfaceWindow)
                            : undefined
                    }
                />
            </div>
        </div>
    );
}
