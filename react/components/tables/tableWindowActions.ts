/**
 * What a table does outside its own surface: show its item in the library
 * and ask Beaver about it. A table in a tab does both in its own main window;
 * a table in its own window has neither a library nor a chat, so it uses a
 * main window's, and brings that window forward.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { resolveChatWindow, resolveNavigationWindow } from '../../../src/runtime/navigation';
import type { TableRef } from '../../../src/services/artifacts/tableItemIdentity';
import { selectItemById } from '../../utils/selectItem';

/**
 * Selects the table's item in a library. `origin` is the main window a tab is
 * in; null for a table window, which uses the most recent main window
 * (opening one if none is left) and brings it forward.
 */
export async function showTableInLibrary(itemID: number, origin: Window | null): Promise<void> {
    try {
        const win = await resolveNavigationWindow(origin);
        await selectItemById(itemID, true, undefined, win);
        if (!origin && !win.closed) win.focus();
    } catch (error) {
        logger(`showTableInLibrary: could not show item ${itemID}: ${String(error)}`, 2);
    }
}

/**
 * Opens Beaver's chat in the most recent main window with the table attached,
 * for a table in its own window. The chat's renderer attaches it (the
 * `ask-about-table` window command): stores never cross windows.
 */
export async function askAboutTableInChat(ref: TableRef): Promise<void> {
    try {
        const win = await resolveChatWindow();
        win.focus();
        await Zotero.Beaver.runtime.dispatchWindowCommand('ask-about-table', {
            windowId: win.__beaverRuntime?.id,
            libraryID: ref.libraryID,
            key: ref.key,
        });
    } catch (error) {
        logger(`askAboutTableInChat: could not open the chat for table ${ref.key}: ${String(error)}`, 2);
    }
}
