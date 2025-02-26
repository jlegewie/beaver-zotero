import React from 'react';
// @ts-ignore no idea why
import { useState, useRef } from 'react';
import ContextMenu, { MenuItem, MenuPosition } from './ContextMenu';
import { Icon } from './icons';

interface MenuButtonProps {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    menuItems: MenuItem[];
    className?: string;
    iconClassName?: string;
    buttonLabel?: string;
    ariaLabel?: string;
    positionAdjustment?: {
        x?: number;
        y?: number;
    };
}

/**
* A button that displays a menu when clicked
*/
const MenuButton: React.FC<MenuButtonProps> = ({
    icon,
    menuItems,
    className = '',
    iconClassName = '',
    buttonLabel,
    ariaLabel,
    positionAdjustment
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
        }
    };
    
    return (
        <>
            <button
                className={`icon-button ${className}`}
                ref={buttonRef}
                onClick={handleButtonClick}
                aria-label={ariaLabel || buttonLabel}
                aria-haspopup="menu"
                aria-expanded={isMenuOpen}
            >
                <Icon icon={icon} className={iconClassName} />
                {buttonLabel && <span className="sr-only">{buttonLabel}</span>}
            </button>
            <ContextMenu
                menuItems={menuItems}
                isOpen={isMenuOpen}
                onClose={() => setIsMenuOpen(false)}
                position={menuPosition}
                useFixedPosition={true}
                positionAdjustment={positionAdjustment}
            />
        </>
    );
};

export default MenuButton; 