/**
 * The table window: a stored table in a window of its own.
 *
 * Zotero gives each reader its own window on request ("Open … in New Window",
 * "Move to New Window", the open-in-new-window preference); a table gets the
 * same. The window is `beaverTableWindow.xhtml` (type `beaver:table`), one per
 * table: opening a table already in a window brings that window forward.
 *
 * ## The renderer
 *
 * The window runs its own copy of the React bundle, as the separate Beaver
 * window does, attached to the plugin runtime with the `table` kind: it
 * follows the active main window as its context (for navigation) and has no
 * chat. It renders the same table view as the Beaver tab
 * (`BeaverReact.renderTableTab`, with `surface: 'window'`), so editing, fills,
 * exports and version history behave the same. "Ask Beaver" opens a main
 * window's chat with the table attached; "Show in library" selects it in a
 * main window and brings that window forward.
 *
 * ## Native menus
 *
 * The window's menu bar (the global one on macOS, the window's own on Windows
 * and Linux) carries the table's actions. Each action is a `<command>` with a
 * `data-table-command`; the window script hands them here, and each menu
 * updates its commands' state from the table as it opens. Edit's Undo, Copy
 * and Select All are Zotero's text commands, so they act on a focused text
 * field; elsewhere a window controller sends them to the table: Undo takes
 * back the last destructive edit, Copy copies the selected text, Select All
 * selects every row in view.
 *
 * ## Lifecycle
 *
 * - The window registers here before it loads, so a second open finds it.
 * - Trashing or deleting the table closes its window.
 * - Quitting Zotero, or Beaver shutting down (update, reload, disable), first
 *   records the open table windows in `tableWindowsToRestore`; the first main
 *   window that loads afterwards reopens them. A window the user closed is not
 *   recorded, and a crash restores none.
 * - The window's renderer is its own: closing every main window leaves it
 *   open, as Zotero's reader windows stay open.
 *
 * Esbuild bundle only: the windows and their records are module state.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableRef } from '../services/artifacts/tableItemIdentity';
import { getPref, setPref } from '../utils/prefs';
import { loadRendererBundle } from './rendererBundle';
import type {
    RenderTableTab,
    TableFocusTarget,
    TableTabHandle,
    TableTabRenderReport,
    TableTabRequest,
    TableViewCommand,
    TableViewMenuState,
} from './tableTabTypes';

/** The window type of a table window, for `Services.wm`. */
export const TABLE_WINDOW_TYPE = 'beaver:table';
const TABLE_WINDOW_URL = 'chrome://beaver/content/beaverTableWindow.xhtml';
const QUIT_TOPIC = 'quit-application-granted';
/** How long a saved list of windows stays worth reopening. */
const RESTORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How far a new window moves away from one already at its place. */
const CASCADE_PX = 26;
const MAX_RENDER_REPORTS = 40;

interface TableWindowRenderer {
    renderTableTab?: RenderTableTab;
    unmountFromElement?(container: Element): boolean;
    disposeRuntime?(): void;
}

type TableWindow = Window & { BeaverReact?: TableWindowRenderer };

/** Opens a table in a window the way the product does (`openTable`); never throws. */
export type TableWindowOpener = (ref: TableRef) => Promise<{ error: string } | { ok: true }>;

interface TableWindowEntry {
    win: TableWindow;
    ref: TableRef;
    itemID: number;
    title: string;
    /** The spec the open read, handed to the first render. */
    initial?: { spec: TableSpec; version: number };
    container: HTMLElement | null;
    handle: TableTabHandle | null;
    /** What arrived before the table mounted, applied when it does. */
    pending: { focus?: TableFocusTarget; request?: TableTabRequest; warning?: string | null };
    controller: object | null;
    /** The last renders, newest last; dev diagnostics only. */
    renders: TableTabRenderReport[];
}

export interface OpenTableWindowOptions {
    initial?: { spec: TableSpec; version: number };
    focus?: TableFocusTarget;
    request?: TableTabRequest;
}

const entries = new Map<Window, TableWindowEntry>();
const stats = { opened: 0, reused: 0, closed: 0, restored: 0 };
let active = false;
let opener: TableWindowOpener | null = null;
let notifierID: string | null = null;
let quitObserver: { observe(): void } | null = null;

function sameRef(a: TableRef, b: TableRef): boolean {
    return a.libraryID === b.libraryID && a.key === b.key;
}

function isOpen(win: Window | null | undefined): win is TableWindow {
    try {
        return !!win && !win.closed;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/** The open table window showing `ref`, if any. */
export function findTableWindow(ref: TableRef): Window | null {
    for (const entry of entries.values()) {
        if (isOpen(entry.win) && sameRef(entry.ref, ref)) return entry.win;
    }
    return null;
}

/**
 * Brings the window showing `ref` forward, or opens one. Synchronous: the
 * window exists on return, its table mounts once it has loaded. Throws when
 * Beaver's table windows are not running.
 */
export function openTableWindow(
    item: Zotero.Item,
    ref: TableRef,
    options: OpenTableWindowOptions = {},
): { win: Window; reused: boolean } {
    if (!active) throw new Error('Beaver is not running.');
    const existing = findTableWindow(ref);
    if (existing) {
        stats.reused += 1;
        const entry = entries.get(existing)!;
        existing.focus();
        if (entry.handle) {
            // A sync can replace the table without a local update event; the
            // open that reused the window has just read it.
            try {
                entry.handle.reload();
                if (options.focus) entry.handle.focus(options.focus);
                if (options.request) entry.handle.request(options.request);
            } catch (error) {
                logger(`tableWindow: updating the window of ${ref.key} failed: ${String(error)}`, 2);
            }
        } else {
            if (options.focus) entry.pending.focus = options.focus;
            if (options.request) entry.pending.request = options.request;
        }
        return { win: existing, reused: true };
    }

    const title = options.initial?.spec.title || String(item.getField('title') || '') || 'Table';
    const win = Services.ww.openWindow(
        null as any,
        TABLE_WINDOW_URL,
        '_blank',
        'chrome,resizable,dialog=no',
        null as any,
    ) as unknown as TableWindow;
    entries.set(win, {
        win,
        ref: { libraryID: ref.libraryID, key: ref.key },
        itemID: item.id,
        title,
        initial: options.initial,
        container: null,
        handle: null,
        pending: { ...(options.focus ? { focus: options.focus } : {}), ...(options.request ? { request: options.request } : {}) },
        controller: null,
        renders: [],
    });
    stats.opened += 1;
    return { win, reused: false };
}

/** Shows (or clears) the open warning in a table window, now or once it mounts. */
export function setTableWindowWarning(win: Window, warning: string | null): void {
    const entry = entries.get(win);
    if (!entry) return;
    if (!entry.handle) {
        entry.pending.warning = warning;
        return;
    }
    try {
        entry.handle.setWarning(warning);
    } catch (error) {
        logger(`tableWindow: could not show the warning: ${String(error)}`, 2);
    }
}

// ---------------------------------------------------------------------------
// The window's own lifecycle (called from beaverTableWindow.js via hooks)
// ---------------------------------------------------------------------------

/**
 * The window has loaded: attach its runtime, load its renderer and mount the
 * table. A window Beaver did not open (nothing registered for it) closes.
 */
export function onTableWindowLoad(win: Window): void {
    const entry = entries.get(win);
    if (!entry || !active || !isOpen(win)) {
        if (isOpen(win)) win.close();
        return;
    }
    setWindowTitle(entry, entry.title);
    cascade(win);
    installController(entry);
    const runtime = Zotero.Beaver.runtime.attachWindow(win, 'table');
    loadRendererBundle(
        win,
        runtime,
        () => {
            const render = entry.win.BeaverReact?.renderTableTab;
            if (typeof render !== 'function') throw new Error('Beaver renderer API unavailable');
            mountTable(entry, render);
            runtime.status = 'ready';
        },
        (error) => {
            if (error) Zotero.logError(error as Error);
            else logger('tableWindow: the renderer failed to load', 1);
            showLoadFailure(entry);
        },
    );
}

function mountTable(entry: TableWindowEntry, render: RenderTableTab): void {
    const container = entry.win.document.getElementById('beaver-pane-table-window') as HTMLElement | null;
    if (!container) throw new Error('The table window has no pane');
    entry.container = container;
    const handle = render(container, entry.ref, {
        surface: 'window',
        initial: entry.initial,
        focus: entry.pending.focus,
        request: entry.pending.request,
        onTitle: (title) => {
            if (title) setWindowTitle(entry, title);
        },
        onRendered: (report) => {
            entry.renders.push(report);
            if (entry.renders.length > MAX_RENDER_REPORTS) entry.renders.shift();
        },
        // The window shows one table: it is on screen whenever the window is.
        isSelected: () => true,
    });
    entry.initial = undefined;
    entry.handle = handle;
    const warning = entry.pending.warning;
    entry.pending = {};
    if (warning !== undefined) setTableWindowWarning(entry.win, warning);
}

/** What the window shows when its renderer could not start. */
function showLoadFailure(entry: TableWindowEntry): void {
    try {
        const container = entry.win.document.getElementById('beaver-pane-table-window');
        if (!container || container.childElementCount) return;
        const message = entry.win.document.createElement('div');
        message.setAttribute('role', 'alert');
        message.setAttribute('style', 'padding: 20px;');
        message.textContent = 'Beaver couldn’t show this table. Close the window and open the table again.';
        container.appendChild(message);
    } catch {
        // The window is already going away.
    }
}

/**
 * The window is unloading: unmount its table, dispose its renderer and
 * detach its runtime. Its queued table work is cancelled; a write already
 * running keeps its lock until it settles.
 */
export function onTableWindowUnload(win: Window): void {
    const entry = entries.get(win);
    if (entry) {
        entries.delete(win);
        stats.closed += 1;
        removeController(entry);
        try {
            if (entry.container) entry.win.BeaverReact?.unmountFromElement?.(entry.container);
            entry.win.BeaverReact?.disposeRuntime?.();
        } catch (error) {
            logger(`tableWindow: unmount failed: ${String(error)}`, 1);
        }
        entry.handle = null;
    }
    const runtime = Zotero.Beaver?.runtime?.getWindow(win);
    if (!runtime) return;
    if (Zotero.Beaver.runtime.markClosing(win)) {
        try {
            Zotero.Beaver.mutations?.cancelOwner(runtime.id);
            Zotero.Beaver.syncPause?.releaseWindow(runtime.id);
        } catch (error) {
            logger(`tableWindow: releasing the window's work failed: ${String(error)}`, 1);
        }
    }
    Zotero.Beaver.runtime.detachWindow(win);
}

function setWindowTitle(entry: TableWindowEntry, title: string): void {
    entry.title = title;
    try {
        if (isOpen(entry.win)) entry.win.document.title = title;
    } catch {
        // The window is going away.
    }
}

/** Moves a new window off another table window left at the same place. */
function cascade(win: Window): void {
    try {
        for (const other of entries.keys()) {
            if (other === win || !isOpen(other)) continue;
            if (Math.abs(other.screenX - win.screenX) < 8 && Math.abs(other.screenY - win.screenY) < 8) {
                win.moveBy(CASCADE_PX, CASCADE_PX);
                return;
            }
        }
    } catch {
        // Placement is cosmetic.
    }
}

// ---------------------------------------------------------------------------
// Native menus and the window controller
// ---------------------------------------------------------------------------

/** Runs a table command from the window's menus or shortcuts. */
export function onTableWindowCommand(win: Window, command: string): void {
    const entry = entries.get(win);
    if (!entry?.handle) return;
    try {
        entry.handle.command(command as TableViewCommand);
    } catch (error) {
        logger(`tableWindow: command ${command} failed: ${String(error)}`, 1);
    }
}

/** The table's menu state in `entry`'s window; null before it has mounted. */
function menuStateOf(entry: TableWindowEntry | undefined): TableViewMenuState | null {
    try {
        return entry?.handle?.menuState() ?? null;
    } catch (error) {
        logger(`tableWindow: reading the menu state failed: ${String(error)}`, 2);
        return null;
    }
}

/**
 * Updates the window's table commands as a menu opens: each `<command>` with a
 * `data-table-command` is enabled or disabled, the row-height entries are
 * checked, and entries the build does not offer are hidden.
 */
export function onTableWindowMenuShowing(win: Window): void {
    const state = menuStateOf(entries.get(win));
    const doc = win.document;
    for (const element of Array.from(doc.querySelectorAll('command[data-table-command]')) as Element[]) {
        const command = element.getAttribute('data-table-command') as TableViewCommand;
        // Boolean XUL attributes are presence-based on Zotero 11.
        element.toggleAttribute('disabled', !state?.enabled[command]);
    }
    for (const item of Array.from(doc.querySelectorAll('menuitem[data-density]')) as Element[]) {
        item.toggleAttribute('checked', !!state?.density && item.getAttribute('data-density') === state.density);
    }
    for (const item of Array.from(doc.querySelectorAll('[data-table-fill]')) as Element[]) {
        item.toggleAttribute('hidden', !state?.fillAvailable);
    }
}

/** Edit commands the table answers when no text field takes them. */
const CONTROLLER_COMMANDS: Record<string, TableViewCommand> = {
    cmd_undo: 'undo',
    cmd_copy: 'copy-selection',
    cmd_selectAll: 'select-all-rows',
};

/**
 * A window controller for Edit's Undo, Copy and Select All. The command
 * dispatcher asks a focused text field's own controller first, so text
 * editing keeps these; elsewhere in the window they reach the table.
 */
function installController(entry: TableWindowEntry): void {
    const controllers = (entry.win as any).controllers;
    const ChromeUtilsRef = (globalThis as any).ChromeUtils ?? (entry.win as any).ChromeUtils;
    if (!controllers?.insertControllerAt || !ChromeUtilsRef) return;
    const enabled = (command: string) => {
        const mapped = CONTROLLER_COMMANDS[command];
        return !!mapped && !!menuStateOf(entry)?.enabled[mapped];
    };
    const controller = {
        supportsCommand: (command: string) => command in CONTROLLER_COMMANDS,
        isCommandEnabled: enabled,
        doCommand: (command: string) => {
            // The table refuses a command it cannot run now.
            if (enabled(command)) entry.handle?.command(CONTROLLER_COMMANDS[command]);
        },
        onEvent: () => {},
        QueryInterface: ChromeUtilsRef.generateQI(['nsIController']),
    };
    try {
        controllers.insertControllerAt(0, controller);
        entry.controller = controller;
    } catch (error) {
        logger(`tableWindow: could not install the edit controller: ${String(error)}`, 2);
    }
}

function removeController(entry: TableWindowEntry): void {
    if (!entry.controller) return;
    try {
        (entry.win as any).controllers?.removeController(entry.controller);
    } catch {
        // The window is already gone.
    }
    entry.controller = null;
}

// ---------------------------------------------------------------------------
// Restoring windows after a quit or a reload
// ---------------------------------------------------------------------------

interface RestoreRecord {
    savedAt: number;
    tables: TableRef[];
}

function isTableRef(value: any): value is TableRef {
    return !!value && Number.isInteger(value.libraryID) && typeof value.key === 'string' && !!value.key;
}

function readRestoreRecord(): RestoreRecord | null {
    try {
        const value = JSON.parse(getPref('tableWindowsToRestore') || 'null');
        if (!value || !Array.isArray(value.tables)) return null;
        if (!(Date.now() - value.savedAt <= RESTORE_MAX_AGE_MS)) return null;
        const tables = value.tables.filter(isTableRef).map((ref: TableRef) => ({ libraryID: ref.libraryID, key: ref.key }));
        return tables.length ? { savedAt: value.savedAt, tables } : null;
    } catch {
        return null;
    }
}

function writeRestoreRecord(tables: TableRef[]): void {
    try {
        setPref('tableWindowsToRestore', tables.length ? JSON.stringify({ savedAt: Date.now(), tables }) : '');
    } catch (error) {
        logger(`tableWindow: could not save the windows to reopen: ${String(error)}`, 1);
    }
}

/** Records the open table windows for {@link restoreTableWindows}. */
function rememberOpenWindows(): void {
    const tables = [...entries.values()].filter((entry) => isOpen(entry.win)).map((entry) => entry.ref);
    if (tables.length) writeRestoreRecord(tables);
}

/**
 * Reopens the table windows a quit or a Beaver shutdown recorded, once. The
 * record is consumed as it is read, so a crash later reopens nothing twice.
 */
export async function restoreTableWindows(): Promise<number> {
    const record = readRestoreRecord();
    if (getPref('tableWindowsToRestore')) writeRestoreRecord([]);
    if (!record || !opener) return 0;
    let restored = 0;
    for (const ref of record.tables) {
        if (!active || !opener) break;
        try {
            const outcome = await opener(ref);
            if ('error' in outcome) logger(`tableWindow: could not reopen ${ref.key}: ${outcome.error}`, 2);
            else restored += 1;
        } catch (error) {
            logger(`tableWindow: could not reopen ${ref.key}: ${String(error)}`, 2);
        }
    }
    stats.restored += restored;
    return restored;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Starts table windows: `open` is the product open in a window, used to
 * reopen recorded windows. Installs the observer that closes a trashed
 * table's window and the one that records open windows at quit. Safe to call
 * twice.
 */
export function initTableWindows(open: TableWindowOpener): void {
    stopObservers();
    active = true;
    opener = open;
    notifierID = Zotero.Notifier.registerObserver(
        {
            notify: async (event: string, _type: string, ids: Array<string | number>) => {
                if (event !== 'trash' && event !== 'delete') return;
                const itemIDs = new Set(ids.map(Number));
                for (const entry of [...entries.values()]) {
                    if (itemIDs.has(entry.itemID) && isOpen(entry.win)) entry.win.close();
                }
            },
        },
        ['item'],
        'beaver-table-window',
    );
    quitObserver = { observe: () => rememberOpenWindows() };
    try {
        Services.obs.addObserver(quitObserver as any, QUIT_TOPIC);
    } catch (error) {
        logger(`tableWindow: could not observe quitting: ${String(error)}`, 1);
    }
}

function stopObservers(): void {
    if (notifierID) {
        try { Zotero.Notifier.unregisterObserver(notifierID); } catch { /* already gone */ }
        notifierID = null;
    }
    if (quitObserver) {
        try { Services.obs.removeObserver(quitObserver as any, QUIT_TOPIC); } catch { /* already gone */ }
        quitObserver = null;
    }
}

/**
 * Stops table windows for Beaver's shutdown: records the open ones, so the
 * next start reopens them, and closes them while their renderers can still
 * clean up.
 */
export function cleanupTableWindows(): void {
    stopObservers();
    rememberOpenWindows();
    active = false;
    opener = null;
    for (const entry of [...entries.values()]) {
        if (isOpen(entry.win)) {
            onTableWindowUnload(entry.win);
            try { entry.win.close(); } catch { /* already gone */ }
        }
    }
    entries.clear();
}

/** Open table windows, for the dev endpoint. */
export function listTableWindows(): Array<{
    libraryID: number;
    key: string;
    title: string;
    mounted: boolean;
    runtimeId: string | null;
    renders: TableTabRenderReport[];
}> {
    return [...entries.values()].map((entry) => ({
        libraryID: entry.ref.libraryID,
        key: entry.ref.key,
        title: entry.title,
        mounted: !!entry.handle && !!entry.container?.isConnected && (entry.container?.childElementCount ?? 0) > 0,
        runtimeId: entry.win.__beaverRuntime?.id ?? null,
        renders: entry.renders.slice(),
    }));
}

/** Lifetime counters, for the dev endpoint. */
export function tableWindowStats(): typeof stats {
    return { ...stats };
}

/** The handle of the window showing `ref`, for the dev endpoint's menu probe. */
export function tableWindowMenuState(ref: TableRef): TableViewMenuState | null {
    const win = findTableWindow(ref);
    return (win && entries.get(win)?.handle?.menuState()) ?? null;
}
