import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { logger } from '../../src/utils/logger';
import { isLibraryTabAtom } from '../atoms/ui';
import {
    selectedZoteroItemsAtom,
    selectedZoteroItemCountAtom,
    libraryViewAtom,
    selectedTagsAtom,
    recentlyAddedTodayCountAtom,
    libraryItemCountAtom,
    SMALL_LIBRARY_THRESHOLD,
    LibraryTreeRowType,
} from '../atoms/zoteroContext';
import { updateNoteItemAtom } from '../atoms/messageComposition';
import { isLibraryAccessReadyAtom, searchableLibraryIdsAtom } from '../atoms/profile';

const MAX_SELECTED_ITEMS = 10;

/**
 * Module-level variables to track Zotero notifier observer IDs.
 * Persist across hot-reloads to ensure proper cleanup.
 */
let moduleItemNotifierId: string | null = null;
let moduleTabNotifierId: string | null = null;

/**
 * Check if a tab type represents a note tab (loaded, unloaded, or loading).
 * Zotero uses 'note-unloaded' for session-restored tabs not yet loaded,
 * and 'note-loading' while a tab is being initialized.
 */
function isNoteTabType(type: string): boolean {
    return type === 'note' || type === 'note-unloaded' || type === 'note-loading';
}

/**
 * Cheap regular-item count probe across non-feed libraries. Used by the
 * first-run gate to route truly empty AND small libraries to the discovery
 * flow (suggestion cards on a 3-paper library produce overblown "Synthesize
 * what your library says about X" framing).
 *
 * Returns the count clamped to `cap` — the SQL `LIMIT cap` stops the scan
 * early, so the query stays cheap on a 50k-item library while still letting
 * the caller distinguish 0/1/.../cap.
 */
async function queryLibraryItemCount(cap: number): Promise<number> {
    const sql = `SELECT 1 FROM items i
        JOIN libraries l ON l.libraryID = i.libraryID
        WHERE l.type != 'feed'
          AND i.itemTypeID NOT IN (
              SELECT itemTypeID FROM itemTypes
              WHERE typeName IN ('note', 'attachment', 'annotation')
          )
          AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        LIMIT ?`;
    let count = 0;
    await Zotero.DB.queryAsync(sql, [cap], {
        onRow: () => { count++; },
    });
    return count;
}

/**
 * Query count of regular items added today (not notes/attachments/annotations/deleted).
 */
async function queryRecentlyAddedTodayCount(): Promise<number> {
    const sql = `SELECT COUNT(*) FROM items
        WHERE itemTypeID NOT IN (
            SELECT itemTypeID FROM itemTypes
            WHERE typeName IN ('note', 'attachment', 'annotation')
        )
        AND itemID NOT IN (SELECT itemID FROM deletedItems)
        AND date(dateAdded) = date('now', 'localtime')`;
    let count = 0;
    await Zotero.DB.queryAsync(sql, [], {
        onRow: (row: any) => {
            count = row.getResultByIndex(0);
        },
    });
    return count;
}

/**
 * Read the current collection tree row and return LibraryViewInfo.
 */
function readLibraryView(zp: any): {
    treeRowType: LibraryTreeRowType;
    libraryId: number;
    libraryName: string;
    collectionId: number | null;
    collectionName: string | null;
    searchName: string | null;
} | null {
    const cv = zp?.collectionsView;
    if (!cv?.selection) return null;

    const focusedIndex = cv.selection.focused;
    if (focusedIndex < 0) return null;

    const row = cv.getRow(focusedIndex);
    if (!row) return null;

    const type = row.type as LibraryTreeRowType;
    const libraryId = row.ref?.libraryID ?? Zotero.Libraries.userLibraryID;
    let libraryName = 'My Library';
    try {
        const lib = Zotero.Libraries.get(libraryId);
        if (lib) libraryName = lib.name;
    } catch {
        // fallback
    }

    return {
        treeRowType: type,
        libraryId,
        libraryName,
        collectionId: type === 'collection' ? (row.ref?.id ?? null) : null,
        collectionName: type === 'collection' ? (row.ref?.name ?? null) : null,
        searchName: type === 'search' ? (row.ref?.name ?? null) : null,
    };
}

/**
 * Read the current tag selection from the tag selector.
 */
function readTagSelection(zp: any): string[] {
    const tagSelection = zp?.tagSelector?.getTagSelection?.();
    if (!tagSelection) return [];
    return Array.from(tagSelection as Set<string>).sort();
}

/**
 * Hook that tracks Zotero application state (selected items, collection view,
 * tags, recently added items) and populates the corresponding Jotai atoms.
 *
 * Should be registered in GlobalContextInitializer after useZoteroTabSelection.
 */
export function useZoteroContext() {
    const isLibraryTab = useAtomValue(isLibraryTabAtom);
    const setSelectedItems = useSetAtom(selectedZoteroItemsAtom);
    const setSelectedItemCount = useSetAtom(selectedZoteroItemCountAtom);
    const setLibraryView = useSetAtom(libraryViewAtom);
    const setSelectedTags = useSetAtom(selectedTagsAtom);
    // Routes through updateNoteItemAtom (not the raw atom) so the note tab item
    // is validated — a note in an excluded/unreadable library is flagged invalid.
    const setNoteItem = useSetAtom(updateNoteItemAtom);
    const isLibraryAccessReady = useAtomValue(isLibraryAccessReadyAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const searchableLibraryIdsKey = searchableLibraryIds.join(',');
    const setRecentlyAddedTodayCount = useSetAtom(recentlyAddedTodayCountAtom);
    const setLibraryItemCount = useSetAtom(libraryItemCountAtom);

    // A note tab may be discovered before profile exclusions and the local
    // library list finish loading. updateNoteItemAtom safely defers that first
    // validation; retry the still-active note once access becomes ready, and
    // whenever the searchable set changes in Preferences.
    useEffect(() => {
        if (!isLibraryAccessReady) return;
        const mainWindow = Zotero.getMainWindow();
        const selectedTab = mainWindow?.Zotero_Tabs?._tabs?.find(
            (tab: any) => tab.id === mainWindow.Zotero_Tabs.selectedID,
        );
        if (!selectedTab || !isNoteTabType(selectedTab.type) || !selectedTab.data?.itemID) {
            return;
        }

        let cancelled = false;
        Zotero.Items.getAsync(selectedTab.data.itemID).then(async (item: Zotero.Item) => {
            if (!item || cancelled) return;
            await item.loadDataType('itemData');
            if (!cancelled) setNoteItem(item);
        }).catch((error: unknown) => {
            logger(`useZoteroContext: failed to revalidate active note tab: ${error}`, 2);
        });

        return () => {
            cancelled = true;
        };
    }, [isLibraryAccessReady, searchableLibraryIdsKey, setNoteItem]);

    useEffect(() => {
        const mainWindow = Zotero.getMainWindow();
        const zp = mainWindow?.ZoteroPane;
        if (!zp) {
            logger('useZoteroContext: ZoteroPane not available', 2);
            return;
        }

        logger('useZoteroContext: initializing');

        // --- collectionsView.onSelect listener ---
        const handleCollectionSelect = () => {
            const viewInfo = readLibraryView(zp);
            if (viewInfo) {
                setLibraryView(viewInfo);
                logger(`useZoteroContext: collection changed to ${viewInfo.treeRowType} "${viewInfo.collectionName || viewInfo.libraryName}"`);
            }
            // Tags are cleared on collection change by Zotero, update our atom
            const tags = readTagSelection(zp);
            setSelectedTags(tags);
        };

        // --- itemsView.onSelect listener ---
        const handleItemSelect = () => {
            if (!isLibraryTab) return;
            const items: Zotero.Item[] = zp.getSelectedItems?.() || [];
            setSelectedItemCount(items.length);
            setSelectedItems(items.slice(0, MAX_SELECTED_ITEMS));
        };

        // --- itemsView.onRefresh listener (catches tag filter changes) ---
        const handleItemsRefresh = () => {
            const tags = readTagSelection(zp);
            setSelectedTags(tags);
        };

        // Attach collectionsView listener
        // Cast to any because Zotero types define these as `false | CollectionTree`
        const cv = zp.collectionsView as any;
        if (cv?.onSelect) {
            cv.onSelect.addListener(handleCollectionSelect);
        }

        // Attach itemsView listeners
        const iv = zp.itemsView as any;
        if (iv?.onSelect) {
            iv.onSelect.addListener(handleItemSelect);
        }
        if (iv?.onRefresh) {
            iv.onRefresh.addListener(handleItemsRefresh);
        }

        // --- Zotero.Notifier for recently added items ---
        if (moduleItemNotifierId) {
            try {
                Zotero.Notifier.unregisterObserver(moduleItemNotifierId);
            } catch {
                // ignore
            }
            moduleItemNotifierId = null;
        }

        // Tracked locally so 'modify' (frequent) can skip the query once the
        // library has crossed the threshold — modify can only grow the count
        // (via restore-from-trash), never shrink it, so we can stop re-probing
        // once we already know the library is at-or-above the threshold.
        let libraryItemCountLocal = 0;
        const refreshLibraryItemCount = async () => {
            libraryItemCountLocal = await queryLibraryItemCount(
                SMALL_LIBRARY_THRESHOLD,
            );
            setLibraryItemCount(libraryItemCountLocal);
        };

        const itemObserver: { notify: _ZoteroTypes.Notifier.Notify } = {
            notify: async function (
                event: _ZoteroTypes.Notifier.Event,
                type: _ZoteroTypes.Notifier.Type,
                _ids: string[] | number[],
            ) {
                if (type !== 'item') return;
                if (event === 'add') {
                    const count = await queryRecentlyAddedTodayCount();
                    setRecentlyAddedTodayCount(count);
                    // 'add' fires for notes/attachments/annotations too, which
                    // don't count as regular items — re-query rather than assume.
                    // Skip once the library is at-or-above the threshold;
                    // further adds can't cross any first-run boundary.
                    if (libraryItemCountLocal < SMALL_LIBRARY_THRESHOLD) {
                        await refreshLibraryItemCount();
                    }
                } else if (event === 'delete' || event === 'trash') {
                    await refreshLibraryItemCount();
                } else if (
                    event === 'modify'
                    && libraryItemCountLocal < SMALL_LIBRARY_THRESHOLD
                ) {
                    // Restore-from-trash fires only 'modify' on item (no
                    // 'trash' event). Skip once we've crossed the threshold:
                    // modify can only grow the count.
                    await refreshLibraryItemCount();
                }
            },
        };

        const itemObserverId = Zotero.Notifier.registerObserver(
            itemObserver,
            ['item'],
            'beaver-zoteroContextItemObserver',
        );
        moduleItemNotifierId = itemObserverId;

        // --- Zotero.Notifier for note tab tracking ---
        // Needed because isLibraryTab is false for both reader and note tabs,
        // so switching between them won't re-trigger this effect.
        if (moduleTabNotifierId) {
            try {
                Zotero.Notifier.unregisterObserver(moduleTabNotifierId);
            } catch {
                // ignore
            }
            moduleTabNotifierId = null;
        }

        const setNoteItemFromTab = async (tab: any) => {
            if (isNoteTabType(tab.type) && tab.data?.itemID) {
                const item = await Zotero.Items.getAsync(tab.data.itemID);
                if (item) {
                    await item.loadDataType('itemData');
                    logger(`useZoteroContext: note tab active, type=${tab.type}, itemID=${tab.data.itemID}`);
                    setNoteItem(item);
                    return;
                }
            }
            setNoteItem(null);
        };

        const tabObserver = {
            notify: async function (
                event: string,
                type: string,
                ids: string[] | number[],
            ) {
                if (type !== 'tab') return;

                if (event === 'select') {
                    const selectedTab = mainWindow.Zotero_Tabs._tabs.find(
                        (tab: any) => tab.id === ids[0],
                    );
                    if (!selectedTab) return;
                    await setNoteItemFromTab(selectedTab);
                } else if (event === 'load') {
                    // When an unloaded note tab finishes loading, re-check
                    // if it's the currently selected tab and update the atom.
                    const loadedTabId = ids[0];
                    if (loadedTabId !== mainWindow.Zotero_Tabs.selectedID) return;
                    const loadedTab = mainWindow.Zotero_Tabs._tabs.find(
                        (tab: any) => tab.id === loadedTabId,
                    );
                    if (!loadedTab) return;
                    await setNoteItemFromTab(loadedTab);
                }
            },
        };

        const tabObserverId = Zotero.Notifier.registerObserver(
            tabObserver,
            ['tab'],
            'beaver-zoteroContextTabObserver',
        );
        moduleTabNotifierId = tabObserverId;

        // --- Set initial state ---
        const viewInfo = readLibraryView(zp);
        if (viewInfo) setLibraryView(viewInfo);

        if (isLibraryTab) {
            const items: Zotero.Item[] = zp.getSelectedItems?.() || [];
            setSelectedItemCount(items.length);
            setSelectedItems(items.slice(0, MAX_SELECTED_ITEMS));
            setSelectedTags(readTagSelection(zp));
            setNoteItem(null);
        } else {
            setSelectedItemCount(0);
            setSelectedItems([]);
            setSelectedTags([]);
            // Check if current tab is a note tab (including unloaded/loading)
            const currentTab = mainWindow.Zotero_Tabs._tabs.find(
                (tab: any) => tab.id === mainWindow.Zotero_Tabs.selectedID,
            );
            if (currentTab && isNoteTabType(currentTab.type) && currentTab.data?.itemID) {
                Zotero.Items.getAsync(currentTab.data.itemID).then(async (item: Zotero.Item) => {
                    if (item) {
                        await item.loadDataType('itemData');
                        setNoteItem(item);
                    }
                });
            } else {
                setNoteItem(null);
            }
        }

        queryRecentlyAddedTodayCount().then(setRecentlyAddedTodayCount);
        refreshLibraryItemCount();

        // --- Cleanup ---
        return () => {
            logger('useZoteroContext: cleaning up');
            cv?.onSelect?.removeListener(handleCollectionSelect);
            iv?.onSelect?.removeListener(handleItemSelect);
            iv?.onRefresh?.removeListener(handleItemsRefresh);
            if (moduleItemNotifierId === itemObserverId) {
                Zotero.Notifier.unregisterObserver(itemObserverId);
                moduleItemNotifierId = null;
            }
            if (moduleTabNotifierId === tabObserverId) {
                Zotero.Notifier.unregisterObserver(tabObserverId);
                moduleTabNotifierId = null;
            }
        };
    }, [
        isLibraryTab,
        setSelectedItems,
        setSelectedItemCount,
        setLibraryView,
        setSelectedTags,
        setNoteItem,
        setRecentlyAddedTodayCount,
        setLibraryItemCount,
    ]);
}
