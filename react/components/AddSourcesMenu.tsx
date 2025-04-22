import React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { PlusSignIcon, CSSItemTypeIcon, TickIcon, Icon } from './icons';
import { ItemSearchResult, searchService } from '../../src/services/searchService';
import { getDisplayNameFromItem, isSourceValid } from '../utils/sourceUtils';
import { createSourceFromItem } from '../utils/sourceUtils';
import SearchMenu, { MenuPosition, SearchMenuItem } from './SearchMenu';
import { currentSourcesAtom } from '../atoms/input';
import { useAtom } from 'jotai';
import { InputSource } from '../types/sources';

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

    useEffect(() => {
        if (isMenuOpen) {
            const getMenuItems = async () => {
                const items = await Promise.all(sources.map(async (source) => await Zotero.Items.getByLibraryAndKeyAsync(source.libraryID, source.itemKey)));
                const menuItems = await Promise.all(
                    items
                        .filter((item): item is Zotero.Item => Boolean(item))
                        .map(async (item) => await createMenuItemFromZoteroItem(item, sources))
                );
                setMenuItems(menuItems);
            }
            getMenuItems();
        }
    }, [isMenuOpen]);

    const handleOnClose = () => {
        setSearchQuery('');
        setMenuItems([]);
        setSearchResults([]);
        onClose();
    }

    // This function is called when the user types in the search field
    const handleSearch = async (query: string) => {
        if (!query.trim()) return [];
        
        try {
            setIsLoading(true);
            
            // Search Zotero items via the API
            const results = await searchService.search(query);
            console.log(results);
            // Update the search results
            setSearchResults(results);
        } catch (error) {
            console.error('Error searching Zotero items:', error);
            return [];
        } finally {
            setIsLoading(false);
        }
    };

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
        const isValid = await isSourceValid(source);
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
                // Add source to sources atom
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
    }, []);

    useEffect(() => {
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
            setMenuItems(menuItems);
        }
        searchToMenuItems(searchResults);
    }, [searchResults, sources, createMenuItemFromZoteroItem]);

    return (
        <>
            <button
                className="variant-outline source-button"
                style={{ paddingRight: '4px', paddingLeft: '4px', paddingTop: '3px', paddingBottom: '3px' }}
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
                placeholder="Search Zotero Items"
                closeOnSelect={true}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
            />
        </>
    );
};

export default AddSourcesMenu;