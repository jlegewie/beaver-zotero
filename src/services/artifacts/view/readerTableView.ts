/**
 * The reader as the host for a rendered table document.
 *
 * A stored table is a snapshot attachment, so double-clicking it, following a
 * `zotero://open` link or opening it from the item pane lands it in Zotero's
 * reader — where, left alone, it is an inert page: the citation markers show a
 * native tooltip at best, and the reader swallows the `zotero:` links. This
 * module makes that page interactive through {@link enhanceTableDocument}, and
 * it is the only surface a stored table has.
 *
 * **One entry point escapes it, by the user's own choice.** Zotero's
 * double-click and `zotero://open` both end at `Zotero.FileHandlers.open`,
 * which consults the `fileHandler.snapshot` preference — Settings → General →
 * "Open snapshots using". Set to anything but Zotero, the file is handed to the
 * browser or another application and no reader is created, so a table opened
 * that way is the plain static document with no card and no link routing. That
 * is honoured rather than intercepted: overriding it would mean patching a
 * Zotero function to defeat a preference the user set deliberately. The item
 * pane's own button calls `Zotero.Reader.open` directly (`src/ui/openTable.ts`)
 * and so always gets the interactive surface.
 *
 * ## Everything here is optional
 *
 * It reaches into reader internals that are not a plugin API. Every step is
 * therefore checked on its own, and every failure is silent: a table that
 * renders as a plain static page is the correct fallback, a broken reader is
 * not.
 *
 * Nothing is *replaced*. All but one of the steps only add — listeners, a card
 * — so a half-finished attempt leaves the reader exactly as it was found. The
 * exception is `setReadOnly`, which changes one reader's state, and it is
 * therefore the only thing with an undo to get wrong: it runs last, after the
 * enhancement has already succeeded, and its undo is registered together with
 * the view that owns it. Adding an early `return` between those two points
 * would strand a reader with its annotation tools off for the session.
 *
 * ## What the seams are
 *
 * Two, both reached through `reader._internalReader`:
 *
 * 1. **The document.** `_primaryView` holds the sandboxed snapshot iframe;
 *    `initializedPromise` is the thing to await and `iframeDocument` is the
 *    document inside it. Chrome-registered listeners do fire in there — the
 *    reader relies on that itself.
 * 2. **`setReadOnly(true)`**, which disables the annotation tools for this
 *    reader only. A table's file is rewritten in place on every mutation
 *    (`tableStore`), so a highlight anchored into it is orphaned by the next
 *    edit. This is the reader's own public method rather than a patch, it is
 *    per-instance, and it leaves selection, copy and Find working.
 *
 * Nothing else about the reader is touched, patched or restored; in particular
 * the reader's `_isExternalLink` is deliberately left alone (see the comment on
 * the click listener in `enhanceTableDocument.ts` for why overriding it is
 * worse than useless here).
 *
 * ## Lifecycle
 *
 * Readers are reached the way the other reader integrations reach them: a
 * `renderToolbar` listener for the ones that appear, `Zotero.Reader._readers`
 * for the ones already open when the plugin starts, and a `tab` notifier for
 * the ones that go away.
 *
 * Reader *windows* (`openReaderInNewWindow`, which is the pref
 * `zotero://open` honours) are handled too, and they are not covered by the tab
 * notifier: closing one splices `Zotero.Reader._readers` through its own
 * `onClose` callback and fires nothing this could hear. So a window-hosted view
 * also carries a plain `unload` listener on its own chrome window — a DOM
 * listener, not a reader internal — whose only job is to drop the entry rather
 * than leave the Map holding a dead realm.
 *
 * `cleanupReaderTableViews()` disposes whatever is left.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    countCitationMarkers,
    enhanceTableDocument,
    type TableViewHost,
    type TableViewSummary,
} from './enhanceTableDocument';
import { openTableLink } from './tableLinks';
import { isTableItem, loadTableItemFields } from '../tableItemIdentity';

/** How long to wait for a view that never finishes initialising. */
const VIEW_INIT_TIMEOUT_MS = 8000;

/** Attempts per reader before it is left alone. */
const MAX_ATTEMPTS = 6;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * What one enhancement attempt managed to attach.
 *
 * Reported verbatim by `/beaver/test/table-open-reader`: a `false` that can be
 * seen beats a silent success, so nothing here is inferred — each field is set
 * by the step that produced it, and `failures` names the seam that did not.
 */
export interface ReaderTableDiagnostics {
    itemKey: string | null;
    libraryID: number | null;
    readerType: string | null;
    tabID: string | null;
    /** Both marks a stored table carries; both are required. */
    isTableItem: boolean;
    beaverTableAttribute: string | null;
    internalReaderFound: boolean;
    primaryViewFound: boolean;
    viewInitialized: boolean;
    documentFound: boolean;
    cardMounted: boolean;
    listenersAttached: boolean;
    /**
     * Whether this reader's annotation tools were turned off for the table.
     * False when the reader was already read-only (nothing to do) or when the
     * build has no `setReadOnly` — neither stops the table working.
     */
    annotationsDisabled: boolean;
    markers: number;
    links: number;
    /** One line per seam that did not come up, in the order they were tried. */
    failures: string[];
    enhanced: boolean;
}

function blankDiagnostics(): ReaderTableDiagnostics {
    return {
        itemKey: null,
        libraryID: null,
        readerType: null,
        tabID: null,
        isTableItem: false,
        beaverTableAttribute: null,
        internalReaderFound: false,
        primaryViewFound: false,
        viewInitialized: false,
        documentFound: false,
        cardMounted: false,
        listenersAttached: false,
        annotationsDisabled: false,
        markers: 0,
        links: 0,
        failures: [],
        enhanced: false,
    };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface EnhancedReaderView {
    reader: any;
    itemKey: string | null;
    libraryID: number | null;
    tabID: string | null;
    markers: number;
    dispose(): void;
}

const views = new Map<any, EnhancedReaderView>();

/** Readers that are definitively not tables, so they are not re-examined. */
const notTables = new WeakSet<object>();

/** Attempts so far, so a reader that never resolves is not retried forever. */
const attempts = new WeakMap<object, number>();

/** In-flight attempts, so overlapping toolbar renders do not double-enhance. */
const inFlight = new WeakSet<object>();

/** The last attempt per Zotero item key, for the dev endpoint. */
const lastDiagnostics = new Map<string, ReaderTableDiagnostics>();

let toolbarHandler: ((event: any) => void) | null = null;
let notifierID: string | null = null;

// ---------------------------------------------------------------------------
// Reader plumbing
// ---------------------------------------------------------------------------

function readerRegistry(): any[] {
    const readers = (Zotero?.Reader as any)?._readers;
    return Array.isArray(readers) ? readers : [];
}

/** The reader's item, with the fields {@link isTableItem} reads loaded. */
async function tableItemFor(reader: any): Promise<Zotero.Item | null> {
    const itemID = reader?.itemID;
    if (!itemID) return null;
    const item = Zotero.Items.get(itemID) as Zotero.Item | false;
    if (!item) return null;
    await loadTableItemFields([item]);
    return isTableItem(item) ? item : null;
}

/**
 * The primary view once it has finished initialising.
 *
 * `initializedPromise` is the reader's own signal that the snapshot iframe has
 * loaded. It is raced against a timeout because a view that never resolves must
 * not hold this attempt open forever.
 */
async function initializedView(reader: any, failures: string[]): Promise<any | null> {
    const internal = reader?._internalReader;
    if (!internal) {
        failures.push('internal_reader_missing');
        return null;
    }
    const view = internal._primaryView;
    if (!view) {
        failures.push('primary_view_missing');
        return null;
    }
    const ready = view.initializedPromise;
    if (!ready?.then) {
        // No promise to await: the view either is already usable or never will
        // be, and the document check below is what decides which.
        return view;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), VIEW_INIT_TIMEOUT_MS);
        });
        const outcome = await Promise.race([ready.then(() => 'ready' as const), timeout]);
        if (outcome === 'timeout') {
            failures.push('view_init_timeout');
            return null;
        }
    } catch (error) {
        failures.push(`view_init_failed: ${error}`);
        return null;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
    return view;
}

/**
 * The reader as a {@link TableViewHost}.
 *
 * The frame is nested twice — the sandboxed snapshot iframe sits inside the
 * reader's own iframe — so the rectangle the card is placed against is the sum
 * of the two, recomputed on every call because both move (the reader sidebar
 * opens, the window resizes).
 */
function readerHost(reader: any, view: any, mount: Element): TableViewHost {
    return {
        win: reader._window,
        cardMount: mount,
        frameRect: () => {
            const outer = reader._iframe.getBoundingClientRect();
            const inner = view._iframe.getBoundingClientRect();
            return {
                left: outer.left + inner.left,
                top: outer.top + inner.top,
                right: outer.left + inner.right,
                bottom: outer.top + inner.bottom,
            };
        },
        openLink: openTableLink,
    };
}

/**
 * Drops a window-hosted view when its window goes.
 *
 * `ReaderWindow.close()` splices `Zotero.Reader._readers` through the `onClose`
 * callback it was constructed with and triggers no notifier, so nothing else
 * here would ever hear about it and the entry would sit in the map holding a
 * dead realm. This is a plain DOM listener on a chrome window this already
 * holds — not another reach into the reader.
 */
function onReaderWindowUnload(reader: any): (() => void) | null {
    const win = reader?._window;
    if (!win?.addEventListener) return null;
    // Disposed directly rather than through `pruneViews()`: `unload` can fire
    // before `ReaderWindow.close()` reaches the `onClose` that splices the
    // registry, so "is it still in `_readers`" is not yet the right question.
    const onUnload = () => disposeView(reader);
    try {
        win.addEventListener('unload', onUnload, { once: true });
    } catch {
        return null;
    }
    return () => {
        try {
            win.removeEventListener('unload', onUnload);
        } catch {
            // The window is already gone, which is what this was for.
        }
    };
}

/**
 * Whether this reader is read-only right now, or null if that cannot be told.
 *
 * `_state.readOnly` is the value `setReadOnly` writes, so it is the one to read
 * before overwriting it. `reader._isReadOnly()` is *not* a substitute: it
 * recomputes item editability on every call (`ReaderInstance._isReadOnly`),
 * which Zotero itself does only once, at open time — so after the item is
 * trashed or restored under an open reader the two disagree, and acting on the
 * recomputation is how an undo ends up *granting* annotation tools on a reader
 * Zotero had locked.
 *
 * It is only the fallback, and only an explicit `true` counts: for an editable,
 * un-trashed, parentless attachment — every stored table — that method returns
 * `undefined` rather than `false`, because its last clause is
 * `item.parentItem && item.parentItem.deleted`. Absent altogether, it answers
 * null rather than assuming `false`: "no state was read" is not the same as
 * "the state is writable", and only the first is safe to build an undo on.
 */
function readerReadOnly(reader: any, internal: any): boolean | null {
    const state = internal?._state;
    if (typeof state?.readOnly === 'boolean') return state.readOnly;
    if (typeof reader?._isReadOnly !== 'function') return null;
    try {
        return reader._isReadOnly() === true;
    } catch {
        return null;
    }
}

/**
 * Turns this reader's annotation tools off, and returns the undo.
 *
 * A table's file is rewritten in place on every mutation, so a highlight
 * anchored into it is orphaned by the next edit. `setReadOnly` is the reader's
 * own public method (it disables the highlight/underline/note buttons and pins
 * the tool to `pointer`, leaving selection, copy and Find alone), so this
 * changes one reader's state rather than patching anything.
 *
 * Returns null when there is nothing to undo — the reader is *already*
 * read-only, its state cannot be read, or the build has no `setReadOnly`. All
 * three are recorded and none is fatal: annotation tools on a table are a
 * nuisance, not a reason to leave the table inert.
 *
 * The undo restores `false` because that is the value just read, and this
 * returns null on every path where it was anything else.
 */
function disableAnnotations(reader: any, failures: string[]): (() => void) | null {
    const internal = reader?._internalReader;
    if (typeof internal?.setReadOnly !== 'function') {
        failures.push('set_read_only_unavailable');
        return null;
    }
    const wasReadOnly = readerReadOnly(reader, internal);
    if (wasReadOnly === null) {
        // Cannot tell what to restore to, so nothing is changed.
        failures.push('read_only_state_unreadable');
        return null;
    }
    if (wasReadOnly) return null;
    try {
        internal.setReadOnly(true);
    } catch (error) {
        failures.push(`set_read_only_failed: ${error}`);
        return null;
    }
    return () => {
        try {
            internal.setReadOnly(false);
        } catch {
            // The reader went with its tab; there is nothing left to restore.
        }
    };
}

// ---------------------------------------------------------------------------
// Enhancing
// ---------------------------------------------------------------------------

/**
 * Enhances one reader if it is showing a table and is not already enhanced.
 *
 * Returns the diagnostics for the attempt, or null when the reader was not a
 * candidate at all (not a snapshot, not one of ours) — the common case, and the
 * one that must cost nothing on every toolbar render.
 */
async function enhanceReader(
    reader: any,
    options: { force?: boolean } = {}
): Promise<ReaderTableDiagnostics | null> {
    if (!reader) return null;
    if (views.has(reader)) return lastDiagnosticsFor(reader);
    if (!options.force && notTables.has(reader)) return null;
    if (inFlight.has(reader)) return null;

    const attempt = (attempts.get(reader) ?? 0) + 1;
    if (!options.force && attempt > MAX_ATTEMPTS) return null;
    attempts.set(reader, attempt);
    inFlight.add(reader);

    const diagnostics = blankDiagnostics();
    try {
        diagnostics.readerType = reader.type ?? null;
        diagnostics.tabID = reader.tabID ?? null;

        // A table is a `text/html` snapshot, so anything else is not a
        // candidate and is never looked at again.
        if (reader.type !== 'snapshot') {
            notTables.add(reader);
            diagnostics.failures.push('not_a_snapshot_reader');
            return options.force ? diagnostics : null;
        }

        const item = await tableItemFor(reader);
        if (!item) {
            notTables.add(reader);
            diagnostics.failures.push('not_a_table_item');
            return options.force ? diagnostics : null;
        }
        diagnostics.isTableItem = true;
        diagnostics.itemKey = item.key;
        diagnostics.libraryID = item.libraryID;
        lastDiagnostics.set(item.key, diagnostics);

        const view = await initializedView(reader, diagnostics.failures);
        diagnostics.internalReaderFound = !!reader._internalReader;
        diagnostics.primaryViewFound = !!reader._internalReader?._primaryView;
        if (!view) return diagnostics;
        diagnostics.viewInitialized = view.initialized !== false;

        // `iframeDocument` is the reader's own public getter for this; the
        // private field is the fallback for a build that predates it.
        const doc: Document | undefined = view.iframeDocument ?? view._iframeDocument;
        if (!doc?.documentElement) {
            diagnostics.failures.push('iframe_document_missing');
            return diagnostics;
        }
        diagnostics.documentFound = true;

        // The second mark. A snapshot that is tagged as a table but whose file
        // was not written by this renderer is left exactly as it is.
        diagnostics.beaverTableAttribute =
            doc.documentElement.getAttribute('data-beaver-table');
        if (diagnostics.beaverTableAttribute === null) {
            diagnostics.failures.push('data_beaver_table_missing');
            notTables.add(reader);
            return diagnostics;
        }

        diagnostics.markers = countCitationMarkers(doc);
        diagnostics.links = doc.querySelectorAll('a[href]').length;

        const mount = reader._iframe?.parentElement;
        if (!mount) {
            diagnostics.failures.push('card_mount_missing');
            return diagnostics;
        }
        if (!reader._window) {
            diagnostics.failures.push('reader_window_missing');
            return diagnostics;
        }

        const undo: Array<() => void> = [];

        // The card and the link routing — the whole of what is attached. If
        // this throws there is nothing to keep, so the attempt ends here.
        try {
            undo.push(enhanceTableDocument(doc, readerHost(reader, view, mount)));
            diagnostics.cardMounted = true;
            diagnostics.listenersAttached = true;
        } catch (error) {
            diagnostics.failures.push(`enhance_failed: ${error}`);
            return diagnostics;
        }

        // Registered the moment `undo` holds anything at all, and before every
        // step below: any statement between a push and this line is a window in
        // which a throw discards that undo, and the steps below read reader
        // properties that throw outright on a dead compartment. The entry
        // closes over the array, so every later push lands in this dispose.
        views.set(reader, {
            reader,
            itemKey: diagnostics.itemKey,
            libraryID: diagnostics.libraryID,
            tabID: diagnostics.tabID,
            markers: diagnostics.markers,
            dispose: () => {
                for (const step of undo.reverse()) {
                    try {
                        step();
                    } catch {
                        // Each undo is independent; one failing must not strand
                        // the rest.
                    }
                }
            },
        });
        // Set with the registration: the table *is* enhanced from here, so a
        // throw in a step below must not make the diagnostics disagree with
        // `views`. Such a throw reports through `failures` instead.
        diagnostics.enhanced = true;

        // The one piece of reader *state* the module changes, so it comes after
        // the registration that owns its undo rather than before.
        const restoreReadOnly = disableAnnotations(reader, diagnostics.failures);
        if (restoreReadOnly) {
            diagnostics.annotationsDisabled = true;
            undo.push(restoreReadOnly);
        }

        // A window-hosted reader closes without a tab event, so it says so
        // itself. Tabs need nothing: the tab notifier already covers them, and
        // their window is the main one, which tears everything down anyway.
        if (!reader.tabID) {
            const release = onReaderWindowUnload(reader);
            if (release) undo.push(release);
            else diagnostics.failures.push('window_unload_listener_failed');
        }

        logger(
            `readerTableView: enhanced table ${diagnostics.itemKey} (${diagnostics.markers} markers)`,
            3
        );
        return diagnostics;
    } catch (error) {
        diagnostics.failures.push(`unexpected: ${error}`);
        logger(`readerTableView: enhancement failed: ${error}`, 3);
        return diagnostics;
    } finally {
        inFlight.delete(reader);
    }
}

function lastDiagnosticsFor(reader: any): ReaderTableDiagnostics | null {
    const view = views.get(reader);
    if (!view?.itemKey) return null;
    return lastDiagnostics.get(view.itemKey) ?? null;
}

/** Drops one view, whatever became of the reader behind it. */
function disposeView(reader: any): void {
    const view = views.get(reader);
    if (!view) return;
    views.delete(reader);
    try {
        view.dispose();
    } catch {
        // The surface went with the reader; nothing left to release.
    }
}

/** Drops the views whose reader has gone away. */
function pruneViews(): void {
    if (views.size === 0) return;
    const live = new Set(readerRegistry());
    for (const reader of [...views.keys()]) {
        if (live.has(reader) && reader?._window?.closed !== true) continue;
        disposeView(reader);
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers the hooks that enhance table snapshots in the reader.
 *
 * Safe to call twice: the previous registration is removed first, which is what
 * a plugin reload needs.
 */
export function initReaderTableViews(): void {
    cleanupReaderTableViews();

    if (typeof Zotero?.Reader?.registerEventListener !== 'function') {
        logger('readerTableView: Reader API not available, skipping', 2);
        return;
    }

    // `renderToolbar` is the one reader event that fires for every view type
    // and carries the instance, so it doubles as "a reader is on screen". It
    // fires repeatedly; the attempt is cheap and bounded per reader.
    toolbarHandler = (event: any) => {
        pruneViews();
        void enhanceReader(event?.reader);
    };
    // `Zotero.Beaver`, not the bare `addon` global: this module is reachable
    // from the webpack bundle, where `addon` does not exist.
    const pluginID = (Zotero as any).Beaver?.data?.config?.addonID as string | undefined;
    Zotero.Reader.registerEventListener('renderToolbar', toolbarHandler, pluginID);

    // Tab close is where a reader disappears; the notifier is how that is heard
    // without polling.
    try {
        notifierID = Zotero.Notifier.registerObserver(
            { notify: () => pruneViews() },
            ['tab'],
            'beaver-table-reader-views'
        );
    } catch (error) {
        logger(`readerTableView: tab observer failed: ${error}`, 2);
        notifierID = null;
    }

    // Readers that were already open — a plugin reload, or a session restored
    // before this ran.
    for (const reader of readerRegistry()) void enhanceReader(reader);
}

/**
 * Disposes the reader views hosted in one window — for that window's unload.
 *
 * `pruneViews()` cannot answer this: during unload the window does not yet
 * report itself closed and its readers are still in `Zotero.Reader._readers`.
 */
export function cleanupReaderTableViewsForWindow(win: Window): void {
    for (const reader of [...views.keys()]) {
        if (reader?._window === win) disposeView(reader);
    }
}

/** Restores every reader this touched, for window teardown and shutdown. */
export function cleanupReaderTableViews(): void {
    for (const reader of [...views.keys()]) disposeView(reader);
    lastDiagnostics.clear();

    if (toolbarHandler) {
        // `Zotero.Reader.unregisterEventListener` filters the registry down to
        // the matching listener instead of removing it, so the removal is done
        // here — the same way the other reader integrations do it.
        try {
            const registry = (Zotero?.Reader as any)?._registeredListeners;
            if (Array.isArray(registry)) {
                (Zotero.Reader as any)._registeredListeners = registry.filter(
                    (l: any) => !(l?.type === 'renderToolbar' && l?.handler === toolbarHandler)
                );
            }
        } catch {
            // Nothing to unregister.
        }
        toolbarHandler = null;
    }

    if (notifierID) {
        try {
            Zotero.Notifier.unregisterObserver(notifierID);
        } catch {
            // Already gone.
        }
        notifierID = null;
    }
}

/** The reader-hosted tables currently enhanced — for the dev endpoint. */
export function listReaderTableViews(): TableViewSummary[] {
    pruneViews();
    return [...views.values()].map((view) => ({
        id: view.tabID ?? String(view.reader?._instanceID ?? ''),
        key: view.itemKey,
        markers: view.markers,
    }));
}

/**
 * Opens a table item in the reader and reports what the enhancer attached.
 *
 * Dev-only: the product path is the reader opening on its own and the
 * `renderToolbar` hook catching it. This drives the same code so that the
 * outcome can be inspected without a UI.
 */
export async function openTableInReader(
    item: Zotero.Item,
    options: { timeoutMs?: number } = {}
): Promise<ReaderTableDiagnostics> {
    const timeoutMs = options.timeoutMs ?? 15000;
    const deadline = Date.now() + timeoutMs;

    try {
        await (Zotero.Reader as any).open(item.id);
    } catch (error) {
        const diagnostics = blankDiagnostics();
        diagnostics.itemKey = item.key;
        diagnostics.libraryID = item.libraryID;
        diagnostics.failures.push(`reader_open_failed: ${error}`);
        return diagnostics;
    }

    let last: ReaderTableDiagnostics | null = null;
    while (Date.now() < deadline) {
        const reader = readerRegistry().find((r: any) => r?.itemID === item.id);
        if (reader) {
            const existing = views.get(reader);
            if (existing) {
                return (
                    lastDiagnostics.get(existing.itemKey ?? '') ?? {
                        ...blankDiagnostics(),
                        itemKey: existing.itemKey,
                        libraryID: existing.libraryID,
                        enhanced: true,
                        markers: existing.markers,
                    }
                );
            }
            const attempted = await enhanceReader(reader, { force: true });
            if (attempted) {
                last = attempted;
                if (attempted.enhanced) return attempted;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (last) return last;
    const diagnostics = blankDiagnostics();
    diagnostics.itemKey = item.key;
    diagnostics.libraryID = item.libraryID;
    diagnostics.failures.push('reader_did_not_appear');
    return diagnostics;
}
