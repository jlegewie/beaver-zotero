/**
 * Putting a stored table on screen.
 *
 * A stored table is a snapshot attachment, so the surface that shows it is
 * Zotero's own snapshot reader — which `view/readerTableView.ts` turns into an
 * interactive table. This module is the one function that gets a table there,
 * so the item-pane button and the dev endpoints share it rather than each
 * calling `Zotero.Reader.open` with their own preflight.
 *
 * There is deliberately no second surface and no choice to make. The tab that
 * used to exist here rendered the *same bytes* as the stored file through the
 * same enhancer, so it was a second host for one document rather than a second
 * view of it. A future editing surface is a React one and will not be this
 * (`react/atoms/windowSurface.ts`).
 *
 * Two rules shape the file:
 *
 * 1. **Nothing throws.** Every caller is a UI path that must degrade, so
 *    failures come back as `{ error }`.
 * 2. **The file is checked first.** The reader opened on a snapshot with no
 *    file on disk is an error dialog, and the caller can say something better.
 *
 * Unlike Zotero's own open paths, this one always reaches the reader: it calls
 * `Zotero.Reader.open` rather than `Zotero.FileHandlers.open`, so a user who
 * set "Open snapshots using" to something other than Zotero still gets the
 * interactive table here. See the note in `view/readerTableView.ts`.
 *
 * This module is compiled into the **esbuild** bundle, so it may not import
 * `react/*` or anything that reaches it. That is why the item is resolved
 * through `tableItemIdentity` rather than through `tableStore.ts`, which
 * imports the library-exclusion check and with it the whole React graph.
 *
 * Opening is not gated on library exclusion. Exclusion governs writes, indexing
 * and what leaves the machine; a table already in the user's library is theirs
 * to look at.
 */

import { resolveTableItem, type TableRef } from '../services/artifacts/tableItemIdentity';

export type OpenTableOutcome = { ok: true } | { error: string };

interface ReaderApi {
    open(
        itemID: number,
        location?: unknown,
        options?: { openInWindow?: boolean; allowDuplicate?: boolean }
    ): Promise<unknown>;
}

function readerApi(): ReaderApi | null {
    const reader = Zotero.Reader as unknown as ReaderApi | undefined;
    return typeof reader?.open === 'function' ? reader : null;
}

/**
 * Whether the reader should open in its own window.
 *
 * Zotero's own preference, read here so this surface behaves like every other
 * way of opening the table: a double-click and `zotero://open` both reach
 * `Zotero.FileHandlers.open`, which passes it. Left unread, the button would
 * always open a tab and quietly contradict the user's setting.
 */
function openReaderInNewWindow(): boolean {
    try {
        return Zotero.Prefs.get('openReaderInNewWindow') === true;
    } catch {
        // A preference that cannot be read is not a reason to refuse to open.
        return false;
    }
}

/**
 * Shows a stored table in the reader, where the enhancer picks it up.
 *
 * Never throws: a thrown error from the lookup or the open is folded into the
 * returned message.
 */
export async function openTable(ref: TableRef): Promise<OpenTableOutcome> {
    const reader = readerApi();
    if (!reader) {
        return { error: `Could not open table ${ref.key} — this Zotero build has no reader API.` };
    }
    try {
        const item = await resolveTableItem(ref);
        const path = await item.getFilePathAsync();
        if (!path) {
            return { error: `Could not open table ${ref.key} — it has no file on disk.` };
        }
        const openInWindow = openReaderInNewWindow();
        // `allowDuplicate` mirrors `Zotero.FileHandlers.open`, and is not
        // decoration: without it `Zotero.Reader.open` short-circuits to any
        // existing tab for the item — including a session-restored *unloaded*
        // one, which has no reader instance — and returns before it ever
        // reaches the window branch. The table would then appear in a tab
        // while the preference asked for a window.
        await reader.open(item.id, undefined, { openInWindow, allowDuplicate: openInWindow });
        return { ok: true };
    } catch (error) {
        // No trailing period: the thrown message usually carries its own, and
        // `... in library 1..` reads like a typo in the log.
        const message = String((error as Error)?.message ?? error);
        return { error: `Could not open table ${ref.key} — ${message}` };
    }
}
