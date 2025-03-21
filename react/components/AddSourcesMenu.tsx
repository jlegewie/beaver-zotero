import React from 'react';
// @ts-ignore no types for react
import { useState, useCallback } from 'react';
import SearchMenuButton from './SearchMenuButton';
import { PlusSignIcon, CSSItemTypeIcon } from './icons';
import { searchService } from '../../src/services/searchService';
import { getDisplayNameFromItem, isSourceValid } from '../utils/sourceUtils';
import { createSourceFromItem } from '../utils/sourceUtils';
import { SearchMenuItem } from './SearchMenu';
import { currentSourcesAtom } from '../atoms/input';
import { useAtom } from 'jotai';
import { InputSource } from 'react/types/sources';

const AddSourcesMenu: React.FC = () => {
    const [isLoading, setIsLoading] = useState(false);
    const [sources, setSources] = useAtom(currentSourcesAtom);

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
        // Add source directly to the sources atom
        const currentSources = [...sources];
        // Check if source already exists
        const exists = currentSources.some(
            (res) => res.libraryID === source.libraryID && res.itemKey === source.itemKey
        );
        if (!exists) {
            currentSources.push(source);
            setSources(currentSources);
        }
    }

    // This function is called when the user types in the search field
    const handleSearch = async (query: string): Promise<SearchMenuItem[]> => {
        if (!query.trim()) return [];
        
        try {
            setIsLoading(true);
            
            // Search Zotero items via the API
            const results = await searchService.search(query);
            
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
                
                // Create the menu item
                menuItems.push({
                    label: getDisplayNameFromItem(item) + " " + result.title,
                    onClick: async () => await handleMenuItemClick(source, isValid),
                    // disabled: !isValid,
                    customContent: (
                        <div className={`flex flex-row gap-2 items-start min-w-0 ${!isValid ? 'opacity-70' : ''}`}>
                            {getIconElement(item)}
                            {/* <span className="truncate font-color-secondary"> */}
                            <div className="flex flex-col gap-2 min-w-0">
                                <span className={`truncate ${isValid ? 'font-color-secondary' : 'font-color-red'}`}>
                                    {getDisplayNameFromItem(item)}
                                </span>
                                <span className={`truncate text-sm ${isValid ? 'font-color-tertiary' : 'font-color-red'} min-w-0`}>
                                    {result.title}
                                </span>
                            </div>
                        </div>
                    ),
                });
            }
            return menuItems;
        } catch (error) {
            console.error('Error searching Zotero items:', error);
            return [];
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <SearchMenuButton
            variant="outline"
            className="scale-90"
            menuItems={[]} // Initial empty menu items
            onSearch={handleSearch}
            noResultsText="No results found"
            placeholder="Search Zotero Items"
            icon={PlusSignIcon}
            verticalPosition="above"
            width="250px"
        />
    );
};

export default AddSourcesMenu;