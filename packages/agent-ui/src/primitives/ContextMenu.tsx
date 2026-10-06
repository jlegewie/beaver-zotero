import { useCallback, useEffect, useLayoutEffect, useRef, useState, ReactNode } from 'react';
import React from 'react';
import ReactDOM from 'react-dom';
import Icon from '../icons/Icon';
import ArrowRightIcon from '../icons/ArrowRightIcon';
import { getWindowFromElement, getDocumentFromElement } from '../utils/windowContext';

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
    /** Keyboard shortcut shown after the label (e.g. `⌘F`); display only. */
    shortcut?: string;
    /**
     * The same shortcut for assistive technology, in `aria-keyshortcuts`
     * syntax (`Meta+F`, `Control+F`). Kept apart from `shortcut`, whose
     * display glyphs are not valid there.
     */
    ariaKeyShortcuts?: string;
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
    /** Optional menu item role override for selectable menu items */
    role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
    /** Checked state for radio or checkbox menu items */
    ariaChecked?: boolean;
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
    /**
     * Items of a submenu that opens beside this item (on hover, click, Enter
     * or ArrowRight). The item's own `onClick` is not called; choosing a
     * submenu item closes the whole menu.
     */
    submenu?: MenuItem[];
}

/** How long the pointer may cross other items on its way into an open submenu. */
const SUBMENU_CLOSE_DELAY_MS = 250;

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
/** Footer content, or a renderer given the menu's `close` for its own controls. */
export type MenuFooter = ReactNode | ((controls: { close: () => void }) => ReactNode);

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
    /** Optional callback to execute after the menu closes */
    onAfterClose?: () => void;
    /** Position coordinates for menu placement */
    position: MenuPosition;
    /** Optional CSS class name */
    className?: string;
    /** Optional class names for default menu item labels (icon + text rows) */
    itemLabelClassName?: string;
    /** Optional class names for default menu item icons */
    itemIconClassName?: string;
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
    /** Optional custom header content to render at the top of the menu */
    header?: ReactNode;
    /**
     * Optional custom footer content to render at the bottom of the menu. A
     * function form receives `close`, for a footer control that should dismiss
     * the menu when activated: a click inside the menu never reaches the
     * outside-click handler, so nothing else would close it.
     */
    footer?: MenuFooter;
}

/**
 * Scrolls a focused menu item into the visible area of its menu container.
 */
const scrollItemIntoMenuView = (
    menuElement: HTMLDivElement,
    itemElement: HTMLDivElement,
) => {
    const menuRect = menuElement.getBoundingClientRect();
    const itemRect = itemElement.getBoundingClientRect();

    if (itemRect.top < menuRect.top) {
        menuElement.scrollTop -= menuRect.top - itemRect.top;
    } else if (itemRect.bottom > menuRect.bottom) {
        menuElement.scrollTop += itemRect.bottom - menuRect.bottom;
    }
};

/**
* A reusable context menu component
*/
const ContextMenu: React.FC<ContextMenuProps> = ({ 
    menuItems, 
    isOpen, 
    onClose, 
    onAfterClose,
    position,
    width = undefined,
    maxWidth = undefined,
    maxHeight = undefined,
    className = '',
    itemLabelClassName = 'flex-1 text-base font-color-secondary truncate',
    itemIconClassName = 'font-color-secondary flex-shrink-0',
    useFixedPosition = false,
    usePortal = false,
    positionAdjustment = { x: 0, y: 0 },
    showArrow = false,
    header,
    footer
}) => {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
    const [focusedIndex, setFocusedIndex] = useState<number>(-1);
    // The same close path an option takes, for the footer's controls.
    const closeMenu = useCallback(() => {
        onClose();
        if (onAfterClose) onAfterClose();
    }, [onClose, onAfterClose]);
    const [hoveredIndex, setHoveredIndex] = useState<number>(-1);
    // Focus is in the footer. The last option keeps the roving tab stop so
    // Shift+Tab can come back; this is what takes the highlight off it.
    const [isFooterFocused, setIsFooterFocused] = useState<boolean>(false);
    const [activeActionsIndex, setActiveActionsIndex] = useState<number>(-1);
    const [adjustedPosition, setAdjustedPosition] = useState<MenuPosition>(position);
    const [arrowPosition, setArrowPosition] = useState<string>('50%');
    const [placement, setPlacement] = useState<'top' | 'bottom' | 'left' | 'right'>('bottom');
    // The open submenu: the index of its parent item, and the submenu item with
    // keyboard focus (-1 while the keyboard is still on the parent menu).
    const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number>(-1);
    const [submenuFocusedIndex, setSubmenuFocusedIndex] = useState<number>(-1);
    const [submenuPosition, setSubmenuPosition] = useState<MenuPosition | null>(null);
    const submenuRef = useRef<HTMLDivElement | null>(null);
    const submenuItemRefs = useRef<Array<HTMLDivElement | null>>([]);
    const submenuCloseTimer = useRef<number | null>(null);
    const submenuItems = openSubmenuIndex >= 0 ? menuItems[openSubmenuIndex]?.submenu ?? null : null;

    const cancelSubmenuClose = useCallback(() => {
        if (submenuCloseTimer.current === null) return;
        getWindowFromElement(menuRef.current)?.clearTimeout(submenuCloseTimer.current);
        submenuCloseTimer.current = null;
    }, []);

    const closeSubmenu = useCallback(() => {
        cancelSubmenuClose();
        setOpenSubmenuIndex(-1);
        setSubmenuFocusedIndex(-1);
        setSubmenuPosition(null);
    }, [cancelSubmenuClose]);

    /** Open the submenu of item `index`; `focusFirst` moves keyboard focus into it. */
    const openSubmenu = useCallback((index: number, focusFirst: boolean) => {
        cancelSubmenuClose();
        const items = menuItems[index]?.submenu ?? [];
        if (index !== openSubmenuIndex) setSubmenuPosition(null);
        setOpenSubmenuIndex(index);
        setSubmenuFocusedIndex(focusFirst ? items.findIndex(item => !item.disabled && !item.isGroupHeader && !item.isDivider) : -1);
    }, [cancelSubmenuClose, menuItems, openSubmenuIndex]);

    const isFocusableItem = (item: MenuItem): boolean => {
        return !item.disabled && !item.isGroupHeader && !item.isDivider;
    };

    const findFocusableIndex = (startIndex: number, step: 1 | -1): number => {
        if (menuItems.length === 0) {
            return -1;
        }

        let index = startIndex;
        for (let checked = 0; checked < menuItems.length; checked++) {
            const normalizedIndex = (index + menuItems.length) % menuItems.length;
            if (isFocusableItem(menuItems[normalizedIndex])) {
                return normalizedIndex;
            }
            index += step;
        }

        return -1;
    };

    // Tab does not wrap: after the last option it should reach the footer,
    // and before the first it should leave the menu.
    const findLinearFocusableIndex = (startIndex: number, step: 1 | -1): number => {
        for (let index = startIndex + step; index >= 0 && index < menuItems.length; index += step) {
            if (isFocusableItem(menuItems[index])) {
                return index;
            }
        }
        return -1;
    };

    // Block scrolling when menu is open
    useEffect(() => {
        if (!isOpen) return;
        
        // Get the correct window/document context for this component
        const doc = getDocumentFromElement(menuRef.current);
        if (!doc) return;

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
        const messagesArea = doc.getElementById('beaver-messages');
        if (messagesArea) {
            messagesArea.addEventListener('wheel', preventScroll, { passive: false });
            messagesArea.addEventListener('touchmove', preventScroll, { passive: false });
        }
        
        // Also prevent on document for safety
        doc.addEventListener('wheel', preventScroll, { capture: true, passive: false });
        doc.addEventListener('touchmove', preventScroll, { capture: true, passive: false });
        
        return () => {
            if (messagesArea) {
                messagesArea.removeEventListener('wheel', preventScroll);
                messagesArea.removeEventListener('touchmove', preventScroll);
            }
            doc.removeEventListener('wheel', preventScroll, { capture: true });
            doc.removeEventListener('touchmove', preventScroll, { capture: true });
        };
    }, [isOpen]);
    
    // Calculate adjusted position when menu opens. A layout effect, so the
    // menu is measured and moved before the browser paints: with a passive
    // effect the first frame shows it at the stale (initially 0,0) position
    // before it jumps to the anchor.
    useLayoutEffect(() => {
        if (!isOpen || !menuRef.current) return;
        
        // Get the correct window context for this component
        const win = getWindowFromElement(menuRef.current);
        if (!win) return;

        // Get viewport dimensions
        const viewportWidth = win.innerWidth;
        const viewportHeight = win.innerHeight;
        
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
        
        // Get the correct document context for this component
        const doc = getDocumentFromElement(menuRef.current);
        if (!doc) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
                if (onAfterClose) onAfterClose();
            }
        };
        
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                // An open submenu closes first, back to its parent item.
                if (openSubmenuIndex >= 0) {
                    closeSubmenu();
                    return;
                }
                onClose();
                if (onAfterClose) onAfterClose();
            }
        };
        
        doc.addEventListener('mousedown', handleClickOutside);
        doc.addEventListener('keydown', handleEscape);
        
        return () => {
            doc.removeEventListener('mousedown', handleClickOutside);
            doc.removeEventListener('keydown', handleEscape);
        };
    }, [isOpen, onClose, onAfterClose, openSubmenuIndex, closeSubmenu]);
    
    // Handle keyboard navigation
    useEffect(() => {
        if (!isOpen || menuItems.length === 0) return;
        
        // Get the correct document context for this component
        const doc = getDocumentFromElement(menuRef.current);
        if (!doc) return;

        const handleKeyNav = (e: KeyboardEvent) => {
            // Keyboard focus is inside the open submenu.
            if (submenuItems && submenuFocusedIndex >= 0) {
                const isFocusable = (item: MenuItem) => !item.disabled && !item.isGroupHeader && !item.isDivider;
                const step = (from: number, delta: 1 | -1) => {
                    for (let checked = 1; checked <= submenuItems.length; checked++) {
                        const index = (from + delta * checked + submenuItems.length) % submenuItems.length;
                        if (isFocusable(submenuItems[index])) return index;
                    }
                    return from;
                };
                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        setSubmenuFocusedIndex(prev => step(prev, 1));
                        return;
                    case 'ArrowUp':
                        e.preventDefault();
                        setSubmenuFocusedIndex(prev => step(prev, -1));
                        return;
                    case 'ArrowLeft':
                        e.preventDefault();
                        closeSubmenu();
                        return;
                    case 'Enter':
                    case ' ': {
                        e.preventDefault();
                        const item = submenuItems[submenuFocusedIndex];
                        if (item && isFocusable(item)) {
                            item.onClick();
                            onClose();
                            if (onAfterClose) onAfterClose();
                        }
                        return;
                    }
                    case 'Tab':
                        // Tab and Shift+Tab stay in the submenu; Ctrl/Alt/Meta+Tab
                        // are host shortcuts (tab switching) and pass through.
                        if (!e.ctrlKey && !e.altKey && !e.metaKey) e.preventDefault();
                        return;
                    default:
                        return;
                }
            }
            switch (e.key) {
                case 'ArrowRight': {
                    const item = menuItems[focusedIndex];
                    if (item?.submenu && isFocusableItem(item)) {
                        e.preventDefault();
                        openSubmenu(focusedIndex, true);
                    }
                    break;
                }
                case 'ArrowLeft':
                    if (openSubmenuIndex >= 0) {
                        e.preventDefault();
                        closeSubmenu();
                    }
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    if (openSubmenuIndex >= 0) closeSubmenu();
                    setFocusedIndex((prev: number) => {
                        return findFocusableIndex(prev >= 0 ? prev + 1 : 0, 1);
                    });
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (openSubmenuIndex >= 0) closeSubmenu();
                    setFocusedIndex((prev: number) => {
                        return findFocusableIndex(prev >= 0 ? prev - 1 : menuItems.length - 1, -1);
                    });
                    break;
                case 'Tab': {
                    // A footer is its own tab stop. Without this, Tab jumps
                    // there from the focused option and skips every later row.
                    // Arrows still wrap; Tab walks the remaining options, then
                    // the browser's tab order takes over (footer, or out).
                    // Ctrl/Alt/Meta+Tab are host shortcuts (tab switching);
                    // only unmodified Tab (and Shift+Tab) move between rows.
                    if (!footer || e.ctrlKey || e.altKey || e.metaKey) break;
                    const target = e.target as Node | null;
                    const menuEl = menuRef.current;
                    if (!target || !menuEl || !menuEl.contains(target)) break;
                    const inItem = itemRefs.current.some(
                        (item) => item === target || item?.contains(target),
                    );
                    if (!inItem) break;
                    const next = findLinearFocusableIndex(focusedIndex, e.shiftKey ? -1 : 1);
                    if (next < 0) break;
                    e.preventDefault();
                    setIsFooterFocused(false);
                    setFocusedIndex(next);
                    break;
                }
                case 'Enter':
                case ' ': {
                    // Focus can sit on something inside the menu that is not an
                    // option — a button in the footer, reached with Tab. That
                    // element's own activation is what the user asked for, and
                    // the highlighted option is not; leave the key to it.
                    const target = e.target as Element | null;
                    const menuEl = menuRef.current;
                    if (
                        target && menuEl && menuEl !== target && menuEl.contains(target)
                        && !itemRefs.current.some((item) => item === target || item?.contains(target))
                    ) {
                        break;
                    }
                    e.preventDefault();
                    if (focusedIndex >= 0 && menuItems[focusedIndex].submenu && isFocusableItem(menuItems[focusedIndex])) {
                        openSubmenu(focusedIndex, true);
                    } else if (focusedIndex >= 0 && !menuItems[focusedIndex].disabled && 
                        !menuItems[focusedIndex].isGroupHeader && !menuItems[focusedIndex].isDivider) {
                        menuItems[focusedIndex].onClick();
                        onClose();
                        if (onAfterClose) onAfterClose();
                    }
                    break;
                }
                    default:
                    break;
            }
        };
        
        doc.addEventListener('keydown', handleKeyNav);
        return () => doc.removeEventListener('keydown', handleKeyNav);
    }, [isOpen, menuItems, focusedIndex, footer, onClose, onAfterClose, submenuItems, submenuFocusedIndex, openSubmenuIndex, openSubmenu, closeSubmenu]);
    
    // Set initial focus
    useEffect(() => {
        if (isOpen && menuRef.current) {
            menuRef.current.focus();
            const firstEnabled = menuItems.findIndex(isFocusableItem);
            if (firstEnabled >= 0) {
                setFocusedIndex(firstEnabled);
            }
        } else {
            setFocusedIndex(-1);
        }
        
        // Reset hovered index when menu opens/closes
        setHoveredIndex(-1);
        setIsFooterFocused(false);
        closeSubmenu();
    }, [isOpen]);

    // A submenu whose parent item is gone or disabled (the items were rebuilt) closes.
    useEffect(() => {
        if (openSubmenuIndex < 0) return;
        const parent = menuItems[openSubmenuIndex];
        if (!parent?.submenu || !isFocusableItem(parent)) closeSubmenu();
    }, [menuItems, openSubmenuIndex, closeSubmenu]);

    useEffect(() => cancelSubmenuClose, [cancelSubmenuClose]);

    // Place the submenu beside its parent item: to the right, or to the left
    // when the right side has no room, and within the viewport vertically. It
    // is position: fixed, so it is not clipped by the scrolling menu.
    useLayoutEffect(() => {
        if (!isOpen || openSubmenuIndex < 0 || !submenuRef.current) return;
        const parentItem = itemRefs.current[openSubmenuIndex];
        const win = getWindowFromElement(submenuRef.current);
        if (!parentItem || !win) return;
        const itemRect = parentItem.getBoundingClientRect();
        const subRect = submenuRef.current.getBoundingClientRect();
        const margin = 8;
        let x = itemRect.right + 4;
        if (x + subRect.width > win.innerWidth - margin) {
            const left = itemRect.left - subRect.width - 4;
            x = left >= margin ? left : Math.max(margin, win.innerWidth - subRect.width - margin);
        }
        // Align the first submenu item with the parent item (the menu's padding is 4px).
        let y = itemRect.top - 5;
        if (y + subRect.height > win.innerHeight - margin) y = Math.max(margin, win.innerHeight - subRect.height - margin);
        if (!submenuPosition || submenuPosition.x !== x || submenuPosition.y !== y) setSubmenuPosition({ x, y });
    }, [isOpen, openSubmenuIndex, submenuItems, adjustedPosition, submenuPosition]);

    useEffect(() => {
        if (submenuFocusedIndex < 0) return;
        const element = submenuItemRefs.current[submenuFocusedIndex];
        if (!element) return;
        try {
            element.focus({ preventScroll: true });
        } catch (e) {
            element.focus();
        }
    }, [submenuFocusedIndex, submenuPosition]);

    useEffect(() => {
        if (!isOpen || focusedIndex < 0 || submenuFocusedIndex >= 0) {
            return;
        }

        const menuElement = menuRef.current;
        const focusedItem = itemRefs.current[focusedIndex];
        if (!menuElement || !focusedItem) {
            return;
        }

        try {
            focusedItem.focus({ preventScroll: true });
        } catch (e) {
            focusedItem.focus();
        }
        scrollItemIntoMenuView(menuElement, focusedItem);
    }, [focusedIndex, isOpen, submenuFocusedIndex]);
    
    if (!isOpen) return null;
    
    // The actual menu element
    const menuElement = (
        <div
            ref={menuRef}
            className={`bg-overlay border-popup rounded-md p-1 overflow-y-auto scrollbar outline-none z-1000 shadow-md ${className}`}
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
            {/* Custom header section */}
            {header && (
                <div className="mb-1">
                    {header}
                </div>
            )}
            {menuItems.map((item, index) => (
                <div
                    key={index}
                    ref={(element) => {
                        itemRefs.current[index] = element;
                    }}
                    role={item.isGroupHeader || item.isDivider ? 'presentation' : item.role ?? 'menuitem'}
                    tabIndex={focusedIndex === index && isFocusableItem(item) ? 0 : -1}
                    className={`
                        ${item.isDivider ? 'border-t border-top-quinary my-1' :
                          item.isGroupHeader ? 'px-2 py-1 font-color-tertiary text-xs font-medium mt-1 first:mt-0' :
                          `beaver-menu-item display-flex items-center gap-2 px-2 py-15 rounded-md transition user-select-none
                          ${item.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                          ${((focusedIndex === index && !isFooterFocused) || hoveredIndex === index || openSubmenuIndex === index) && !item.disabled ? 'bg-quinary' : ''}`
                        }
                    `}
                    style={!item.isDivider && !item.isGroupHeader ? { maxWidth: '100%', minWidth: 0 } : undefined}
                    onClick={(e) => {
                        e.stopPropagation();
                        if (!item.isGroupHeader && !item.isDivider && !item.disabled) {
                            if (item.submenu) {
                                openSubmenu(index, false);
                                return;
                            }
                            item.onClick();
                            onClose();
                            if (onAfterClose) onAfterClose();
                        }
                    }}
                    onMouseEnter={() => {
                        if (!item.isGroupHeader && !item.isDivider && !item.disabled) {
                            setHoveredIndex(index);
                            setFocusedIndex(index);
                            setActiveActionsIndex(index);
                            if (item.submenu) {
                                openSubmenu(index, false);
                            } else if (openSubmenuIndex >= 0 && submenuCloseTimer.current === null) {
                                // Leave time to cross this item on the way into the submenu.
                                const win = getWindowFromElement(menuRef.current);
                                if (win) {
                                    submenuCloseTimer.current = win.setTimeout(() => {
                                        submenuCloseTimer.current = null;
                                        closeSubmenu();
                                    }, SUBMENU_CLOSE_DELAY_MS);
                                } else {
                                    closeSubmenu();
                                }
                            }
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
                    aria-disabled={!item.isGroupHeader && !item.isDivider ? item.disabled : undefined}
                    aria-checked={
                        !item.isGroupHeader && !item.isDivider && item.ariaChecked !== undefined
                            ? item.ariaChecked
                            : undefined
                    }
                    aria-label={!item.isGroupHeader && !item.isDivider ? item.label : undefined}
                    aria-haspopup={item.submenu ? 'menu' : undefined}
                    aria-keyshortcuts={item.ariaKeyShortcuts}
                    aria-expanded={item.submenu ? openSubmenuIndex === index : undefined}
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
                                <Icon icon={item.icon} size={14} className={itemIconClassName}/>
                            )}
                            <span className={itemLabelClassName}>{item.label}</span>
                            {item.shortcut && (
                                <span className="text-sm font-color-tertiary flex-shrink-0 ml-2">{item.shortcut}</span>
                            )}
                            {item.submenu && (
                                <Icon icon={ArrowRightIcon} size={12} className="font-color-tertiary flex-shrink-0" />
                            )}
                        </span>
                    )}
                </div>
            ))}

            {/* Open submenu, beside its parent item */}
            {submenuItems && (
                <div
                    ref={submenuRef}
                    className="bg-overlay border-popup rounded-md p-1 overflow-y-auto scrollbar outline-none z-1000 shadow-md"
                    style={{
                        position: 'fixed',
                        // Placed by a layout effect before the first paint. Not
                        // hidden until then: a hidden item cannot take focus.
                        top: submenuPosition?.y ?? 0,
                        left: submenuPosition?.x ?? 0,
                        minWidth: '9rem',
                        // Long labels (an item title) truncate rather than widen it.
                        maxWidth: 'min(20rem, calc(100vw - 16px))',
                        maxHeight: '80vh',
                    }}
                    role="menu"
                    aria-orientation="vertical"
                    aria-label={menuItems[openSubmenuIndex]?.label}
                    onMouseEnter={cancelSubmenuClose}
                >
                    {submenuItems.map((subItem, subIndex) => (
                        <div
                            key={subIndex}
                            ref={(element) => {
                                submenuItemRefs.current[subIndex] = element;
                            }}
                            role={subItem.isGroupHeader || subItem.isDivider ? 'presentation' : subItem.role ?? 'menuitem'}
                            tabIndex={submenuFocusedIndex === subIndex ? 0 : -1}
                            className={
                                subItem.isDivider ? 'border-t border-top-quinary my-1'
                                : subItem.isGroupHeader ? 'px-2 py-1 font-color-tertiary text-xs font-medium mt-1 first:mt-0'
                                : `beaver-menu-item display-flex items-center gap-2 px-2 py-15 rounded-md transition user-select-none
                                    ${subItem.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                                    ${submenuFocusedIndex === subIndex && !subItem.disabled ? 'bg-quinary' : ''}`
                            }
                            onClick={(e) => {
                                e.stopPropagation();
                                if (subItem.isGroupHeader || subItem.isDivider || subItem.disabled) return;
                                subItem.onClick();
                                onClose();
                                if (onAfterClose) onAfterClose();
                            }}
                            onMouseEnter={() => {
                                if (!subItem.isGroupHeader && !subItem.isDivider && !subItem.disabled) {
                                    setSubmenuFocusedIndex(subIndex);
                                }
                            }}
                            aria-disabled={!subItem.isGroupHeader && !subItem.isDivider ? subItem.disabled : undefined}
                            aria-label={!subItem.isGroupHeader && !subItem.isDivider ? subItem.label : undefined}
                        >
                            {subItem.isDivider ? null : subItem.isGroupHeader ? (
                                <span className="truncate">{subItem.label}</span>
                            ) : subItem.customContent ? (
                                subItem.customContent
                            ) : (
                                <span className="display-flex items-center gap-2 w-full min-w-0">
                                    {subItem.icon && (
                                        <Icon icon={subItem.icon} size={14} className={itemIconClassName}/>
                                    )}
                                    <span className={itemLabelClassName}>{subItem.label}</span>
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
            
            {/* Custom footer section */}
            {footer && (
                <div
                    className="mt-1"
                    // Tabbing into the footer moves focus off the options; the
                    // highlight follows, so one thing looks focused at a time.
                    // Only the highlight: the focused option keeps its tabIndex
                    // of 0, so Shift+Tab lands back on it rather than outside
                    // the still-open menu.
                    onFocus={() => setIsFooterFocused(true)}
                    onBlur={() => setIsFooterFocused(false)}
                >
                    {typeof footer === 'function' ? footer({ close: closeMenu }) : footer}
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
        // Using React Portal to render outside the current DOM hierarchy.
        // The document comes from the menu's own ref, which is only attached
        // once the menu has rendered — so on the first open there is nothing to
        // portal into yet. Render in place for that pass rather than guessing a
        // window; the ref lands on this pass and the portal takes over on the
        // next render, in the window the menu actually belongs to.
        // A host document need not have a `body` (a XUL chrome window is rooted
        // at `<window>`), and `createPortal` throws on a null container, taking
        // down the whole tree — render in place in that case too.
        const container = getDocumentFromElement(menuRef.current)?.body;
        if (container) {
            return ReactDOM.createPortal(
                menuElement,
                container
            );
        }
    }

    return menuElement;
};

export default ContextMenu;
