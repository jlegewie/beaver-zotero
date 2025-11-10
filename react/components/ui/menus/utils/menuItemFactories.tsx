import React from 'react';
import { Icon, TickIcon, CSSItemTypeIcon, CSSIcon } from '../../../icons/icons';
import { SearchMenuItem } from '../SearchMenu';
import { getDisplayNameFromItem, isValidZoteroItem } from '../../../../utils/sourceUtils';
import { ZoteroTag } from '../../../../types/zotero';

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
 * Context for creating tag menu items
 */
export interface TagMenuItemContext {
    currentTags: ZoteroTag[];
    onSelect: (tag: ZoteroTag) => void;
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

/**
 * Create a menu item from a Zotero tag (for tags mode)
 */
export function createTagMenuItem(
    tag: ZoteroTag,
    context: TagMenuItemContext
): SearchMenuItem {
    const { currentTags, onSelect } = context;
    const isSelected = currentTags.some((selected) => selected.id === tag.id);

    // Render colored dot if tag has a color, otherwise use tag icon
    const tagIndicator = tag.color ? (
        <span
            className="tag-color-dot mt-15"
            style={{
                display: 'inline-block',
                width: '0.72em',
                height: '0.72em',
                marginRight: '0.27em',
                borderRadius: '50%',
                backgroundColor: tag.color,
                verticalAlign: '-0.36em',
                flexShrink: 0,
            }}
        />
    ) : (
        // <CSSIcon name="tag" className="icon-16 scale-90" />
        null
    );

    return {
        label: tag.name,
        onClick: () => onSelect(tag),
        customContent: (
            <div className={'display-flex flex-row gap-05 items-start min-w-0'}>
                {tagIndicator}
                <div className={`display-flex flex-row justify-between flex-1 min-w-0 font-color-secondary ${tag.type === 0 ? 'font-semibold' : ''}`}>
                    <span className="truncate">
                        {tag.name}
                    </span>
                    {isSelected && <Icon icon={TickIcon} className="scale-12 ml-2" />}
                </div>
            </div>
        ),
    };
}
