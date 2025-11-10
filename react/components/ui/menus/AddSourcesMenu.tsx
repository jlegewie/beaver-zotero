import React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { PlusSignIcon, Icon, CSSIcon, ArrowRightIcon } from '../../icons/icons';
import { ItemSearchResult, itemSearchResultFromZoteroItem } from '../../../../src/services/searchService';
import SearchMenu, { MenuPosition, SearchMenuItem } from './SearchMenu';
import { currentLibraryIdsAtom, inputAttachmentCountAtom, removeItemFromMessageAtom, currentCollectionIdsAtom } from '../../../atoms/messageComposition';
import { useAtomValue, useSetAtom } from 'jotai';
import { getPref, setPref } from '../../../../src/utils/prefs';
import { getRecentAsync, loadFullItemData, getActiveZoteroLibraryId } from '../../../../src/utils/zoteroUtils';
import { searchTitleCreatorYear, scoreSearchResult } from '../../../utils/search';
import { logger } from '../../../../src/utils/logger';
import { planFeaturesAtom, syncLibraryIdsAtom } from '../../../atoms/profile';
import { threadAttachmentCountAtom } from '../../../atoms/threads';
import { addPopupMessageAtom } from '../../../utils/popupMessageUtils';
import { isAppKeyModelAtom } from '../../../atoms/models';
import { store } from '../../../store';
import { addItemToCurrentMessageItemsAtom } from '../../../atoms/messageComposition';
import { currentMessageItemsAtom } from '../../../atoms/messageComposition';
import { createSourceMenuItem, createLibraryMenuItem, createCollectionMenuItem } from './utils/menuItemFactories';

const RECENT_ITEMS_LIMIT = 5;

type MenuMode = 'sources' | 'libraries' | 'collections';

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
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);
    const [menuMode, setMenuMode] = useState<MenuMode>('sources');
    const [allLibraries, setAllLibraries] = useState<Zotero.Library[]>([]);
    const [allCollections, setAllCollections] = useState<Zotero.Collection[]>([]);
    const [activeCollectionsLibraryId, setActiveCollectionsLibraryId] = useState<number | null>(null);
    const [activeZoteroLibraryId, setActiveZoteroLibraryId] = useState<number | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const threadAttachmentCount = useAtomValue(threadAttachmentCountAtom);
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);
    const inputAttachmentCount = useAtomValue(inputAttachmentCountAtom);
    const setPopupMessage = useSetAtom(addPopupMessageAtom);
    const isAppKeyModel = useAtomValue(isAppKeyModelAtom);
    const currentLibraryIds = useAtomValue(currentLibraryIdsAtom);
    const setCurrentLibraryIds = useSetAtom(currentLibraryIdsAtom);
    const currentCollectionIds = useAtomValue(currentCollectionIdsAtom);
    const setCurrentCollectionIds = useSetAtom(currentCollectionIdsAtom);
    const addItemToCurrentMessageItems = useSetAtom(addItemToCurrentMessageItemsAtom);
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const removeItemFromMessage = useSetAtom(removeItemFromMessageAtom);

    // Add ref for tracking the current search request
    const currentSearchRef = useRef<string>('');

    useEffect(() => {
        if (!isMenuOpen) return;
        setActiveZoteroLibraryId(getActiveZoteroLibraryId());
    }, [isMenuOpen, menuMode]);

    const handleOnClose = () => {
        setSearchQuery('');
        setMenuItems([]);
        setSearchResults([]);
        setMenuMode('sources');
        // Delay the onClose call to ensure focus happens after menu is fully closed
        setTimeout(() => {
            onClose();
        }, 5);
    }

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
            const currentLibraryIds = store.get(currentLibraryIdsAtom);
            const currentCollections = store.get(currentCollectionIdsAtom);
            const searchLibraryIds = currentLibraryIds.length > 0 ? currentLibraryIds : syncLibraryIds;
            const searchCollectionIds = currentCollections.length > 0 ? currentCollections : undefined;
            logger(`AddSourcesMenu.handleSearch: Searching for '${query}' in libraries: ${searchLibraryIds.join(', ')}${searchCollectionIds ? `, collections: ${searchCollectionIds.join(', ')}` : ''}`)
            const resultsItems = await searchTitleCreatorYear(query, searchLibraryIds, searchCollectionIds);

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
    }, [scoreSearchResult]);

    // Handler functions for menu item callbacks
    const handleAddSourceItem = useCallback((item: Zotero.Item) => {
        updateRecentItems([{ zotero_key: item.key, library_id: item.libraryID }]);
        addItemToCurrentMessageItems(item);
        handleOnClose();
    }, [addItemToCurrentMessageItems]);

    const handleRemoveSourceItem = useCallback((item: Zotero.Item) => {
        removeItemFromMessage(item);
        handleOnClose();
    }, [removeItemFromMessage]);

    const handleSelectLibrary = useCallback((libraryId: number) => {
        setCurrentLibraryIds((prev) => {
            if (prev.includes(libraryId)) {
                return prev.filter((id) => id !== libraryId);
            }
            return [libraryId];
        });
        setCurrentCollectionIds([]);
        handleOnClose();
    }, [setCurrentLibraryIds, setCurrentCollectionIds]);

    const handleSelectCollection = useCallback((collectionId: number) => {
        setCurrentCollectionIds((prev) => {
            if (prev.includes(collectionId)) {
                return prev.filter((id) => id !== collectionId);
            }
            return [...prev, collectionId];
        });
        setCurrentLibraryIds([]);
        handleOnClose();
    }, [setCurrentCollectionIds, setCurrentLibraryIds]);

    // Sources mode: initial menu items
    useEffect(() => {
        if (!isMenuOpen || menuMode !== 'sources') return;

        const getMenuItems = async () => {

            const currentLibraryId = activeZoteroLibraryId ?? getActiveZoteroLibraryId();
            const collectionIds = currentLibraryId ? await Zotero.Collections.getAllIDs(currentLibraryId) : [];
            const canSelectCollections = Boolean(
                currentLibraryId && 
                syncLibraryIds.includes(currentLibraryId) &&
                collectionIds.filter(id => !Zotero.Collections.get(id)?.deleted).length > 0
            );
            
            // Filter by menu items
            const filterByHeader = { label: "Filter Search by", isGroupHeader: true, onClick: () => {} };
            const filterByMenuItems: SearchMenuItem[] = [filterByHeader];

            // Select Libraries menu (only show if multiple libraries available)
            const selectLibrariesMenuItem = {
                label: `"Select Library"`,
                onClick: async () => {
                    setSearchQuery('');
                    setMenuMode('libraries');
                },
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-row gap-2">
                            <CSSIcon name="library" className="icon-16 font-color-secondary scale-90" />
                            <div>Select Library</div>
                        </div>
                        <div className="flex-1"/>
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            };
            if (syncLibraryIds.length > 1) {
                filterByMenuItems.unshift(selectLibrariesMenuItem);
            }

            // Select Collections menu (always show, but disable when library not synced)
            const selectCollectionsMenuItem = {
                label: `"Select Collections"`,
                onClick: async () => {
                    const latestLibraryId = getActiveZoteroLibraryId();
                    setActiveZoteroLibraryId(latestLibraryId);
                    if (!latestLibraryId || !syncLibraryIds.includes(latestLibraryId)) {
                        return;
                    }
                    setSearchQuery('');
                    setMenuMode('collections');
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
                        <div className="flex-1"/>
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            };
    
            // Add select collections menu item to filter by menu items
            filterByMenuItems.unshift(selectCollectionsMenuItem);

            // 1. Get all initial items
            const currentMessageItemsFiltered = currentMessageItems.filter((i) => !i.isAnnotation());
            const recentItems: Zotero.Item[] = await getRecentItems();
            const recentlyModifiedItems = await getRecentAsync(1, { limit: RECENT_ITEMS_LIMIT * 3 }) as Zotero.Item[];

            const allItems = [...currentMessageItemsFiltered, ...recentItems, ...recentlyModifiedItems]
                .filter((item): item is Zotero.Item => Boolean(item));

            await loadFullItemData(allItems);

            // 5. Process items
            const currentItemsHeader = { label: "Current Items", isGroupHeader: true, onClick: () => {} };
            const menuItemsCurrentItems = await Promise.all(
                currentMessageItemsFiltered.map(async (item) => 
                    await createSourceMenuItem(item, {
                        currentMessageItems,
                        onAdd: handleAddSourceItem,
                        onRemove: handleRemoveSourceItem
                    })
                )
            );
            const menuItemsCurrentItemsWithHeader = menuItemsCurrentItems.length > 0 ? [...menuItemsCurrentItems, currentItemsHeader] : [];

            // Recently used items
            const recentItemsHeader = { label: "Recent Items", isGroupHeader: true, onClick: () => {} };

            // Recently modified items - process them now that data is loaded
            const recentlyModifiedItemsFiltered = recentlyModifiedItems
                .map((item) => item.parentItem ? item.parentItem : item)
                .filter((item) => item.isRegularItem() || item.isAttachment());
            
            // Remove duplicates from recent items and recently modified items
            const combinedItems = [...recentItems, ...recentlyModifiedItemsFiltered]
                .filter((item, index, self) =>
                    index === self.findIndex((t) => t.id === item.id) &&
                    !currentMessageItems.some((i) => i.id === item.id)
                )
                .slice(0, Math.max(RECENT_ITEMS_LIMIT - menuItemsCurrentItems.length, 0));
            
            // Create menu items from combined items (data already loaded)
            const menuItemsRecentItems = await Promise.all(
                combinedItems.map(async (item) => 
                    await createSourceMenuItem(item, {
                        currentMessageItems,
                        onAdd: handleAddSourceItem,
                        onRemove: handleRemoveSourceItem
                    })
                )
            );

            const menuItemsRecentItemsWithHeader = menuItemsRecentItems.length > 0
                ? [...menuItemsRecentItems, recentItemsHeader]
                : [];

            // Combine all menu items
            const allMenuItems = [
                ...(filterByMenuItems.length > 1 ? filterByMenuItems : []),
                ...menuItemsCurrentItemsWithHeader, 
                ...menuItemsRecentItemsWithHeader
            ];

            // Set menu items
            setMenuItems(allMenuItems);
        }
        getMenuItems();
    }, [isMenuOpen, menuMode, currentMessageItems, syncLibraryIds, activeZoteroLibraryId, handleAddSourceItem, handleRemoveSourceItem]);

    // Libraries mode: fetch libraries when entering this mode
    useEffect(() => {
        if (!isMenuOpen || menuMode !== 'libraries') return;
        const fetchLibraries = async () => {
            const libraries = await Zotero.Libraries.getAll();
            const librariesFiltered = libraries.filter((library) => syncLibraryIds.includes(library.libraryID));
            setAllLibraries(librariesFiltered);
        };
        fetchLibraries();
    }, [isMenuOpen, menuMode, syncLibraryIds]);

    // Collections mode: fetch collections for the currently active library
    useEffect(() => {
        if (!isMenuOpen || menuMode !== 'collections') return;
        let isCancelled = false;

        const fetchCollections = async () => {
            const libraryId = getActiveZoteroLibraryId();
            setActiveZoteroLibraryId(libraryId);
            if (!libraryId || !syncLibraryIds.includes(libraryId)) {
                setAllCollections([]);
                setActiveCollectionsLibraryId(null);
                return;
            }

            try {
                const collectionIds = await Zotero.Collections.getAllIDs(libraryId);
                const collections = collectionIds
                    .map((id) => {
                        try {
                            return Zotero.Collections.get(id);
                        } catch {
                            return null;
                        }
                    })
                    .filter((collection): collection is Zotero.Collection => Boolean(collection))
                    .filter(collection => !collection.deleted)
                    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

                if (!isCancelled) {
                    setAllCollections(collections);
                    setActiveCollectionsLibraryId(libraryId);
                }
            } catch (error) {
                console.error('Error fetching collections:', error);
                if (!isCancelled) {
                    setAllCollections([]);
                    setActiveCollectionsLibraryId(null);
                }
            }
        };

        fetchCollections();

        return () => {
            isCancelled = true;
        };
    }, [isMenuOpen, menuMode, syncLibraryIds]);

    // Libraries mode: update menu items based on libraries or search query
    useEffect(() => {
        if (!isMenuOpen || menuMode !== 'libraries') return;

        const lowerCaseQuery = searchQuery.toLowerCase();
        const filteredLibraries = allLibraries.filter(lib => 
            lib.name.toLowerCase().includes(lowerCaseQuery)
        );
        const items = filteredLibraries.map(lib => 
            createLibraryMenuItem(lib, {
                currentLibraryIds,
                onSelect: handleSelectLibrary
            })
        );
        const header = { label: "Select Library", isGroupHeader: true, onClick: () => {} };
        setMenuItems([...items.reverse(), header]);
    }, [isMenuOpen, menuMode, allLibraries, searchQuery, currentLibraryIds, handleSelectLibrary]);

    // Collections mode: update menu items when collections list or query changes
    useEffect(() => {
        if (!isMenuOpen || menuMode !== 'collections') return;

        const lowerCaseQuery = searchQuery.toLowerCase();
        const filteredCollections = allCollections.filter(collection =>
            collection.name.toLowerCase().includes(lowerCaseQuery)
        );
        const items = filteredCollections.map(collection => 
            createCollectionMenuItem(collection, {
                currentCollectionIds,
                onSelect: handleSelectCollection
            })
        );
        let headerLabel = "Select Collections";
        if (activeCollectionsLibraryId) {
            const library = Zotero.Libraries.get(activeCollectionsLibraryId);
            headerLabel = library ? `Collections in ${library.name}` : headerLabel;
        }
        const header = { label: headerLabel, isGroupHeader: true, onClick: () => {} };
        setMenuItems([...items.reverse(), header]);
    }, [isMenuOpen, menuMode, allCollections, searchQuery, currentCollectionIds, handleSelectCollection, activeCollectionsLibraryId]);

    // Search results -> menu items (sources mode only)
    useEffect(() => {
        if (menuMode !== 'sources') return;
        const header = { label: "Search Results", isGroupHeader: true, onClick: () => {} };
        const searchToMenuItems = async (results: ItemSearchResult[]) => {
            // Map the search results to menu items
            const menuItems: SearchMenuItem[] = [];
            
            for (const result of results) {
                // Get the Zotero item from the library and key
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                    result.library_id,
                    result.zotero_key
                );
                if (!item) continue;
                const menuItem = await createSourceMenuItem(item, {
                    currentMessageItems,
                    onAdd: handleAddSourceItem,
                    onRemove: handleRemoveSourceItem
                });
                if (menuItem) {
                    menuItems.push(menuItem);
                }
            }
            setMenuItems(menuItems.length > 0 ? [...menuItems, header] : []);
        }
        searchToMenuItems(searchResults);
    }, [searchResults, currentMessageItems, handleAddSourceItem, handleRemoveSourceItem, menuMode]);

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
            : "No collections found";

    const placeholderText = menuMode === 'sources'
        ? "Search by author, year and title"
        : menuMode === 'libraries'
            ? "Search libraries"
            : "Search collections";

    // Handle keyboard events - go back to sources mode on backspace/delete when search is empty
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (!isMenuOpen) return;
        
        // Check if backspace or delete key was pressed
        if (e.key === 'Backspace' || e.key === 'Delete') {
            // If in libraries or collections mode and search query is empty, go back to sources
            if ((menuMode === 'libraries' || menuMode === 'collections') && searchQuery === '') {
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
