import { SearchMenuItem } from '@beaver/agent-ui/primitives/SearchMenu';
import { useEffect, useMemo, useState } from 'react';
import { SavedSearchMenuItemContext, createSavedSearchMenuItem } from '../utils/menuItemFactories';

interface UseSavedSearchesMenuOptions {
    isActive: boolean;
    searchQuery: string;
    /** The library whose saved searches are listed; a searchable one, or null for none. */
    libraryId: number | null;
    savedSearchMenuItemContext: SavedSearchMenuItemContext;
    verticalPosition?: 'above' | 'below';
}

interface UseSavedSearchesMenuResult {
    menuItems: SearchMenuItem[];
}

/** The saved searches of one library that are not in the trash, by name. */
export async function availableSavedSearches(libraryId: number): Promise<Zotero.Search[]> {
    const searches = await Zotero.Searches.getAll(libraryId);
    return searches.filter((search) => !search.deleted);
}

export const useSavedSearchesMenu = ({
    isActive,
    searchQuery,
    libraryId,
    savedSearchMenuItemContext,
    verticalPosition = 'above',
}: UseSavedSearchesMenuOptions): UseSavedSearchesMenuResult => {
    const [searches, setSearches] = useState<Zotero.Search[]>([]);

    useEffect(() => {
        setSearches([]);
        if (!isActive || !libraryId) return;
        let isCancelled = false;
        availableSavedSearches(libraryId)
            .then((available) => {
                if (!isCancelled) setSearches(available);
            })
            .catch((error) => {
                console.error('Error fetching saved searches:', error);
            });
        return () => {
            isCancelled = true;
        };
    }, [isActive, libraryId]);

    const menuItems = useMemo(() => {
        if (!isActive) return [];
        const lowerCaseQuery = searchQuery.toLowerCase();
        const items = searches
            .filter((search) => search.name.toLowerCase().includes(lowerCaseQuery))
            .map((search) => createSavedSearchMenuItem(search, savedSearchMenuItemContext, searchQuery));
        const library = libraryId ? Zotero.Libraries.get(libraryId) : null;
        const header: SearchMenuItem = {
            label: library ? `Saved Searches in ${library.name}` : 'Select Saved Searches',
            isGroupHeader: true,
            onClick: () => {},
        };
        // 'above' menus display the array reversed, so the header goes last there.
        return verticalPosition === 'above' ? [...items.reverse(), header] : [header, ...items];
    }, [isActive, searchQuery, searches, savedSearchMenuItemContext, libraryId, verticalPosition]);

    return { menuItems };
};
