/**
 * Opens a rendered `TableSpec` in a temporary Zotero tab.
 *
 * `Zotero_Tabs.add` accepts any `type` string and creates a `tab-content`
 * container in the deck — no item, no file, no reader. The table is mounted
 * into it as a content iframe carrying the self-contained document from
 * `tableHtml.ts`, which is the same document a saved snapshot would hold.
 *
 * Three things this file exists to get right, all learned from the real API
 * rather than its (absent) documentation:
 *
 * 1. **`data` is not optional.** `Zotero_Tabs._update()` reads `tab.data.icon`
 *    for *every* tab on every update, so one tab added without `data` throws
 *    from then on — including from other people's `add` and `select` calls.
 * 2. **The tab type must not contain a hyphen.** `parseTabType` splits on `-`,
 *    so `beaver-table` would parse as type `beaver`, state `table`.
 * 3. **Cleanup is the plugin's job.** Zotero removes the container on close;
 *    releasing what was mounted into it is ours.
 *
 * The tab is ephemeral by design: `restoreState` is a no-op for an unregistered
 * type, so it disappears on restart with no ghost tab. Persistence would mean
 * registering a hook, which is a separate decision.
 *
 * `Zotero_Tabs` is an internal global rather than a plugin API, so every entry
 * point here checks for it and degrades to doing nothing.
 */

import { buildTableDocument, type TableHtmlOptions } from '../services/reports/tableHtml';
import type { RowRef, TableSpec } from '@beaver/agent-core/layouts/table';
import { logger } from '@beaver/agent-core/platform/logger';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const TAB_TYPE = 'beaverTable';

interface ZoteroTabsApi {
    add(options: {
        id?: string;
        type: string;
        data: Record<string, unknown>;
        title?: string;
        index?: number;
        select?: boolean;
        onClose?: () => void;
    }): { id: string; container: XULElement };
    close(id: string): void;
    select(id: string): void;
    _tabs?: Array<{ id: string; type: string; data?: Record<string, unknown> }>;
}

function tabsApi(win: Window): ZoteroTabsApi | null {
    const api = (win as unknown as { Zotero_Tabs?: ZoteroTabsApi }).Zotero_Tabs;
    return api && typeof api.add === 'function' ? api : null;
}

/** Whether this Zotero exposes the internal tab API this surface needs. */
export function canOpenTableTab(win: Window = Zotero.getMainWindow()): boolean {
    return !!tabsApi(win);
}

/**
 * `zotero://` URIs for a row, built here because only Zotero knows whether a
 * library id is the user library or a group.
 */
export function zoteroLinksFor(ref: RowRef): { selectUri?: string | null; openUri?: string | null } {
    if (ref.kind !== 'item') return {};
    const { library_id: libraryID, zotero_key: key } = ref;
    let scope = 'library';
    try {
        if (libraryID !== Zotero.Libraries.userLibraryID) {
            const groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
            if (groupID) scope = `groups/${groupID}`;
        }
    } catch {
        // A library that no longer resolves still gets a select URI for the
        // user library; the worst case is a link that reveals nothing.
    }
    const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
    const hasFile =
        item && typeof (item as Zotero.Item).getAttachments === 'function'
            ? (item as Zotero.Item).getAttachments().length > 0
            : false;

    return {
        selectUri: `zotero://select/${scope}/items/${key}`,
        openUri: hasFile ? `zotero://open/${scope}/items/${key}` : null,
    };
}

const openTabs = new Map<string, { win: Window; iframe: HTMLIFrameElement }>();

export interface OpenTableTabOptions {
    /** Tab title. Defaults to the spec's title. */
    title?: string;
    /** Reuse the tab with this id instead of adding another. */
    tabId?: string;
    win?: Window;
    /** Passed through to the renderer; links default to Zotero's own. */
    html?: Omit<TableHtmlOptions, 'linksFor'>;
}

/**
 * Renders the spec and shows it in a tab, returning the tab id.
 *
 * Returns null where the internal tab API is missing, so a caller can fall back
 * to the separate window rather than failing.
 */
export function openTableTab(
    spec: TableSpec,
    options: OpenTableTabOptions = {}
): string | null {
    const win = options.win ?? Zotero.getMainWindow();
    const tabs = tabsApi(win);
    if (!tabs) {
        logger('openTableTab: Zotero_Tabs is unavailable; not opening a table tab', 2);
        return null;
    }

    const { html } = buildTableDocument(spec, {
        ...options.html,
        linksFor: (ref) => zoteroLinksFor(ref),
    });

    const title = options.title ?? spec.title ?? 'Table';
    const existingId = options.tabId && openTabs.has(options.tabId) ? options.tabId : null;

    if (existingId) {
        const existing = openTabs.get(existingId)!;
        existing.iframe.setAttribute('srcdoc', html);
        tabs.select(existingId);
        return existingId;
    }

    const { id, container } = tabs.add({
        id: options.tabId,
        type: TAB_TYPE,
        // Required: `_update()` reads `data.icon` for every tab, so a tab added
        // without it breaks every later tab update in the window.
        data: { icon: 'chrome://zotero/skin/16/universal/note.svg' },
        title,
        select: true,
        onClose: () => closeTableTab(id, { skipTabClose: true }),
    });

    const iframe = win.document.createElementNS(HTML_NS, 'iframe') as HTMLIFrameElement;
    // A content docshell, so the document is not privileged chrome, and
    // `srcdoc` because the document is generated rather than fetched.
    iframe.setAttribute('type', 'content');
    iframe.style.cssText = 'width:100%;height:100%;border:0;';
    container.appendChild(iframe);
    // Order matters: the listener has to be registered before the document
    // exists, or the only `load` it could catch has already gone by and the
    // links are left unwired.
    iframe.setAttribute('srcdoc', html);
    wireLinks(iframe, win);

    openTabs.set(id, { win, iframe });
    return id;
}

/**
 * The chrome-side half of the document's links.
 *
 * `zotero://` navigates on its own — Zotero's protocol handler picks it up from
 * a content docshell — so the only thing it needs here is for the click not to
 * also toggle the `<details>` row it sits inside.
 *
 * An `https:` link is the one that has to be intercepted: left alone it would
 * load the publisher's page *into the tab*, replacing the table with no way
 * back. It goes to the system browser instead.
 */
function wireLinks(iframe: HTMLIFrameElement, win: Window): void {
    const wired = new WeakSet<Document>();

    /** Wires the current document, and reports whether it is the real one. */
    const attach = (): boolean => {
        const doc = iframe.contentDocument;
        if (!doc) return false;
        const ready = doc.documentURI === 'about:srcdoc' && doc.readyState !== 'loading';
        // The blank document that precedes the real one is a document too, so
        // each is wired at most once and only the real one ends the wait.
        if (wired.has(doc)) return ready;
        wired.add(doc);
        doc.addEventListener(
            'click',
            (event: Event) => {
                const target = event.target as Element | null;
                const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
                if (!anchor) return;
                const href = anchor.getAttribute('href') ?? '';

                // Either way the row must not expand under the click.
                event.stopPropagation();

                if (/^https:\/\//i.test(href)) {
                    event.preventDefault();
                    try {
                        Zotero.launchURL(href);
                    } catch (error) {
                        logger(`openTableTab: could not open ${href}: ${error}`, 2);
                    }
                }
            },
            true
        );
        return ready;
    };

    // A `srcdoc` document in a chrome `type="content"` iframe never fires
    // `load` on the iframe element, so the document is waited for rather than
    // listened for. Bounded: a document that never arrives stops the wait
    // instead of polling forever.
    let attempts = 0;
    const wait = () => {
        if (attach()) return;
        if (++attempts > 40) {
            logger('openTableTab: table document did not load; links are inert', 2);
            return;
        }
        win.setTimeout(wait, 50);
    };
    wait();
}

/** Closes a table tab and releases what was mounted into it. */
export function closeTableTab(id: string, options: { skipTabClose?: boolean } = {}): void {
    const entry = openTabs.get(id);
    openTabs.delete(id);
    if (!entry) return;

    // Drop the document before the container goes, so a large table is not held
    // alive by a detached iframe.
    try {
        entry.iframe.removeAttribute('srcdoc');
        entry.iframe.remove();
    } catch {
        // The container may already be gone; nothing left to release.
    }

    if (options.skipTabClose) return;
    const tabs = tabsApi(entry.win);
    try {
        tabs?.close(id);
    } catch {
        // Closing an already-closed tab is not an error worth surfacing.
    }
}

/** Closes every table tab this window opened — for plugin shutdown. */
export function closeAllTableTabs(): void {
    for (const id of [...openTabs.keys()]) closeTableTab(id);
}
