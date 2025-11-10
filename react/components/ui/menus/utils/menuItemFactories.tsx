import React from 'react';
import { Icon, TickIcon, CSSItemTypeIcon, CSSIcon } from '../../../icons/icons';
import { SearchMenuItem } from '../SearchMenu';
import { getDisplayNameFromItem, isValidZoteroItem } from '../../../../utils/sourceUtils';

/**
 * Context for creating source menu items
 */
export interface SourceMenuItemContext {
    currentMessageItems: Zotero.Item[];
    onAdd: (item: Zotero.Item) => void;
    onRemove: (item: Zotero.Item) => void;
}

/**
 * Context for creating library menu items
 */
export interface LibraryMenuItemContext {
    currentLibraryIds: number[];
    onSelect: (libraryId: number) => void;
}

/**
 * Context for creating collection menu items
 */
export interface CollectionMenuItemContext {
    currentCollectionIds: number[];
    onSelect: (collectionId: number) => void;
}

/**
 * Create a menu item from a Zotero item (for sources mode)
 */
export async function createSourceMenuItem(
    item: Zotero.Item,
    context: SourceMenuItemContext
): Promise<SearchMenuItem> {
    const { currentMessageItems, onAdd, onRemove } = context;
    
    const title = item.getDisplayTitle();
    
    // Determine item status
    const { valid: isValid } = await isValidZoteroItem(item);
    const isInCurrentMessageItems = currentMessageItems.some(
        (i) => i.id === item.id
    );

    // Handle menu item click
    const handleMenuItemClick = async () => {
        if (!isValid) return;
        
        // Check if source already exists
        const exists = currentMessageItems.some((i) => i.id === item.id);
        
        // Add or remove source
        if (!exists) {
            onAdd(item);
        } else {
            onRemove(item);
        }
    };

    // Get the icon element for the item
    const getIconElement = (item: Zotero.Item) => {
        const iconName = item.getItemTypeIconName();
        const iconElement = iconName ? (
            <span className="scale-80">
                <CSSItemTypeIcon itemType={iconName} />
            </span>
        ) : null;
        return iconElement;
    };
    
    // Create the menu item
    return {
        label: getDisplayNameFromItem(item) + " " + title,
        onClick: handleMenuItemClick,
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
}

/**
 * Create a menu item from a Zotero library (for libraries mode)
 */
export function createLibraryMenuItem(
    library: Zotero.Library,
    context: LibraryMenuItemContext
): SearchMenuItem {
    const { currentLibraryIds, onSelect } = context;
    const isSelected = currentLibraryIds.includes(library.libraryID);

    const getIconElement = (library: Zotero.Library) => {
        return (
            <span className="scale-90">
                <CSSIcon name={library.isGroup ? "library-group" : "library"} className="icon-16" />
            </span>
        );
    };
    
    return {
        label: library.name,
        onClick: () => onSelect(library.libraryID),
        customContent: (
            <div className={'display-flex flex-row gap-2 items-start min-w-0'}>
                {getIconElement(library)}
                <div className="display-flex flex-row justify-between flex-1 min-w-0 font-color-secondary">
                    <span className="truncate">
                        {library.name}
                    </span>
                    {isSelected && <Icon icon={TickIcon} className="scale-12 ml-2" />}
                </div>
            </div>
        ),
    };
}

/**
 * Create a menu item from a Zotero collection (for collections mode)
 */
export function createCollectionMenuItem(
    collection: Zotero.Collection,
    context: CollectionMenuItemContext
): SearchMenuItem {
    const { currentCollectionIds, onSelect } = context;
    const isSelected = currentCollectionIds.includes(collection.id);

    return {
        label: collection.name,
        onClick: () => onSelect(collection.id),
        customContent: (
            <div className={'display-flex flex-row gap-2 items-start min-w-0'}>
                <CSSIcon name="collection" className="icon-16 scale-90" />
                <div className="display-flex flex-row justify-between flex-1 min-w-0 font-color-secondary">
                    <span className="truncate">
                        {collection.name}
                    </span>
                    {isSelected && <Icon icon={TickIcon} className="scale-12 ml-2" />}
                </div>
            </div>
        ),
    };
}

