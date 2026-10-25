/**
 * The table tab: a stored table in a Beaver tab of a main window.
 *
 * The tab itself — type, Zotero hooks, pane, closing, keeping it out of the
 * session and reopening it after a restart or reload — is `beaverTabs.ts`,
 * shared by every kind of Beaver tab. This module is the `table` kind: it
 * renders the table into the tab's pane through the window's own React
 * bundle (`win.BeaverReact.renderTableTab`, `react/index.tsx`), mounted the
 * same way the sidebar roots are, and handles what is particular to tables.
 *
 * ## The tab
 *
 * Type `beaver-table`; its ref is the table's `{ libraryID, key }`.
 * `data.itemID` is the table's attachment. It makes `Zotero.Reader.open` —
 * double-click, `zotero://open` — select an open table tab instead of
 * creating a reader, and it gives the tab the item's icon.
 *
 * Every open, the restore after a restart or reload, and undo-close go
 * through the product open (`openTable`), so repair and locking apply.
 * Trashing or deleting a table closes its tab, which is not remembered.
 *
 * ## Readers on a table item
 *
 * A reader opened on a table — double-click, `zotero://open`, anything that
 * calls `Zotero.Reader.open` while no table tab is open — is closed and the
 * table tab opened instead. It is heard on the `tab` notifier's `add`, which
 * Zotero fires inside `Zotero_Tabs.add`, before the reader loads, so the
 * snapshot never paints. The observer stays short and never awaits the
 * reader's initialisation: the notifier runs its observers one after another.
 * Restored, unloaded reader tabs load without an `add`; `readerTableView`'s
 * toolbar hook hands those over through the same redirect. Reader *windows*
 * keep the snapshot and its enhancement.
 */

import { TABLE_TAB_TYPE, collapseTableTabContextPane, isBeaverChatOpen } from './tableTabContextPane';
import { logger } from '@beaver/agent-core/platform/logger';
import { isTableItem, loadTableItemFields, type TableRef } from '../services/artifacts/tableItemIdentity';
import { isTableReaderOptedIn, setTableReaderRedirect } from '../services/artifacts/view/readerTableView';
import {
    addBeaverTab,
    beaverTabWindow,
    closeBeaverTab,
    findBeaverTab,
    listBeaverTabs,
    registerBeaverTabKind,
    renameBeaverTab,
    selectBeaverTab,
    unregisterBeaverTabKind,
} from './beaverTabs';
import type { TableSpec } from '@beaver/agent-core/layouts/table';
import type { RenderTableTab, TableTabHandle, TableTabRenderReport } from './tableTabTypes';

export { TABLE_TAB_TYPE };
/** The Beaver tab kind of a table tab. */
export const TABLE_TAB_KIND = 'table';

interface TableTabRenderer {
    renderTableTab?: RenderTableTab;
    unmountFromElement?(container: Element): boolean;
}

type TableTabWindow = Window & {
    Zotero_Tabs?: { selectedID: string; close(ids: string | string[]): void };
    BeaverReact?: TableTabRenderer;
};

interface TableTabEntry {
    win: TableTabWindow;
    tabID: string;
    ref: TableRef;
    itemID: number;
    pane: HTMLElement;
    reactContainer: HTMLElement;
    handle: TableTabHandle | null;
    /** The last renders, newest last; dev diagnostics only. */
    renders: TableTabRenderReport[];
}

/** Opens a table the way the product does: `openTable` with its repair. */
export type TableTabOpener = (
    ref: TableRef,
    options: { window: Window; background?: boolean; index?: number }
) => Promise<{ error: string } | { ok: true }>;

const entries = new Map<string, TableTabEntry>();
const stats = { opened: 0, reused: 0, closed: 0, unmounted: 0, redirected: 0 };
const MAX_RENDER_REPORTS = 40;

let opener: TableTabOpener | null = null;
let notifierID: string | null = null;

function tabsOf(win: Window | null | undefined): TableTabWindow['Zotero_Tabs'] {
    return (win as TableTabWindow | null | undefined)?.Zotero_Tabs;
}

function rendererOf(win: Window): TableTabRenderer | undefined {
    return (win as TableTabWindow).BeaverReact;
}

function sameRef(a: TableRef, b: TableRef): boolean {
    return a.libraryID === b.libraryID && a.key === b.key;
}

/** `value` as a table ref, or null. */
function parseTableRef(value: unknown): TableRef | null {
    const ref = value as Partial<TableRef> | null | undefined;
    return ref && Number.isInteger(ref.libraryID) && typeof ref.key === 'string' && ref.key
        ? { libraryID: ref.libraryID!, key: ref.key }
        : null;
}

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

/** The open table tab showing `ref` in `win`, if any. */
export function findTableTab(win: Window, ref: TableRef): string | null {
    return findBeaverTab(win, TABLE_TAB_KIND, ref);
}

/** Whether `win` can host a table tab right now. */
export function canHostTableTab(win: Window | null | undefined): boolean {
    return !!win && !win.closed && !!tabsOf(win)
        && typeof (win as TableTabWindow).BeaverReact?.renderTableTab === 'function';
}

export interface OpenTableTabOptions {
    /** The spec just read, handed to the first render. */
    initial?: { spec: TableSpec; version: number };
    /** Open behind the selected tab instead of selecting it. */
    background?: boolean;
    /** Tab position (1 is right after the library tab). */
    index?: number;
}

/**
 * Opens `ref` in a table tab of `win`, or selects the one already showing it.
 * Synchronous: the tab, its pane and the React root exist on return. Throws
 * when `win` cannot host one — `openTable` resolves the window first — or when
 * Beaver tabs are not running.
 */
export function openTableTab(
    win: Window,
    item: Zotero.Item,
    ref: TableRef,
    options: OpenTableTabOptions = {}
): { tabID: string; reused: boolean } {
    const renderer = rendererOf(win);
    if (!tabsOf(win) || typeof renderer?.renderTableTab !== 'function') {
        throw new Error('This window cannot show a Beaver tab.');
    }
    if (!opener) throw new Error('Beaver is not running.');

    const existing = findTableTab(win, ref);
    if (existing) {
        stats.reused += 1;
        if (!options.background) selectBeaverTab(existing);
        // A sync can replace the table without a local update event; the
        // open that reused the tab has just read it, so the tab reads again.
        try {
            entries.get(existing)?.handle?.reload();
        } catch (error) {
            Zotero.debug(`Beaver: reloading table tab ${existing} failed: ${String(error)}`);
        }
        return { tabID: existing, reused: true };
    }

    const title = options.initial?.spec.title || String(item.getField('title') || '') || 'Table';
    // `onRelease` is created before the entry it releases exists.
    const slot: { entry?: TableTabEntry } = {};
    const { tabID, pane } = addBeaverTab(win, {
        kind: TABLE_TAB_KIND,
        ref: { libraryID: ref.libraryID, key: ref.key },
        title,
        data: { itemID: item.id },
        index: options.index,
        background: options.background,
        onRelease: () => {
            if (slot.entry) releaseEntry(slot.entry);
        },
    });

    const reactContainer = win.document.createElement('div');
    reactContainer.className = 'display-flex flex-col flex-1 h-full w-full min-w-0 min-h-0';
    pane.appendChild(reactContainer);

    const owned: TableTabEntry = { win: win as TableTabWindow, tabID, ref, itemID: item.id, pane, reactContainer, handle: null, renders: [] };
    slot.entry = owned;
    entries.set(tabID, owned);
    stats.opened += 1;

    try {
        owned.handle = renderer.renderTableTab(reactContainer, ref, {
            initial: options.initial,
            onTitle: (next) => {
                if (entries.has(owned.tabID) && next) renameBeaverTab(owned.tabID, next);
            },
            onRendered: (report) => {
                owned.renders.push(report);
                if (owned.renders.length > MAX_RENDER_REPORTS) owned.renders.shift();
            },
        });
    } catch (error) {
        // A tab with nothing in it is worse than none.
        closeBeaverTab(tabID);
        throw error;
    }
    return { tabID, reused: false };
}

/** Shows (or clears) the open warning in a table tab. */
export function setTableTabWarning(tabID: string, warning: string | null): void {
    try {
        entries.get(tabID)?.handle?.setWarning(warning);
    } catch (error) {
        logger(`tableTab: could not show the warning: ${String(error)}`, 2);
    }
}

/** Unmounts a tab's React root and forgets it; the pane is `beaverTabs`'. */
function releaseEntry(entry: TableTabEntry): void {
    if (!entries.delete(entry.tabID)) return;
    stats.closed += 1;
    try {
        if (rendererOf(entry.win)?.unmountFromElement?.(entry.reactContainer)) stats.unmounted += 1;
    } catch (error) {
        logger(`tableTab: unmount failed: ${String(error)}`, 1);
    }
}

// ---------------------------------------------------------------------------
// Readers on a table item
// ---------------------------------------------------------------------------

function windowOfTab(tabID: string): Window | null {
    const owner = beaverTabWindow(tabID);
    if (owner) return owner;
    for (const win of Zotero.getMainWindows()) {
        if (!win.closed && tabsOf(win) && win.document.getElementById(tabID)) return win;
    }
    return null;
}

/** Candidates are imported HTML snapshots; everything else costs nothing. */
function mayBeTable(item: Zotero.Item | false | undefined): item is Zotero.Item {
    return !!item && item.isAttachment() && item.attachmentContentType === 'text/html';
}

/**
 * Replaces the reader tab `tabID` on a table item with the table tab. The
 * open is not awaited: it repairs the table under its lock, and the notifier
 * waits for each observer in turn.
 */
function replaceReaderTab(win: Window, tabID: string, item: Zotero.Item): void {
    const tabs = tabsOf(win);
    if (!tabs || !opener) return;
    const background = tabs.selectedID !== tabID;
    try {
        tabs.close(tabID);
    } catch (error) {
        logger(`tableTab: could not close the reader on ${item.key}: ${String(error)}`, 1);
        return;
    }
    stats.redirected += 1;
    void opener({ libraryID: item.libraryID, key: item.key }, { window: win, background }).then(
        (outcome) => {
            // The reader is gone, so a table that cannot be shown must say so.
            if (!('error' in outcome)) return;
            logger(`tableTab: redirect to the table tab failed: ${outcome.error}`, 1);
            if (!win.closed) Zotero.alert(win, 'Beaver', outcome.error);
        },
        (error) => logger(`tableTab: redirect to the table tab failed: ${String(error)}`, 1),
    );
}

async function onTabAdded(tabID: string, extra: { type?: string; itemID?: number } | undefined): Promise<void> {
    if (extra?.type !== 'reader' || !extra.itemID || !opener) return;
    if (isTableReaderOptedIn(extra.itemID)) return;
    const item = Zotero.Items.get(extra.itemID) as Zotero.Item | false;
    if (!mayBeTable(item)) return;
    await loadTableItemFields([item]);
    if (!isTableItem(item)) return;
    const win = windowOfTab(tabID);
    if (win) replaceReaderTab(win, tabID, item);
}

/** Closes the table tabs showing any of these items, through their normal close. */
function closeTableTabsForItems(ids: Array<string | number>): void {
    const itemIDs = new Set(ids.map(Number));
    for (const entry of [...entries.values()]) {
        if (itemIDs.has(entry.itemID)) closeBeaverTab(entry.tabID);
    }
}

/** For `readerTableView`'s toolbar hook: a restored reader tab that loaded. */
function redirectLoadedReader(reader: { tabID?: string; _window?: Window }, item: Zotero.Item): boolean {
    if (!reader?.tabID || !opener || isTableReaderOptedIn(item.id)) return false;
    const win = reader._window && tabsOf(reader._window) ? reader._window : windowOfTab(reader.tabID);
    if (!win) return false;
    replaceReaderTab(win, reader.tabID, item);
    return true;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the `table` kind with `beaverTabs` (after `initBeaverTabs`) and
 * installs the reader and item observers. `open` is the product open
 * (`openTable`), used to redirect readers, to reopen a closed tab and to
 * restore tabs. Safe to call twice.
 */
export function initTableTabs(open: TableTabOpener): void {
    cleanupTableTabs();
    opener = open;
    registerBeaverTabKind<TableRef>({
        kind: TABLE_TAB_KIND,
        parseRef: parseTableRef,
        sameRef,
        open: (ref, options) => open(ref, options),
    });

    notifierID = Zotero.Notifier.registerObserver(
        {
            notify: async (event: string, type: string, ids: Array<string | number>, extraData: any) => {
                if (type === 'item') {
                    // Zotero closes a reader whose item is trashed or deleted;
                    // a table tab is not a reader, so it closes here.
                    if (event === 'trash' || event === 'delete') closeTableTabsForItems(ids);
                    return;
                }
                if (event === 'select') {
                    const id = String(ids[0]);
                    if (extraData?.[id]?.type !== TABLE_TAB_TYPE) return;
                    // With the chat open, the sidebar shows it in the context
                    // pane (`tableTabContextPane`); closed, nothing belongs there.
                    const win = windowOfTab(id);
                    if (win && !isBeaverChatOpen(win)) collapseTableTabContextPane(win);
                    // Double-click and `zotero://open` select an open tab
                    // without opening the table, so the tab reads it again:
                    // a table damaged since shows why it cannot be shown.
                    try {
                        entries.get(id)?.handle?.reload();
                    } catch (error) {
                        logger(`tableTab: could not reload on select: ${String(error)}`, 2);
                    }
                    return;
                }
                if (event !== 'add') return;
                for (const id of ids) {
                    try {
                        await onTabAdded(String(id), extraData?.[id]);
                    } catch (error) {
                        logger(`tableTab: reader redirect failed: ${String(error)}`, 1);
                    }
                }
            },
        },
        ['tab', 'item'],
        'beaver-table-tab'
    );
    setTableReaderRedirect(redirectLoadedReader);
}

/**
 * Removes the observers and the `table` kind. The tabs themselves are closed
 * (and remembered) by `cleanupBeaverTabs`, which runs first.
 */
export function cleanupTableTabs(): void {
    setTableReaderRedirect(null);
    if (notifierID) {
        try { Zotero.Notifier.unregisterObserver(notifierID); } catch { /* already gone */ }
        notifierID = null;
    }
    unregisterBeaverTabKind(TABLE_TAB_KIND);
    opener = null;
}

/** Open table tabs, for the dev endpoint. */
export function listTableTabs(): Array<{
    tabID: string;
    libraryID: number;
    key: string;
    title: string;
    mounted: boolean;
    renders: TableTabRenderReport[];
}> {
    const titles = new Map(listBeaverTabs(TABLE_TAB_KIND).map((tab) => [tab.tabID, tab.title]));
    return [...entries.values()].map((entry) => ({
        tabID: entry.tabID,
        libraryID: entry.ref.libraryID,
        key: entry.ref.key,
        title: titles.get(entry.tabID) ?? '',
        mounted: entry.pane.isConnected && entry.reactContainer.childElementCount > 0,
        renders: entry.renders.slice(),
    }));
}

/** Lifetime counters, for the dev endpoint. */
export function tableTabStats(): typeof stats {
    return { ...stats };
}
