import React from 'react';
import { Icon } from './icons';

type ButtonVariant = 'solid' | 'surface' | 'outline' | 'subtle' | 'ghost';

interface ButtonProps {
    /** Button variant */
    variant: ButtonVariant;
    /** Button contents */
    children?: React.ReactNode;
    /** Icon to display (optional) */
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /** Icon to display on the right (optional) */
    rightIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /** Click handler */
    onClick?: (e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>) => void;
    /** Additional class names */
    className?: string;
    /** Additional class names for the icon */
    iconClassName?: string;
    /** Accessible label for the button */
    ariaLabel?: string;
    /** Whether the button is disabled */
    disabled?: boolean;
    /** Loading state */
    loading?: boolean;
    /** Text to show when loading */
    loadingText?: string;
    /** Optional title attribute for tooltips */
    title?: string;
    /** Type of button */
    type?: 'button' | 'submit' | 'reset';
}

/**
* Button component with multiple variants
*/
const Button: React.FC<ButtonProps> = ({
    variant,
    children,
    icon,
    rightIcon,
    onClick,
    className = '',
    iconClassName = '',
    ariaLabel,
    disabled = false,
    loading = false,
    loadingText,
    title,
    type = 'button'
}) => {
    const hasText = !!children;
    const isIconOnly = !!icon && !children;
    
    const variantClass = `variant-${variant}`;
    const classes = [
        variantClass,
        isIconOnly ? 'icon-only' : '',
        hasText ? 'has-text' : '',
        loading ? 'loading' : '',
        loadingText ? 'has-loading-text' : '',
        className
    ].filter(Boolean).join(' ');
    
    return (
        <button
            className={classes}
            onClick={onClick}
            aria-label={ariaLabel}
            disabled={disabled || loading}
            title={title}
            type={type}
        >
            {icon && <Icon icon={icon} className={iconClassName} />}
            {children}
            {rightIcon && <Icon icon={rightIcon} className={iconClassName} />}
            {loading && <span className="spinner">●</span>}
            {loading && loadingText && <span>{loadingText}</span>}
        </button>
    );
};

export default Button;