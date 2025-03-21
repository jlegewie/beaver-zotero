import React from 'react';
// @ts-ignore no types for react
import { useState, useEffect } from 'react';
import SearchMenuButton from './SearchMenuButton';
import { PlusSignIcon, CSSItemTypeIcon, TickIcon, Icon } from './icons';
import { ItemSearchResult, searchService } from '../../src/services/searchService';
import { getDisplayNameFromItem, isSourceValid } from '../utils/sourceUtils';
import { createSourceFromItem } from '../utils/sourceUtils';
import { SearchMenuItem } from './SearchMenu';
import { currentSourcesAtom } from '../atoms/input';
import { useAtom } from 'jotai';
import { InputSource } from 'react/types/sources';


const AddSourcesMenu: React.FC<{
    showText: boolean,
    onClose: () => void,
    onOpen: () => void,
    isMenuOpen: boolean
}> = ({ showText, onClose, onOpen, isMenuOpen }) => {
    const [isLoading, setIsLoading] = useState(false);
    const [sources, setSources] = useAtom(currentSourcesAtom);
    const [searchResults, setSearchResults] = useState<ItemSearchResult[]>([]);
    const [menuItems, setMenuItems] = useState<SearchMenuItem[]>([]);

    const getIconElement = (item: Zotero.Item) => {
        const iconName = item.getItemTypeIconName();
        const iconElement = iconName ? (
            <span className="scale-80">
                <CSSItemTypeIcon itemType={iconName} />
            </span>
        ) : null
        return iconElement
    }

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

    // This function is called when the user types in the search field
    const handleSearch = async (query: string) => {
        console.log("handleSearch", query);
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

                // Create a source from the item
                const source: InputSource = await createSourceFromItem(item, true);

                // Determine item status
                const isValid = await isSourceValid(source);
                const isInSources = sources.some(
                    (res) => res.libraryID === source.libraryID && res.itemKey === source.itemKey
                );
                
                // Create the menu item
                menuItems.push({
                    label: getDisplayNameFromItem(item) + " " + result.title,
                    onClick: async () => await handleMenuItemClick(source, isValid),
                    // disabled: !isValid,
                    customContent: (
                        <div className={`flex flex-row gap-2 items-start min-w-0 ${!isValid ? 'opacity-70' : ''}`}>
                            {getIconElement(item)}
                            {/* <span className="truncate font-color-secondary"> */}
                            <div className="flex flex-col gap-2 min-w-0 font-color-secondary">
                                <div className="flex flex-row justify-between min-w-0">
                                    <span className={`truncate ${isValid ? 'font-color-secondary' : 'font-color-red'}`}>
                                        {getDisplayNameFromItem(item)}
                                    </span>
                                    {isInSources && <Icon icon={TickIcon} className="scale-12" />}
                                </div>
                                <span className={`truncate text-sm ${isValid ? 'font-color-tertiary' : 'font-color-red'} min-w-0`}>
                                    {result.title}
                                </span>
                            </div>
                        </div>
                    ),
                });
            }
            setMenuItems(menuItems);
        }
        searchToMenuItems(searchResults);
    }, [searchResults, sources]);

    return (
        <SearchMenuButton
            variant="outline"
            // className="scale-90"
            menuItems={menuItems}
            onSearch={handleSearch}
            onClose={onClose}
            onOpen={onOpen}
            noResultsText="No results found"
            placeholder="Search Zotero Items"
            icon={PlusSignIcon}
            buttonLabel={showText ? "Add Sources" : undefined}
            verticalPosition="above"
            width="250px"
            isMenuOpen={isMenuOpen}
            closeOnSelect={true}
        />
    );
};

export default AddSourcesMenu;