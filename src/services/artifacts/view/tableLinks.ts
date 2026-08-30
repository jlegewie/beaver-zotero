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
