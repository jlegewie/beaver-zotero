/**
 * Double-clicking a stored table opens Beaver's table surface.
 *
 * `ZoteroPane.viewItems` and `ZoteroPane.viewAttachment` are plain assignable
 * properties on a per-window object, so they are wrapped rather than hooked —
 * the same unsanctioned-but-established pattern as
 * `Zotero.Reader.onChangeSidebarWidth` in `react/ui/UIManager.ts`, and with the
 * same obligation: what was there before is captured once, and restored only
 * while the slot still holds the wrapper we put in it.
 *
 * ## The guard is the point
 *
 * Wrapping the item-tree's activation handler means every double-click in
 * Zotero now runs Beaver code first. So the design goal is not "open tables",
 * it is **"never break a double-click"**:
 *
 * - The whole handler body is one `try`. Any throw falls through to the
 *   original handler, which is called at most once on every path and never
 *   alongside a Beaver surface.
 * - Beaver takes over only when *all* of these hold: exactly one item, it is a
 *   table per {@link isTableItem}, a table surface exists, and the preference is
 *   on. A PDF, a note, a multi-selection — anything else — reaches Zotero
 *   untouched.
 *
 * ## Why the decision is synchronous
 *
 * Zotero's default action for a double-click is what `viewItems` does. Once
 * this wrapper `await`s, that action has already been skipped for this event
 * and cannot be handed back — returning the original's result later is not the
 * same thing. So the decision is made with no `await` at all.
 *
 * {@link isTableItem} needs `itemData` and `tags` loaded, which Zotero loads
 * lazily, so the loading is done *ahead* of the click:
 *
 * - at startup, every item carrying the `beaver-table` tag is found and its
 *   fields loaded ({@link warmKnownTables});
 * - a `Zotero.Notifier` observer re-warms items as they are added or changed,
 *   and forgets the ones that go away;
 * - an item seen for the first time is warmed in the background and this click
 *   falls through.
 *
 * "Not yet known" therefore means *not ours*. Being wrong in that direction
 * costs one ordinary double-click; being wrong the other way costs a dead one.
 *
 * ## What the wrapper does and does not reach
 *
 * `viewItems` is the items-tree activation handler. `viewAttachment` is reached
 * from it and from the deliberate "open this attachment" surfaces — the locate
 * menu's View Attachment, the item pane's attachment row, box and preview.
 * Intercepting those is the intent.
 *
 * **`zotero://open` is not one of them**, which matters because a citation
 * marker inside a rendered table emits exactly that URI. Zotero routes it
 * through `ZoteroProtocolHandler`'s `OpenExtension.doAction`, which calls
 * `Zotero.FileHandlers.open()` directly; `ZoteroPane.loadURI` — where
 * `tableLinks.ts` sends the scheme — dispatches to that same `doAction` for any
 * `noContent` extension rather than to the pane's own viewers. Neither path
 * touches `viewAttachment`, so a citation always lands in the reader whatever
 * `tables.openIn` says, and no carve-out is needed here to keep it that way.
 *
 * This module is compiled into the **esbuild** bundle, so it may not import
 * `react/*` or anything that reaches it. It also keeps module-level state (the
 * per-window installs, the warm cache, the last decision), so it must exist in
 * that bundle *only* — the webpack side reaches it through
 * `Zotero.__beaverTables`; see `src/services/artifacts/tablesApi.ts`.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../utils/prefs';
import {
    isTableItem,
    loadTableItemFields,
    TABLE_TAG,
    type TableRef,
} from '../services/artifacts/tableItemIdentity';
import { canOpenTable, openTable, type TableTarget } from './openTable';

/** Preference that turns the interception off entirely. */
const INTERCEPT_PREF = 'tables.interceptDoubleClick';

/**
 * Property stashed on a wrapper holding the handler it replaced, so an
 * inspector (and a future generation of this code) can see the chain. The
 * restore below does not rely on it: identity against the installed wrapper is
 * the stricter test, and the one the requirement asks for.
 */
const ORIGINAL_PROP = '__beaverTableOriginalHandler';

type Handler = (...args: any[]) => any;
type HandlerName = 'viewItems' | 'viewAttachment';

// ---------------------------------------------------------------------------
// What the guard knows before the click
// ---------------------------------------------------------------------------

/** Item ids confirmed to be stored tables, with their fields loaded. */
const knownTables = new Set<number>();

/** Item ids confirmed not to be, so they are not re-examined on every click. */
const knownOther = new Set<number>();

/** Warms in flight, so one unknown item is not looked up on every click. */
const warming = new Set<number>();

let notifierID: string | null = null;

/**
 * Loads the fields {@link isTableItem} reads and records the verdict.
 *
 * Exported for the dev endpoint, which needs a deterministic warm state rather
 * than whatever the startup scan happened to reach.
 */
export async function warmTableItems(items: Zotero.Item[]): Promise<number> {
    if (items.length === 0) return 0;
    await loadTableItemFields(items);
    let tables = 0;
    for (const item of items) {
        if (typeof item?.id !== 'number') continue;
        if (isTableItem(item)) {
            knownTables.add(item.id);
            knownOther.delete(item.id);
            tables++;
        } else {
            knownOther.add(item.id);
            knownTables.delete(item.id);
        }
    }
    return tables;
}

async function warmIDs(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const loaded = (await Zotero.Items.getAsync(ids)) as Zotero.Item[] | Zotero.Item;
    const items = Array.isArray(loaded) ? loaded : [loaded];
    return warmTableItems(items.filter(Boolean));
}

/** Warms one item in the background; this click falls through regardless. */
function scheduleWarm(itemID: number): void {
    if (warming.has(itemID)) return;
    warming.add(itemID);
    void warmIDs([itemID])
        .catch((error) => logger(`tableDoubleClick: warm failed: ${error}`, 3))
        .finally(() => warming.delete(itemID));
}

/**
 * Finds every stored table in the local libraries and loads its fields.
 *
 * Local enumeration and metadata lookup only: nothing here leaves the machine,
 * is indexed, or reaches a model, so the searchable-library filter does not
 * apply — a table in an excluded library still opens when the user asks for it.
 */
export async function warmKnownTables(): Promise<number> {
    let tables = 0;
    let libraries: { libraryID: number }[] = [];
    try {
        libraries = Zotero.Libraries.getAll();
    } catch (error) {
        logger(`tableDoubleClick: could not list libraries: ${error}`, 2);
        return 0;
    }
    for (const library of libraries) {
        try {
            const search = new Zotero.Search() as unknown as ZoteroSearchWritable;
            search.libraryID = library.libraryID;
            search.addCondition('tag', 'is', TABLE_TAG);
            tables += await warmIDs((await search.search()) as number[]);
        } catch (error) {
            logger(
                `tableDoubleClick: table scan failed for library ${library.libraryID}: ${error}`,
                2
            );
        }
    }
    return tables;
}

function forget(ids: number[]): void {
    for (const id of ids) {
        knownTables.delete(id);
        knownOther.delete(id);
    }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type DoubleClickPath = 'beaver' | 'original';

/**
 * Why a click went where it did. Reported verbatim by the dev endpoint, so a
 * fall-through can be told apart from a refusal.
 */
export type DoubleClickReason =
    | 'disabled'
    | 'not_single_item'
    | 'no_item'
    | 'not_warm'
    | 'not_a_table'
    | 'no_surface'
    | 'reentrant'
    | 'threw'
    | 'table';

export interface TableDoubleClickRecord {
    at: string;
    handler: HandlerName;
    path: DoubleClickPath;
    reason: DoubleClickReason;
    itemID: number | null;
    key: string | null;
    libraryID: number | null;
    /** Filled once the (asynchronous) open settles. */
    opened?: TableTarget | null;
    error?: string | null;
}

let lastRecord: TableDoubleClickRecord | null = null;
let pendingOpen: Promise<void> | null = null;

/** The most recent decision this guard made — for the dev endpoint. */
export function lastTableDoubleClick(): TableDoubleClickRecord | null {
    return lastRecord;
}

/** Resolves once the open started by the most recent decision has settled. */
export function whenTableDoubleClickSettles(): Promise<void> {
    return pendingOpen ?? Promise.resolve();
}

function record(
    handler: HandlerName,
    path: DoubleClickPath,
    reason: DoubleClickReason,
    item?: Zotero.Item | null
): void {
    lastRecord = {
        at: new Date().toISOString(),
        handler,
        path,
        reason,
        itemID: typeof item?.id === 'number' ? item.id : null,
        key: item?.key ?? null,
        libraryID: typeof item?.libraryID === 'number' ? item.libraryID : null,
    };
}

function intercepting(): boolean {
    try {
        return getPref(INTERCEPT_PREF) !== false;
    } catch {
        // A preference that cannot be read is not a reason to take over a
        // double-click.
        return false;
    }
}

/**
 * Whether Beaver should handle this click, and for which table.
 *
 * Synchronous by construction — see the module header. May throw; the caller
 * treats a throw as "not ours".
 */
function decide(
    handler: HandlerName,
    items: Zotero.Item[],
    win: Window
): TableRef | null {
    if (!intercepting()) {
        record(handler, 'original', 'disabled');
        return null;
    }
    if (items.length !== 1) {
        record(handler, 'original', 'not_single_item');
        return null;
    }
    const item = items[0];
    if (!item || typeof item.id !== 'number') {
        record(handler, 'original', 'no_item');
        return null;
    }
    if (!knownTables.has(item.id)) {
        // Unknown, or known to be something else. Either way Zotero handles it;
        // an unknown one is warmed so the next click can be answered.
        if (!knownOther.has(item.id)) scheduleWarm(item.id);
        record(handler, 'original', knownOther.has(item.id) ? 'not_a_table' : 'not_warm', item);
        return null;
    }
    // The cache says its fields are loaded, so this is now authoritative rather
    // than a guess that a lazy field made unanswerable.
    if (!isTableItem(item)) {
        knownTables.delete(item.id);
        knownOther.add(item.id);
        record(handler, 'original', 'not_a_table', item);
        return null;
    }
    if (!canOpenTable(win)) {
        record(handler, 'original', 'no_surface', item);
        return null;
    }
    record(handler, 'beaver', 'table', item);
    return { libraryID: item.libraryID, key: item.key };
}

/**
 * Starts the open and returns. Cannot throw: the caller has already committed
 * to not running Zotero's handler, so a throw here would leave the click doing
 * nothing at all.
 */
function startOpen(ref: TableRef, win: Window): void {
    const entry = lastRecord;
    try {
        pendingOpen = openTable(ref, { win })
            .then((outcome) => {
                if (!entry) return;
                if ('opened' in outcome) {
                    entry.opened = outcome.opened;
                } else {
                    entry.opened = null;
                    entry.error = outcome.error;
                    logger(`tableDoubleClick: ${outcome.error}`, 2);
                }
            })
            .catch((error) => {
                if (entry) {
                    entry.opened = null;
                    entry.error = String(error);
                }
                logger(`tableDoubleClick: open failed: ${error}`, 2);
            });
    } catch (error) {
        if (entry) {
            entry.opened = null;
            entry.error = String(error);
        }
        logger(`tableDoubleClick: open could not start: ${error}`, 2);
    }
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

interface Wrapped {
    original: Handler;
    wrapper: Handler;
}

/** Per-window installs, so each window's originals are restored to that window. */
const installs = new Map<Window, Partial<Record<HandlerName, Wrapped>>>();

/**
 * Depth of a fall-through currently running Zotero's own `viewItems`.
 *
 * `viewItems` delegates to `this.viewAttachment` for an attachment, so without
 * this the nested call would be examined a second time and could open Beaver's
 * surface *after* the original had already been entered. The counter spans the
 * original's whole promise, which is what its internal `await` needs. A
 * concurrent unrelated double-click can only be made to fall through by it,
 * never to be intercepted — the safe direction.
 */
let insideOriginal = 0;

function callOriginal(entry: Wrapped, self: any, args: any[]): any {
    return entry.original.apply(self, args);
}

/** `viewItems(items, event, options)` — item objects. */
function itemsFromViewItems(args: any[]): Zotero.Item[] {
    const first = args[0];
    if (Array.isArray(first)) return first as Zotero.Item[];
    return first ? [first as Zotero.Item] : [];
}

/** `viewAttachment(itemIDs, ...)` — one id or an array of them. */
function itemsFromViewAttachment(args: any[]): Zotero.Item[] {
    const first = args[0];
    const ids = Array.isArray(first) ? first : [first];
    const items: Zotero.Item[] = [];
    for (const id of ids) {
        if (typeof id !== 'number') return [];
        const item = Zotero.Items.get(id) as Zotero.Item | false;
        if (!item) return [];
        items.push(item);
    }
    return items;
}

function makeWrapper(
    name: HandlerName,
    original: Handler,
    win: Window,
    collect: (args: any[]) => Zotero.Item[]
): Wrapped {
    const entry: Wrapped = { original, wrapper: null as unknown as Handler };
    // Rest parameters rather than `arguments`, applied straight through, so the
    // original is called with exactly the arity it was handed — Zotero's
    // `viewItems` relies on a defaulted third parameter.
    const wrapper = function (this: any, ...args: any[]) {
        // One try around the whole body: any throw at all means Zotero's
        // handler runs, exactly as if this wrapper were not here.
        try {
            if (insideOriginal > 0) {
                record(name, 'original', 'reentrant');
                return callOriginal(entry, this, args);
            }
            const ref = decide(name, collect(args), win);
            if (ref) {
                // `startOpen` cannot throw, so this path can never also reach
                // the original below.
                startOpen(ref, win);
                return undefined;
            }
        } catch (error) {
            logger(`tableDoubleClick: guard threw, deferring to Zotero: ${error}`, 2);
            record(name, 'original', 'threw');
        }

        if (name !== 'viewItems') return callOriginal(entry, this, args);

        // Hold the re-entry guard for the whole of Zotero's `viewItems`, which
        // awaits `this.viewAttachment` inside itself.
        insideOriginal++;
        let result: any;
        try {
            result = callOriginal(entry, this, args);
        } catch (error) {
            insideOriginal--;
            throw error;
        }
        if (result && typeof result.then === 'function') {
            return result.then(
                (value: unknown) => {
                    insideOriginal--;
                    return value;
                },
                (error: unknown) => {
                    insideOriginal--;
                    throw error;
                }
            );
        }
        insideOriginal--;
        return result;
    };
    (wrapper as any)[ORIGINAL_PROP] = original;
    entry.wrapper = wrapper;
    return entry;
}

function paneFor(win: Window): any {
    return (win as any)?.ZoteroPane ?? null;
}

/**
 * Wraps one window's `viewItems` / `viewAttachment`.
 *
 * Re-installing is safe: the previous install for this window is restored
 * first, so a plugin reload replaces the wrapper instead of chaining onto it.
 * A slot holding something that is not a function is left alone entirely.
 */
export function installTableDoubleClick(win: Window): void {
    try {
        uninstallTableDoubleClick(win);
        const pane = paneFor(win);
        if (!pane) return;

        const collectors: Record<HandlerName, (args: any[]) => Zotero.Item[]> = {
            viewItems: itemsFromViewItems,
            viewAttachment: itemsFromViewAttachment,
        };

        const entries: Partial<Record<HandlerName, Wrapped>> = {};
        for (const name of ['viewItems', 'viewAttachment'] as HandlerName[]) {
            const original = pane[name];
            // Capture once, and only a real function: there is nothing to defer
            // to otherwise, and a wrapper over a non-function is a broken pane.
            if (typeof original !== 'function') continue;
            const entry = makeWrapper(name, original as Handler, win, collectors[name]);
            pane[name] = entry.wrapper;
            entries[name] = entry;
        }
        if (Object.keys(entries).length > 0) installs.set(win, entries);
    } catch (error) {
        logger(`tableDoubleClick: install failed: ${error}`, 2);
    }
}

/**
 * Restores this window's handlers.
 *
 * Only slots that still hold *our* wrapper are restored. Something else
 * wrapped after us is left alone: putting the original back would silently drop
 * that other wrapper, which is a worse failure than leaving ours in the chain.
 */
export function uninstallTableDoubleClick(win: Window): void {
    const entries = installs.get(win);
    installs.delete(win);
    if (!entries) return;
    const pane = paneFor(win);
    if (!pane) return;
    for (const name of Object.keys(entries) as HandlerName[]) {
        const entry = entries[name];
        if (!entry) continue;
        try {
            if (pane[name] === entry.wrapper) pane[name] = entry.original;
        } catch (error) {
            logger(`tableDoubleClick: restore of ${name} failed: ${error}`, 2);
        }
    }
}

/**
 * Whether this window's handlers are currently wrapped — for the dev endpoint.
 *
 * Defaults to the main window: a no-argument call answering `false` while the
 * handlers are demonstrably wrapped reads as "not installed" rather than as
 * "you asked about no window", which is the wrong answer to give a diagnostic.
 */
export function isTableDoubleClickInstalled(
    win: Window = Zotero.getMainWindow()
): boolean {
    const entries = installs.get(win);
    const pane = paneFor(win);
    if (!entries || !pane) return false;
    return (Object.keys(entries) as HandlerName[]).some(
        (name) => pane[name] === entries[name]?.wrapper
    );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Starts the pre-warming the synchronous decision depends on: the startup scan
 * and the notifier that keeps it current. Window-independent — the wrapping
 * itself is {@link installTableDoubleClick}, once per window.
 *
 * Safe to call twice; the previous observer is removed first.
 */
export function initTableDoubleClick(): void {
    cleanupTableDoubleClickState();
    try {
        notifierID = Zotero.Notifier.registerObserver(
            {
                notify: (event: string, type: string, ids: (string | number)[]) => {
                    if (type !== 'item') return;
                    const numeric = ids
                        .map((id) => (typeof id === 'number' ? id : Number(id)))
                        .filter((id) => Number.isFinite(id));
                    if (event === 'delete' || event === 'trash') {
                        forget(numeric);
                        return;
                    }
                    if (event === 'add' || event === 'modify') {
                        void warmIDs(numeric).catch((error) =>
                            logger(`tableDoubleClick: re-warm failed: ${error}`, 3)
                        );
                    }
                },
            },
            ['item'],
            'beaver-table-double-click'
        );
    } catch (error) {
        logger(`tableDoubleClick: item observer failed: ${error}`, 2);
        notifierID = null;
    }

    void warmKnownTables().catch((error) =>
        logger(`tableDoubleClick: startup scan failed: ${error}`, 2)
    );
}

function cleanupTableDoubleClickState(): void {
    if (notifierID) {
        try {
            Zotero.Notifier.unregisterObserver(notifierID);
        } catch {
            // Already gone.
        }
        notifierID = null;
    }
    knownTables.clear();
    knownOther.clear();
    warming.clear();
    lastRecord = null;
    pendingOpen = null;
    insideOriginal = 0;
}

/** Restores every window's handlers and stops the pre-warming — for shutdown. */
export function cleanupTableDoubleClick(): void {
    for (const win of [...installs.keys()]) uninstallTableDoubleClick(win);
    installs.clear();
    cleanupTableDoubleClickState();
}
