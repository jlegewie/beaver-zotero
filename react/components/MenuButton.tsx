import React from 'react';
// @ts-ignore no idea why
import { useState, useRef } from 'react';
import ContextMenu, { MenuItem, MenuPosition } from './ContextMenu';
import { Icon } from './icons';
import Tooltip from './Tooltip';

interface MenuButtonProps {
    menuItems: MenuItem[];
    variant?: string;
    maxWidth?: string;
    maxHeight?: string;
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    className?: string;
    iconClassName?: string;
    buttonLabel?: string;
    disabled?: boolean;
    ariaLabel?: string;
    tooltipContent?: string;
    positionAdjustment?: {
        x?: number;
        y?: number;
    };
    /** Whether to show an arrow pointing to the button */
    showArrow?: boolean;
}

/**
* A button that displays a menu when clicked
*/
const MenuButton: React.FC<MenuButtonProps> = ({
    menuItems,
    variant = 'surface',
    maxWidth = undefined,
    maxHeight = undefined,
    icon,
    className = '',
    iconClassName = '',
    buttonLabel,
    ariaLabel,
    disabled = false,
    positionAdjustment,
    tooltipContent,
    showArrow = false
}) => {
    const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    
    const handleButtonClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        
        // Get button position
        if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPosition({ 
                x: rect.left,
                y: rect.bottom + 5
            });
            setIsMenuOpen(true);
            
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
                ${icon && !buttonLabel ? 'icon-only' : ''}
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
            {buttonLabel && <span className="sr-only">{buttonLabel}</span>}
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
            <ContextMenu
                menuItems={menuItems}
                isOpen={isMenuOpen}
                maxWidth={maxWidth}
                maxHeight={maxHeight}
                onClose={() => setIsMenuOpen(false)}
                position={menuPosition}
                useFixedPosition={true}
                positionAdjustment={positionAdjustment}
                showArrow={showArrow}
            />
        </>
    );
};

export default MenuButton; 