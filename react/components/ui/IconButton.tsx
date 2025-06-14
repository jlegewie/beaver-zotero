import React from 'react';
import { Icon } from '../icons/icons';

type IconButtonVariant = 'solid' | 'surface' | 'outline' | 'subtle' | 'ghost' | 'ghost-secondary';

interface IconButtonProps {
    /** Icon to display */
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /** Button variant */
    variant?: IconButtonVariant;
    /** Click handler */
    onClick: (e: React.MouseEvent) => void;
    /** Additional class names for the button */
    className?: string;
    /** Additional class names for the icon */
    iconClassName?: string;
    /** Accessible label for the button */
    ariaLabel?: string;
    /** Whether the button is disabled */
    disabled?: boolean;
    /** Loading state */
    loading?: boolean;
    /** Optional title attribute for tooltips */
    title?: string;
    /** Mouse enter event handler */
    onMouseEnter?: () => void;
    /** Mouse leave event handler */
    onMouseLeave?: () => void;
}

/**
* A button that displays an icon with multiple variant options
*/
const IconButton: React.FC<IconButtonProps> = ({
    icon,
    variant = 'ghost',
    onClick,
    className = '',
    iconClassName = '',
    ariaLabel,
    disabled = false,
    loading = false,
    title,
    onMouseEnter,
    onMouseLeave
}) => {
    // Use the existing icon-button class for ghost variant for compatibility
    // Use the variant-{type} classes for the other variants
    // const buttonClass = variant === 'ghost' 
    //     ? `icon-button ${className}`
    //     : `variant-${variant} icon-only ${className} ${loading ? 'loading' : ''}`;
    const buttonClass = `variant-${variant} icon-only ${className} ${loading ? 'loading' : ''}`;
    
    return (
        <button
            className={buttonClass}
            onClick={onClick}
            aria-label={ariaLabel}
            disabled={disabled || loading}
            title={title}
            type="button"
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <Icon icon={icon} className={iconClassName} />
            {loading && <span className="spinner">●</span>}
        </button>
    );
};

export default IconButton;