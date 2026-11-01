/**
 * Readers on a stored table, handed to the Beaver tab.
 *
 * A stored table is a snapshot attachment, and with Beaver running its one
 * surface is the Beaver tab (`src/ui/tableTab.ts`). Most readers on a table
 * never load: the tab's `add` observer replaces a reader *tab* before the
 * snapshot paints. Two kinds load without an `add`:
 *
 * - a restored, unloaded reader tab the user selects;
 * - a reader *window*: `openReaderInNewWindow` (which double-click and
 *   `zotero://open` honour), a shift-click, or Zotero reopening reader windows
 *   at startup.
 *
 * This module hears both on the reader's `renderToolbar` event, the one event
 * that fires for every reader type and carries the instance, and hands them to
 * the redirect `tableTab.ts` registers. Readers already open when it starts (a
 * plugin reload, a session restored before Beaver) are swept once.
 *
 * Without Beaver, or before the redirect is registered, a reader shows the
 * static page (`tableDocument.ts`), which stands on its own.
 *
 * **One entry point escapes, by the user's choice.** Double-click and
 * `zotero://open` end at `Zotero.FileHandlers.open`, which consults the
 * `fileHandler.snapshot` preference (Settings → General → "Open snapshots
 * using"). Set to anything but Zotero, the file goes to a browser or another
 * application and no reader is created, so the table opens as the static page.
 * That is honoured rather than intercepted. The item pane's button calls
 * `openTable` (`src/ui/openTable.ts`) and always gets the Beaver tab.
 *
 * The listener is registered on Zotero's reader, which outlives every window,
 * so it belongs to the plugin realm and is removed at plugin shutdown.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { isTableItem, loadTableItemFields } from '../tableItemIdentity';

/**
 * Hands a reader on a table to the Beaver tab and answers true when it took
 * it. Registered by `tableTab.ts`, which owns opening the tab.
 */
export type TableReaderRedirect = (reader: any, item: Zotero.Item) => boolean;

let readerRedirect: TableReaderRedirect | null = null;
let toolbarHandler: ((event: any) => void) | null = null;

/**
 * Readers already looked at: handed over, or not a table. `renderToolbar`
 * fires repeatedly for one reader, and each reader is decided once.
 */
const seen = new WeakSet<object>();

export function setTableReaderRedirect(redirect: TableReaderRedirect | null): void {
    readerRedirect = redirect;
}

function readerRegistry(): any[] {
    const readers = (Zotero?.Reader as any)?._readers;
    return Array.isArray(readers) ? readers : [];
}

/** The reader's item when it is a stored table, with the fields {@link isTableItem} reads loaded. */
async function tableItemFor(reader: any): Promise<Zotero.Item | null> {
    const itemID = reader?.itemID;
    if (!itemID) return null;
    const item = Zotero.Items.get(itemID) as Zotero.Item | false;
    if (!item) return null;
    await loadTableItemFields([item]);
    return isTableItem(item) ? item : null;
}

/**
 * Whether the reader is still open. The user can close it while its item's
 * fields load, and closing a reader twice is not safe: a reader window's
 * close removes `indexOf(reader)` from Zotero's registry, which for a reader
 * already gone is the last one.
 */
function isLive(reader: any): boolean {
    if (!readerRegistry().includes(reader) || reader._isTabClosed) return false;
    return !reader._window?.closed;
}

/**
 * Hands one reader to the Beaver tab if it shows a table. Cheap for every
 * other reader: a table is a `snapshot` reader, so nothing else is looked up.
 */
async function redirectReader(reader: any): Promise<void> {
    if (!reader || seen.has(reader) || !readerRedirect) return;
    seen.add(reader);
    if (reader.type !== 'snapshot') return;
    try {
        const item = await tableItemFor(reader);
        if (!item || !readerRedirect || !isLive(reader)) return;
        if (readerRedirect(reader, item)) {
            logger(`readerTableView: handed the reader on table ${item.key} to the Beaver tab`, 3);
        }
    } catch (error) {
        // A reader left as it is shows the static page, which is a working
        // fallback; a redirect error must not break the reader.
        logger(`readerTableView: could not redirect a reader: ${String(error)}`, 2);
    }
}

/**
 * Registers the listener and sweeps the readers already open. Safe to call
 * twice: the previous registration is removed first.
 */
export function initTableReaderRedirect(): void {
    cleanupTableReaderRedirect();

    if (typeof Zotero?.Reader?.registerEventListener !== 'function') {
        logger('readerTableView: Reader API not available, skipping', 2);
        return;
    }

    toolbarHandler = (event: any) => {
        void redirectReader(event?.reader);
    };
    // `Zotero.Beaver`, not the bare `addon` global: this module is reachable
    // from the webpack bundle, where `addon` does not exist.
    const pluginID = (Zotero as any).Beaver?.data?.config?.addonID as string | undefined;
    Zotero.Reader.registerEventListener('renderToolbar', toolbarHandler, pluginID);

    for (const reader of readerRegistry()) void redirectReader(reader);
}

/** Removes the listener, for plugin shutdown. */
export function cleanupTableReaderRedirect(): void {
    if (!toolbarHandler) return;
    // `Zotero.Reader.unregisterEventListener` filters the registry down to
    // the matching listener instead of removing it, so the removal is done
    // here, the same way the other reader integrations do it.
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
