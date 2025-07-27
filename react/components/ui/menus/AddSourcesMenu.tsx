import React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { PlusSignIcon, CSSItemTypeIcon, TickIcon, Icon } from '../../icons/icons';
import { ItemSearchResult, itemSearchResultFromZoteroItem, searchService } from '../../../../src/services/searchService';
import { getDisplayNameFromItem, isSourceValid } from '../../../utils/sourceUtils';
import { createSourceFromItem } from '../../../utils/sourceUtils';
import SearchMenu, { MenuPosition, SearchMenuItem } from './SearchMenu';
import { currentSourcesAtom, inputAttachmentCountAtom } from '../../../atoms/input';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { InputSource } from '../../../types/sources';
import { getPref, setPref } from '../../../../src/utils/prefs';
import { getRecentAsync } from '../../../../src/utils/zoteroUtils';
import { searchTitleCreatorYear } from '../../../utils/search';
import { logger } from '../../../../src/utils/logger';
import { planFeaturesAtom } from '../../../atoms/profile';
import { threadAttachmentCountAtom } from '../../../atoms/threads';
import { addPopupMessageAtom } from '../../../utils/popupMessageUtils';

const RECENT_ITEMS_LIMIT = 5;

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
    const [sources, setSources] = useAtom(currentSourcesAtom);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<ItemSearchResult[]>([]);
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const planFeatures = useAtomValue(planFeaturesAtom);
    const threadAttachmentCount = useAtomValue(threadAttachmentCountAtom);
    const inputAttachmentCount = useAtomValue(inputAttachmentCountAtom);
    const setPopupMessage = useSetAtom(addPopupMessageAtom);

    // Add ref for tracking the current search request
    const currentSearchRef = useRef<string>('');

    // Custom scoring function for search results
    const scoreSearchResult = useCallback((item: Zotero.Item, query: string): number => {
        const queryLower = query.toLowerCase();
        let score = 0;
        
        // Get item data
        const title = item.getField('title')?.toLowerCase() || '';
        const creators = item.getCreators();
        const year = item.getField('date') || '';
        
        // Perfect matches get highest scores
        const titleExactMatch = title === queryLower;
        const authorExactMatch = creators.some(creator => {
            const lastName = creator.lastName?.toLowerCase() || '';
            const firstName = creator.firstName?.toLowerCase() || '';
            const fullName = `${firstName} ${lastName}`.trim();
            return lastName === queryLower || firstName === queryLower || fullName === queryLower;
        });
        
        if (titleExactMatch) score += 1000;
        if (authorExactMatch) score += 900;
        
        // Starts with matches (high priority)
        const titleStartsWith = title.startsWith(queryLower);
        const authorStartsWith = creators.some(creator => {
            const lastName = creator.lastName?.toLowerCase() || '';
            const firstName = creator.firstName?.toLowerCase() || '';
            return lastName.startsWith(queryLower) || firstName.startsWith(queryLower);
        });
        
        if (titleStartsWith) score += 500;
        if (authorStartsWith) score += 600; // Author matches weighted higher
        
        // Word boundary matches (medium priority)
        const titleWordMatch = new RegExp(`\\b${queryLower}`, 'i').test(title);
        const authorWordMatch = creators.some(creator => {
            const lastName = creator.lastName || '';
            const firstName = creator.firstName || '';
            const fullName = `${firstName} ${lastName}`;
            return new RegExp(`\\b${queryLower}`, 'i').test(fullName);
        });
        
        if (titleWordMatch) score += 200;
        if (authorWordMatch) score += 300; // Author matches weighted higher
        
        // Contains matches (lower priority)
        const titleContains = title.includes(queryLower);
        const authorContains = creators.some(creator => {
            const lastName = creator.lastName?.toLowerCase() || '';
            const firstName = creator.firstName?.toLowerCase() || '';
            return lastName.includes(queryLower) || firstName.includes(queryLower);
        });
        
        if (titleContains) score += 50;
        if (authorContains) score += 100; // Author matches weighted higher
        
        // Year match bonus
        if (year.includes(queryLower)) {
            score += 150;
        }
        
        // Boost for regular items over attachments/notes
        if (item.isRegularItem()) {
            score += 10;
        }
        
        return score;
    }, []);

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
            
            logger(`AddSourcesMenu.handleSearch: Searching for ${query}`)
            
            // Search Zotero items
            const resultsItems = await searchTitleCreatorYear(query, true);
            
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

    // Set initial menu items
    useEffect(() => {
        if (isMenuOpen) {
            const getMenuItems = async () => {

                // Current sources
                const currentSourcesHeader = { label: "Current Sources", isGroupHeader: true, onClick: () => {} };
                const items = await Promise.all(
                    sources
                        .filter((s) => s.type !== "annotation")
                        .map(async (source) => await Zotero.Items.getByLibraryAndKeyAsync(source.libraryID, source.itemKey))
                    );
                const menuItemsCurrentSources = await Promise.all(
                    items
                        .filter((item): item is Zotero.Item => Boolean(item))
                        .map(async (item) => await createMenuItemFromZoteroItem(item, sources))
                );
                const menuItemsCurrentSourcesWithHeader = menuItemsCurrentSources.length > 0 ? [...menuItemsCurrentSources, currentSourcesHeader] : [];

                // Recently used items
                const recentItemsHeader = { label: "Recent Items", isGroupHeader: true, onClick: () => {} };
                const recentItems: Zotero.Item[] = await getRecentItems();
                
                // Recently modified items
                const recentlyModifiedItems = await getRecentAsync(1, { limit: RECENT_ITEMS_LIMIT*3 }) as Zotero.Item[];
                const recentlyModifiedItemsFiltered = await Promise.all(
                    recentlyModifiedItems
                        .map((item) => item.parentItem ? item.parentItem : item)
                        .filter((item) => item.isRegularItem() || item.isAttachment())
                );
                // setMenuItems(menuItemsRecentlyModified);

                // Remove duplicates from recent items and recently modified items
                const combinedItems = [...recentItems, ...recentlyModifiedItemsFiltered]
                    .filter((item, index, self) =>
                        index === self.findIndex((t) => t.id === item.id) &&
                        !sources.some((source) => source.itemKey === item.key && source.libraryID === item.libraryID)
                    )
                    .slice(0, Math.max(RECENT_ITEMS_LIMIT - menuItemsCurrentSources.length, 0));

                // Create menu items from combined items
                const menuItemsRecentItems = await Promise.all(
                    combinedItems
                        .map(async (item) => await createMenuItemFromZoteroItem(item, sources))
                );

                const menuItemsRecentItemsWithHeader = menuItemsRecentItems.length > 0 ? [...menuItemsRecentItems, recentItemsHeader] : [];

                // Set menu items
                setMenuItems([...menuItemsCurrentSourcesWithHeader,...menuItemsRecentItemsWithHeader]);
            }
            getMenuItems();
        }
    }, [isMenuOpen]);

    const handleOnClose = () => {
        setSearchQuery('');
        setMenuItems([]);
        setSearchResults([]);
        // Delay the onClose call to ensure focus happens after menu is fully closed
        setTimeout(() => {
            onClose();
        }, 5);
    }

    const handleButtonClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        
        // Get button position
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPosition({ 
                x: rect.left,
                y: rect.top - 5
            });
            onOpen();
            
            // Remove focus from the button after opening the menu
            buttonRef.current.blur();
            
            // Force any active tooltip to close by triggering a mousedown event on document
            const mainWindow = Zotero.getMainWindow();
            mainWindow.document.dispatchEvent(new MouseEvent('click'));
        }
    };

    // createMenuItemFromZoteroItem is a memoized function that creates a menu item from a Zotero item
    const createMenuItemFromZoteroItem = useCallback(async (
        item: Zotero.Item, 
        sources: InputSource[]
    ): Promise<SearchMenuItem> => {
        
        const title = item.getDisplayTitle();
        
        // Create a source from the item
        const source: InputSource = await createSourceFromItem(item, true);
        
        // Determine item status
        const {valid: isValid, error: invalidReason} = await isSourceValid(source);
        const isInSources = sources.some(
            (res) => res.libraryID === source.libraryID && res.itemKey === source.itemKey
        );

        // Handle menu item click
        const handleMenuItemClick = async (source: InputSource, isValid: boolean) => {
            if (!isValid) return;
            // Check if source already exists
            const exists = sources.some(
                (res) => res.libraryID === source.libraryID && res.itemKey === source.itemKey
            );
            
            if (!exists) {
                // Check attachment limit before adding
                const availableAttachments = planFeatures.maxUserAttachments - (inputAttachmentCount + threadAttachmentCount);
                
                if (availableAttachments <= 0) {
                    setPopupMessage({
                        type: 'warning',
                        title: 'Attachment Limit Exceeded',
                        text: `Maximum of ${planFeatures.maxUserAttachments} attachments reached. Remove some attachments to add more.`,
                        expire: true
                    });
                    return;
                }
                
                // Add source to sources atom
                updateRecentItems([{ zotero_key: source.itemKey, library_id: source.libraryID }]);
                setSources((prevSources) => [...prevSources, source]);
            } else {
                // Remove source from sources atom
                setSources((prevSources) => prevSources.filter(
                    (res) => res.libraryID !== source.libraryID || res.itemKey !== source.itemKey
                ));
            }
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
            onClick: async () => await handleMenuItemClick(source, isValid),
            // disabled: !isValid,
            customContent: (
                <div className={`display-flex flex-row gap-2 items-start min-w-0 ${!isValid ? 'opacity-70' : ''}`}>
                    {getIconElement(item)}
                    <div className="display-flex flex-col gap-2 min-w-0 font-color-secondary">
                        <div className="display-flex flex-row justify-between min-w-0">
                            <span className={`truncate ${isValid ? 'font-color-secondary' : 'font-color-red'}`}>
                                {getDisplayNameFromItem(item)}
                            </span>
                            {isInSources && <Icon icon={TickIcon} className="scale-12 ml-2" />}
                        </div>
                        <span className={`truncate text-sm ${isValid ? 'font-color-tertiary' : 'font-color-red'} min-w-0`}>
                            {title}
                        </span>
                    </div>
                </div>
            ),
        };
    }, [planFeatures, inputAttachmentCount, threadAttachmentCount, setPopupMessage]);

    // Search
    useEffect(() => {
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
                const menuItem = await createMenuItemFromZoteroItem(item, sources);
                if (menuItem) {
                    menuItems.push(menuItem);
                }
            }
            setMenuItems(menuItems.length > 0 ? [...menuItems, header] : []);
        }
        searchToMenuItems(searchResults);
    }, [searchResults, sources, createMenuItemFromZoteroItem]);

    return (
        <>
            <button
                className="variant-outline source-button"
                style={{ height: '22px !important', paddingRight: '4px', paddingLeft: '4px', paddingTop: '3px', paddingBottom: '3px' }}
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
                onSearch={handleSearch}
                noResultsText="No results found"
                placeholder="Search by author, year and title"
                closeOnSelect={true}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
            />
        </>
    );
};

export default AddSourcesMenu;