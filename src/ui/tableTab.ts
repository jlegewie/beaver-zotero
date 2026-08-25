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

const openTabs = new Map<
    string,
    { win: Window; iframe: HTMLIFrameElement; card?: HTMLElement }
>();

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
    const card = makeCitationCard(win, container);
    // Order matters: the listener has to be registered before the document
    // exists, or the only `load` it could catch has already gone by and the
    // links are left unwired.
    iframe.setAttribute('srcdoc', html);
    wireLinks(iframe, win, card);

    openTabs.set(id, { win, iframe, card });
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
/**
 * The hover card a citation marker gets, built in chrome rather than in the
 * document.
 *
 * The document cannot draw its own: a marker sits inside a cell that is clamped
 * with `overflow: hidden`, so any card rendered beside it is clipped by the
 * cell it belongs to. Chrome is outside that clip, so the card is positioned
 * over the iframe from the marker's own rectangle — which is what lets the tab
 * show what the chat's `Citation` shows instead of a native tooltip.
 */
function makeCitationCard(win: Window, container: Element): HTMLElement {
    const card = win.document.createElementNS(HTML_NS, 'div') as HTMLElement;
    card.className = 'beaver-root bt-tab-cite-card';
    card.style.cssText = [
        'position: absolute',
        'z-index: 100',
        'display: none',
        'width: 22rem',
        'max-width: 22rem',
        'border: 1px solid var(--color-border50)',
        'border-radius: 0.5rem',
        // Opaque: the menu material is translucent and the table showed
        // through the card.
        'background: var(--material-sidepane)',
        'box-shadow: 0 0.4rem 1.4rem rgba(0, 0, 0, 0.22)',
        'font-size: 0.92rem',
        'line-height: 1.4',
        'color: var(--fill-primary)',
        'pointer-events: none',
    ].join(';');
    container.appendChild(card);
    return card;
}

/**
 * Fills the card from the marker's own data and centres it under it.
 *
 * The layout is the app's citation card: the source and its locator on one row,
 * a rule, the cited passage in quotation marks, a rule, and what a click will
 * do. The document carries those as separate attributes rather than one string
 * precisely so they can be laid out rather than dumped.
 */
function showCitationCard(
    card: HTMLElement,
    iframe: HTMLIFrameElement,
    marker: Element
): void {
    const name = marker.getAttribute('data-cite-name');
    const locator = marker.getAttribute('data-cite-loc');
    const preview = marker.getAttribute('data-cite-preview');
    const action = marker.getAttribute('data-cite-action');
    if (!name && !preview) return;

    const doc = card.ownerDocument;
    const row = (cssText: string) => {
        const el = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
        el.style.cssText = cssText;
        return el;
    };
    card.textContent = '';

    if (name) {
        const head = row(
            'display: flex; gap: 0.75rem; align-items: baseline; padding: 0.45rem 0.6rem;'
        );
        const who = row('flex: 1 1 auto; font-weight: 600; min-width: 0;');
        who.textContent = name;
        head.appendChild(who);
        if (locator) {
            const where = row(
                'flex: 0 0 auto; color: var(--fill-secondary); white-space: nowrap;'
            );
            where.textContent = locator;
            head.appendChild(where);
        }
        card.appendChild(head);
    }

    if (preview) {
        const body = row(
            'padding: 0.45rem 0.6rem; border-top: 1px solid var(--color-border50); color: var(--fill-secondary); overflow-wrap: anywhere;'
        );
        body.textContent = preview;
        card.appendChild(body);
    }

    if (action) {
        const foot = row(
            'padding: 0.4rem 0.6rem; border-top: 1px solid var(--color-border50); color: var(--fill-secondary); font-size: 0.85rem;'
        );
        foot.textContent = action;
        card.appendChild(foot);
    }

    // Centred under the marker, then pulled back inside the tab if that would
    // hang it off either edge.
    card.style.display = 'block';
    const frame = iframe.getBoundingClientRect();
    const at = marker.getBoundingClientRect();
    const origin = (card.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    const width = card.offsetWidth;
    const centred = frame.left + at.left + at.width / 2 - width / 2;
    const clamped = Math.min(
        Math.max(frame.left + 8, centred),
        frame.right - width - 8
    );
    card.style.left = `${clamped - (origin?.left ?? 0)}px`;
    card.style.top = `${frame.top + at.bottom - (origin?.top ?? 0) + 6}px`;
}

function wireLinks(
    iframe: HTMLIFrameElement,
    win: Window,
    card?: HTMLElement
): void {
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
        if (card) {
            doc.addEventListener(
                'mouseover',
                (event: Event) => {
                    const marker = (event.target as Element | null)?.closest?.(
                        '[data-bt-cite]'
                    );
                    if (!marker) return;
                    // The document ships a `title` for viewers that can show no
                    // card of their own. This is not one of them, and leaving it
                    // would put the platform's tooltip on top of ours.
                    const native = marker.getAttribute('title');
                    if (native !== null) {
                        marker.setAttribute('data-cite-title', native);
                        marker.removeAttribute('title');
                    }
                    showCitationCard(card, iframe, marker);
                },
                true
            );
            const hide = () => {
                card.style.display = 'none';
            };
            doc.addEventListener(
                'mouseout',
                (event: Event) => {
                    if ((event.target as Element | null)?.closest?.('[data-bt-cite]'))
                        hide();
                },
                true
            );
            doc.addEventListener('scroll', hide, true);
            doc.defaultView?.addEventListener('scroll', hide, true);
        }

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
        entry.card?.remove();
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
