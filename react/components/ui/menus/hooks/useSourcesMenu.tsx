import React, { useEffect, useState } from 'react';
import { ItemSearchResult } from '../../../../../src/services/searchService';
import { getActiveZoteroLibraryId, getRecentAsync, loadFullItemData } from '../../../../../src/utils/zoteroUtils';
import { ArrowRightIcon, CSSIcon, Icon } from '../../../icons/icons';
import { SearchMenuItem } from '../SearchMenu';
import { SourceMenuItemContext, createSourceMenuItem } from '../utils/menuItemFactories';

interface UseSourcesMenuOptions {
    isActive: boolean;
    searchResults: ItemSearchResult[];
    sourceMenuItemContext: SourceMenuItemContext;
    syncLibraryIds: number[];
    activeZoteroLibraryId: number | null;
    onNavigateToLibraries: () => void;
    onNavigateToCollections: (libraryId: number) => void;
    getRecentItems: () => Promise<Zotero.Item[]>;
    recentItemsLimit: number;
}

interface UseSourcesMenuResult {
    menuItems: SearchMenuItem[];
}

export const useSourcesMenu = ({
    isActive,
    searchResults,
    sourceMenuItemContext,
    syncLibraryIds,
    activeZoteroLibraryId,
    onNavigateToLibraries,
    onNavigateToCollections,
    getRecentItems,
    recentItemsLimit
}: UseSourcesMenuOptions): UseSourcesMenuResult => {
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);

    useEffect(() => {
        if (!isActive) {
            setMenuItems([]);
            return;
        }

        let isCancelled = false;

        const buildMenuItems = async () => {
            const currentMessageItemsFiltered = sourceMenuItemContext.currentMessageItems.filter((item) => !item.isAnnotation());
            const recentItems = await getRecentItems();
            const recentlyModifiedItems = await getRecentAsync(1, { limit: recentItemsLimit * 3 }) as Zotero.Item[];

            const allItems = [...currentMessageItemsFiltered, ...recentItems, ...recentlyModifiedItems]
                .filter((item): item is Zotero.Item => Boolean(item));

            await loadFullItemData(allItems);

            const currentLibraryId = activeZoteroLibraryId ?? getActiveZoteroLibraryId();
            let collectionIds: number[] = [];

            if (currentLibraryId) {
                try {
                    collectionIds = await Zotero.Collections.getAllIDs(currentLibraryId);
                } catch {
                    collectionIds = [];
                }
            }

            const canSelectCollections = Boolean(
                currentLibraryId &&
                syncLibraryIds.includes(currentLibraryId) &&
                collectionIds.some((id) => {
                    try {
                        const collection = Zotero.Collections.get(id);
                        return collection && !collection.deleted;
                    } catch {
                        return false;
                    }
                })
            );

            const filterByHeader: SearchMenuItem = { label: 'Filter Search by', isGroupHeader: true, onClick: () => {} };
            const filterItems: SearchMenuItem[] = [filterByHeader];

            if (syncLibraryIds.length > 1) {
                filterItems.unshift({
                    label: '"Select Library"',
                    onClick: async () => {
                        onNavigateToLibraries();
                    },
                    customContent: (
                        <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                            <div className="display-flex flex-row gap-2">
                                <CSSIcon name="library" className="icon-16 font-color-secondary scale-90" />
                                <div>Select Library</div>
                            </div>
                            <div className="flex-1" />
                            <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                        </div>
                    )
                });
            }

            filterItems.unshift({
                label: '"Select Collections"',
                onClick: async () => {
                    const latestLibraryId = getActiveZoteroLibraryId();
                    if (!latestLibraryId || !syncLibraryIds.includes(latestLibraryId)) {
                        return;
                    }
                    onNavigateToCollections(latestLibraryId);
                },
                disabled: !canSelectCollections,
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-col gap-05 min-w-0">
                            <div className="display-flex flex-row gap-2">
                                <CSSIcon name="collection" className="icon-16 font-color-secondary scale-90" />
                                <div>Select Collections</div>
                            </div>
                        </div>
                        <div className="flex-1" />
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            });

            const menuItemsCurrentItems = await Promise.all(
                currentMessageItemsFiltered.map(async (item) => await createSourceMenuItem(item, sourceMenuItemContext))
            );

            const recentlyUsedHeader: SearchMenuItem = { label: 'Recent Items', isGroupHeader: true, onClick: () => {} };
            const currentItemsHeader: SearchMenuItem = { label: 'Current Items', isGroupHeader: true, onClick: () => {} };

            const recentlyModifiedItemsFiltered = recentlyModifiedItems
                .map((item) => (item.parentItem ? item.parentItem : item))
                .filter((item): item is Zotero.Item => Boolean(item))
                .filter((item) => item.isRegularItem() || item.isAttachment());

            const combinedItems = [...recentItems, ...recentlyModifiedItemsFiltered]
                .filter((item, index, self) => index === self.findIndex((candidate) => candidate.id === item.id))
                .filter((item) => !sourceMenuItemContext.currentMessageItems.some((existing) => existing.id === item.id))
                .slice(0, Math.max(recentItemsLimit - menuItemsCurrentItems.length, 0));

            await loadFullItemData(combinedItems);

            const menuItemsRecentItems = await Promise.all(
                combinedItems.map(async (item) => await createSourceMenuItem(item, sourceMenuItemContext))
            );

            const sections: SearchMenuItem[] = [
                ...(filterItems.length > 1 ? filterItems : []),
                ...(menuItemsCurrentItems.length > 0 ? [...menuItemsCurrentItems, currentItemsHeader] : []),
                ...(menuItemsRecentItems.length > 0 ? [...menuItemsRecentItems, recentlyUsedHeader] : [])
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
        syncLibraryIds,
        activeZoteroLibraryId,
        onNavigateToLibraries,
        onNavigateToCollections,
        getRecentItems,
        recentItemsLimit
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
                const item = await Zotero.Items.getByLibraryAndKeyAsync(result.library_id, result.zotero_key);
                if (!item) {
                    continue;
                }
                const menuItem = await createSourceMenuItem(item, sourceMenuItemContext);
                items.push(menuItem);
            }

            if (!isCancelled) {
                setMenuItems(items.length > 0 ? [...items, searchResultsHeader] : []);
            }
        };

        applySearchResults();

        return () => {
            isCancelled = true;
        };
    }, [isActive, searchResults, sourceMenuItemContext]);

    return { menuItems };
};
