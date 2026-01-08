import React from 'react';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { PlusSignIcon, Icon } from '../../icons/icons';
import { ItemSearchResult, itemSearchResultFromZoteroItem } from '../../../../src/services/searchService';
import SearchMenu, { MenuPosition } from './SearchMenu';
import { currentMessageFiltersAtom, removeItemFromMessageAtom, addItemToCurrentMessageItemsAtom, currentMessageItemsAtom } from '../../../atoms/messageComposition';
import { useAtomValue, useSetAtom } from 'jotai';
import { getPref, setPref } from '../../../../src/utils/prefs';
import { getRecentAsync, loadFullItemData, getActiveZoteroLibraryId } from '../../../../src/utils/zoteroUtils';
import { searchTitleCreatorYear, scoreSearchResult } from '../../../utils/search';
import { logger } from '../../../../src/utils/logger';
import { syncedLibraryIdsAtom } from '../../../atoms/profile';
import { store } from '../../../store';
import { SourceMenuItemContext, LibraryMenuItemContext, CollectionMenuItemContext, TagMenuItemContext } from './utils/menuItemFactories';
import { useSourcesMenu } from './hooks/useSourcesMenu';
import { useLibrariesMenu } from './hooks/useLibrariesMenu';
import { useCollectionsMenu } from './hooks/useCollectionsMenu';
import { useTagsMenu } from './hooks/useTagsMenu';
import { ZoteroTag } from '../../../types/zotero';

const RECENT_ITEMS_LIMIT = 5;

type MenuMode = 'sources' | 'libraries' | 'collections' | 'tags';

interface RecentItem {
    zotero_key: string;
    library_id: number;
}

const updateRecentItems = async (newRecentItems: RecentItem[]) => {
    // Get recent items from preferences
    const recentItemsPref = getPref("recentItems");
    let recentItems: RecentItem[] = [];
    if (recentItemsPref) {
        const recentItemsPrefParsed = JSON.parse(recentItemsPref as string);
        if (Array.isArray(recentItemsPrefParsed)) {
            recentItems = (await Promise.all(
                recentItemsPrefParsed
                    .filter((recentItem): recentItem is RecentItem => 
                        typeof recentItem === 'object' && 
                        recentItem !== null && 
                        'zotero_key' in recentItem && 
                        'library_id' in recentItem
                    )
            ));
        }
    }
    // Combine recent items and new recent items
    const combinedItems = [...newRecentItems, ...recentItems]
        .filter((item, index, self) =>
            index === self.findIndex((t) => t.zotero_key === item.zotero_key && t.library_id === item.library_id)
        )
        .slice(0, RECENT_ITEMS_LIMIT)

    // Update recent items
    setPref('recentItems', JSON.stringify(combinedItems));
}

const getRecentItems = async (): Promise<Zotero.Item[]> => {
    const recentItemsPref = getPref("recentItems");
    let recentItems: Zotero.Item[] = [];
    if (recentItemsPref) {
        const recentItemsPrefParsed = JSON.parse(recentItemsPref as string);
        if (Array.isArray(recentItemsPrefParsed)) {
            recentItems = (await Promise.all(
                recentItemsPrefParsed
                    .filter((recentItem): recentItem is RecentItem => 
                        typeof recentItem === 'object' && 
                        recentItem !== null && 
                        'zotero_key' in recentItem && 
                        'library_id' in recentItem
                    )
                    .map(async (recentItem) => await Zotero.Items.getByLibraryAndKeyAsync(recentItem.library_id, recentItem.zotero_key))
            )).filter((item): item is Zotero.Item => Boolean(item));
        }
    }
    return recentItems;
}


const AddSourcesMenu: React.FC<{
    showText: boolean,
    onClose: () => void,
    onOpen: () => void,
    isMenuOpen: boolean,
    menuPosition: MenuPosition,
    setMenuPosition: (position: MenuPosition) => void
}> = ({ showText, onClose, onOpen, isMenuOpen, menuPosition, setMenuPosition }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<ItemSearchResult[]>([]);
    const [menuMode, setMenuMode] = useState<MenuMode>('sources');
    const [activeZoteroLibraryId, setActiveZoteroLibraryId] = useState<number | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const syncedLibraryIds = useAtomValue(syncedLibraryIdsAtom);
    const currentMessageFilters = useAtomValue(currentMessageFiltersAtom);
    const setCurrentMessageFilters = useSetAtom(currentMessageFiltersAtom);
    const { libraryIds: currentLibraryIds, collectionIds: currentCollectionIds, tagSelections: currentTagSelections } = currentMessageFilters;
    const addItemToCurrentMessageItems = useSetAtom(addItemToCurrentMessageItemsAtom);
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const removeItemFromMessage = useSetAtom(removeItemFromMessageAtom);

    // Add ref for tracking the current search request
    const currentSearchRef = useRef<string>('');

    useEffect(() => {
        if (!isMenuOpen) return;
        setActiveZoteroLibraryId(getActiveZoteroLibraryId());
    }, [isMenuOpen, menuMode]);

    const handleOnClose = useCallback(() => {
        setSearchQuery('');
        setSearchResults([]);
        setMenuMode('sources');
        // Delay the onClose call to ensure focus happens after menu is fully closed
        setTimeout(() => {
            onClose();
        }, 5);
    }, [onClose, setMenuMode, setSearchQuery, setSearchResults]);

    // Improved search function with debouncing and cancellation
    const handleSearch = useCallback(async (query: string, limit: number = 10) => {
        if (!query.trim()) return [];
        
        // Generate unique search ID for this request
        const searchId = Date.now().toString();
        currentSearchRef.current = searchId;
        
        try {
            setIsLoading(true);

            // Query formatting
            query = query.replace(/ (?:&|and) /g, " ");
            query = query.replace(/,/, ' ');
            query = query.replace(/&/, ' ');
            query = query.replace(/ ?(\d{1,4})$/, ' $1');
            query = query.trim();
            
            // Search Zotero items
            const { libraryIds, collectionIds, tagSelections } = store.get(currentMessageFiltersAtom);
            const searchLibraryIds = libraryIds.length > 0
                ? libraryIds
                : tagSelections.length > 0
                    ? Array.from(new Set(tagSelections.map((tag: ZoteroTag) => tag.libraryId)))
                    : syncedLibraryIds;
            const searchCollectionIds = collectionIds.length > 0 ? collectionIds : undefined;
            const searchTags = tagSelections.length > 0 ? tagSelections : undefined;
            logger(`AddSourcesMenu.handleSearch: Searching for '${query}' in libraries: ${searchLibraryIds.join(', ')}${searchCollectionIds ? `, collections: ${searchCollectionIds.join(', ')}` : ''}${searchTags ? `, tags: ${searchTags.map((tag: ZoteroTag) => `${tag.tag} (lib ${tag.libraryId})`).join('; ')}` : ''}`)
            const resultsItems = await searchTitleCreatorYear(query, searchLibraryIds, searchCollectionIds, searchTags);

            // Ensure item data is loaded
            await loadFullItemData(resultsItems);
            
            // Check if this search was cancelled
            if (searchId !== currentSearchRef.current) {
                return [];
            }
            
            // Score and sort results
            const scoredResults = resultsItems
                .map(item => ({
                    item,
                    score: scoreSearchResult(item, query)
                }))
                .filter(result => result.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)
                .map(result => result.item);
            
            // Final check if search was cancelled
            if (searchId !== currentSearchRef.current) {
                return [];
            }
            
            const results = scoredResults.map(itemSearchResultFromZoteroItem).filter(Boolean) as ItemSearchResult[];
            
            // Update the search results only if this is still the current search
            if (searchId === currentSearchRef.current) {
                setSearchResults(results);
            }
        } catch (error) {
            console.error('Error searching Zotero items:', error);
            return [];
        } finally {
            // Only update loading state if this is still the current search
            if (searchId === currentSearchRef.current) {
                setIsLoading(false);
            }
        }
    }, [scoreSearchResult, syncedLibraryIds]);

    const handleNavigateToLibraries = useCallback(() => {
        setSearchQuery('');
        setMenuMode('libraries');
    }, [setMenuMode, setSearchQuery]);

    const handleNavigateToCollections = useCallback((libraryId: number) => {
        setActiveZoteroLibraryId(libraryId);
        setSearchQuery('');
        setMenuMode('collections');
    }, [setActiveZoteroLibraryId, setMenuMode, setSearchQuery]);

    const handleNavigateToTags = useCallback((libraryId: number) => {
        setActiveZoteroLibraryId(libraryId);
        setSearchQuery('');
        setMenuMode('tags');
    }, [setActiveZoteroLibraryId, setMenuMode, setSearchQuery]);

    // Handler functions for menu item callbacks
    const handleAddSourceItem = useCallback((item: Zotero.Item) => {
        updateRecentItems([{ zotero_key: item.key, library_id: item.libraryID }]);
        addItemToCurrentMessageItems(item);
        handleOnClose();
    }, [addItemToCurrentMessageItems, handleOnClose]);

    const handleRemoveSourceItem = useCallback((item: Zotero.Item) => {
        removeItemFromMessage(item);
        handleOnClose();
    }, [removeItemFromMessage, handleOnClose]);

    const handleSelectLibrary = useCallback((libraryId: number) => {
        setCurrentMessageFilters((prev) => {
            const isSelected = prev.libraryIds.includes(libraryId);
            return {
                ...prev,
                libraryIds: isSelected ? prev.libraryIds.filter((id) => id !== libraryId) : [libraryId],
                collectionIds: [],
                tagSelections: []
            };
        });
        handleOnClose();
    }, [setCurrentMessageFilters, handleOnClose]);

    const handleSelectCollection = useCallback((collectionId: number) => {
        setCurrentMessageFilters((prev) => {
            const exists = prev.collectionIds.includes(collectionId);
            return {
                ...prev,
                libraryIds: [],
                collectionIds: exists
                    ? prev.collectionIds.filter((id) => id !== collectionId)
                    : [...prev.collectionIds, collectionId],
                tagSelections: []
            };
        });
        handleOnClose();
    }, [setCurrentMessageFilters, handleOnClose]);

    const handleSelectTag = useCallback((tag: ZoteroTag) => {
        setCurrentMessageFilters((prev) => {
            const exists = prev.tagSelections.some((selected) => selected.id === tag.id);
            return {
                ...prev,
                libraryIds: [],
                collectionIds: [],
                tagSelections: exists
                    ? prev.tagSelections.filter((selected) => selected.id !== tag.id)
                    : [...prev.tagSelections, tag]
            };
        });
        handleOnClose();
    }, [setCurrentMessageFilters, handleOnClose]);

    const sourceMenuItemContext = useMemo<SourceMenuItemContext>(() => ({
        currentMessageItems,
        onAdd: handleAddSourceItem,
        onRemove: handleRemoveSourceItem
    }), [currentMessageItems, handleAddSourceItem, handleRemoveSourceItem]);

    const libraryMenuItemContext = useMemo<LibraryMenuItemContext>(() => ({
        currentLibraryIds,
        onSelect: handleSelectLibrary
    }), [currentLibraryIds, handleSelectLibrary]);

    const collectionMenuItemContext = useMemo<CollectionMenuItemContext>(() => ({
        currentCollectionIds,
        onSelect: handleSelectCollection
    }), [currentCollectionIds, handleSelectCollection]);

    const tagMenuItemContext = useMemo<TagMenuItemContext>(() => ({
        currentTags: currentTagSelections,
        onSelect: handleSelectTag
    }), [currentTagSelections, handleSelectTag]);

    const sourcesMenu = useSourcesMenu({
        isActive: isMenuOpen && menuMode === 'sources',
        searchResults,
        sourceMenuItemContext,
        syncedLibraryIds,
        activeZoteroLibraryId,
        onNavigateToLibraries: handleNavigateToLibraries,
        onNavigateToCollections: handleNavigateToCollections,
        onNavigateToTags: handleNavigateToTags,
        getRecentItems,
        recentItemsLimit: RECENT_ITEMS_LIMIT
    });

    const librariesMenu = useLibrariesMenu({
        isActive: isMenuOpen && menuMode === 'libraries',
        searchQuery,
        syncedLibraryIds,
        libraryMenuItemContext
    });

    const collectionsMenu = useCollectionsMenu({
        isActive: isMenuOpen && menuMode === 'collections',
        searchQuery,
        syncedLibraryIds,
        collectionMenuItemContext
    });

    const tagsMenu = useTagsMenu({
        isActive: isMenuOpen && menuMode === 'tags',
        searchQuery,
        syncedLibraryIds,
        tagMenuItemContext
    });

    const menuItems = menuMode === 'sources'
        ? sourcesMenu.menuItems
        : menuMode === 'libraries'
            ? librariesMenu.menuItems
            : menuMode === 'collections'
                ? collectionsMenu.menuItems
                : tagsMenu.menuItems;

    const handleButtonClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        
        // Get button position
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPosition({ 
                x: rect.left,
                y: rect.top - 5
            });
            setMenuMode('sources');
            onOpen();
            
            // Remove focus from the button after opening the menu
            buttonRef.current.blur();
            
            // Force any active tooltip to close by triggering a mousedown event on document
            const mainWindow = Zotero.getMainWindow();
            mainWindow.document.dispatchEvent(new MouseEvent('click'));
        }
    };

    const noResultsText = menuMode === 'sources'
        ? "No results found"
        : menuMode === 'libraries'
            ? "No libraries found"
            : menuMode === 'collections'
                ? "No collections found"
                : "No tags found";

    const placeholderText = menuMode === 'sources'
        ? "Search by author, year and title"
        : menuMode === 'libraries'
            ? "Search libraries"
            : menuMode === 'collections'
                ? "Search collections"
                : "Search tags";

    // Handle keyboard events - go back to sources mode on backspace/delete when search is empty
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (!isMenuOpen) return;
        
        // Check if backspace or delete key was pressed
        if (e.key === 'Backspace' || e.key === 'Delete') {
            // If in libraries or collections mode and search query is empty, go back to sources
            if ((menuMode === 'libraries' || menuMode === 'collections' || menuMode === 'tags') && searchQuery === '') {
                e.preventDefault();
                setSearchQuery('');
                setMenuMode('sources');
            }
        }
    }, [isMenuOpen, menuMode, searchQuery]);

    // Add keyboard event listener
    useEffect(() => {
        if (!isMenuOpen) return;
        
        const mainWindow = Zotero.getMainWindow();
        mainWindow.addEventListener('keydown', handleKeyDown);
        return () => {
            mainWindow.removeEventListener('keydown', handleKeyDown);
        };
    }, [isMenuOpen, handleKeyDown]);

    return (
        <>
            <button
                className="variant-outline source-button"
                style={{ height: '22px', paddingRight: '4px', paddingLeft: '4px', paddingTop: '3px', paddingBottom: '3px' }}
                ref={buttonRef}
                onClick={handleButtonClick}
                aria-label="Add Sources"
                aria-haspopup="menu"
                aria-expanded={isMenuOpen}
            >
                <Icon icon={PlusSignIcon} className="scale-12" />
                {showText && <span>Add Sources</span>}
            </button>
            <SearchMenu
                menuItems={menuItems}
                isOpen={isMenuOpen}
                onClose={handleOnClose}
                position={menuPosition}
                useFixedPosition={true}
                verticalPosition="above"
                width="250px"
                onSearch={menuMode === 'sources' ? handleSearch : () => {}}
                noResultsText={noResultsText}
                placeholder={placeholderText}
                closeOnSelect={false}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
            />
        </>
    );
};

export default AddSourcesMenu;
