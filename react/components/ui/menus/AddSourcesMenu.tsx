import React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { PlusSignIcon, CSSItemTypeIcon, TickIcon, Icon, CSSIcon, ArrowRightIcon } from '../../icons/icons';
import { ItemSearchResult, itemSearchResultFromZoteroItem } from '../../../../src/services/searchService';
import { getDisplayNameFromItem, isValidZoteroItem } from '../../../utils/sourceUtils';
import SearchMenu, { MenuPosition, SearchMenuItem } from './SearchMenu';
import { currentLibraryIdsAtom, inputAttachmentCountAtom, removeItemFromMessageAtom } from '../../../atoms/messageComposition';
import { useAtomValue, useSetAtom } from 'jotai';
import { getPref, setPref } from '../../../../src/utils/prefs';
import { getRecentAsync, loadFullItemData } from '../../../../src/utils/zoteroUtils';
import { searchTitleCreatorYear, scoreSearchResult } from '../../../utils/search';
import { logger } from '../../../../src/utils/logger';
import { planFeaturesAtom, syncLibraryIdsAtom } from '../../../atoms/profile';
import { threadAttachmentCountAtom } from '../../../atoms/threads';
import { addPopupMessageAtom } from '../../../utils/popupMessageUtils';
import { isAppKeyModelAtom } from '../../../atoms/models';
import { store } from '../../../store';
import { addItemToCurrentMessageItemsAtom } from '../../../atoms/messageComposition';
import { currentMessageItemsAtom } from '../../../atoms/messageComposition';

const RECENT_ITEMS_LIMIT = 5;

type MenuMode = 'sources' | 'libraries';

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
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const threadAttachmentCount = useAtomValue(threadAttachmentCountAtom);
    const syncLibraryIds = useAtomValue(syncLibraryIdsAtom);
    const inputAttachmentCount = useAtomValue(inputAttachmentCountAtom);
    const setPopupMessage = useSetAtom(addPopupMessageAtom);
    const isAppKeyModel = useAtomValue(isAppKeyModelAtom);
    const setCurrentLibraryIds = useSetAtom(currentLibraryIdsAtom);
    const addItemToCurrentMessageItems = useSetAtom(addItemToCurrentMessageItemsAtom);
    const currentMessageItems = useAtomValue(currentMessageItemsAtom);
    const removeItemFromMessage = useSetAtom(removeItemFromMessageAtom);

    // Add ref for tracking the current search request
    const currentSearchRef = useRef<string>('');

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
            const searchLibraryIds = currentLibraryIds.length > 0 ? currentLibraryIds : syncLibraryIds;
            logger(`AddSourcesMenu.handleSearch: Searching for '${query}' in libraries: ${searchLibraryIds.join(', ')}`)
            const resultsItems = await searchTitleCreatorYear(query, searchLibraryIds);

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

    // Sources mode: initial menu items
    useEffect(() => {
        if (!isMenuOpen || menuMode !== 'sources') return;

        const getMenuItems = async () => {

            // Select Libraries menu (only show if multiple libraries available)
            const librariesHeader = { label: "Select Library", isGroupHeader: true, onClick: () => {} };
            const selectLibrariesMenuItem = {
                label: `"Select Library"`,
                onClick: async () => {
                    setSearchQuery('');
                    setMenuMode('libraries');
                },
                customContent: (
                    <div className={'display-flex flex-row flex-1 items-start font-color-secondary'}>
                        <div className="display-flex flex-row gap-2">
                            <CSSIcon name="library" className="icon-16 font-color-secondary" />
                            <div>Select Library</div>
                        </div>
                        <div className="flex-1"/>
                        <Icon icon={ArrowRightIcon} className="scale-12 mt-020" />
                    </div>
                )
            };
            const menuItemsLibraries = syncLibraryIds.length > 1 ? [selectLibrariesMenuItem, librariesHeader] : [];

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
                currentMessageItemsFiltered.map(async (item) => await createMenuItemFromZoteroItem(item))
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
                combinedItems.map(async (item) => await createMenuItemFromZoteroItem(item))
            );

            const menuItemsRecentItemsWithHeader = menuItemsRecentItems.length > 0
                ? [...menuItemsRecentItems, recentItemsHeader]
                : [];

            // Combine all menu items
            const allMenuItems = [
                ...menuItemsLibraries,
                ...menuItemsCurrentItemsWithHeader, 
                ...menuItemsRecentItemsWithHeader
            ];

            // Set menu items
            setMenuItems(allMenuItems);
        }
        getMenuItems();
    }, [isMenuOpen, menuMode, currentMessageItems, syncLibraryIds]);

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

    // Libraries mode: update menu items based on libraries or search query
    useEffect(() => {
        if (!isMenuOpen || menuMode !== 'libraries') return;

        const lowerCaseQuery = searchQuery.toLowerCase();
        const filteredLibraries = allLibraries.filter(lib => 
            lib.name.toLowerCase().includes(lowerCaseQuery)
        );
        const items = filteredLibraries.map(lib => createMenuItemFromLibrary(lib));
        const header = { label: "Select Library", isGroupHeader: true, onClick: () => {} };
        setMenuItems([...items.reverse(), header]);
    }, [isMenuOpen, menuMode, allLibraries, searchQuery]);

    // createMenuItemFromZoteroItem is a memoized function that creates a menu item from a Zotero item
    const createMenuItemFromZoteroItem = useCallback(async (
        item: Zotero.Item
    ): Promise<SearchMenuItem> => {
        
        const title = item.getDisplayTitle();
                
        // Determine item status
        const {valid: isValid} = await isValidZoteroItem(item);
        const isInCurrentMessageItems = currentMessageItems.some(
            (i) => i.id === item.id
        );

        // Handle menu item click
        const handleMenuItemClick = async (item: Zotero.Item, isValid: boolean) => {
            if (!isValid) return;
            // Check if source already exists
            const exists = currentMessageItems.some(
                (i) => i.id === item.id
            );
            
            if (!exists) {
                // Check attachment limit before adding
                const maxUserAttachments = isAppKeyModel ? planFeatures.maxUserAttachments : getPref("maxAttachments");
                const availableAttachments = maxUserAttachments - (inputAttachmentCount + threadAttachmentCount);
                
                if (availableAttachments <= 0) {
                    setPopupMessage({
                        type: 'warning',
                        title: 'Attachment Limit Exceeded',
                        text: `Maximum of ${maxUserAttachments} attachments reached. Remove attachments from the current message to add more.`,
                        expire: true
                    });
                    return;
                }
                
                // Add source to sources atom
                updateRecentItems([{ zotero_key: item.key, library_id: item.libraryID }]);
                addItemToCurrentMessageItems(item);
            } else {
                removeItemFromMessage(item);
            }
            // Close after selection in sources mode
            handleOnClose();
        }

        // Get the icon element for the item
        const getIconElement = (item: Zotero.Item) => {
            const iconName = item.getItemTypeIconName();
            const iconElement = iconName ? (
                <span className="scale-80">
                    <CSSItemTypeIcon itemType={iconName} />
                </span>
            ) : null
            return iconElement;
        }
        
        // Create the menu item
        return {
            label: getDisplayNameFromItem(item) + " " + title,
            onClick: async () => await handleMenuItemClick(item, isValid),
            customContent: (
                <div className={`display-flex flex-row gap-2 items-start min-w-0 ${!isValid ? 'opacity-70' : ''}`}>
                    {getIconElement(item)}
                    <div className="display-flex flex-col gap-2 min-w-0 font-color-secondary">
                        <div className="display-flex flex-row justify-between min-w-0">
                            <span className={`truncate ${isValid ? 'font-color-secondary' : 'font-color-red'}`}>
                                {getDisplayNameFromItem(item)}
                            </span>
                            {isInCurrentMessageItems && <Icon icon={TickIcon} className="scale-12 ml-2" />}
                        </div>
                        <span className={`truncate text-sm ${isValid ? 'font-color-tertiary' : 'font-color-red'} min-w-0`}>
                            {title}
                        </span>
                    </div>
                </div>
            ),
        };
    }, [currentMessageItems, planFeatures, inputAttachmentCount, threadAttachmentCount, setPopupMessage, isAppKeyModel, addItemToCurrentMessageItems]);

    // Create menu item for a library (libraries sub-menu)
    const createMenuItemFromLibrary = useCallback((
        library: Zotero.Library,
    ): SearchMenuItem => {

        const getIconElement = (library: Zotero.Library) => {
            return (
                <span className="scale-90">
                    <CSSIcon name={library.isGroup ? "library-group" : "library"} className="icon-16" />
                </span>
            );
        }
        
        return {
            label: library.name,
            onClick: () => {
                setCurrentLibraryIds([library.libraryID]);
                handleOnClose();
            },
            customContent: (
                <div className={'display-flex flex-row gap-2 items-start min-w-0'}>
                    {getIconElement(library)}
                    <div className="display-flex flex-col gap-2 min-w-0 font-color-secondary">
                        <div className="display-flex flex-row justify-between min-w-0">
                            <span className={'truncate font-color-secondary'}>
                                {library.name}
                            </span>
                        </div>
                    </div>
                </div>
            ),
        };
    }, [setCurrentLibraryIds]);

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
                const menuItem = await createMenuItemFromZoteroItem(item);
                if (menuItem) {
                    menuItems.push(menuItem);
                }
            }
            setMenuItems(menuItems.length > 0 ? [...menuItems, header] : []);
        }
        searchToMenuItems(searchResults);
    }, [searchResults, currentMessageItems, createMenuItemFromZoteroItem, menuMode]);

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
                noResultsText={menuMode === 'sources' ? "No results found" : "No libraries found"}
                placeholder={menuMode === 'sources' ? "Search by author, year and title" : "Search libraries"}
                closeOnSelect={false}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
            />
        </>
    );
};

export default AddSourcesMenu;