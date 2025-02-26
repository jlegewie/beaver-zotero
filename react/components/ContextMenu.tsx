import React from 'react';
// @ts-ignore - not idea why
import { useEffect, useRef, useState, ReactNode } from 'react';
import ReactDOM from 'react-dom';

/**
* Menu item interface
*/
export interface MenuItem {
    /** Label text for the menu item */
    label: string;
    /** Callback function when item is clicked */
    onClick: () => void;
    /** Optional icon element */
    icon?: ReactNode;
    /** Whether the item is disabled */
    disabled?: boolean;
}

/**
* Position interface for menu placement
*/
export interface MenuPosition {
    x: number;
    y: number;
}

/**
* Props for the ContextMenu component
*/
export interface ContextMenuProps {
    /** Array of menu items */
    menuItems: MenuItem[];
    /** Controls menu visibility */
    isOpen: boolean;
    /** Callback when menu should close */
    onClose: () => void;
    /** Position coordinates for menu placement */
    position: MenuPosition;
    /** Optional CSS class name */
    className?: string;
    /** Whether to use fixed positioning instead of absolute */
    useFixedPosition?: boolean;
    /** Whether to use portal for rendering (prevents containment issues) */
    usePortal?: boolean;
    /** Optional adjustments for the menu position */
    positionAdjustment?: {
        x?: number;
        y?: number;
    };
}

/**
* A reusable context menu component
*/
const ContextMenu: React.FC<ContextMenuProps> = ({ 
    menuItems, 
    isOpen, 
    onClose, 
    position,
    className = '',
    useFixedPosition = false,
    usePortal = false,
    positionAdjustment = { x: 0, y: 0 }
}) => {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [focusedIndex, setFocusedIndex] = useState<number>(-1);
    const [adjustedPosition, setAdjustedPosition] = useState<MenuPosition>(position);
    
    // Block scrolling when menu is open
    useEffect(() => {
        if (!isOpen) return;
        
        // Prevent scroll on all elements when context menu is open
        const preventScroll = (e: Event) => {
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
        
        // Calculate adjusted position to keep menu within viewport
        let adjustedX = position.x + (positionAdjustment.x || 0);
        let adjustedY = position.y + (positionAdjustment.y || 0);
        
        // Check if menu would go off the right side
        if (adjustedX + menuWidth > viewportWidth) {
            adjustedX = Math.max(0, viewportWidth - menuWidth);
        }
        
        // Check if menu would go off the bottom
        if (adjustedY + menuHeight > viewportHeight) {
            adjustedY = Math.max(0, viewportHeight - menuHeight);
        }
        
        // Only update position if it's actually different to prevent infinite loops
        if (adjustedX !== adjustedPosition.x || adjustedY !== adjustedPosition.y) {
            setAdjustedPosition({ x: adjustedX, y: adjustedY });
        }
    }, [isOpen, position, positionAdjustment, adjustedPosition]);
    
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
        
        const handleKeyNav = (e: KeyboardEvent) => {
            switch (e.key) {
                case 'ArrowDown':
                e.preventDefault();
                setFocusedIndex((prev: number) => {
                    let next = (prev + 1) % menuItems.length;
                    // Skip disabled items
                    while (menuItems[next].disabled && next !== prev) {
                        next = (next + 1) % menuItems.length;
                    }
                    return next;
                });
                break;
                case 'ArrowUp':
                e.preventDefault();
                setFocusedIndex((prev: number) => {
                    let next = (prev - 1 + menuItems.length) % menuItems.length;
                    // Skip disabled items
                    while (menuItems[next].disabled && next !== prev) {
                        next = (next - 1 + menuItems.length) % menuItems.length;
                    }
                    return next;
                });
                break;
                case 'Enter':
                case ' ':
                e.preventDefault();
                if (focusedIndex >= 0 && !menuItems[focusedIndex].disabled) {
                    menuItems[focusedIndex].onClick();
                    onClose();
                }
                break;
                default:
                break;
            }
        };
        
        Zotero.getMainWindow().document.addEventListener('keydown', handleKeyNav);
        return () => Zotero.getMainWindow().document.removeEventListener('keydown', handleKeyNav);
    }, [isOpen, menuItems, focusedIndex, onClose]);
    
    // Set initial focus
    useEffect(() => {
        if (isOpen && menuRef.current) {
            menuRef.current.focus();
            const firstEnabled = menuItems.findIndex(item => !item.disabled);
            if (firstEnabled >= 0) {
                setFocusedIndex(firstEnabled);
            }
        } else {
            setFocusedIndex(-1);
        }
    }, [isOpen, menuItems]);
    
    if (!isOpen) return null;
    
    // The actual menu element
    const menuElement = (
        <div
            ref={menuRef}
            className={`bg-quaternary rounded-md p-1 overflow-y-auto z-1000 shadow-md ${className}`}
            style={{
                position: useFixedPosition ? 'fixed' : 'absolute',
                top: adjustedPosition.y,
                left: adjustedPosition.x,
                maxHeight: '80vh',
                border: '1px solid var(--fill-quinary)'
            }}
            tabIndex={-1}
            role="menu"
            aria-orientation="vertical"
            onClick={(e) => e.stopPropagation()} // Prevent clicks from propagating
        >
            {menuItems.map((item, index) => (
                <div
                    key={index}
                    role="menuitem"
                    tabIndex={focusedIndex === index ? 0 : -1}
                    className={`flex items-center gap-2 px-3 py-2 rounded-md transition user-select-none ${
                        item.disabled 
                        ? 'opacity-50 cursor-not-allowed'
                        : 'cursor-pointer hover:bg-quarternary'
                    } ${
                        focusedIndex === index ? 'bg-quarternary' : ''
                    }`}
                    onClick={(e) => {
                        e.stopPropagation(); // Prevent click from reaching parent elements
                        if (!item.disabled) {
                            item.onClick();
                            onClose();
                        }
                    }}
                    onFocus={() => setFocusedIndex(index)}
                    aria-disabled={item.disabled}
                >
                    {item.icon && (
                        <span className="flex-none flex items-center">{item.icon}</span>
                    )}
                    <span className="flex-1 text-sm font-color-secondary">{item.label}</span>
                </div>
            ))}
        </div>
    );
    
    // Handle portal rendering if requested
    if (usePortal) {
        // Using React Portal to render outside the current DOM hierarchy
        return ReactDOM.createPortal(
            menuElement,
            Zotero.getMainWindow().document.body
        );
    }
    
    return menuElement;
};

export default ContextMenu;