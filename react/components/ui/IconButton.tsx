import React, { forwardRef } from 'react';
import { Icon, Spinner } from '../icons/icons';
import { ButtonVariant } from './Button';


interface IconButtonProps {
    /** Icon to display */
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /** Button variant */
    variant?: ButtonVariant;
    /** Click handler */
    onClick: (e: React.MouseEvent) => void;
    /** Additional class names for the button */
    className?: string;
    /** Additional class names for the icon */
    iconClassName?: string;
    /** Accessible label for the button */
    ariaLabel?: string;
    /** ID of an element that describes the button for assistive technology */
    ariaDescribedBy?: string;
    /** Whether the button is currently pressed when used as a toggle */
    ariaPressed?: React.AriaAttributes['aria-pressed'];
    /** Whether the button is unavailable while remaining focusable */
    ariaDisabled?: React.AriaAttributes['aria-disabled'];
    /** Whether the button is disabled */
    disabled?: boolean;
    /** Additional style for the button */
    style?: React.CSSProperties;
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
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(({
    icon,
    variant = 'ghost',
    onClick,
    className = '',
    iconClassName = '',
    ariaLabel,
    disabled = false,
    style,
    loading = false,
    title,
    onMouseEnter,
    onMouseLeave,
    ariaDescribedBy,
    ariaPressed,
    ariaDisabled
}, ref) => {
    // Use the existing icon-button class for ghost variant for compatibility
    // Use the variant-{type} classes for the other variants
    // const buttonClass = variant === 'ghost' 
    //     ? `icon-button ${className}`
    //     : `variant-${variant} icon-only ${className} ${loading ? 'loading' : ''}`;
    const buttonClass = `variant-${variant} icon-only ${className} ${loading ? 'loading' : ''}`;
    
    return (
        <button
            ref={ref}
            className={buttonClass}
            onClick={onClick}
            aria-label={ariaLabel}
            aria-describedby={ariaDescribedBy}
            aria-pressed={ariaPressed}
            aria-disabled={ariaDisabled}
            disabled={disabled || loading}
            title={title}
            type="button"
            style={style}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <Icon icon={!loading ? icon : Spinner} className={iconClassName} />
        </button>
    );
});

IconButton.displayName = 'IconButton';

export default IconButton;
