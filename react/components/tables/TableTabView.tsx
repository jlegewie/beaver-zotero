import React from 'react';
import type { TableSpec } from '@beaver/agent-core/layouts/table';
import { ExtractionTable } from '@beaver/agent-ui/layouts';
import MarkdownRenderer from '../messages/MarkdownRenderer';
import {
    isTableItemError,
    readTable,
    UNREADABLE_TABLE_RECOVERY,
    type TableRef,
} from '../../../src/services/artifacts/tableItemIdentity';
import { TABLE_UPDATED_EVENT, type TableUpdatedDetail } from '../../../src/services/artifacts/tableStore';
import type { TableTabMountOptions, TableTabRenderReport } from '../../../src/ui/tableTabTypes';
import { getWindowRuntime } from '../../runtime/windowRuntime';
import { useSurfaceWindow } from '../../runtime/SurfaceWindowContext';
import { selectItemById } from '../../utils/selectItem';

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

function sameTable(a: Loaded, b: Loaded): boolean {
    return a.version === b.version && JSON.stringify(a.spec) === JSON.stringify(b.spec);
}

/** What the tab says when the table cannot be read, with the way back for a damaged file. */
function readFailure(error: unknown): string {
    const message = String((error as Error)?.message ?? error).replace(/\.$/, '');
    const damaged = isTableItemError(error) && error.code !== 'file_missing' && error.code !== 'not_a_table';
    return damaged ? `This table could not be read — ${message}. ${UNREADABLE_TABLE_RECOVERY}` : `${message}.`;
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
                const message = readFailure(error);
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
