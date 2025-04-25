import React from 'react';
// @ts-ignore - not idea why
import { useEffect, useRef, useState, ReactNode } from 'react';
import ReactDOM from 'react-dom';
import { Icon } from './icons';

/**
* Menu item interface
*/
export interface MenuItem {
    /** Label text for the menu item */
    label: string;
    /** Callback function when item is clicked */
    onClick: () => void;
    /** Optional icon element */
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /** Whether the item is disabled */
    disabled?: boolean;
    /** 
     * Optional custom content to render instead of the default label and icon.
     * 
     * @example
     * // Example with custom content
     * const menuItems = [
     *   {
     *     label: "Custom Item", // still needed for accessibility
     *     onClick: () => console.log("Custom item clicked"),
     *     customContent: (
     *       <div className="display-flex flex-col">
     *         <span className="font-bold">Custom Title</span>
     *         <span className="text-xs">Additional description text</span>
     *       </div>
     *     )
     *   }
     * ];
     */
    customContent?: ReactNode;
    /** Whether this item is a group header */
    isGroupHeader?: boolean;
    /** Whether this item is a divider */
    isDivider?: boolean;
    /** Action buttons to display on hover (e.g., edit, delete) */
    actionButtons?: {
        /** Icon component for the button */
        icon: ReactNode;
        /** Callback function when the button is clicked */
        onClick: (e: React.MouseEvent) => void;
        /** Optional tooltip text */
        tooltip?: string;
        /** Optional className for the button */
        className?: string;
        /** Optional aria label */
        ariaLabel?: string;
    }[];
    /** Function called when editing is complete (for rename functionality) */
    onEditComplete?: (newName: string) => void;
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
    useFixedPosition?: boolean;
    /** Whether to use portal for rendering (prevents containment issues) */
    usePortal?: boolean;
    /** Optional adjustments for the menu position */
    positionAdjustment?: {
        x?: number;
        y?: number;
    };
    /** Whether to show an arrow pointing to the trigger element */
    showArrow?: boolean;
    /** Optional custom footer content to render at the bottom of the menu */
    footer?: ReactNode;
}

/**
* A reusable context menu component
*/
const ContextMenu: React.FC<ContextMenuProps> = ({ 
    menuItems, 
    isOpen, 
    onClose, 
    position,
    width = undefined,
    maxWidth = undefined,
    maxHeight = undefined,
    className = '',
    useFixedPosition = false,
    usePortal = false,
    positionAdjustment = { x: 0, y: 0 },
    showArrow = false,
    footer
}) => {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [focusedIndex, setFocusedIndex] = useState<number>(-1);
    const [hoveredIndex, setHoveredIndex] = useState<number>(-1);
    const [activeActionsIndex, setActiveActionsIndex] = useState<number>(-1);
    const [adjustedPosition, setAdjustedPosition] = useState<MenuPosition>(position);
    const [arrowPosition, setArrowPosition] = useState<string>('50%');
    const [placement, setPlacement] = useState<'top' | 'bottom' | 'left' | 'right'>('bottom');
    
    // Block scrolling when menu is open
    useEffect(() => {
        if (!isOpen) return;
        
        // Prevent scroll on all elements when context menu is open except for the menu itself
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
        let newPlacement: 'top' | 'bottom' | 'left' | 'right' = 'bottom';
        
        // Check if menu would go off the right side
        if (adjustedX + menuWidth > viewportWidth - 8) {
            adjustedX = Math.max(8, viewportWidth - menuWidth - 8);
        }
        
        // Check if menu would go off the left side
        if (adjustedX < 8) {
            adjustedX = 8;
        }
        
        // Determine vertical placement
        if (anchorY + menuHeight > viewportHeight - 8) {
            // Not enough space below, try to place it above
            if (anchorY - menuHeight > 8) {
                // There's enough space above
                adjustedY = anchorY - menuHeight;
                newPlacement = 'top';
            } else {
                // Not enough space above either, just place it at the bottom with scroll
                adjustedY = Math.max(8, viewportHeight - menuHeight - 8);
                newPlacement = 'bottom';
            }
        } else {
            // Default placement below the anchor
            adjustedY = anchorY;
            newPlacement = 'bottom';
        }
        
        // Calculate arrow position (relative to menu left edge)
        // The formula centers the arrow on the original click position
        let arrowPos;
        if (showArrow) {
            // Calculate arrow position relative to the menu's left edge
            // This centers the arrow on the original click position
            arrowPos = anchorX - adjustedX;
            
            // Make sure arrow doesn't go outside of menu bounds
            const arrowOffset = 12; // Give some margin from the edge
            if (arrowPos < arrowOffset) arrowPos = arrowOffset;
            if (arrowPos > menuWidth - arrowOffset) arrowPos = menuWidth - arrowOffset;
            
            setArrowPosition(`${arrowPos}px`);
            setPlacement(newPlacement);
        }
        
        // Only update position if it's actually different to prevent infinite loops
        if (adjustedX !== adjustedPosition.x || adjustedY !== adjustedPosition.y) {
            setAdjustedPosition({ x: adjustedX, y: adjustedY });
        }
    }, [isOpen, position, positionAdjustment, showArrow]);
    
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
                        // Skip disabled items, headers, and dividers
                        while ((menuItems[next].disabled || menuItems[next].isGroupHeader || menuItems[next].isDivider) && next !== prev) {
                            next = (next + 1) % menuItems.length;
                        }
                        return next;
                    });
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    setFocusedIndex((prev: number) => {
                        let next = (prev - 1 + menuItems.length) % menuItems.length;
                        // Skip disabled items, headers, and dividers
                        while ((menuItems[next].disabled || menuItems[next].isGroupHeader || menuItems[next].isDivider) && next !== prev) {
                            next = (next - 1 + menuItems.length) % menuItems.length;
                        }
                        return next;
                    });
                    break;
                case 'Enter':
                case ' ':
                    e.preventDefault();
                    if (focusedIndex >= 0 && !menuItems[focusedIndex].disabled && 
                        !menuItems[focusedIndex].isGroupHeader && !menuItems[focusedIndex].isDivider) {
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
            const firstEnabled = menuItems.findIndex(item => 
                !item.disabled && !item.isGroupHeader && !item.isDivider
            );
            if (firstEnabled >= 0) {
                setFocusedIndex(firstEnabled);
            }
        } else {
            setFocusedIndex(-1);
        }
        
        // Reset hovered index when menu opens/closes
        setHoveredIndex(-1);
    }, [isOpen]);
    
    if (!isOpen) return null;
    
    // The actual menu element
    const menuElement = (
        <div
            ref={menuRef}
            className={`bg-quaternary border-quinary rounded-md p-1 overflow-y-auto scrollbar outline-none z-1000 shadow-md ${className}`}
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
            {menuItems.map((item, index) => (
                <div
                    key={index}
                    role={item.isGroupHeader ? 'presentation' : 'menuitem'}
                    tabIndex={focusedIndex === index && !item.isGroupHeader ? 0 : -1}
                    className={`
                        ${item.isDivider ? 'border-t border-quinary my-1' : ''}
                        ${item.isGroupHeader ? 'px-2 py-1 font-color-tertiary text-xs font-medium mt-1 first:mt-0' : 
                          `display-flex items-center gap-2 px-2 py-15 rounded-md transition user-select-none
                          ${item.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                          ${(focusedIndex === index || hoveredIndex === index) && !item.disabled ? 'bg-quinary' : ''}`
                        }
                    `}
                    style={!item.isDivider && !item.isGroupHeader ? { maxWidth: '100%', minWidth: 0 } : undefined}
                    onClick={(e) => {
                        e.stopPropagation(); // Prevent click from reaching parent elements
                        if (!item.isGroupHeader && !item.isDivider && !item.disabled) {
                            item.onClick();
                            onClose();
                        }
                    }}
                    onMouseEnter={() => {
                        if (!item.isGroupHeader && !item.isDivider && !item.disabled) {
                            setHoveredIndex(index);
                            setFocusedIndex(index);
                            setActiveActionsIndex(index);
                        }
                    }}
                    onMouseLeave={() => {
                        if (hoveredIndex === index) {
                            setHoveredIndex(-1);
                        }
                    }}
                    onFocus={() => {
                        if (!item.isGroupHeader && !item.isDivider) {
                            setFocusedIndex(index);
                        }
                    }}
                    aria-disabled={item.disabled || item.isGroupHeader || item.isDivider}
                >
                    {item.isDivider ? null : item.isGroupHeader ? (
                        // Render group header
                        <span className="truncate">{item.label}</span>
                    ) : item.customContent ? (
                        // Render custom content if provided
                        <div className="w-full relative display-flex flex-row">
                            <div className="flex-1 overflow-hidden">
                                {item.customContent}
                            </div>
                            
                            {/* Action buttons - shown based on state */}
                            {activeActionsIndex === index && item.actionButtons && item.actionButtons.length > 0 && (
                                <div className={`display-flex items-center ml-1 gap-3 transition-opacity ${activeActionsIndex === index ? 'opacity-100' : 'opacity-0'}`}>
                                    {item.actionButtons.map((btn, btnIndex) => (
                                        <button
                                            key={btnIndex}
                                            className={`variant-thread-menu display-flex ${btn.className || ''}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                btn.onClick(e);
                                                setActiveActionsIndex(index);
                                            }}
                                            onMouseEnter={() => {
                                                setActiveActionsIndex(index);
                                            }}
                                            aria-label={btn.ariaLabel || 'Action'}
                                            title={btn.tooltip}
                                        >
                                            {btn.icon}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        // Otherwise render default icon + label layout
                        <span className="display-flex items-center gap-2 w-full min-w-0">
                            {item.icon && (
                                <Icon icon={item.icon} size={14} className="font-color-secondary flex-shrink-0"/>
                            )}
                            <span className="flex-1 text-sm font-color-secondary truncate">{item.label}</span>
                        </span>
                    )}
                </div>
            ))}
            
            {/* Custom footer section */}
            {footer && (
                <div className="mt-1">
                    {footer}
                </div>
            )}
            
            {/* Arrow pointing to the trigger element - moved here to be at the container level */}
            {showArrow && (
                <span 
                    className={`tooltip-arrow tooltip-arrow-${placement} block`}
                    style={{ 
                        left: arrowPosition, 
                        display: 'block',
                        position: 'absolute',
                        // Position the arrow based on placement
                        ...(placement === 'top' ? { bottom: '-6px' } : { top: '-6px' }),
                        zIndex: 1001 // Ensure arrow is above other content
                    }}
                />
            )}
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