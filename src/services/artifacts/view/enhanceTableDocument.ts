/**
 * The chrome-side half of a rendered table document.
 *
 * {@link buildTableDocument} produces a document that sorts, filters and
 * expands with no script of its own. Two things it cannot do for itself:
 *
 * 1. **Show a citation card.** A marker sits inside a cell clamped with
 *    `overflow: hidden`, so any card the document draws beside it is clipped by
 *    the cell it belongs to. Chrome is outside that clip, so the card is drawn
 *    over the frame instead — which is what lets a table show what the chat's
 *    `Citation` shows rather than a native tooltip.
 * 2. **Route its own links.** Left alone, an `https:` link loads the
 *    publisher's page *into the frame*, replacing the table with no way back,
 *    and a `zotero:` link is at the mercy of whatever the frame does with an
 *    unknown scheme.
 *
 * This module knows nothing about Zotero or about which surface the document is
 * rendered on: the surface arrives as a {@link TableViewHost}. Today exactly
 * one host uses it — the reader (`readerTableView.ts`) — but the seam stays,
 * because what the reader needs is peculiar to it: its snapshot iframe is
 * nested inside the reader's own iframe, which is why the frame's rectangle is
 * a callback rather than an element.
 */

import { logger } from '@beaver/agent-core/platform/logger';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** The frame's position in `host.win`'s viewport, in CSS pixels. */
export interface FrameRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface TableViewHost {
    /** Chrome window the card is drawn in. */
    win: Window;
    /** Element the card is appended to; must be able to overlay the document. */
    cardMount: Element;
    /** Viewport rect of the frame the document is rendered in, at call time. */
    frameRect(): FrameRect;
    /** Opens a URL the document asked for. */
    openLink(href: string): void;
}

/** One enhanced document, for the dev view-state endpoint. */
export interface TableViewSummary {
    /** The reader's tab id, or its instance id for a reader window. */
    id: string;
    /** The stored table's Zotero item key, where the document has one. */
    key: string | null;
    /** Citation markers found in the document. */
    markers: number;
}

/**
 * The link schemes the renderer can emit, and therefore the ones a host is
 * asked to open. Everything else the document may contain — a fragment, a
 * relative path — is left to the frame, which is the only thing that knows
 * what it means there.
 */
const ROUTED_HREF = /^(https:\/\/|zotero:\/\/)/i;

/** Whether this href is one the host opens rather than the frame. */
export function isRoutedTableHref(href: string): boolean {
    return ROUTED_HREF.test(href);
}

/** Citation markers in the document, which is also what a host reports. */
export function countCitationMarkers(doc: Document): number {
    try {
        return doc.querySelectorAll('[data-bt-cite]').length;
    } catch {
        return 0;
    }
}

/**
 * Wires the citation card and link routing onto an already-loaded table
 * document, and returns the disposer that removes every listener and the card.
 *
 * The caller owns waiting for the document: this attaches to the one it is
 * given and does not poll for another.
 */
export function enhanceTableDocument(doc: Document, host: TableViewHost): () => void {
    const card = makeCitationCard(host);
    const removers: Array<() => void> = [];

    /** Every listener is a capture listener, and every one is undone below. */
    const on = (
        target: EventTarget | null | undefined,
        type: string,
        handler: (event: Event) => void
    ): void => {
        if (!target?.addEventListener) return;
        target.addEventListener(type, handler, true);
        removers.push(() => {
            try {
                target.removeEventListener(type, handler, true);
            } catch {
                // The document may already be gone; there is nothing to detach.
            }
        });
    };

    const hide = () => {
        card.style.display = 'none';
    };

    on(doc, 'mouseover', (event: Event) => {
        const marker = (event.target as Element | null)?.closest?.('[data-bt-cite]');
        if (!marker) return;
        // The document ships a `title` for viewers that can show no card of
        // their own. This is not one of them, and leaving it would put the
        // platform's tooltip on top of ours.
        const native = marker.getAttribute('title');
        if (native !== null) {
            marker.setAttribute('data-cite-title', native);
            marker.removeAttribute('title');
        }
        showCitationCard(card, host, marker);
    });

    on(doc, 'mouseout', (event: Event) => {
        if ((event.target as Element | null)?.closest?.('[data-bt-cite]')) hide();
    });

    on(doc, 'scroll', hide);
    on(doc.defaultView, 'scroll', hide);

    // Registered in the **capture** phase on the document, which is what makes
    // this the whole story for links in both hosts — no reader internals needed.
    //
    // In the reader the snapshot document is live, and Zotero's reader has its
    // own click handler; but it is registered bubble-phase on the frame's
    // *window* (`reader/src/dom/common/dom-view.tsx:300`), so a capture listener
    // on the document runs first and `stopPropagation()` below means
    // `_handleClick` (`:964`) never runs at all. Nothing there has to be
    // patched, and nothing there can double-open a link this opened.
    //
    // In particular: do **not** override the reader's `_isExternalLink` to make
    // `zotero:` links live. It is true in general that a `zotero:` href is dead
    // in a snapshot — but not here, because this handler already opened it, and
    // the override is actively harmful. `_handlePointerOver`
    // (`dom-view.tsx:861-869`) *is* still reached, on a different event from the
    // `mouseover` above, and for a link it calls external it overwrites
    // `link.title` with the raw href — permanently replacing the document's own
    // "Reveal in library". Left classified as internal, the same handler calls
    // `_handlePointerOverInternalLink`, which the snapshot view does not
    // override and which does nothing (`dom-view.tsx:888`).
    on(doc, 'click', (event: Event) => {
        const target = event.target as Element | null;
        const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!anchor) return;
        const href = anchor.getAttribute('href') ?? '';

        // Either way the row must not expand under the click: the cells live
        // inside the `<summary>` of the `<details>` that expands them.
        event.stopPropagation();

        if (!isRoutedTableHref(href)) return;
        // The frame must not navigate: an `https:` link would replace the
        // table, and a `zotero:` link means nothing to the frame. The host
        // opens both.
        event.preventDefault();
        try {
            host.openLink(href);
        } catch (error) {
            logger(`enhanceTableDocument: could not open ${href}: ${error}`, 2);
        }
    });

    return () => {
        for (const remove of removers) remove();
        removers.length = 0;
        try {
            card.remove();
        } catch {
            // The mount may already be gone with its surface.
        }
    };
}

/**
 * The hover card a citation marker gets, built in chrome rather than in the
 * document — see the note at the top of this file for why it cannot be drawn
 * where the marker is.
 */
function makeCitationCard(host: TableViewHost): HTMLElement {
    const card = host.win.document.createElementNS(HTML_NS, 'div') as HTMLElement;
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
    host.cardMount.appendChild(card);
    return card;
}

/**
 * Where the card goes: centred under the marker, then pulled back inside the
 * frame if that would hang it off either edge.
 *
 * The marker's rectangle is relative to the frame's own viewport and the card
 * is positioned relative to its offset parent, so the frame's position is what
 * joins the two. A card with no positioned ancestor resolves against the
 * initial containing block, which is the viewport — hence an absent origin
 * counts as zero rather than as an error.
 */
export function citationCardPosition(
    frame: FrameRect,
    marker: { left: number; bottom: number; width: number },
    origin: { left: number; top: number } | null,
    cardWidth: number
): { left: number; top: number } {
    const centred = frame.left + marker.left + marker.width / 2 - cardWidth / 2;
    const clamped = Math.min(
        Math.max(frame.left + 8, centred),
        frame.right - cardWidth - 8
    );
    return {
        left: clamped - (origin?.left ?? 0),
        top: frame.top + marker.bottom - (origin?.top ?? 0) + 6,
    };
}

/**
 * Fills the card from the marker's own data and places it under it.
 *
 * The layout is the app's citation card: the source and its locator on one row,
 * a rule, the cited passage in quotation marks, a rule, and what a click will
 * do. The document carries those as separate attributes rather than one string
 * precisely so they can be laid out rather than dumped.
 */
export function showCitationCard(
    card: HTMLElement,
    host: TableViewHost,
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

    // Shown before it is measured: `offsetWidth` is 0 while it is `display: none`.
    card.style.display = 'block';
    const at = marker.getBoundingClientRect();
    const origin = (card.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? null;
    const { left, top } = citationCardPosition(
        host.frameRect(),
        { left: at.left, bottom: at.bottom, width: at.width },
        origin,
        card.offsetWidth
    );
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}
