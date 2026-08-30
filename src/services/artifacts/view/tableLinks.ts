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
