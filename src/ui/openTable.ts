/**
 * Putting a stored table on screen: the Beaver tab.
 *
 * Every product path that opens a table — the item-pane button, chat cards,
 * request chips, a reader replaced by the Beaver tab — comes through
 * {@link openTable}, so the window choice, the open repair and the warnings
 * are decided once.
 *
 * Three rules shape the file:
 *
 * 1. **Nothing throws.** Every caller is a UI path that must degrade, so
 *    failures come back as `{ error }`.
 * 2. **The tab opens before the repair.** The tab renders the committed
 *    `table.json`, which is current whatever state the snapshot is in, so it
 *    does not wait for the store's open repair — which takes the table's lock
 *    and so can sit behind a write in progress. The repair runs afterwards,
 *    and what it reports is shown in the tab and returned.
 * 3. **The tab opens where the user is.** The caller passes the window the
 *    interaction came from; the tab opens in that window's main window (the
 *    standalone Beaver window's is the main window it follows). Only an
 *    originless command — or a standalone window with no main window left —
 *    falls back to the most recent main window, opening one if none is open.
 *
 * This module is compiled into the **esbuild** bundle, so it may not import
 * `react/*` or anything that reaches it. That is why the item is resolved
 * through `tableItemIdentity` rather than through `tableStore.ts`, which
 * imports the library-exclusion check and with it the whole React graph.
 *
 * Opening is not gated on library exclusion. Exclusion governs writes, indexing
 * and what leaves the machine; a table already in the user's library is theirs
 * to look at.
 */

import { closeStaleTableReaders } from '../services/artifacts/view/readerTableView';
import { snapshotIsCurrent } from '../services/artifacts/tableRenderer';
import {
    readTableItemSpec,
    resolveTableItem,
    unreadableTableRecovery,
    type TableRef,
} from '../services/artifacts/tableItemIdentity';
import { contextMainWindow, resolveNavigationWindow, WindowUnavailableError } from '../runtime/navigation';
import { canHostTableTab, openTableTab, setTableTabWarning } from './tableTab';

export type OpenTableOutcome =
    | { ok: true; tabID: string; reused: boolean; warning?: string }
    | { error: string };

export interface OpenTableOptions {
    /**
     * The window the interaction came from — the clicked element's
     * `ownerDocument.defaultView`. Omit only for a command with no origin.
     */
    window?: Window | null;
    /** Open behind the selected tab (a reader replaced in the background). */
    background?: boolean;
    /** Tab position, for reopening a closed tab where it was. */
    index?: number;
}

/** How long to wait for a main window's Beaver renderer to come up. */
const TAB_HOST_TIMEOUT_MS = 15000;

const BOOKKEEPING_PENDING =
    'Content is committed, but local bookkeeping needs repair. Use Check / repair table to retry.';
const BOOKKEEPING_UNCHECKED =
    'Local bookkeeping could not be checked. Use Check / repair table to retry.';
const SNAPSHOT_BEHIND =
    'The saved snapshot of this table could not be updated, so Zotero without Beaver shows an earlier version. Use Check / repair table to retry.';

/**
 * The main window that hosts the tab: the origin's own (see rule 3), once its
 * Beaver renderer is up.
 */
async function tableTabWindow(origin: Window | null | undefined): Promise<Window> {
    const local = origin ? contextMainWindow(origin) : null;
    // A closed or closing origin is not an originless command: never open the
    // table somewhere else on its behalf.
    if (origin && !local && (origin.closed || origin.__beaverRuntime?.status === 'closing')) {
        throw new WindowUnavailableError();
    }
    const win: Window = await resolveNavigationWindow(local ?? undefined);
    const deadline = Date.now() + TAB_HOST_TIMEOUT_MS;
    while (!canHostTableTab(win) || win.__beaverRuntime?.status !== 'ready') {
        if (win.closed || win.__beaverRuntime?.status === 'closing' || Date.now() >= deadline) {
            throw new WindowUnavailableError();
        }
        await Zotero.Promise.delay(50);
    }
    return win;
}

/**
 * The store's open repair — re-rendering a stale snapshot, rebuilding a
 * missing `table.json` — and the warning to show for what it could not do.
 */
async function repairOnOpen(item: Zotero.Item, ref: TableRef): Promise<string | undefined> {
    let sha256: string | undefined;
    try {
        const current = await Zotero.Beaver.libraryOperations.run('table_openTable', [ref]);
        sha256 = current.sha256;
        if (current.recovered.some((entry) => entry.kind === 'bookkeeping_pending')) return BOOKKEEPING_PENDING;
    } catch {
        return BOOKKEEPING_UNCHECKED;
    }
    // A render that failed leaves the previous snapshot in place.
    if (sha256 && !(await snapshotIsCurrent(item, sha256))) return SNAPSHOT_BEHIND;
    return undefined;
}

/**
 * Shows a stored table in the Beaver tab, or selects the tab already showing
 * it, then runs the store's open repair.
 *
 * Resolves `{ ok, tabID, reused, warning? }` once the repair has settled; the
 * tab itself is on screen before that. Never throws.
 */
export async function openTable(ref: TableRef, options: OpenTableOptions = {}): Promise<OpenTableOutcome> {
    try {
        const item = await resolveTableItem(ref);
        // Read before choosing a window: a table whose files have not reached
        // this device, or that cannot be read at all, opens nothing.
        const read = await readTableItemSpec(item);
        if (!read.ok) {
            if (read.code === 'no_file') return { error: `Could not open table ${ref.key} — it has no file on disk.` };
            const recovery = await unreadableTableRecovery(ref);
            return {
                error: `Could not open table ${ref.key} — ${read.message.replace(/\.$/, '')}.${recovery ? ` ${recovery}` : ''}`,
            };
        }
        const win = await tableTabWindow(options.window);
        // A reader still showing an old snapshot of this table goes away.
        await closeStaleTableReaders(item.id);
        const { tabID, reused } = openTableTab(win, item, ref, {
            initial: { spec: read.spec, version: read.spec.version ?? 0 },
            background: options.background,
            index: options.index,
        });
        const warning = await repairOnOpen(item, ref);
        setTableTabWarning(tabID, warning ?? null);
        return { ok: true, tabID, reused, ...(warning ? { warning } : {}) };
    } catch (error) {
        if (error instanceof WindowUnavailableError) {
            return { error: `Could not open table ${ref.key} — no Zotero window is available to show it.` };
        }
        // No trailing period: the thrown message usually carries its own, and
        // `... in library 1..` reads like a typo in the log.
        const message = String((error as Error)?.message ?? error);
        return { error: `Could not open table ${ref.key} — ${message}` };
    }
}
