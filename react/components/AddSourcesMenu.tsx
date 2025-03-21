import React from 'react';
import SearchMenuButton from './SearchMenuButton';
import { PlusSignIcon } from './icons';

const AddSourcesMenu: React.FC = () => {

    const menuItems = [
        {
            label: 'Author 2023',
            onClick: () => {},
        },
        {
            label: 'Author 2024',
            onClick: () => {},
        },
        {
            label: 'Author 2025',
            onClick: () => {},
        },
    ];
    return (
        <SearchMenuButton
            variant="outline"
            className="scale-90"
            menuItems={menuItems}
            onSearch={() => []}
            noResultsText="No results found"
            placeholder="Search Zotero Items"
            icon={PlusSignIcon}
            verticalPosition="above"
        />
    );
};

export default AddSourcesMenu;