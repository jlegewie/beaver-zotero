import { useEffect, useState } from 'react';
import { SearchMenuItem } from '../SearchMenu';
import { CollectionMenuItemContext, createCollectionMenuItem } from '../utils/menuItemFactories';
import { getActiveZoteroLibraryId } from '../../../../../src/utils/zoteroUtils';

interface UseCollectionsMenuOptions {
    isActive: boolean;
    searchQuery: string;
    syncLibraryIds: number[];
    collectionMenuItemContext: CollectionMenuItemContext;
}

interface UseCollectionsMenuResult {
    menuItems: SearchMenuItem[];
}

export const useCollectionsMenu = ({
    isActive,
    searchQuery,
    syncLibraryIds,
    collectionMenuItemContext
}: UseCollectionsMenuOptions): UseCollectionsMenuResult => {
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);
    const [collections, setCollections] = useState<Zotero.Collection[]>([]);
    const [activeLibraryId, setActiveLibraryId] = useState<number | null>(null);

    useEffect(() => {
        if (!isActive) {
            setCollections([]);
            setMenuItems([]);
            setActiveLibraryId(null);
            return;
        }

        let isCancelled = false;

        const fetchCollections = async () => {
            const libraryId = getActiveZoteroLibraryId();
            setActiveLibraryId(libraryId);

            if (!libraryId || !syncLibraryIds.includes(libraryId)) {
                if (!isCancelled) {
                    setCollections([]);
                }
                return;
            }

            try {
                const collectionIds = await Zotero.Collections.getAllIDs(libraryId);
                const availableCollections = collectionIds
                    .map((id) => {
                        try {
                            return Zotero.Collections.get(id);
                        } catch {
                            return null;
                        }
                    })
                    .filter((collection): collection is Zotero.Collection => Boolean(collection))
                    .filter((collection) => !collection.deleted)
                    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

                if (!isCancelled) {
                    setCollections(availableCollections);
                }
            } catch (error) {
                console.error('Error fetching collections:', error);
                if (!isCancelled) {
                    setCollections([]);
                }
            }
        };

        fetchCollections();

        return () => {
            isCancelled = true;
        };
    }, [isActive, syncLibraryIds]);

    useEffect(() => {
        if (!isActive) {
            return;
        }

        const lowerCaseQuery = searchQuery.toLowerCase();
        const filteredCollections = collections.filter((collection) =>
            collection.name.toLowerCase().includes(lowerCaseQuery)
        );
        const items = filteredCollections.map((collection) =>
            createCollectionMenuItem(collection, collectionMenuItemContext)
        );
        let headerLabel = 'Select Collections';
        if (activeLibraryId) {
            const library = Zotero.Libraries.get(activeLibraryId);
            headerLabel = library ? `Collections in ${library.name}` : headerLabel;
        }
        const header: SearchMenuItem = { label: headerLabel, isGroupHeader: true, onClick: () => {} };
        setMenuItems([...items.reverse(), header]);
    }, [isActive, searchQuery, collections, collectionMenuItemContext, activeLibraryId]);

    return { menuItems };
};
