import { useEffect, useState } from 'react';
import { SearchMenuItem } from '../SearchMenu';
import { LibraryMenuItemContext, createLibraryMenuItem } from '../utils/menuItemFactories';

interface UseLibrariesMenuOptions {
    isActive: boolean;
    searchQuery: string;
    syncLibraryIds: number[];
    libraryMenuItemContext: LibraryMenuItemContext;
}

interface UseLibrariesMenuResult {
    menuItems: SearchMenuItem[];
}

export const useLibrariesMenu = ({
    isActive,
    searchQuery,
    syncLibraryIds,
    libraryMenuItemContext
}: UseLibrariesMenuOptions): UseLibrariesMenuResult => {
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);
    const [libraries, setLibraries] = useState<Zotero.Library[]>([]);

    useEffect(() => {
        if (!isActive) {
            setLibraries([]);
            setMenuItems([]);
            return;
        }

        let isCancelled = false;

        const fetchLibraries = async () => {
            const allLibraries = await Zotero.Libraries.getAll();
            const filtered = allLibraries.filter((library) => syncLibraryIds.includes(library.libraryID));
            if (!isCancelled) {
                setLibraries(filtered);
            }
        };

        fetchLibraries();

        return () => {
            isCancelled = true;
        };
    }, [isActive, syncLibraryIds]);

    useEffect(() => {
        if (!isActive) {
            return;
        }

        const lowerCaseQuery = searchQuery.toLowerCase();
        const filteredLibraries = libraries.filter((library) =>
            library.name.toLowerCase().includes(lowerCaseQuery)
        );
        const items = filteredLibraries.map((library) =>
            createLibraryMenuItem(library, libraryMenuItemContext)
        );
        const header: SearchMenuItem = { label: 'Select Library', isGroupHeader: true, onClick: () => {} };
        setMenuItems([...items.reverse(), header]);
    }, [isActive, searchQuery, libraries, libraryMenuItemContext]);

    return { menuItems };
};
