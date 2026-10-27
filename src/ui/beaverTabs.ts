/**
 * Beaver tabs: Beaver content in a `Zotero_Tabs` tab of a main window.
 *
 * This module owns what every kind of Beaver tab shares — the tab type, the
 * tab-type hooks Zotero needs, the pane each tab mounts into, and the
 * lifecycle around them. A kind (the stored table, `tableTab.ts`) registers
 * itself with {@link registerBeaverTabKind}, adds its tabs through
 * {@link addBeaverTab} and renders into the pane it gets back.
 *
 * ## The tab
 *
 * Type `beaver-<kind>`. Zotero's `parseTabType` splits a type on `-`, so every
 * hook Zotero looks up for a Beaver tab is keyed by the content type `beaver`,
 * whatever its kind: the hooks here are shared and dispatch by kind. A kind
 * name therefore never contains `-`.
 *
 * The tab's data carries `beaverTab: { kind, ref }`, where `ref` is the
 * kind's JSON description of the content it shows. Zotero hands hooks the
 * data, not always the type (`undoClose` gets only `data`), so the kind is in
 * the data too. A kind may add `itemID`: Zotero then selects the open tab for
 * that item instead of opening a reader, gives it the item's icon, and renames
 * it through the `getTitle` hook whenever the item is modified or the
 * reader-title preference changes — so that hook is required.
 *
 * The pane is `div#beaver-pane-<kind>-<tabID>.beaver-root` inside the tab's
 * container, because the shared sheets scope their utilities to
 * `[id^="beaver-pane-"]` and `.beaver-root .x`; a kind mounts one level below.
 *
 * ## Lifecycle
 *
 * - Closing the tab calls the kind's `onRelease` in `onClose`, which
 *   `Zotero_Tabs.close` runs synchronously; Zotero removes the container a
 *   tick later.
 * - A window's Beaver tabs close before its renderer goes away
 *   (`BeaverUIFactory.removeChatPanel`, through `Zotero.__beaverTabs`), so a
 *   re-bootstrapped window starts without them.
 * - **Beaver tabs stay out of Zotero's session.** `Zotero_Tabs.getState()`
 *   persists every tab, and restoring one with no `restoreState` hook throws
 *   inside Zotero's restore loop and loses every tab after it — which is what
 *   any start without Beaver would do. So: the hook exists in every main window
 *   from `DOMContentLoaded` on (a window restores its tabs on `load`, before
 *   plugins hear about it) and drops the entry; the tabs close on
 *   `quit-application-granted`, which reaches this observer before Zotero's
 *   own session save; closing tabs also strips them from the in-memory session
 *   (the state Zotero keeps for a last window closed while the app runs); and
 *   plugin shutdown saves the session without them.
 * - **Beaver reopens them itself.** Every lifecycle close — quit, plugin
 *   shutdown (update, reload, disable), a renderer going away, the last main
 *   window closing while Zotero runs — first records the window's Beaver tabs
 *   (kind, ref, position, whether selected) in the `beaverTabsToRestore`
 *   preference, keyed by the window's `outerWindowID`, which survives a plugin
 *   reload. A window closing while another stays open records nothing: Zotero
 *   forgets its tabs too. When a main window can host Beaver tabs again,
 *   {@link restoreBeaverTabs} takes its list off the record and reopens each
 *   tab through its kind's product open: the window's own list after a reload,
 *   the last closed window's in a new window, and after a restart the list of
 *   the first main window, the one whose tabs Zotero's session restores. A tab
 *   the user closed, or one a kind closed because its content went away,
 *   records nothing.
 * - **A crash restores no Beaver tab.** The record is written only by the
 *   closes above and is consumed when read. Zotero's periodic session save can
 *   still capture an open Beaver tab, and at a cold start the first window can
 *   restore before the plugin starts, losing the tabs after ours.
 *   {@link recoverTabsAfterBeaverTabs} reopens those, but not the Beaver tab.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { getPref, setPref } from '../utils/prefs';

/** What Zotero's `parseTabType` makes of every Beaver tab type; hooks are keyed by it. */
export const BEAVER_TAB_CONTENT_TYPE = 'beaver';

const ZOTERO_PANE_URL = 'chrome://zotero/content/zoteroPane.xhtml';
const QUIT_TOPIC = 'quit-application-granted';

/** The Zotero tab type of a Beaver tab of `kind`. */
export function beaverTabType(kind: string): string {
    return `${BEAVER_TAB_CONTENT_TYPE}-${kind}`;
}

/** Whether a Zotero tab type is a Beaver tab's, of any kind. */
export function isBeaverTabType(type: string | undefined | null): boolean {
    return (type ?? '').split('-')[0] === BEAVER_TAB_CONTENT_TYPE;
}

/** Opens Beaver content the way the product does; never throws. */
export interface BeaverTabOpenOptions {
    window: Window;
    /** Open behind the selected tab instead of selecting it. */
    background?: boolean;
    /** Tab position (1 is right after the library tab). */
    index?: number;
}

export type BeaverTabOpenOutcome = { error: string } | { ok: true };

/** A kind of Beaver tab, as {@link registerBeaverTabKind} takes it. */
export interface BeaverTabKind<Ref = unknown> {
    /** The part of the tab type after `beaver-`; no `-`. */
    kind: string;
    /** `value` as this kind's ref, from tab data or the restore record; null when it is not one. */
    parseRef(value: unknown): Ref | null;
    /** Whether two refs show the same content; a window shows each in one tab. */
    sameRef(a: Ref, b: Ref): boolean;
    /**
     * The product open: opens `ref` in `options.window`, or selects the tab
     * already showing it. Used to reopen a closed tab and to restore tabs.
     */
    open(ref: Ref, options: BeaverTabOpenOptions): Promise<BeaverTabOpenOutcome>;
}

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
    getState(): SessionTab[];
    selectedID: string;
    tabHooks: Record<string, Record<string, TabHook> | undefined>;
}

type BeaverTabWindow = Window & { Zotero_Tabs?: TabsApi; BeaverReact?: unknown };

/** What a Beaver tab's Zotero data carries about it. */
interface BeaverTabData {
    kind: string;
    ref: unknown;
}

interface SessionTab {
    type?: string;
    data?: { itemID?: number; beaverTab?: Partial<BeaverTabData> };
    selected?: boolean;
}

interface SessionState {
    windows?: Array<{ type?: string; tabs?: SessionTab[] }>;
}

interface BeaverTabEntry {
    win: BeaverTabWindow;
    tabID: string;
    kind: string;
    ref: unknown;
    title: string;
    pane: HTMLElement;
    onRelease: () => void;
}

/** A Beaver tab as a lifecycle close left it; `index` counts the library tab as 0. */
export interface RememberedBeaverTab extends BeaverTabData {
    index: number;
    selected: boolean;
}

interface RememberedWindow {
    /** The window's `outerWindowID`: stable while Zotero runs, across plugin reloads. */
    window: string | null;
    /** The window whose tabs Zotero's session restores on the next start. */
    primary: boolean;
    tabs: RememberedBeaverTab[];
}

/** The `beaverTabsToRestore` preference. */
interface RestoreRecord {
    /** The run of Zotero that wrote it ({@link appSessionID}). */
    session: string;
    savedAt: number;
    windows: RememberedWindow[];
}

interface PendingRestore {
    tabs: RememberedBeaverTab[];
    skipped: number;
    /** The tab to select at the end; restored tabs open in the background. */
    selected: BeaverTabData | null;
}

/** How long a saved list stays worth reopening. */
const RESTORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a loading window may take to be able to host a Beaver tab. */
const RESTORE_HOST_TIMEOUT_MS = 15000;

const kinds = new Map<string, BeaverTabKind<any>>();
const entries = new Map<string, BeaverTabEntry>();

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
    restores: [] as Array<{ result: string; restored: number; skipped: number }>,
};
/** Changes on every init and teardown; work started under another one stops. */
let generation = 0;
let active = false;
let windowListener: { onOpenWindow(xulWindow: any): void; onCloseWindow(): void } | null = null;
let quitObserver: { observe(): void } | null = null;
/** Set while Beaver closes tabs itself, so `onClose` does not take it for Zotero's teardown. */
let closingOwnTabs = false;
/** Windows whose tabs Zotero's own teardown closed, already remembered. */
let rememberedTeardowns = new WeakSet<Window>();
/**
 * Tabs a running {@link restoreBeaverTabs} has yet to reopen, per window, and
 * how many it skipped so far. A lifecycle close during the restore records
 * them with the open tabs, so they are not lost.
 */
const restoring = new Map<Window, PendingRestore>();

function tabsOf(win: Window | null | undefined): TabsApi | undefined {
    return (win as BeaverTabWindow | null | undefined)?.Zotero_Tabs;
}

function sameTab(a: BeaverTabData, b: BeaverTabData): boolean {
    if (a.kind !== b.kind) return false;
    const kind = kinds.get(a.kind);
    return kind ? kind.sameRef(a.ref, b.ref) : JSON.stringify(a.ref) === JSON.stringify(b.ref);
}

/** The `beaverTab` of a Zotero tab's data, when its kind is registered and its ref valid. */
function tabDataOf(data: SessionTab['data'] | undefined): BeaverTabData | null {
    const kind = typeof data?.beaverTab?.kind === 'string' ? kinds.get(data.beaverTab.kind) : undefined;
    const ref = kind?.parseRef(data?.beaverTab?.ref) ?? null;
    return kind && ref !== null ? { kind: kind.kind, ref } : null;
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/** Registers a kind of Beaver tab, replacing one of the same name. */
export function registerBeaverTabKind<Ref>(kind: BeaverTabKind<Ref>): void {
    if (!kind.kind || kind.kind.includes('-')) throw new Error(`Invalid Beaver tab kind "${kind.kind}"`);
    kinds.set(kind.kind, kind as BeaverTabKind<any>);
}

export function unregisterBeaverTabKind(kind: string): void {
    kinds.delete(kind);
}

// ---------------------------------------------------------------------------
// Tab-type hooks
// ---------------------------------------------------------------------------

function installTabHooks(win: Window): boolean {
    const hooks = tabsOf(win)?.tabHooks;
    if (!hooks) return false;
    (hooks.getTitle ??= {})[BEAVER_TAB_CONTENT_TYPE] = async (tab: { id: string; title?: string }) =>
        entries.get(tab.id)?.title ?? tab.title ?? '';
    // Zotero's session never restores a Beaver tab (Beaver does, from its own
    // record). Answering with an object is what keeps Zotero's
    // `let { itemID } = await hook(...)` from throwing and abandoning the tabs
    // that follow this one.
    (hooks.restoreState ??= {})[BEAVER_TAB_CONTENT_TYPE] = async () => ({ itemID: null });
    // Reopening a closed tab goes through its kind's product open, so it
    // selects the tab itself; answering false keeps Zotero from jumping to a
    // tab index the tab may not occupy.
    (hooks.undoClose ??= {})[BEAVER_TAB_CONTENT_TYPE] = async (tab: { data?: SessionTab['data'] }, index?: number) => {
        const target = tabDataOf(tab?.data);
        const kind = target && active ? kinds.get(target.kind) : undefined;
        if (target && kind) {
            void kind
                .open(target.ref, { window: win, ...(Number.isInteger(index) && index! > 0 ? { index } : {}) })
                .catch((error) => logger(`beaverTabs: reopen failed: ${String(error)}`, 1));
        }
        return false;
    };
    // Keyboard selection and dragging move focus into the tab's content
    // through these; without them focus stays on the tab strip.
    (hooks.focusFirst ??= {})[BEAVER_TAB_CONTENT_TYPE] = async (tab: { id: string }) => {
        focusBeaverTab(tab.id, null);
    };
    (hooks.refocus ??= {})[BEAVER_TAB_CONTENT_TYPE] = async (
        tab: { id: string; lastFocusedElement?: Element | null }
    ) => {
        const last = tab.lastFocusedElement;
        tab.lastFocusedElement = null;
        focusBeaverTab(tab.id, last ?? null);
    };
    return true;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]';

/** Focuses `last` when it is still in the tab, else the tab's first control. */
function focusBeaverTab(tabID: string, last: Element | null): void {
    const entry = entries.get(tabID);
    if (!entry) return;
    const { pane } = entry;
    if (last?.isConnected && pane.contains(last) && typeof (last as HTMLElement).focus === 'function') {
        (last as HTMLElement).focus();
        return;
    }
    const first = pane.querySelector<HTMLElement>(FOCUSABLE);
    if (first) {
        first.focus();
        return;
    }
    if (!pane.hasAttribute('tabindex')) pane.setAttribute('tabindex', '-1');
    pane.focus();
}

function uninstallTabHooks(win: Window): void {
    const hooks = tabsOf(win)?.tabHooks;
    if (!hooks) return;
    delete hooks.getTitle?.[BEAVER_TAB_CONTENT_TYPE];
    delete hooks.restoreState?.[BEAVER_TAB_CONTENT_TYPE];
    delete hooks.undoClose?.[BEAVER_TAB_CONTENT_TYPE];
    delete hooks.focusFirst?.[BEAVER_TAB_CONTENT_TYPE];
    delete hooks.refocus?.[BEAVER_TAB_CONTENT_TYPE];
}

// ---------------------------------------------------------------------------
// Adding, finding and closing tabs
// ---------------------------------------------------------------------------

export interface AddBeaverTabOptions<Ref> {
    kind: string;
    ref: Ref;
    title: string;
    /** More Zotero tab data, such as `itemID`. */
    data?: Record<string, unknown>;
    /** Tab position (1 is right after the library tab). */
    index?: number;
    /** Open behind the selected tab instead of selecting it. */
    background?: boolean;
    /** Releases what the kind mounted into the pane; runs once, as the tab closes. */
    onRelease: () => void;
}

/**
 * Adds a Beaver tab of a registered kind to `win` and returns its pane, empty
 * and in the document. Throws when `win` has no tab bar or Beaver tabs are not
 * running — an open still in flight when the plugin was torn down would
 * otherwise add a tab that nothing tracks or closes.
 */
export function addBeaverTab<Ref>(win: Window, options: AddBeaverTabOptions<Ref>): { tabID: string; pane: HTMLElement } {
    const tabs = tabsOf(win);
    if (!tabs) throw new Error('This window cannot show a Beaver tab.');
    if (!active || !kinds.has(options.kind)) throw new Error('Beaver is not running.');
    installTabHooks(win);

    // `onClose` is created before the entry it releases exists.
    const slot: { entry?: BeaverTabEntry } = {};
    const { id, container } = tabs.add({
        type: beaverTabType(options.kind),
        title: options.title,
        data: { ...options.data, beaverTab: { kind: options.kind, ref: options.ref } },
        ...(options.index && options.index > 0 ? { index: options.index } : {}),
        select: !options.background,
        onClose: () => {
            const entry = slot.entry;
            if (!entry) return;
            if (!closingOwnTabs) {
                if (isClosing(entry.win)) rememberTornDownWindow(entry.win);
                // Closed by the user, or by its kind: a restore still opening
                // it must not record it again.
                else dropFromPendingRestore(entry.win, entry);
            }
            releaseEntry(entry);
        },
    });

    const pane = win.document.createElement('div');
    pane.id = `beaver-pane-${options.kind}-${id}`;
    pane.className = `beaver-root beaver-tab beaver-${options.kind}-tab`;
    pane.setAttribute('style', 'display: flex; flex: 1; height: 100%; width: 100%; min-width: 0; min-height: 0; overflow: hidden;');
    container.appendChild(pane);

    const entry: BeaverTabEntry = {
        win: win as BeaverTabWindow,
        tabID: id,
        kind: options.kind,
        ref: options.ref,
        title: options.title,
        pane,
        onRelease: options.onRelease,
    };
    slot.entry = entry;
    entries.set(id, entry);
    return { tabID: id, pane };
}

/** The open Beaver tab of `kind` showing `ref` in `win`, if any. */
export function findBeaverTab(win: Window, kind: string, ref: unknown): string | null {
    for (const entry of entries.values()) {
        if (entry.win === win && sameTab(entry, { kind, ref })) return entry.tabID;
    }
    return null;
}

/** Renames an open Beaver tab; the title `getTitle` answers from then on. */
export function renameBeaverTab(tabID: string, title: string): void {
    const entry = entries.get(tabID);
    if (!entry || !title || title === entry.title) return;
    entry.title = title;
    void tabsOf(entry.win)?.rename(tabID, title);
}

/** Selects an open Beaver tab. */
export function selectBeaverTab(tabID: string): void {
    const entry = entries.get(tabID);
    if (entry) tabsOf(entry.win)?.select(tabID);
}

/**
 * Closes a Beaver tab the way the user would; for a kind whose content went
 * away. Never remembered.
 */
export function closeBeaverTab(tabID: string): void {
    const entry = entries.get(tabID);
    if (!entry) return;
    try {
        tabsOf(entry.win)?.close(tabID);
    } catch (error) {
        logger(`beaverTabs: could not close tab ${tabID}: ${String(error)}`, 1);
    }
}

/** The window an open Beaver tab is in. */
export function beaverTabWindow(tabID: string): Window | null {
    return entries.get(tabID)?.win ?? null;
}

/** The open Beaver tabs, optionally of one kind. */
export function listBeaverTabs(kind?: string): Array<{ tabID: string; kind: string; ref: unknown; title: string; win: Window; pane: HTMLElement }> {
    return [...entries.values()]
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map(({ tabID, kind: entryKind, ref, title, win, pane }) => ({ tabID, kind: entryKind, ref, title, win, pane }));
}

/** Calls the kind's release and forgets the tab; its container is Zotero's. */
function releaseEntry(entry: BeaverTabEntry): void {
    if (!entries.delete(entry.tabID)) return;
    try {
        entry.onRelease();
    } catch (error) {
        logger(`beaverTabs: releasing a ${entry.kind} tab failed: ${String(error)}`, 1);
    }
    entry.pane.remove();
}

/**
 * Closes `win`'s Beaver tabs and strips them from the in-memory session,
 * remembering them first for {@link restoreBeaverTabs}. For a window losing
 * its renderer: quit, re-bootstrap, unload, plugin shutdown.
 */
export function closeBeaverTabsForWindow(win: Window): number {
    const owned = [...entries.values()].filter((entry) => entry.win === win);
    closeOwnedTabs(win, owned);
    dropBeaverTabsFromSession();
    return owned.length;
}

/**
 * Remembers `win`'s Beaver tabs, with any its restore has not reopened yet,
 * and closes `owned`; lifecycle closes only.
 */
function closeOwnedTabs(win: Window, owned: BeaverTabEntry[]): void {
    const pending = restoring.get(win);
    restoring.delete(win);
    if (!owned.length && !pending?.tabs.length) return;
    try {
        if (remembersClose(win)) {
            const open = snapshotBeaverTabs(tabsOf(win)?.getState()).filter((tab) => owned.some((entry) => sameTab(entry, tab)));
            rememberBeaverTabs(win, withPendingRestore(open, pending));
        }
    } catch (error) {
        logger(`beaverTabs: could not remember the open tabs: ${String(error)}`, 1);
    }
    if (!owned.length) return;
    closingOwnTabs = true;
    try {
        tabsOf(win)?.close(owned.map((entry) => entry.tabID));
    } catch (error) {
        logger(`beaverTabs: closing tabs failed: ${String(error)}`, 1);
    } finally {
        closingOwnTabs = false;
    }
    // A tab Zotero did not close still owns what its kind mounted.
    for (const entry of owned) releaseEntry(entry);
}

/**
 * Removes Beaver tabs from the session Zotero holds in memory: what it loaded
 * at startup and, after the last main window closed, that window's state —
 * both of which a later save writes back as they are.
 */
export function dropBeaverTabsFromSession(): boolean {
    let changed = false;
    for (const window of sessionState()?.windows ?? []) {
        if (!Array.isArray(window?.tabs)) continue;
        const kept = window.tabs.filter((tab) => !isBeaverTabType(tab?.type));
        if (kept.length !== window.tabs.length) {
            window.tabs = kept;
            changed = true;
        }
    }
    return changed;
}

function sessionState(): SessionState | undefined {
    return (Zotero as unknown as { Session?: { state?: SessionState } }).Session?.state;
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
export async function recoverTabsAfterBeaverTabs(win: Window): Promise<number> {
    if (!lateHookedWindows.has(win)) {
        startup.recoveries.push({ result: 'hooked_before_restore', restored: 0 });
        return 0;
    }
    lateHookedWindows.delete(win);
    const tabs = tabsOf(win);
    const saved = sessionAtInit ?? [];
    const first = saved.findIndex((tab) => isBeaverTabType(tab?.type));
    if (!tabs || first < 0) {
        startup.recoveries.push({ result: 'no_saved_beaver_tab', restored: 0 });
        return 0;
    }

    const present = new Set(
        tabs.getState().map((tab) => `${baseTabType(tab.type)}:${tab.data?.itemID ?? ''}`)
    );
    const missing = saved
        .slice(first + 1)
        .filter((tab) => tab?.type && !isBeaverTabType(tab.type) && tab.type !== 'library'
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
            logger(`beaverTabs: could not restore a ${tab.type} tab: ${String(error)}`, 1);
        }
    }
    dropBeaverTabsFromSession();
    startup.recoveries.push({ result: 'checked', restored });
    if (restored) logger(`beaverTabs: restored ${restored} tab(s) lost to a saved Beaver tab`, 2);
    return restored;
}

// ---------------------------------------------------------------------------
// Reopening after a lifecycle close
// ---------------------------------------------------------------------------

/** This run of Zotero; kept on the `Zotero` global, so a plugin reload keeps it. */
function appSessionID(): string {
    return (Zotero.__beaverAppSessionID ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

/** The window's `outerWindowID`, or null once its docshell is gone. */
function windowKey(win: Window): string | null {
    try {
        const id = (win as Window & { docShell?: { outerWindowID?: number } | null }).docShell?.outerWindowID;
        return typeof id === 'number' ? String(id) : null;
    } catch {
        return null;
    }
}

/** A well-formed record entry; whether its kind and ref are still valid is checked when it reopens. */
function isRememberedTab(value: Partial<RememberedBeaverTab> | null | undefined): value is RememberedBeaverTab {
    return !!value && typeof value.kind === 'string' && !!value.kind && value.ref !== undefined && value.ref !== null
        && Number.isInteger(value.index) && value.index! > 0;
}

function readRestoreRecord(): RestoreRecord | null {
    try {
        const value = JSON.parse(getPref('beaverTabsToRestore') || 'null');
        if (!value || typeof value.session !== 'string' || !Array.isArray(value.windows)) return null;
        if (!(Date.now() - value.savedAt <= RESTORE_MAX_AGE_MS)) return null;
        const windows: RememberedWindow[] = value.windows
            .filter((w: any) => w && Array.isArray(w.tabs))
            .map((w: any) => ({
                window: typeof w.window === 'string' ? w.window : null,
                primary: w.primary === true,
                tabs: w.tabs.filter(isRememberedTab).map((tab: RememberedBeaverTab) => ({
                    kind: tab.kind,
                    ref: tab.ref,
                    index: tab.index,
                    selected: tab.selected === true,
                })),
            }))
            .filter((w: RememberedWindow) => w.tabs.length);
        return windows.length ? { session: value.session, savedAt: value.savedAt, windows } : null;
    } catch {
        return null;
    }
}

function writeRestoreRecord(record: RestoreRecord | null): void {
    try {
        setPref('beaverTabsToRestore', record?.windows.length ? JSON.stringify(record) : '');
    } catch (error) {
        logger(`beaverTabs: could not save the tabs to reopen: ${String(error)}`, 1);
    }
}

/** The Beaver tabs in a list of Zotero tab states, with their positions. */
function snapshotBeaverTabs(tabs: SessionTab[] | undefined): RememberedBeaverTab[] {
    const remembered: RememberedBeaverTab[] = [];
    (tabs ?? []).forEach((tab, index) => {
        if (!isBeaverTabType(tab?.type)) return;
        const target = tabDataOf(tab.data);
        if (target && index > 0) remembered.push({ ...target, index, selected: tab.selected === true });
    });
    return remembered;
}

/** Whether `win` is closing: it has left Zotero's window list, or is closed. */
function isClosing(win: Window): boolean {
    return win.closed || !Zotero.getMainWindows().some((open) => open === win);
}

/**
 * Whether a lifecycle close of `win`'s tabs is remembered. Not for a window
 * closing while another main window stays open: Zotero forgets that window's
 * tabs too.
 */
function remembersClose(win: Window): boolean {
    return !isClosing(win) || !Zotero.getMainWindows().some((other) => other !== win && !other.closed);
}

function dropFromPendingRestore(win: Window, target: BeaverTabData): void {
    const pending = restoring.get(win);
    if (!pending) return;
    pending.tabs = pending.tabs.filter((tab) => !sameTab(tab, target));
    if (pending.selected && sameTab(pending.selected, target)) pending.selected = null;
}

/** Windows with Beaver tabs open or still being reopened. */
function windowsWithBeaverTabs(): Set<Window> {
    return new Set<Window>([...[...entries.values()].map((entry) => entry.win), ...restoring.keys()]);
}

/**
 * The open tabs plus the ones an interrupted restore had yet to reopen, at
 * the positions they would have taken, in order.
 */
function withPendingRestore(open: RememberedBeaverTab[], pending: PendingRestore | undefined): RememberedBeaverTab[] {
    if (!pending) return open;
    const rest = pending.tabs
        .filter((tab) => !open.some((other) => sameTab(other, tab)))
        .map((tab) => ({ ...tab, index: Math.max(1, tab.index - pending.skipped), selected: false }));
    const tabs = [...open, ...rest].sort((a, b) => a.index - b.index);
    // Unless the user selected a Beaver tab meanwhile, the tab that was
    // selected stays the one to select.
    const target = pending.selected;
    if (target && !open.some((tab) => tab.selected)) {
        return tabs.map((tab) => ({ ...tab, selected: sameTab(tab, target) }));
    }
    return tabs;
}

/**
 * Saves `win`'s Beaver tabs for {@link restoreBeaverTabs}, replacing what that
 * window saved before. A record from an earlier run of Zotero is dropped.
 */
function rememberBeaverTabs(win: Window, tabs: RememberedBeaverTab[]): void {
    if (!tabs.length) return;
    const session = appSessionID();
    const previous = readRestoreRecord();
    const key = windowKey(win);
    const open = Zotero.getMainWindows().filter((other) => !other.closed);
    // Zotero's next start restores the first main window's tabs; with none
    // left open, the closing window's, which Zotero keeps.
    const primary = open.length ? open[0] === win : true;
    const windows = (previous?.session === session ? previous.windows : [])
        .filter((w) => key === null || w.window !== key)
        .map((w) => (primary ? { ...w, primary: false } : w));
    windows.push({ window: key, primary, tabs });
    writeRestoreRecord({ session, savedAt: Date.now(), windows });
}

/**
 * Zotero closes every tab of a main window as it unloads. When that runs
 * before Beaver's own unload, the tabs are gone by the time
 * {@link closeBeaverTabsForWindow} looks. For the last main window, Zotero has
 * just saved its tabs, ours included, as the session's pane state, so they are
 * remembered from there.
 */
function rememberTornDownWindow(win: Window): void {
    if (rememberedTeardowns.has(win) || !isClosing(win) || !remembersClose(win)) return;
    rememberedTeardowns.add(win);
    // Recorded together, or the later unload would replace these with the
    // rest of an interrupted restore alone.
    const pending = restoring.get(win);
    restoring.delete(win);
    try {
        const pane = sessionState()?.windows?.find((w) => w?.type === 'pane');
        const open = [...entries.values()].filter((entry) => entry.win === win);
        const tabs = snapshotBeaverTabs(pane?.tabs).filter((tab) => open.some((entry) => sameTab(entry, tab)));
        rememberBeaverTabs(win, withPendingRestore(tabs, pending));
    } catch (error) {
        logger(`beaverTabs: could not remember the open tabs: ${String(error)}`, 1);
    }
}

/**
 * Takes the tabs `win` should reopen off the record, so no later load can
 * reopen them again: after a restart, the first main window's; otherwise the
 * window's own, or those of the last main window that closed.
 */
function takeRememberedTabs(win: Window): RememberedBeaverTab[] {
    const record = readRestoreRecord();
    if (!record) {
        if (getPref('beaverTabsToRestore')) writeRestoreRecord(null);
        return [];
    }
    if (record.session !== appSessionID()) {
        // Only into the window whose tabs Zotero restored, the first one, even
        // when another window's renderer is ready sooner.
        const first = Zotero.getMainWindows().find((other) => !other.closed);
        if (first && first !== win) return [];
        writeRestoreRecord(null);
        return record.windows.find((w) => w.primary)?.tabs ?? [];
    }
    const key = windowKey(win);
    const open = new Set(Zotero.getMainWindows().filter((other) => !other.closed).map(windowKey));
    const own = key === null ? undefined : record.windows.find((w) => w.window === key);
    const taken = own ?? record.windows.find((w) => w.primary && (w.window === null || !open.has(w.window)));
    // Lists of windows that closed for good are dropped with it.
    writeRestoreRecord({
        ...record,
        windows: record.windows.filter((w) => w !== taken && w.window !== null && open.has(w.window)),
    });
    return taken?.tabs ?? [];
}

/** Whether `win` or its renderer is closing; its lifecycle close is on the way. */
function windowGoingAway(win: Window): boolean {
    return win.closed || win.__beaverRuntime?.status === 'closing';
}

/**
 * Waits until `win`'s renderer is up, which every kind renders through; false
 * when it closes or never comes up.
 */
async function waitForBeaverTabHost(win: Window): Promise<boolean> {
    const deadline = Date.now() + RESTORE_HOST_TIMEOUT_MS;
    for (;;) {
        const status = win.__beaverRuntime?.status;
        if (win.closed || status === 'closing') return false;
        if (tabsOf(win) && (win as BeaverTabWindow).BeaverReact && status === 'ready') return true;
        if (Date.now() >= deadline) return false;
        await Zotero.Promise.delay(50);
    }
}

/**
 * Reopens the Beaver tabs a lifecycle close left for `win`, once the window can
 * host them. Each tab opens through its kind's product open, in the background
 * at its old position; the one that was selected is selected again unless the
 * user has moved on. A tab whose kind is not registered, or whose content is
 * gone or unreadable, is skipped without a message. Resolves to the number
 * reopened.
 */
export async function restoreBeaverTabs(win: Window): Promise<number> {
    const run = generation;
    const report = (result: string, restored = 0, skipped = 0) => {
        startup.restores.push({ result, restored, skipped });
        return restored;
    };
    if (!active) return report('not_initialized');
    // A window that never can keeps the record for the next load.
    if (!(await waitForBeaverTabHost(win))) return report('no_host');
    if (generation !== run) return report('not_initialized');
    const remembered = takeRememberedTabs(win);
    const tabs = tabsOf(win);
    if (!remembered.length || !tabs) return report('nothing_to_restore');

    const selectedBefore = tabs.selectedID;
    let restored = 0;
    let skipped = 0;
    // In order of position, so each one's index counts the ones before it.
    const chosen = remembered.find((tab) => tab.selected);
    const pending: PendingRestore = {
        tabs: [...remembered].sort((a, b) => a.index - b.index),
        skipped: 0,
        selected: chosen ? { kind: chosen.kind, ref: chosen.ref } : null,
    };
    restoring.set(win, pending);
    while (pending.tabs.length) {
        // A lifecycle close took over the rest (`closeOwnedTabs`), or will.
        if (windowGoingAway(win) || generation !== run || restoring.get(win) !== pending) break;
        const tab = pending.tabs[0];
        const kind = kinds.get(tab.kind);
        const ref = kind?.parseRef(tab.ref) ?? null;
        // Tabs before this one that did not reopen would push it right.
        const index = Math.max(1, Math.min(tab.index - skipped, tabs.getState().length));
        let outcome: BeaverTabOpenOutcome;
        if (!kind || ref === null) {
            outcome = { error: `no Beaver tab kind "${tab.kind}" for this content` };
        } else {
            try {
                outcome = await kind.open(ref, { window: win, background: true, index });
            } catch (error) {
                outcome = { error: String(error) };
            }
        }
        // Interrupted: the tab stays with the rest for the next load. A
        // closing window's open fails for that reason, not the content's.
        if (restoring.get(win) !== pending || windowGoingAway(win) || generation !== run) break;
        // By identity: the user may have closed it, and so dropped it, meanwhile.
        pending.tabs = pending.tabs.filter((other) => other !== tab);
        if ('error' in outcome) {
            skipped += 1;
            pending.skipped = skipped;
            logger(`beaverTabs: not reopening a ${tab.kind} tab: ${outcome.error}`, 2);
            continue;
        }
        restored += 1;
    }
    // A lifecycle close took the rest, or will: a closing window, or one whose
    // renderer is going away, still records them (`closeBeaverTabsForWindow`).
    if (restoring.get(win) !== pending || windowGoingAway(win)) return report('interrupted', restored, skipped);
    restoring.delete(win);
    // Looked up now: the user may have closed it while later tabs opened.
    const select = pending.selected ? findBeaverTab(win, pending.selected.kind, pending.selected.ref) : null;
    if (select && !win.closed && generation === run && tabs.selectedID === selectedBefore) tabs.select(select);
    if (restored) logger(`beaverTabs: reopened ${restored} Beaver tab(s)`, 3);
    return report('restored', restored, skipped);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Installs the tab hooks in every main window, now and as each opens, and the
 * quit observer, and publishes `Zotero.__beaverTabs`. Kinds register after
 * this. Safe to call twice.
 */
export function initBeaverTabs(): void {
    teardown();
    active = true;
    generation += 1;
    lateHookedWindows = new WeakSet();
    const paneTabs = sessionState()?.windows?.find((w) => w?.type === 'pane')?.tabs;
    sessionAtInit = Array.isArray(paneTabs) && paneTabs.some((tab) => isBeaverTabType(tab?.type))
        ? paneTabs.map((tab) => ({ ...tab }))
        : null;
    startup.savedTabs = Array.isArray(paneTabs) ? paneTabs.map((tab) => String(tab?.type)) : null;
    startup.recoveries = [];
    startup.restores = [];
    rememberedTeardowns = new WeakSet();

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
            for (const win of windowsWithBeaverTabs()) closeBeaverTabsForWindow(win);
            dropBeaverTabsFromSession();
        },
    };
    Services.obs.addObserver(quitObserver as any, QUIT_TOPIC);

    // The window renderer closes its window's tabs through this; it lives in
    // the other bundle and must not import this module (a second copy would
    // track no tabs).
    Zotero.__beaverTabs = { closeForWindow: (win: Window) => closeBeaverTabsForWindow(win) };
}

/**
 * Closes every Beaver tab and removes the hooks, observers and kinds. With
 * `saveSession` (plugin shutdown), rewrites the session without the tabs:
 * nothing could restore them once Beaver is gone; Beaver reopens them itself
 * when it starts again.
 */
export function cleanupBeaverTabs(options: { saveSession?: boolean } = {}): void {
    teardown();
    dropBeaverTabsFromSession();
    if (options.saveSession) {
        const session = (Zotero as unknown as { Session?: { save?: () => Promise<void> } }).Session;
        void session?.save?.()?.catch?.((error: unknown) => logger(`beaverTabs: session save failed: ${String(error)}`, 1));
    }
}

/**
 * Closes the tabs (remembering them) and removes hooks, observers and kinds.
 * Leaves the in-memory session alone: at startup it is what
 * {@link recoverTabsAfterBeaverTabs} compares against.
 */
function teardown(): void {
    if (windowListener) {
        try { Services.wm.removeListener(windowListener as any); } catch { /* already gone */ }
        windowListener = null;
    }
    if (quitObserver) {
        try { Services.obs.removeObserver(quitObserver as any, QUIT_TOPIC); } catch { /* already gone */ }
        quitObserver = null;
    }
    for (const win of windowsWithBeaverTabs()) {
        closeOwnedTabs(win, [...entries.values()].filter((entry) => entry.win === win));
    }
    for (const win of Zotero.getMainWindows()) uninstallTabHooks(win);
    if (Zotero.__beaverTabs) Zotero.__beaverTabs = undefined;
    kinds.clear();
    active = false;
    generation += 1;
}

/**
 * What startup saw: windows hooked late, the saved tabs, each recovery and
 * restore, and the tabs still waiting to be reopened.
 */
export function beaverTabStartup(): typeof startup & { pendingRestore: RestoreRecord | null } {
    return {
        ...startup,
        recoveries: startup.recoveries.slice(),
        restores: startup.restores.slice(),
        pendingRestore: readRestoreRecord(),
    };
}
