import React from 'react';
// @ts-ignore no idea why
import { useState, useRef, useEffect } from 'react';
import SearchMenu, { SearchMenuItem, MenuPosition } from './SearchMenu';
import { Icon } from './icons';
import Tooltip from './Tooltip';

interface SearchMenuButtonProps {
    menuItems: SearchMenuItem[];
    isMenuOpen: boolean;
    onClose: () => void;
    onOpen: () => void;
    variant?: string;
    width?: string;
    maxWidth?: string;
    maxHeight?: string;
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    className?: string;
    iconClassName?: string;
    buttonLabel?: string;
    disabled?: boolean;
    ariaLabel?: string;
    tooltipContent?: string;
    verticalPosition?: 'below' | 'above';
    positionAdjustment?: {
        x?: number;
        y?: number;
    };
    /** Optional callback to search the menu */
    onSearch: (query: string) => void;
    /** Optional text to display when no results are found */
    noResultsText: string;
    /** Optional placeholder text for the search input */
    placeholder: string;
    /** Whether to close the menu when an item is selected */
    closeOnSelect?: boolean;
}

/**
* A button that displays a menu when clicked
*/
const SearchMenuButton: React.FC<SearchMenuButtonProps> = ({
    menuItems,
    variant = 'surface',
    width = undefined,
    maxWidth = undefined,
    maxHeight = undefined,
    icon,
    className = '',
    iconClassName = '',
    buttonLabel,
    ariaLabel,
    disabled = false,
    positionAdjustment,
    verticalPosition = 'below',
    tooltipContent,
    onSearch,
    noResultsText,
    placeholder,
    isMenuOpen,
    onClose,
    onOpen,
    closeOnSelect = true
}) => {
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    
    const handleButtonClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        
        // Get button position
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPosition({ 
                x: rect.left,
                y: verticalPosition === 'above' ? rect.top - 5 : rect.bottom + 5
            });
            onOpen();
            
            // Remove focus from the button after opening the menu
            buttonRef.current.blur();
            
            // Force any active tooltip to close by triggering a mousedown event on document
            const mainWindow = Zotero.getMainWindow();
            mainWindow.document.dispatchEvent(new MouseEvent('click'));
        }
    };

    const buttonElement = (
        <button
            className={`
                variant-${variant}
                ${icon && !buttonLabel ? 'p-1' : ''}
                ${className}`
            }
            ref={buttonRef}
            onClick={handleButtonClick}
            aria-label={ariaLabel || buttonLabel}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            disabled={disabled}
        >
            {icon && <Icon icon={icon} className={iconClassName} />}
            {buttonLabel && <span>{buttonLabel}</span>}
        </button>
    );

    return (
        <>
            {tooltipContent ? (
                <Tooltip
                    content={tooltipContent} 
                    showArrow 
                    singleLine 
                    disabled={isMenuOpen}
                >
                    {buttonElement}
                </Tooltip>
            ) : (
                buttonElement
            )}
            <SearchMenu
                menuItems={menuItems}
                isOpen={isMenuOpen}
                maxWidth={maxWidth}
                maxHeight={maxHeight}
                onClose={onClose}
                position={menuPosition}
                useFixedPosition={true}
                verticalPosition={verticalPosition}
                positionAdjustment={positionAdjustment}
                width={width}
                onSearch={onSearch}
                noResultsText={noResultsText}
                placeholder={placeholder}
                closeOnSelect={closeOnSelect}
            />
        </>
    );
};

export default SearchMenuButton; 