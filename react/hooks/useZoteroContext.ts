import { selectedTabIfAccepted } from '../../src/runtime/navigation';
import { countLibraryItems } from '../utils/libraryShape';
import { getContextWindow } from '../runtime/windowRuntime';
import { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import { isLibraryTabAtom, selectedZoteroTabIdAtom } from '../atoms/ui';
import { isLibraryTabType } from '../../src/ui/libraryPane';
import {
    selectedZoteroItemsAtom,
    selectedZoteroItemCountAtom,
    libraryViewAtom,
    emptyLibraryView,
    selectedTagsAtom,
    recentlyAddedTodayCountAtom,
    libraryItemCountAtom,
    SMALL_LIBRARY_THRESHOLD,
    LibraryTreeRowType,
    LibraryViewInfo,
    SelectedCollectionInfo,
    SelectedViewInfo,
} from '../atoms/zoteroContext';
import { getCollectionTreeRows, isCollectionTargetViewType } from '../../src/utils/zoteroSelection';
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

function readLibraryName(libraryId: number): string {
    try {
        const lib = Zotero.Libraries.get(libraryId);
        if (lib) return lib.name;
    } catch {
        // fallback
    }
    return 'My Library';
}

/** A collections-tree row's display name, e.g. "Unfiled Items" or a saved search's name. */
function readRowName(row: any): string {
    try {
        const name = row.getName?.();
        if (typeof name === 'string' && name) return name;
    } catch {
        // fall through
    }
    return typeof row?.ref?.name === 'string' ? row.ref.name : '';
}

/**
 * Read the collections-tree selection and return LibraryViewInfo.
 *
 * The tree supports multi-row selection, so this reports both the primary
 * (topmost) row and the whole selection — see {@link LibraryViewInfo}. Returns
 * null when nothing is selected.
 */
function readLibraryView(zp: any): LibraryViewInfo | null {
    const rows = getCollectionTreeRows(zp);
    if (rows.length === 0) return null;

    const primary = rows[0];
    const type = primary.type as LibraryTreeRowType;
    const libraryId = primary.ref?.libraryID ?? Zotero.Libraries.userLibraryID;

    const selectedCollections: SelectedCollectionInfo[] = [];
    const selectedViews: SelectedViewInfo[] = [];
    const selectedLibraryIds: number[] = [];
    for (const row of rows) {
        const rowLibraryId = row?.ref?.libraryID;
        if (typeof rowLibraryId === 'number' && !selectedLibraryIds.includes(rowLibraryId)) {
            selectedLibraryIds.push(rowLibraryId);
        }
        if (row?.type === 'collection' && row.ref?.id != null) {
            selectedCollections.push({
                collectionId: row.ref.id,
                collectionName: row.ref.name ?? '',
                libraryId: typeof rowLibraryId === 'number' ? rowLibraryId : libraryId,
            });
        } else if (isCollectionTargetViewType(row?.type) && typeof rowLibraryId === 'number') {
            selectedViews.push({
                type: row.type,
                name: readRowName(row),
                libraryId: rowLibraryId,
                ...(row.type === 'search' && typeof row.ref?.key === 'string' ? { key: row.ref.key } : {}),
            });
        }
    }

    return {
        treeRowType: type,
        libraryId,
        libraryName: readLibraryName(libraryId),
        collectionId: type === 'collection' ? (primary.ref?.id ?? null) : null,
        collectionName: type === 'collection' ? (primary.ref?.name ?? null) : null,
        searchName: type === 'search' ? (primary.ref?.name ?? null) : null,
        selectedRowCount: rows.length,
        selectedCollections,
        selectedViews,
        selectedLibraryIds,
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
    // `ZoteroPane.itemsView` / `collectionsView` belong to the active library
    // view. Zotero 11 has one per library tab and builds its trees after the
    // tab is first selected: attach again when another library tab becomes
    // active, and when the selected one finishes loading.
    const selectedTabId = useAtomValue(selectedZoteroTabIdAtom);
    const libraryTabKey = isLibraryTab ? selectedTabId : null;
    const [libraryViewRevision, setLibraryViewRevision] = useState(0);

    // A note tab may be discovered before profile exclusions and the local
    // library list finish loading. updateNoteItemAtom safely defers that first
    // validation; retry the still-active note once access becomes ready, and
    // whenever the searchable set changes in Preferences.
    useEffect(() => {
        if (!isLibraryAccessReady) return;
        const mainWindow = getContextWindow();
        const selectedTab = mainWindow?.Zotero_Tabs?._tabs?.find(
            (tab: any) => tab.id === mainWindow.Zotero_Tabs.selectedID,
        );
        if (!selectedTab || !isNoteTabType(selectedTab.type) || !selectedTab.data?.itemID) {
            return;
        }

        let cancelled = false;
        Zotero.Items.getAsync(selectedTab.data.itemID).then(async (item) => {
            if (!item || cancelled) return;
            await item.loadDataType('itemData');
            if (!cancelled && !mainWindow.closed && mainWindow.Zotero_Tabs.selectedID === selectedTab.id) setNoteItem(item);
        }).catch((error: unknown) => {
            logger(`useZoteroContext: failed to revalidate active note tab: ${error}`, 2);
        });

        return () => {
            cancelled = true;
        };
    }, [isLibraryAccessReady, searchableLibraryIdsKey, setNoteItem]);

    useEffect(() => {
        const mainWindow = getContextWindow();
        const zp = mainWindow?.ZoteroPane;
        if (!zp) {
            setSelectedItems([]);
            setSelectedItemCount(0);
            setSelectedTags([]);
            setNoteItem(null);
            setLibraryView(emptyLibraryView);
            logger('useZoteroContext: ZoteroPane not available', 2);
            return;
        }

        logger('useZoteroContext: initializing');
        let disposed = false;
        let noteGeneration = 0;

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
            const generation = ++noteGeneration;
            const isCurrent = () => !disposed && !mainWindow.closed
                && generation === noteGeneration && mainWindow.Zotero_Tabs.selectedID === tab.id;
            setNoteItem(null);
            if (isNoteTabType(tab.type) && tab.data?.itemID) {
                const item = await Zotero.Items.getAsync(tab.data.itemID);
                if (item) {
                    await item.loadDataType('itemData');
                    logger(`useZoteroContext: note tab active, type=${tab.type}, itemID=${tab.data.itemID}`);
                    if (isCurrent()) setNoteItem(item);
                    return;
                }
            }
            if (isCurrent()) setNoteItem(null);
        };

        const tabObserver = {
            notify: async function (
                event: string,
                type: string,
                ids: string[] | number[],
                extraData: any,
            ) {
                if (type !== 'tab') return;

                if (event === 'select') {
                    const selectedTab = selectedTabIfAccepted(mainWindow, ids, extraData);
                    if (!selectedTab) return;
                    await setNoteItemFromTab(selectedTab);
                } else if (event === 'load') {
                    // When an unloaded note tab finishes loading, re-check
                    // if it's the currently selected tab and update the atom.
                    const loadedTab = selectedTabIfAccepted(mainWindow, ids, extraData);
                    if (!loadedTab) return;
                    if (isLibraryTabType(loadedTab.type)) {
                        // The selected library view has built its trees.
                        if ((ids as (string | number)[]).includes(loadedTab.id)) {
                            setLibraryViewRevision((revision) => revision + 1);
                        }
                        return;
                    }
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
                void setNoteItemFromTab(currentTab);
            } else {
                setNoteItem(null);
            }
        }

        // --- Cleanup ---
        return () => {
            disposed = true;
            ++noteGeneration;
            logger('useZoteroContext: cleaning up');
            // A closed Zotero 11 library view has already torn down its trees,
            // and their event dispatchers throw on removal. A throw here would
            // unmount every hook of this renderer's context initializer.
            const detach = (remove: () => void) => {
                try { remove(); } catch { /* the view is gone */ }
            };
            detach(() => cv?.onSelect?.removeListener(handleCollectionSelect));
            detach(() => iv?.onSelect?.removeListener(handleItemSelect));
            detach(() => iv?.onRefresh?.removeListener(handleItemsRefresh));
            if (moduleTabNotifierId === tabObserverId) {
                Zotero.Notifier.unregisterObserver(tabObserverId);
                moduleTabNotifierId = null;
            }
        };
    }, [
        isLibraryTab,
        libraryTabKey,
        libraryViewRevision,
        setSelectedItems,
        setSelectedItemCount,
        setLibraryView,
        setSelectedTags,
        setNoteItem,
    ]);

    // Library-wide counts for the first-run views. They don't depend on the
    // selected tab or library view, so they stay out of the effect above,
    // which re-runs on every tab switch.
    useEffect(() => {
        if (!getContextWindow()?.ZoteroPane) return;

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
            // Every library but feeds, clamped to the threshold: first run
            // only needs to tell empty and small libraries from the rest. A
            // failed count leaves the last one in place.
            const count = await countLibraryItems(SMALL_LIBRARY_THRESHOLD);
            if (count === null) return;
            libraryItemCountLocal = count;
            setLibraryItemCount(count);
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

        queryRecentlyAddedTodayCount().then(setRecentlyAddedTodayCount);
        refreshLibraryItemCount();

        return () => {
            if (moduleItemNotifierId === itemObserverId) {
                Zotero.Notifier.unregisterObserver(itemObserverId);
                moduleItemNotifierId = null;
            }
        };
    }, [setRecentlyAddedTodayCount, setLibraryItemCount]);
}
