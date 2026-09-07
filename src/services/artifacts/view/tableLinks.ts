/**
 * `zotero://` links for a stored table's rows and citations.
 *
 * The renderer emits exactly two schemes (`tableDocument.ts`'s `safeHref`), and
 * this module builds the `zotero://` ones: a row's verbs become links here, and
 * `zoteroLinkScope` names a cited item's library.
 *
 * Stateless, and deliberately kept apart from the reader host: every bundle
 * that renders or stores a table needs these links, while
 * `view/readerTableView.ts`, which owns the enhanced-view registry, must exist
 * in the **esbuild bundle only**. A stateless helper living in a stateful
 * module is how a second copy of that registry gets created.
 *
 * **Best effort throughout.** `zoteroLinksFor` runs once per row inside
 * `buildTableDocument`, which every write goes through, so a lookup that throws
 * here would abort the write with an error naming none of it. Nothing here asks
 * Zotero about an item: what a verb points at is in the spec (`rowActionTarget`),
 * and the only lookup is the library's URI scope, which degrades to the
 * personal library.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    ROW_ACTIONS,
    rowActionTarget,
    type Row,
    type RowActionTarget,
} from '@beaver/agent-core/layouts/table';
import type { TableHtmlLinks } from '../tableDocument';
import { getZoteroUriScope } from '../../../utils/zoteroUris';

/**
 * The `zotero://` path scope for a library. Returns `library` when this device
 * cannot resolve the id, because callers (citation links and row actions) must
 * not throw mid-render.
 *
 * Used as `citationScopeFor` and for the row links below, so a citation and a
 * row action into the same group never disagree about how to name it.
 */
export function zoteroLinkScope(libraryID: number): string {
    return getZoteroUriScope(libraryID) ?? 'library';
}

/** The `zotero://` href for one row-action target, or null when it has none. */
export function rowActionHref(target: RowActionTarget): string | null {
    switch (target.kind) {
        case 'reveal_item':
            return `zotero://select/${zoteroLinkScope(target.ref.library_id)}/items/${target.ref.zotero_key}`;
        case 'open_file':
            return `zotero://open/${zoteroLinkScope(target.ref.library_id)}/items/${target.ref.zotero_key}`;
        case 'open_annotation':
            // `zotero://open` accepts only a file attachment, and scrolls to the
            // annotation named in the query.
            return `zotero://open/${zoteroLinkScope(target.attachment.library_id)}/items/${target.attachment.zotero_key}?annotation=${encodeURIComponent(target.ref.zotero_key)}`;
        // The host resolves these at click time (best attachment, local file
        // copy) or carries them through approval (import); no static link.
        case 'open_item':
        case 'open_external_file':
        case 'import_reference':
            return null;
    }
}

/** `zotero://` URIs for a row's verbs, keyed by verb. Verbs without a link are omitted. */
export function zoteroLinksFor(row: Row): TableHtmlLinks {
    const links: TableHtmlLinks = {};
    for (const action of ROW_ACTIONS) {
        const target = rowActionTarget(row, action);
        const href = target ? rowActionHref(target) : null;
        if (href) links[action] = href;
    }
    return links;
}

export function openTableLink(href: string): void {
    try {
        if (/^https:\/\//i.test(href)) {
            Zotero.launchURL(href);
            return;
        }
        if (/^zotero:\/\//i.test(href)) {
            const pane = Zotero.getActiveZoteroPane();
            if (!pane?.loadURI) {
                logger(`openTableLink: no Zotero pane to open ${href}`, 2);
                return;
            }
            pane.loadURI(href);
            return;
        }
        // Never handed to the OS: a scheme the renderer does not emit is not
        // one this plugin should launch on the user's behalf.
        logger(`openTableLink: refusing to open ${href}`, 2);
    } catch (error) {
        logger(`openTableLink: could not open ${href}: ${error}`, 2);
    }
}
