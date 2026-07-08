import React, { useEffect, useState } from 'react';
import { ItemSearchResult } from '../../../../../src/services/searchService';
import { getActiveZoteroLibraryId, getRecentAsync, loadFullItemData } from '../../../../../src/utils/zoteroUtils';
import { UNRESOLVED_LIBRARY_ID } from '../../../../../src/utils/libraryIdentity';
import { ArrowRightIcon, CSSIcon, FileLinkIcon, Icon } from '../../../icons/icons';
import { SearchMenuItem } from '../SearchMenu';
import { SourceMenuItemContext, createSourceMenuItem } from '../utils/menuItemFactories';

interface UseSourcesMenuOptions {
    isActive: boolean;
    searchResults: ItemSearchResult[];
    sourceMenuItemContext: SourceMenuItemContext;
    searchableLibraryIds: number[];
    activeZoteroLibraryId: number | null;
    onNavigateToLibraries: () => void;
    onNavigateToCollections: (libraryId: number) => void;
    onNavigateToTags: (libraryId: number) => void;
    onNavigateToNotes: () => void;
    /** Open a file picker to attach external files (files from disk). */
    onSelectFiles: () => void;
    getRecentItems: () => Promise<Zotero.Item[]>;
    recentItemsLimit: number;
    verticalPosition?: 'above' | 'below';
}

interface UseSourcesMenuResult {
    menuItems: SearchMenuItem[];
}

export const useSourcesMenu = ({
    isActive,
    searchResults,
    sourceMenuItemContext,
    searchableLibraryIds,
    activeZoteroLibraryId,
    onNavigateToLibraries,
    onNavigateToCollections,
    onNavigateToTags,
    onNavigateToNotes,
    onSelectFiles,
    getRecentItems,
    recentItemsLimit,
    verticalPosition = 'above'
}: UseSourcesMenuOptions): UseSourcesMenuResult => {
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);

    const getEffectiveLibraryId = (libraryId: number | null): number | null => {
        if (libraryId && searchableLibraryIds.includes(libraryId)) {
            return libraryId;
        }
        if (searchableLibraryIds.includes(1)) {
            return 1;
        }
        return null;
    };

    useEffect(() => {
        if (!isActive) {
            setMenuItems([]);
            return;
        }

        let isCancelled = false;

        const buildMenuItems = async () => {
            const recentItems = await getRecentItems();
            const recentlyModifiedItems = await getRecentAsync(1, { limit: recentItemsLimit * 3 }) as Zotero.Item[];

            const allItems = [...recentItems, ...recentlyModifiedItems]
                .filter((item): item is Zotero.Item => Boolean(item));

            await loadFullItemData(allItems);

            const activeLibraryIdRaw = activeZoteroLibraryId ?? getActiveZoteroLibraryId();
            const effectiveLibraryId = getEffectiveLibraryId(activeLibraryIdRaw);
            let collectionIds: number[] = [];

            let hasTagsInLibrary = false;

            if (effectiveLibraryId) {
                try {
                    collectionIds = await Zotero.Collections.getAllIDs(effectiveLibraryId);
                } catch {
                    collectionIds = [];
                }
                try {
                    const tags = await Zotero.Tags.getAll(effectiveLibraryId);
                    hasTagsInLibrary = Array.isArray(tags) && tags.length > 0;
                } catch {
                    hasTagsInLibrary = false;
                }
            }

            const canSelectCollections = Boolean(
                effectiveLibraryId &&
                collectionIds.some((id) => {
                    try {
                        const collection = Zotero.Collections.get(id);
                        return collection && !collection.deleted;
                    } catch {
                        return false;
                    }
                })
            );
            const canSelectTags = Boolean(
                effectiveLibraryId &&
                hasTagsInLibrary
            );

            // Action rows are self-describing ("Filter by …" / "Add …"), so
            // the group carries no header; a divider separates it from the
            // item sections below.
            const filterItems: SearchMenuItem[] = [];

            if (searchableLibraryIds.length > 1) {
                filterItems.unshift({
                    label: '"Filter by Library"',
                    onClick: async () => {
                        onNavigateToLibraries();
                    },
                    customContent: (
                        <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                            <div className="display-flex flex-row gap-2">
                                <CSSIcon name="library" className="icon-16 font-color-secondary scale-90" />
                                <div>Filter by Library</div>
                            </div>
                            <div className="flex-1" />
                            <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                        </div>
                    )
                });
            }

            filterItems.unshift({
                label: '"Filter by Collections"',
                onClick: async () => {
                    const latestLibraryIdRaw = getActiveZoteroLibraryId();
                    const latestEffectiveLibraryId = getEffectiveLibraryId(latestLibraryIdRaw);
                    if (!latestEffectiveLibraryId) {
                        return;
                    }
                    onNavigateToCollections(latestEffectiveLibraryId);
                },
                disabled: !canSelectCollections,
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-col gap-05 min-w-0">
                            <div className="display-flex flex-row gap-2">
                                <CSSIcon name="collection" className="icon-16 font-color-secondary scale-90" />
                                <div>Filter by Collections</div>
                            </div>
                        </div>
                        <div className="flex-1" />
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            });

            filterItems.unshift({
                label: '"Filter by Tags"',
                onClick: async () => {
                    const latestLibraryIdRaw = getActiveZoteroLibraryId();
                    const latestEffectiveLibraryId = getEffectiveLibraryId(latestLibraryIdRaw);
                    if (!latestEffectiveLibraryId) {
                        return;
                    }
                    onNavigateToTags(latestEffectiveLibraryId);
                },
                disabled: !canSelectTags,
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-col gap-05 min-w-0">
                            <div className="display-flex flex-row gap-2">
                                <CSSIcon
                                    name="tag"
                                    className="icon-16 font-color-secondary scale-90 icon-tag"
                                />
                                <div>Filter by Tags</div>
                            </div>
                        </div>
                        <div className="flex-1" />
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            });

            filterItems.unshift({
                label: '"Add Note"',
                onClick: async () => {
                    onNavigateToNotes();
                },
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-row gap-2">
                            <CSSIcon name="note" className="icon-16 font-color-secondary scale-90" />
                            <div>Add Note</div>
                        </div>
                        <div className="flex-1" />
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            });

            filterItems.unshift({
                label: '"Add File"',
                onClick: async () => {
                    onSelectFiles();
                },
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-row gap-2">
                            {/* <CSSIcon name="attachment-file" className="icon-16 font-color-secondary scale-90" /> */}
                            <Icon icon={FileLinkIcon} className="font-color-secondary mt-015 ml-05 scale-11" />
                            <div>Add External File…</div>
                        </div>
                        <div className="flex-1" />
                    </div>
                )
            });

            const recentlyUsedHeader: SearchMenuItem = { label: 'Recent Items', isGroupHeader: true, onClick: () => {} };

            const recentlyModifiedItemsFiltered = recentlyModifiedItems
                .map((item) => (item.parentItem ? item.parentItem : item))
                .filter((item): item is Zotero.Item => Boolean(item))
                .filter((item) => item.isRegularItem() || item.isAttachment() || item.isNote());

            // Already-attached items are excluded: the input-area chips are
            // the "what's attached" affordance, so the menu lists only
            // addable items.
            const combinedItems = [...recentItems, ...recentlyModifiedItemsFiltered]
                .filter((item, index, self) => index === self.findIndex((candidate) => candidate.id === item.id))
                .filter((item) => !sourceMenuItemContext.currentMessageItems.some((existing) => existing.id === item.id))
                .slice(0, recentItemsLimit);

            await loadFullItemData(combinedItems);

            const menuItemsRecentItems = await Promise.all(
                combinedItems.map(async (item) => await createSourceMenuItem(item, sourceMenuItemContext))
            );

            const hasItemSections = menuItemsRecentItems.length > 0;
            const groupDivider: SearchMenuItem[] = filterItems.length > 0 && hasItemSections
                ? [{ label: '', isDivider: true, onClick: () => {} }]
                : [];

            // 'above' menus display the array reversed, so the divider follows
            // the group rows here to land between the group and the item
            // sections on screen.
            const sections: SearchMenuItem[] = verticalPosition === 'above'
                ? [
                    ...(filterItems.length > 0 ? filterItems : []),
                    ...groupDivider,
                    ...(menuItemsRecentItems.length > 0 ? [...menuItemsRecentItems, recentlyUsedHeader] : [])
                ]
                : [
                    ...(filterItems.length > 0 ? [...filterItems].reverse() : []),
                    ...groupDivider,
                    ...(menuItemsRecentItems.length > 0 ? [recentlyUsedHeader, ...menuItemsRecentItems] : [])
                ];

            if (!isCancelled) {
                setMenuItems(sections);
            }
        };

        buildMenuItems();

        return () => {
            isCancelled = true;
        };
    }, [
        isActive,
        sourceMenuItemContext,
        searchableLibraryIds,
        activeZoteroLibraryId,
        onNavigateToLibraries,
        onNavigateToCollections,
        onNavigateToTags,
        onNavigateToNotes,
        onSelectFiles,
        getRecentItems,
        recentItemsLimit,
        verticalPosition
    ]);

    useEffect(() => {
        if (!isActive) {
            return;
        }

        let isCancelled = false;

        const applySearchResults = async () => {
            const searchResultsHeader: SearchMenuItem = { label: 'Search Results', isGroupHeader: true, onClick: () => {} };
            const items: SearchMenuItem[] = [];

            for (const result of searchResults) {
                // A portable library ref that couldn't be resolved on this device
                // carries library_id 0, which throws synchronously if looked up.
                if (result.library_id === UNRESOLVED_LIBRARY_ID) {
                    continue;
                }
                const item = await Zotero.Items.getByLibraryAndKeyAsync(result.library_id, result.zotero_key);
                if (!item) {
                    continue;
                }
                const menuItem = await createSourceMenuItem(item, sourceMenuItemContext);
                items.push(menuItem);
            }

            if (!isCancelled) {
                if (items.length > 0) {
                    setMenuItems(verticalPosition === 'above'
                        ? [...items, searchResultsHeader]
                        : [searchResultsHeader, ...items]
                    );
                } else {
                    setMenuItems([]);
                }
            }
        };

        applySearchResults();

        return () => {
            isCancelled = true;
        };
    }, [isActive, searchResults, sourceMenuItemContext, verticalPosition]);

    return { menuItems };
};
