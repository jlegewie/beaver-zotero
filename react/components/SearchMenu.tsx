import React from 'react';
// @ts-ignore no types for react
import { useEffect, useRef, useState, ReactNode } from 'react';
import { Icon, SearchIcon } from './icons';

/**
* Menu item interface for search menu
*/
export interface SearchMenuItem {
    /** Label text for the menu item */
    label: string;
    /** Callback function when item is clicked */
    onClick: () => void;
    /** Optional icon element */
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /** Optional custom content to render instead of the default label and icon. */
    customContent?: ReactNode;
    /** Whether this item is a group header */
    isGroupHeader?: boolean;
}

/**
* Position interface for menu placement
*/
export interface MenuPosition {
    x: number;
    y: number;
}

/**
* Props for the SearchMenu component
*/
export interface SearchMenuProps {
    /** Initial array of menu items */
    menuItems: SearchMenuItem[];
    /** Controls menu visibility */
    isOpen: boolean;
    /** Search query */
    searchQuery: string;
    /** Set search query */
    setSearchQuery: (query: string) => void;
    /** Optional width for the menu */
    width?: string;
    /** Optional max width for the menu */
    maxWidth?: string;
    /** Optional max height for the menu */
    maxHeight?: string;
    /** Callback when menu should close */
    onClose: () => void;
    /** Position coordinates for menu placement */
    position: MenuPosition;
    /** Optional CSS class name */
    className?: string;
    /** Whether to use fixed positioning instead of absolute */
    verticalPosition: 'below' | 'above';
    /** Whether to use fixed positioning instead of absolute */
    useFixedPosition?: boolean;
    /** Optional adjustments for the menu position */
    positionAdjustment?: {
        x?: number;
        y?: number;
    };
    /** Search function that returns filtered menu items based on input */
    onSearch: (query: string) => void;
    /** Text to display when no results are found */
    noResultsText: string;
    /** Placeholder text for the search input */
    placeholder: string;
    /** Whether to close the menu when an item is selected */
    closeOnSelect?: boolean;
}

/**
* A search menu component with filterable items
*/
const SearchMenu: React.FC<SearchMenuProps> = ({ 
    menuItems, 
    isOpen, 
    onClose, 
    position,
    width = undefined,
    maxWidth = undefined,
    maxHeight = undefined,
    className = '',
    useFixedPosition = false,
    positionAdjustment = { x: 0, y: 0 },
    verticalPosition = 'below',
    onSearch,
    noResultsText,
    placeholder,
    closeOnSelect = true,
    searchQuery,
    setSearchQuery
}) => {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const wasOpen = useRef(false);
    const [focusedIndex, setFocusedIndex] = useState<number>(-1);
    const [hoveredIndex, setHoveredIndex] = useState<number>(-1);
    const [adjustedPosition, setAdjustedPosition] = useState<MenuPosition>(position);
    // const [menuItems, setMenuItems] = useState<SearchMenuItem[]>(initialMenuItems);
    
    // Modified reset effect
    // useEffect(() => {
    //     if (!wasOpen.current && isOpen) {
    //         setSearchQuery('');
    //         setMenuItems(initialMenuItems);
    //     }
    //     wasOpen.current = isOpen;
    // }, [isOpen, initialMenuItems]);
    
    // Block scrolling when menu is open
    useEffect(() => {
        if (!isOpen) return;
        
        // Prevent scroll on all elements when menu is open except for the menu itself
        const preventScroll = (e: Event) => {
            // Check if the event originated from within the menu
            if (menuRef.current && menuRef.current.contains(e.target as Node)) {
                // Allow scrolling within the menu
                return;
            }
            
            // Prevent scroll on elements outside the menu
            e.preventDefault();
            e.stopPropagation();
        };
        
        // Get all scrollable containers
        const messagesArea = Zotero.getMainWindow().document.getElementById('beaver-messages');
        if (messagesArea) {
            messagesArea.addEventListener('wheel', preventScroll, { passive: false });
            messagesArea.addEventListener('touchmove', preventScroll, { passive: false });
        }
        
        // Also prevent on document for safety
        Zotero.getMainWindow().document.addEventListener('wheel', preventScroll, { capture: true, passive: false });
        Zotero.getMainWindow().document.addEventListener('touchmove', preventScroll, { capture: true, passive: false });
        
        return () => {
            if (messagesArea) {
                messagesArea.removeEventListener('wheel', preventScroll);
                messagesArea.removeEventListener('touchmove', preventScroll);
            }
            Zotero.getMainWindow().document.removeEventListener('wheel', preventScroll, { capture: true });
            Zotero.getMainWindow().document.removeEventListener('touchmove', preventScroll, { capture: true });
        };
    }, [isOpen]);
    
    // Calculate adjusted position when menu opens
    useEffect(() => {
        if (!isOpen || !menuRef.current) return;
        
        // Get viewport dimensions
        const viewportWidth = Zotero.getMainWindow().innerWidth;
        const viewportHeight = Zotero.getMainWindow().innerHeight;
        
        // Get menu dimensions
        const menuRect = menuRef.current.getBoundingClientRect();
        const menuWidth = menuRect.width;
        const menuHeight = menuRect.height;
        
        // Original anchor position
        const anchorX = position.x + (positionAdjustment.x || 0);
        const anchorY = position.y + (positionAdjustment.y || 0);
        
        // Calculate adjusted position to keep menu within viewport with a margin of 8px
        let adjustedX = anchorX;
        let adjustedY = anchorY;
        
        // Check if menu would go off the right side
        if (adjustedX + menuWidth > viewportWidth - 8) {
            adjustedX = Math.max(8, viewportWidth - menuWidth - 8);
        }
        
        // Check if menu would go off the left side
        if (adjustedX < 8) {
            adjustedX = 8;
        }
        
        // Add gap to prevent menu from covering the anchor
        const gap = 8;
        
        // Vertical placement
        if (verticalPosition === 'above') {
            // Place menu above the anchor with a gap
            adjustedY = anchorY - menuHeight;
        } else {
            // Place menu below the anchor with a gap
            adjustedY = anchorY + gap;
        }
        
        // Only update position if it's actually different to prevent infinite loops
        if (adjustedX !== adjustedPosition.x || adjustedY !== adjustedPosition.y) {
            setAdjustedPosition({ x: adjustedX, y: adjustedY });
        }
    }, [isOpen, position, positionAdjustment, verticalPosition]);
    
    // Handle outside clicks
    useEffect(() => {
        if (!isOpen) return;
        
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        
        Zotero.getMainWindow().document.addEventListener('mousedown', handleClickOutside);
        Zotero.getMainWindow().document.addEventListener('keydown', handleEscape);
        
        return () => {
            Zotero.getMainWindow().document.removeEventListener('mousedown', handleClickOutside);
            Zotero.getMainWindow().document.removeEventListener('keydown', handleEscape);
        };
    }, [isOpen, onClose]);
    
    // Handle keyboard navigation
    useEffect(() => {
        if (!isOpen || menuItems.length === 0) return;
        
        // Compute display order items based on verticalPosition inside the effect
        const displayOrderMenuItems = verticalPosition === 'above' 
            ? [...menuItems].reverse() 
            : menuItems;
        
        const handleKeyNav = (e: KeyboardEvent) => {
            // Only handle navigation keys if not coming from the input field
            if (e.target === inputRef.current) {
                // For input field, only handle arrow keys and enter
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
                    e.preventDefault();
                } else {
                    // Let other keystrokes pass to input for typing
                    return;
                }
            }
            
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    setFocusedIndex((prev: number) => {
                        let next = (prev + 1) % displayOrderMenuItems.length;
                        // Skip group headers
                        while (displayOrderMenuItems[next].isGroupHeader && next !== prev) {
                            next = (next + 1) % displayOrderMenuItems.length;
                        }
                        return next;
                    });
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    setFocusedIndex((prev: number) => {
                        let next = (prev - 1 + displayOrderMenuItems.length) % displayOrderMenuItems.length;
                        // Skip group headers
                        while (displayOrderMenuItems[next].isGroupHeader && next !== prev) {
                            next = (next - 1 + displayOrderMenuItems.length) % displayOrderMenuItems.length;
                        }
                        return next;
                    });
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (focusedIndex >= 0 && 
                        focusedIndex < displayOrderMenuItems.length && 
                        !displayOrderMenuItems[focusedIndex].isGroupHeader) {
                        displayOrderMenuItems[focusedIndex].onClick();
                        if(closeOnSelect) onClose();
                    }
                    break;
                default:
                    break;
            }
        };
        
        Zotero.getMainWindow().document.addEventListener('keydown', handleKeyNav);
        return () => Zotero.getMainWindow().document.removeEventListener('keydown', handleKeyNav);
    }, [isOpen, menuItems, focusedIndex, onClose, closeOnSelect, verticalPosition]);
    
    // Set initial focus
    useEffect(() => {
        if (isOpen) {
            // Focus the input
            inputRef.current?.focus();

            // If we have items, highlight first or last depending on direction
            if (menuItems.length > 0) {
                let initialIndex = -1;
                
                if (verticalPosition === 'above') {
                    // Start from the bottom (last in normal order)
                    initialIndex = menuItems.length - 1;
                    // Skip any group headers
                    while (initialIndex >= 0 && menuItems[initialIndex].isGroupHeader) {
                        initialIndex--;
                    }
                } else {
                    // Start from the top (first in normal order)
                    initialIndex = 0;
                    // Skip any group headers
                    while (initialIndex < menuItems.length && menuItems[initialIndex].isGroupHeader) {
                        initialIndex++;
                    }
                }
                
                setFocusedIndex(initialIndex >= 0 ? initialIndex : -1);
            } else {
                setFocusedIndex(-1);
            }
        } else {
            setFocusedIndex(-1);
            setHoveredIndex(-1);
        }
    }, [isOpen, menuItems, verticalPosition]);
    
    // Modified search input handler
    const handleSearchInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const query = e.target.value;
        setSearchQuery(query);
        
        try {
            if (query.trim()) await onSearch(query);
        } catch (error) {
            console.error('Error during search:', error);
        }
    };
    
    if (!isOpen) return null;
    
    // Compute display order items based on verticalPosition for rendering
    const displayOrderMenuItems = verticalPosition === 'above' 
        ? [...menuItems].reverse() 
        : menuItems;

    // Helper function to render menu item
    const renderMenuItem = (item: SearchMenuItem, index: number) => {
        if (item.isGroupHeader) {
            // Render group header
            return (
                <div
                    key={index}
                    role="presentation"
                    className="px-2 py-1 font-color-tertiary text-sm font-semibold mt-1 first:mt-0"
                >
                    <span className="truncate">{item.label}</span>
                </div>
            );
        }
        
        // Regular menu item
        return (
            <div
                key={index}
                role="menuitem"
                tabIndex={focusedIndex === index ? 0 : -1}
                className={`
                    display-flex items-center gap-2 px-2 py-15 transition user-select-none cursor-pointer
                    ${(focusedIndex === index || hoveredIndex === index) ? 'bg-quinary' : ''}
                `}
                style={{ maxWidth: '100%', minWidth: 0 }}
                onClick={(e) => {
                    e.stopPropagation();
                    item.onClick();
                    if(closeOnSelect) onClose();
                }}
                onMouseEnter={() => {
                    if (!item.isGroupHeader) {
                        setHoveredIndex(index);
                        setFocusedIndex(index);
                    }
                }}
                onMouseLeave={() => {
                    if (hoveredIndex === index) {
                        setHoveredIndex(-1);
                    }
                }}
                onFocus={() => {
                    if (!item.isGroupHeader) {
                        setFocusedIndex(index);
                    }
                }}
            >
                {item.customContent ? (
                    item.customContent
                ) : (
                    <span className="display-flex items-center gap-2 w-full min-w-0">
                        {item.icon && (
                            <Icon icon={item.icon} size={14} className="font-color-secondary flex-shrink-0"/>
                        )}
                        <span className="flex-1 text-sm font-color-secondary truncate">{item.label}</span>
                    </span>
                )}
            </div>
        );
    };

    const textInput = (
        // <div className="display-flex flex-row items-center gap-2">
        //     <Icon icon={SearchIcon} size={14} className="font-color-secondary flex-shrink-0"/>
        //     {textInput}
        // </div>
        <div className="display-flex flex-row items-center gap-05 p-1 mt-1 border-top-quinary">
            <Icon icon={SearchIcon} size={14} className="font-color-tertiary flex-shrink-0"/>
            <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={handleSearchInput}
                placeholder={placeholder}
                className="w-full bg-quaternary font-color-primary outline-none chat-input"
                aria-label="Search"
            />
        </div>
    )

    return (
        <div
            ref={menuRef}
            className={`bg-quaternary border-popup rounded-md outline-none z-1000 shadow-md display-flex flex-col ${className}`}
            style={{
                position: useFixedPosition ? 'fixed' : 'absolute',
                top: adjustedPosition.y,
                left: adjustedPosition.x,
                maxWidth: maxWidth || undefined,
                width: width || undefined,
                maxHeight: maxHeight || '80vh'
            }}
            tabIndex={-1}
            role="menu"
            aria-orientation="vertical"
            onClick={(e) => e.stopPropagation()} // Prevent clicks from propagating
        >
            {/* Render menu items and search input based on vertical position */}
            {verticalPosition === 'above' ? (
                <>
                    {/* Menu items take remaining space and scroll */}
                    <div className="overflow-y-auto overflow-x-hidden scrollbar flex-1">
                        {displayOrderMenuItems.length > 0 ? (
                            displayOrderMenuItems.map((item, index) => renderMenuItem(item, index))
                        ) : (
                            <div className="px-2 p-1 py-2 text-sm font-color-tertiary text-center">
                                {searchQuery.trim() ? "No results found" : "Start typing to search"}
                            </div>
                        )}
                    </div>
                    
                    {/* Search input at the bottom, ensure it doesn't shrink */}
                    <div className="flex-shrink-0"> 
                        {textInput}
                    </div>
                </>
            ) : (
                <>
                    {/* Search input at the top, ensure it doesn't shrink */}
                    <div className="flex-shrink-0">
                        {textInput}
                    </div>
                    
                    {/* Menu items take remaining space and scroll */}
                    <div className="overflow-y-auto overflow-x-hidden scrollbar flex-1">
                        {displayOrderMenuItems.length > 0 ? (
                            displayOrderMenuItems.map((item, index) => renderMenuItem(item, index))
                        ) : (
                            <div className="px-2 py-1 text-sm font-color-tertiary text-center">
                                {noResultsText}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

export default SearchMenu; 