/**
 * The Beaver tab: a stored table in a `Zotero_Tabs` tab of a main window.
 *
 * This module owns the Zotero side — the tab, its container, the tab-type
 * hooks Zotero needs, and the lifecycle around them. The table itself is
 * rendered by the window's own React bundle through
 * `win.BeaverReact.renderTableTab` (`react/index.tsx`), mounted the same way
 * the sidebar roots are.
 *
 * ## The tab
 *
 * Type `beaver-table`. Zotero's `parseTabType` splits a type on `-`, so every
 * hook Zotero looks up for it is keyed by the content type `beaver`.
 *
 * `data.itemID` is the table's attachment. It makes `Zotero.Reader.open` —
 * double-click, `zotero://open` — select an open Beaver tab instead of
 * creating a reader, and it gives the tab the item's icon. It also makes
 * Zotero rename the tab through the `getTitle` hook whenever the item is
 * modified or the reader-title preference changes, so that hook is required:
 * without it the title becomes `undefined` and every tab-bar update throws.
 *
 * The pane is `div#beaver-pane-table-<tabID>.beaver-root` with React mounted
 * one level below it, because the shared sheets scope their utilities to
 * `[id^="beaver-pane-"]` and `.beaver-root .x`.
 *
 * ## Lifecycle
 *
 * - Closing the tab unmounts React in `onClose`, which `Zotero_Tabs.close`
 *   runs synchronously; Zotero removes the container a tick later.
 * - A window's Beaver tabs close before its renderer goes away
 *   (`BeaverUIFactory.removeChatPanel`), so a re-bootstrapped window starts
 *   without them.
 * - **Beaver tabs are not restored.** `Zotero_Tabs.getState()` persists every
 *   tab, and restoring one with no `restoreState` hook throws inside Zotero's
 *   restore loop and loses every tab after it. So: the hook exists in every
 *   main window from `DOMContentLoaded` on (a window restores its tabs on
 *   `load`, before plugins hear about it) and drops the entry; the tabs close
 *   on `quit-application-granted`, which reaches this observer before Zotero's
 *   own session save; closing tabs also strips them from the in-memory session
 *   (the state Zotero keeps for a last window closed while the app runs); and
 *   plugin shutdown saves the session without them. One gap remains: at a cold
 *   start the first window can restore before the plugin starts, so a session
 *   written by Zotero's periodic save just before a crash loses the tabs after
 *   ours. {@link recoverTabsAfterTableTabs} reopens those.
 *
 * ## Readers on a table item
 *
 * A reader opened on a table — double-click, `zotero://open`, anything that
 * calls `Zotero.Reader.open` while no Beaver tab is open — is closed and the
 * Beaver tab opened instead. It is heard on the `tab` notifier's `add`, which
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
import type { TableSpec } from '@beaver/agent-core/layouts/table';
import type { RenderTableTab, TableTabHandle, TableTabRenderReport } from './tableTabTypes';

export { TABLE_TAB_TYPE };
/** What Zotero's `parseTabType` makes of {@link TABLE_TAB_TYPE}; hooks are keyed by it. */
export const TABLE_TAB_CONTENT_TYPE = 'beaver';

const ZOTERO_PANE_URL = 'chrome://zotero/content/zoteroPane.xhtml';
const QUIT_TOPIC = 'quit-application-granted';

type TabHook = (...args: any[]) => unknown;

/** The part of `Zotero_Tabs` this module uses. */
interface TabsApi {
    add(options: {
        type: string;
        title?: string;
        data?: Record<string, unknown>;
        index?: number;
        select?: boolean;
        onClose?: () => void;
    }): { id: string; container: Element };
    select(id: string): void;
    close(ids: string | string[]): void;
    rename(id: string, title?: string): Promise<void>;
    getState(): Array<{ type: string; data?: { itemID?: number } }>;
    restoreState(tabs: unknown[]): Promise<void>;
    selectedID: string;
    tabHooks: Record<string, Record<string, TabHook> | undefined>;
}

interface TableTabRenderer {
    renderTableTab?: RenderTableTab;
    unmountFromElement?(container: Element): boolean;
}

type TableTabWindow = Window & {
    Zotero_Tabs?: TabsApi;
    BeaverReact?: TableTabRenderer;
};

interface SessionTab {
    type?: string;
    data?: { itemID?: number };
}

interface SessionState {
    windows?: Array<{ type?: string; tabs?: SessionTab[] }>;
}

interface TableTabEntry {
    win: TableTabWindow;
    tabID: string;
    ref: TableRef;
    itemID: number;
    mount: HTMLElement;
    reactContainer: HTMLElement;
    title: string;
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

/** Windows already open when the hooks went in; they may have restored without them. */
let lateHookedWindows = new WeakSet<Window>();
/**
 * The saved pane tabs as they were when the hooks went in, kept only when they
 * hold a Beaver tab: what the late windows restored from. Captured before
 * anything strips the in-memory session.
 */
let sessionAtInit: SessionTab[] | null = null;
/** What the startup checks saw, for the dev endpoint. */
const startup = {
    lateWindows: 0,
    savedTabs: null as string[] | null,
    recoveries: [] as Array<{ result: string; restored: number }>,
};
let opener: TableTabOpener | null = null;
let windowListener: { onOpenWindow(xulWindow: any): void; onCloseWindow(): void } | null = null;
let quitObserver: { observe(): void } | null = null;
let notifierID: string | null = null;

function tabsOf(win: Window | null | undefined): TabsApi | undefined {
    return (win as TableTabWindow | null | undefined)?.Zotero_Tabs;
}

function rendererOf(win: Window): TableTabRenderer | undefined {
    return (win as TableTabWindow).BeaverReact;
}

function sameRef(a: TableRef, b: TableRef): boolean {
    return a.libraryID === b.libraryID && a.key === b.key;
}

// ---------------------------------------------------------------------------
// Tab-type hooks
// ---------------------------------------------------------------------------

function installTabHooks(win: Window): boolean {
    const hooks = tabsOf(win)?.tabHooks;
    if (!hooks) return false;
    (hooks.getTitle ??= {})[TABLE_TAB_CONTENT_TYPE] = async (tab: { id: string; title?: string }) =>
        entries.get(tab.id)?.title ?? tab.title ?? '';
    // Tables are not restored. Answering with an object is what keeps
    // Zotero's `let { itemID } = await hook(...)` from throwing and abandoning
    // the tabs that follow this one.
    (hooks.restoreState ??= {})[TABLE_TAB_CONTENT_TYPE] = async () => ({ itemID: null });
    // Reopening a closed table goes through the product open, so it selects
    // the tab itself; answering false keeps Zotero from jumping to a tab index
    // the table may not occupy.
    (hooks.undoClose ??= {})[TABLE_TAB_CONTENT_TYPE] = async (
        tab: { data?: { beaverTable?: TableRef } },
        index?: number
    ) => {
        const ref = tab?.data?.beaverTable;
        if (opener && ref && Number.isInteger(ref.libraryID) && typeof ref.key === 'string') {
            void opener(
                { libraryID: ref.libraryID, key: ref.key },
                { window: win, ...(Number.isInteger(index) && index! > 0 ? { index } : {}) }
            ).catch((error) => logger(`tableTab: reopen failed: ${String(error)}`, 1));
        }
        return false;
    };
    // Keyboard selection and dragging move focus into the tab's content
    // through these; without them focus stays on the tab strip.
    (hooks.focusFirst ??= {})[TABLE_TAB_CONTENT_TYPE] = async (tab: { id: string }) => {
        focusTableTab(tab.id, null);
    };
    (hooks.refocus ??= {})[TABLE_TAB_CONTENT_TYPE] = async (
        tab: { id: string; lastFocusedElement?: Element | null }
    ) => {
        const last = tab.lastFocusedElement;
        tab.lastFocusedElement = null;
        focusTableTab(tab.id, last ?? null);
    };
    return true;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]';

/** Focuses `last` when it is still in the tab, else the tab's first control. */
function focusTableTab(tabID: string, last: Element | null): void {
    const entry = entries.get(tabID);
    if (!entry) return;
    const { mount } = entry;
    if (last?.isConnected && mount.contains(last) && typeof (last as HTMLElement).focus === 'function') {
        (last as HTMLElement).focus();
        return;
    }
    const first = mount.querySelector<HTMLElement>(FOCUSABLE);
    if (first) {
        first.focus();
        return;
    }
    if (!mount.hasAttribute('tabindex')) mount.setAttribute('tabindex', '-1');
    mount.focus();
}

function uninstallTabHooks(win: Window): void {
    const hooks = tabsOf(win)?.tabHooks;
    if (!hooks) return;
    delete hooks.getTitle?.[TABLE_TAB_CONTENT_TYPE];
    delete hooks.restoreState?.[TABLE_TAB_CONTENT_TYPE];
    delete hooks.undoClose?.[TABLE_TAB_CONTENT_TYPE];
    delete hooks.focusFirst?.[TABLE_TAB_CONTENT_TYPE];
    delete hooks.refocus?.[TABLE_TAB_CONTENT_TYPE];
}

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

/** The open Beaver tab showing `ref` in `win`, if any. */
export function findTableTab(win: Window, ref: TableRef): string | null {
    for (const entry of entries.values()) {
        if (entry.win === win && sameRef(entry.ref, ref)) return entry.tabID;
    }
    return null;
}

/** Whether `win` can host a Beaver tab right now. */
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
 * Opens `ref` in a Beaver tab of `win`, or selects the one already showing
 * it. Synchronous: the tab, its container and the React root exist on return.
 * Throws when `win` cannot host one — `openTable` resolves the window first.
 */
export function openTableTab(
    win: Window,
    item: Zotero.Item,
    ref: TableRef,
    options: OpenTableTabOptions = {}
): { tabID: string; reused: boolean } {
    const tabs = tabsOf(win);
    const renderer = rendererOf(win);
    if (!tabs || typeof renderer?.renderTableTab !== 'function') {
        throw new Error('This window cannot show a Beaver tab.');
    }
    installTabHooks(win);

    const existing = findTableTab(win, ref);
    if (existing) {
        stats.reused += 1;
        if (!options.background) tabs.select(existing);
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
    // `onClose` is created before the entry it releases exists.
    const slot: { entry?: TableTabEntry } = {};
    const { id, container } = tabs.add({
        type: TABLE_TAB_TYPE,
        title,
        data: { itemID: item.id, beaverTable: { libraryID: ref.libraryID, key: ref.key } },
        ...(options.index && options.index > 0 ? { index: options.index } : {}),
        select: !options.background,
        onClose: () => {
            if (slot.entry) releaseEntry(slot.entry);
        },
    });

    const doc = win.document;
    const mount = doc.createElement('div');
    mount.id = `beaver-pane-table-${id}`;
    mount.className = 'beaver-root beaver-table-tab';
    mount.setAttribute('style', 'display: flex; flex: 1; height: 100%; width: 100%; min-width: 0; min-height: 0; overflow: hidden;');
    const reactContainer = doc.createElement('div');
    reactContainer.className = 'display-flex flex-col flex-1 h-full w-full min-w-0 min-h-0';
    mount.appendChild(reactContainer);
    container.appendChild(mount);

    const owned: TableTabEntry = { win: win as TableTabWindow, tabID: id, ref, itemID: item.id, mount, reactContainer, title, handle: null, renders: [] };
    slot.entry = owned;
    entries.set(id, owned);
    stats.opened += 1;

    try {
        owned.handle = renderer.renderTableTab(reactContainer, ref, {
            initial: options.initial,
            onTitle: (next) => {
                if (!entries.has(owned.tabID) || !next || next === owned.title) return;
                owned.title = next;
                void tabs.rename(owned.tabID, next);
            },
            onRendered: (report) => {
                owned.renders.push(report);
                if (owned.renders.length > MAX_RENDER_REPORTS) owned.renders.shift();
            },
        });
    } catch (error) {
        // A tab with nothing in it is worse than none.
        tabs.close(id);
        throw error;
    }
    return { tabID: id, reused: false };
}

/** Shows (or clears) the open warning in a Beaver tab. */
export function setTableTabWarning(tabID: string, warning: string | null): void {
    try {
        entries.get(tabID)?.handle?.setWarning(warning);
    } catch (error) {
        logger(`tableTab: could not show the warning: ${String(error)}`, 2);
    }
}

/** Unmounts a tab's React root and forgets it; its container is Zotero's. */
function releaseEntry(entry: TableTabEntry): void {
    if (!entries.delete(entry.tabID)) return;
    stats.closed += 1;
    try {
        if (rendererOf(entry.win)?.unmountFromElement?.(entry.reactContainer)) stats.unmounted += 1;
    } catch (error) {
        logger(`tableTab: unmount failed: ${String(error)}`, 1);
    }
    entry.mount.remove();
}

/**
 * Closes `win`'s Beaver tabs and strips them from the in-memory session.
 * For a window losing its renderer: re-bootstrap, unload, plugin shutdown.
 */
export function closeTableTabsForWindow(win: Window): number {
    const owned = [...entries.values()].filter((entry) => entry.win === win);
    if (owned.length) {
        try {
            tabsOf(win)?.close(owned.map((entry) => entry.tabID));
        } catch (error) {
            logger(`tableTab: closing tabs failed: ${String(error)}`, 1);
        }
        // A tab Zotero did not close still owns a root.
        for (const entry of owned) releaseEntry(entry);
    }
    dropTableTabsFromSession();
    return owned.length;
}

/**
 * Removes Beaver tabs from the session Zotero holds in memory: what it loaded
 * at startup and, after the last main window closed, that window's state —
 * both of which a later save writes back as they are.
 */
export function dropTableTabsFromSession(): boolean {
    const state = (Zotero as unknown as { Session?: { state?: SessionState } }).Session?.state;
    let changed = false;
    for (const window of state?.windows ?? []) {
        if (!Array.isArray(window?.tabs)) continue;
        const kept = window.tabs.filter((tab) => tab?.type !== TABLE_TAB_TYPE);
        if (kept.length !== window.tabs.length) {
            window.tabs = kept;
            changed = true;
        }
    }
    return changed;
}

function baseTabType(type: string | undefined): string {
    return (type ?? '').replace(/-unloaded$/, '');
}

/**
 * Reopens tabs a session restore lost to a persisted Beaver tab.
 *
 * Only for a window that was open before the hooks went in (the first window
 * of a cold start), and only when the session it restored from holds a Beaver
 * tab — which a clean exit never leaves. Tabs after the first Beaver entry that
 * the window does not have are restored through Zotero's own restore hook
 * for their type, appended in their saved order.
 */
export async function recoverTabsAfterTableTabs(win: Window): Promise<number> {
    if (!lateHookedWindows.has(win)) {
        startup.recoveries.push({ result: 'hooked_before_restore', restored: 0 });
        return 0;
    }
    lateHookedWindows.delete(win);
    const tabs = tabsOf(win);
    const saved = sessionAtInit ?? [];
    const first = saved.findIndex((tab) => tab?.type === TABLE_TAB_TYPE);
    if (!tabs || first < 0) {
        startup.recoveries.push({ result: 'no_saved_table_tab', restored: 0 });
        return 0;
    }

    const present = new Set(
        tabs.getState().map((tab) => `${baseTabType(tab.type)}:${tab.data?.itemID ?? ''}`)
    );
    const missing = saved
        .slice(first + 1)
        .filter((tab) => tab?.type && tab.type !== TABLE_TAB_TYPE && tab.type !== 'library'
            && tab.data?.itemID && !present.has(`${baseTabType(tab.type)}:${tab.data.itemID}`));
    let restored = 0;
    for (const tab of missing) {
        // Zotero's own restore hook for the type, as `restoreState` calls it,
        // with the position at the end: `restoreState` itself would pass this
        // tab index 0, which `Zotero_Tabs.add` rejects.
        const hook = tabs.tabHooks.restoreState?.[baseTabType(tab.type).split('-')[0]];
        if (typeof hook !== 'function') continue;
        try {
            await hook(tab, tabs.getState().length);
            restored += 1;
        } catch (error) {
            logger(`tableTab: could not restore a ${tab.type} tab: ${String(error)}`, 1);
        }
    }
    dropTableTabsFromSession();
    startup.recoveries.push({ result: 'checked', restored });
    if (restored) logger(`tableTab: restored ${restored} tab(s) lost to a saved Beaver tab`, 2);
    return restored;
}

// ---------------------------------------------------------------------------
// Readers on a table item
// ---------------------------------------------------------------------------

function windowOfTab(tabID: string): Window | null {
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
 * Replaces the reader tab `tabID` on a table item with the Beaver tab. The
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
            logger(`tableTab: redirect to the Beaver tab failed: ${outcome.error}`, 1);
            if (!win.closed) Zotero.alert(win, 'Beaver', outcome.error);
        },
        (error) => logger(`tableTab: redirect to the Beaver tab failed: ${String(error)}`, 1),
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


/** Closes the Beaver tabs showing any of these items, through their normal close. */
function closeTableTabsForItems(ids: Array<string | number>): void {
    const itemIDs = new Set(ids.map(Number));
    for (const entry of [...entries.values()]) {
        if (!itemIDs.has(entry.itemID)) continue;
        try {
            tabsOf(entry.win)?.close(entry.tabID);
        } catch (error) {
            logger(`tableTab: could not close the tab of a removed table: ${String(error)}`, 1);
        }
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
 * Installs the tab hooks in every main window, now and as each opens, and the
 * quit and reader observers. `open` is the product open (`openTable`), used
 * to redirect readers and to reopen a closed tab. Safe to call twice.
 */
export function initTableTabs(open: TableTabOpener): void {
    teardown();
    opener = open;
    lateHookedWindows = new WeakSet();
    const state = (Zotero as unknown as { Session?: { state?: SessionState } }).Session?.state;
    const paneTabs = state?.windows?.find((w) => w?.type === 'pane')?.tabs;
    sessionAtInit = Array.isArray(paneTabs) && paneTabs.some((tab) => tab?.type === TABLE_TAB_TYPE)
        ? paneTabs.map((tab) => ({ ...tab }))
        : null;
    startup.savedTabs = Array.isArray(paneTabs) ? paneTabs.map((tab) => String(tab?.type)) : null;
    startup.recoveries = [];

    startup.lateWindows = 0;
    for (const win of Zotero.getMainWindows()) {
        if (installTabHooks(win)) {
            lateHookedWindows.add(win);
            startup.lateWindows += 1;
        }
    }
    windowListener = {
        onOpenWindow(xulWindow: any) {
            const win = xulWindow?.docShell?.domWindow as Window | undefined;
            win?.addEventListener('DOMContentLoaded', () => {
                if (win.location?.href === ZOTERO_PANE_URL) installTabHooks(win);
            }, { once: true });
        },
        onCloseWindow() {},
    };
    Services.wm.addListener(windowListener as any);

    // `nsIObserverService` notifies the most recently added observer first, so
    // this runs before the save Zotero registered at its own startup.
    quitObserver = {
        observe() {
            for (const win of new Set([...entries.values()].map((entry) => entry.win))) closeTableTabsForWindow(win);
            dropTableTabsFromSession();
        },
    };
    Services.obs.addObserver(quitObserver as any, QUIT_TOPIC);

    notifierID = Zotero.Notifier.registerObserver(
        {
            notify: async (event: string, type: string, ids: Array<string | number>, extraData: any) => {
                if (type === 'item') {
                    // Zotero closes a reader whose item is trashed or deleted;
                    // a Beaver tab is not a reader, so it closes here.
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
 * Closes every Beaver tab and removes the hooks and observers. With
 * `saveSession` (plugin shutdown), rewrites the session without the tabs:
 * nothing could restore them once Beaver is gone.
 */
export function cleanupTableTabs(options: { saveSession?: boolean } = {}): void {
    teardown();
    dropTableTabsFromSession();
    if (options.saveSession) {
        const session = (Zotero as unknown as { Session?: { save?: () => Promise<void> } }).Session;
        void session?.save?.()?.catch?.((error: unknown) => logger(`tableTab: session save failed: ${String(error)}`, 1));
    }
}

/**
 * Closes the tabs and removes hooks and observers. Leaves the in-memory
 * session alone: at startup it is what {@link recoverTabsAfterTableTabs}
 * compares against.
 */
function teardown(): void {
    setTableReaderRedirect(null);
    if (windowListener) {
        try { Services.wm.removeListener(windowListener as any); } catch { /* already gone */ }
        windowListener = null;
    }
    if (quitObserver) {
        try { Services.obs.removeObserver(quitObserver as any, QUIT_TOPIC); } catch { /* already gone */ }
        quitObserver = null;
    }
    if (notifierID) {
        try { Zotero.Notifier.unregisterObserver(notifierID); } catch { /* already gone */ }
        notifierID = null;
    }
    for (const entry of [...entries.values()]) {
        try {
            tabsOf(entry.win)?.close(entry.tabID);
        } catch (error) {
            logger(`tableTab: closing a tab failed: ${String(error)}`, 1);
        }
        releaseEntry(entry);
    }
    for (const win of Zotero.getMainWindows()) uninstallTabHooks(win);
    opener = null;
}

/** Open Beaver tabs, for the dev endpoint. */
export function listTableTabs(): Array<{
    tabID: string;
    libraryID: number;
    key: string;
    title: string;
    mounted: boolean;
    renders: TableTabRenderReport[];
}> {
    return [...entries.values()].map((entry) => ({
        tabID: entry.tabID,
        libraryID: entry.ref.libraryID,
        key: entry.ref.key,
        title: entry.title,
        mounted: entry.mount.isConnected && entry.reactContainer.childElementCount > 0,
        renders: entry.renders.slice(),
    }));
}

/** Lifetime counters, for the dev endpoint. */
export function tableTabStats(): typeof stats {
    return { ...stats };
}

/** What startup saw: windows hooked late, the saved tabs, each recovery. */
export function tableTabStartup(): typeof startup {
    return { ...startup, recoveries: startup.recoveries.slice() };
}
