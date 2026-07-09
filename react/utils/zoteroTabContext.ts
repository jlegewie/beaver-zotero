/**
 * Zotero-host-specific lookup for the item backing the currently selected
 * reader or note tab. Reads Zotero's tab registry directly (rather than
 * waiting on the async `zoteroContextAtom` update chain) so callers get a
 * synchronous result for cache-key computation and menu default rows.
 *
 * This is host-specific code, not part of the client-agnostic render layer —
 * it calls `Zotero.*` directly and must not be imported from
 * `react/components/citations/**` or other client-agnostic surfaces.
 */

export interface ReaderOrNoteContext {
    item: Zotero.Item;
    libraryId: number;
    keys: string[];               // [item.key, parentKey?]
    source: 'reader' | 'note';
}

const NOTE_TAB_TYPES = new Set(['note', 'note-unloaded', 'note-loading']);

/**
 * Resolves the item associated with a reader or note tab. Tries the reader
 * tab first, then falls back to a note tab lookup via `Zotero_Tabs._tabs`.
 * Returns null when the tab isn't a reader/note tab or its item can't be
 * resolved.
 */
export function getReaderOrNoteContextItem(selectedTabId: string | null): ReaderOrNoteContext | null {
    if (!selectedTabId) return null;

    // Try reader tab first
    try {
        const reader = Zotero.Reader.getByTabID(selectedTabId);
        if (reader && reader.itemID) {
            const item = Zotero.Items.get(reader.itemID);
            if (item) {
                const keys = [item.key];
                // Also include parent item key so callers can find threads
                // associated with either the attachment or its parent
                if (item.parentItemID) {
                    const parent = Zotero.Items.get(item.parentItemID);
                    if (parent) keys.push(parent.key);
                }
                return { item, libraryId: item.libraryID, keys, source: 'reader' };
            }
        }
    } catch (e) {
        console.error('getReaderOrNoteContextItem: error getting reader info:', e);
    }

    // If not a reader tab, check for note tab
    try {
        const mainWindow = Zotero.getMainWindow();
        const tab = mainWindow?.Zotero_Tabs?._tabs?.find((t: any) => t.id === selectedTabId);
        if (tab && NOTE_TAB_TYPES.has(tab.type) && tab.data?.itemID) {
            const item = Zotero.Items.get(tab.data.itemID);
            if (item) {
                const keys = [item.key];
                if (item.parentItemID) {
                    const parent = Zotero.Items.get(item.parentItemID);
                    if (parent) keys.push(parent.key);
                }
                return { item, libraryId: item.libraryID, keys, source: 'note' };
            }
        }
    } catch (e) {
        console.error('getReaderOrNoteContextItem: error getting note tab info:', e);
    }

    return null;
}

/**
 * Resolves the item that represents the "current context" for a thread
 * filter: the reader/note tab's item outside the library tab, or the first
 * selected item within it.
 */
export function getCurrentContextItemForFilter(
    isLibraryTab: boolean,
    selectedTabId: string | null,
    selectedZoteroItems: Zotero.Item[],
): Zotero.Item | null {
    if (!isLibraryTab) {
        return getReaderOrNoteContextItem(selectedTabId)?.item ?? null;
    }
    return selectedZoteroItems[0] ?? null;
}
