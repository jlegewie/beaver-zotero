import React from 'react';
// @ts-ignore no types for react
import { useState, useCallback } from 'react';
import SearchMenuButton from './SearchMenuButton';
import { PlusSignIcon, CSSItemTypeIcon } from './icons';
import { searchService } from '../../src/services/searchService';
import { getDisplayNameFromItem } from '../utils/sourceUtils';
import { createSourceFromItem } from '../utils/sourceUtils';
import { SearchMenuItem } from './SearchMenu';

const AddSourcesMenu: React.FC = () => {
    const [isLoading, setIsLoading] = useState(false);

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
                
                // Get the icon name and create the icon element
                const iconName = item.getItemTypeIconName();
                
                menuItems.push({
                    label: getDisplayNameFromItem(item),
                    onClick: async () => {
                        // Create a source from the item and use it
                        const source = await createSourceFromItem(item);
                        // Here you would typically add this source to your state
                        console.log('Selected item:', source);
                    },
                    // icon: iconName ? (
                    //     <span className="scale-80">
                    //         <CSSItemTypeIcon itemType={iconName} />
                    //     </span>
                    // ) : undefined
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
        />
    );
};

export default AddSourcesMenu;