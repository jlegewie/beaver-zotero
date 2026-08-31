/**
 * Opening the links a rendered table document carries.
 *
 * The renderer emits exactly two schemes (`tableDocument.ts`'s `linkHref`), and
 * both hosts must open them the same way, so the rule lives here rather than
 * once per host:
 *
 * - `https:` goes to the system browser. Loading it in place would replace the
 *   table with the publisher's page and leave no way back — and in the reader
 *   the snapshot's blocking observer would refuse it outright.
 * - `zotero:` goes to `ZoteroPane.loadURI`, which is where Zotero's own reader
 *   sends the links it opens (`ReaderInstance`'s `onOpenLink`). For the
 *   `select` and `open` extensions the table uses, that runs the same
 *   `doAction` a navigation to the URI would have run.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { RowRef } from '@beaver/agent-core/layouts/table';
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

/**
 * `zotero://` URIs for a row, built here because only Zotero knows whether a
 * library id is the user library or a group.
 *
 * Stateless, and deliberately kept apart from the tab host: the stored
 * document, the tab rendering and the reader must offer the same links, so
 * every bundle needs this — while `src/ui/tableTab.ts`, which owns the open-tab
 * registry, must exist in the **esbuild bundle only**. A stateless helper
 * living in a stateful module is how a second copy of that registry gets
 * created.
 *
 * **Best effort throughout.** This runs once per row inside `buildTableDocument`,
 * which every write goes through, so a lookup that throws here would abort the
 * write with an error naming none of it. Every step is therefore guarded and
 * degrades to a missing link.
 */
export function zoteroLinksFor(ref: RowRef): { selectUri?: string | null; openUri?: string | null } {
    if (ref.kind !== 'item') return {};
    const { library_id: libraryID, zotero_key: key } = ref;
    const scope = zoteroLinkScope(libraryID);

    return {
        selectUri: `zotero://select/${scope}/items/${key}`,
        openUri: hasOpenableFile(libraryID, key) ? `zotero://open/${scope}/items/${key}` : null,
    };
}

/**
 * Whether the row's item has a file the reader could open.
 *
 * `getAttachments()` throws in two ordinary cases: the item *is* an attachment,
 * and its child items are not loaded — which is true of any item nothing has
 * touched this session. Neither can be pre-empted here: this is synchronous and
 * called per row while a document renders, so there is no point at which the
 * `childItems` load that `tableItemPane.ts` does before its own
 * `getAnnotations()` call could be awaited. A row whose item cannot be asked
 * simply gets no open link.
 */
function hasOpenableFile(libraryID: number, key: string): boolean {
    try {
        const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
        if (!item || typeof (item as Zotero.Item).getAttachments !== 'function') {
            return false;
        }
        return (item as Zotero.Item).getAttachments().length > 0;
    } catch {
        return false;
    }
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
