/**
 * The reader as a second host for a rendered table document.
 *
 * A stored table is a snapshot attachment, so double-clicking it, following a
 * `zotero://open` link or opening it from the item pane lands it in Zotero's
 * reader — where, left alone, it is an inert page: the citation markers show a
 * native tooltip at best, and the reader swallows the `zotero:` links. This
 * module gives the reader the same interactivity the temporary tab has, through
 * the same {@link enhanceTableDocument}.
 *
 * ## Everything here is optional
 *
 * It reaches into reader internals that are not a plugin API. Every step is
 * therefore checked on its own, and every failure is silent: a table that
 * renders as a plain static page is the correct fallback, a broken reader is
 * not. The reader is left exactly as it was found — this module adds listeners
 * and a card, and replaces nothing, so there is no patched state to restore and
 * no way for a half-finished attempt to leave the reader worse off.
 *
 * ## What the seams are
 *
 * Exactly one: **the document.** `reader._internalReader._primaryView` holds
 * the sandboxed snapshot iframe; `initializedPromise` is the thing to await and
 * `_iframeDocument` is the document inside it. Chrome-registered listeners do
 * fire in there — the reader relies on that itself. Nothing else about the
 * reader is touched, patched or restored; in particular the reader's
 * `_isExternalLink` is deliberately left alone (see the comment on the click
 * listener in `enhanceTableDocument.ts` for why overriding it is worse than
 * useless here).
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

        const doc: Document | undefined = view._iframeDocument;
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

        // A window-hosted reader closes without a tab event, so it says so
        // itself. Tabs need nothing: the tab notifier already covers them, and
        // their window is the main one, which tears everything down anyway.
        if (!reader.tabID) {
            const release = onReaderWindowUnload(reader);
            if (release) undo.push(release);
            else diagnostics.failures.push('window_unload_listener_failed');
        }

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
        diagnostics.enhanced = true;
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
        host: 'reader' as const,
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
