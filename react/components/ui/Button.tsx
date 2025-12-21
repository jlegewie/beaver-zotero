import React from 'react';
import { Icon } from '../icons/icons';
import Spinner from '../icons/Spinner';

export type ButtonVariant = 'solid' | 'surface' | 'outline' | 'subtle' | 'ghost' | 'surface-light' | 'ghost-secondary' | 'ghost-tertiary' | 'error';

interface ButtonProps {
    /** Button variant */
    variant: ButtonVariant;
    /** Button contents */
    children?: React.ReactNode;
    /** Icon to display (optional) */
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>> | React.ReactElement;
    /** Icon to display on the right (optional) */
    rightIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>> | React.ReactElement;
    /** Click handler */
    onClick?: (e: React.FormEvent<HTMLFormElement> | React.MouseEvent<HTMLButtonElement>) => void;
    /** Mouse enter handler */
    onMouseEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    /** Mouse leave handler */
    onMouseLeave?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    /** Additional class names */
    className?: string;
    /** Additional class names for the icon */
    iconClassName?: string;
    /** Additional style for the button */
    style?: React.CSSProperties;
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
    onMouseEnter,
    onMouseLeave,
    className = '',
    iconClassName = '',
    style,
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
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            aria-label={ariaLabel}
            disabled={disabled || loading}
            title={title}
            type={type}
            style={style}
        >
            {icon && (React.isValidElement(icon) ? icon : <Icon icon={icon as React.ComponentType<React.SVGProps<SVGSVGElement>>} className={iconClassName} />)}
            {children}
            {rightIcon && (React.isValidElement(rightIcon) ? rightIcon : <Icon icon={rightIcon as React.ComponentType<React.SVGProps<SVGSVGElement>>} className={iconClassName} />)}
            {loading && <Spinner />}
            {loading && loadingText && <span>{loadingText}</span>}
        </button>
    );
};

export default Button;