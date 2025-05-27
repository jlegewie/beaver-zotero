import React, { useState, useRef, ReactNode, useEffect } from 'react';
import ContextMenu, { MenuItem, MenuPosition } from './ContextMenu';
import { Icon } from '../icons';
import Tooltip from './Tooltip';

interface MenuButtonProps {
    menuItems: MenuItem[];
    variant?: string;
    width?: string;
    maxWidth?: string;
    maxHeight?: string;
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    rightIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    className?: string;
    style?: React.CSSProperties;
    iconClassName?: string;
    rightIconClassName?: string;
    buttonLabel?: string;
    customContent?: ReactNode;
    disabled?: boolean;
    ariaLabel?: string;
    tooltipContent?: string;
    positionAdjustment?: {
        x?: number;
        y?: number;
    };
    /** Whether to show an arrow pointing to the button */
    showArrow?: boolean;
    /** Optional custom footer content to render at the bottom of the menu */
    footer?: ReactNode;
    /** Optional callback to toggle the menu */
    toggleCallback?: (isOpen: boolean) => void;
    /** Optional callback to execute after the menu closes */
    onAfterClose?: () => void;
}

/**
* A button that displays a menu when clicked
*/
const MenuButton: React.FC<MenuButtonProps> = ({
    menuItems,
    variant = 'surface',
    width = undefined,
    maxWidth = undefined,
    maxHeight = undefined,
    icon,
    rightIcon,
    className = '',
    style = {},
    iconClassName = '',
    rightIconClassName = '',
    buttonLabel,
    customContent,
    ariaLabel,
    disabled = false,
    positionAdjustment,
    tooltipContent,
    showArrow = false,
    footer,
    toggleCallback,
    onAfterClose,
}) => {
    const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });
    const buttonRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        if (toggleCallback) {
            toggleCallback(isMenuOpen);
        }
    }, [isMenuOpen, toggleCallback]);
    
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
            type="button"
            className={`
                variant-${variant}
                ${((icon || rightIcon) && !buttonLabel) ? 'icon-only' : ''}
                ${className}`
            }
            ref={buttonRef}
            onClick={handleButtonClick}
            style={style}
            aria-label={ariaLabel || buttonLabel}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            disabled={disabled}
        >
            {customContent ?
                customContent
            :
                <>
                    {icon && <Icon icon={icon} className={iconClassName} />}
                    {buttonLabel && <span className="sr-only">{buttonLabel}</span>}
                    {rightIcon && <Icon icon={rightIcon} className={rightIconClassName} />}
                </>
            }
            
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
                onAfterClose={onAfterClose}
                position={menuPosition}
                useFixedPosition={true}
                positionAdjustment={positionAdjustment}
                showArrow={showArrow}
                width={width}
                footer={footer}
            />
        </>
    );
};

export default MenuButton; 