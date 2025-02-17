import React, { ButtonHTMLAttributes } from 'react';
import { Spinner } from './icons';

// Button props interface
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    loading?: boolean;
    loadingText?: string;
}

// Base Button component
const Button: React.FC<ButtonProps> = ({
    children,
    disabled,
    loading = false,
    loadingText,
    className = '',
    ...props
}) => {
    // Determine if the button has both text and icon
    const hasTextAndIcon = React.Children.toArray(children).length > 1;
    
    const renderContent = () => {
        if (loading) {
            if (loadingText) {
                return (
                    <>
                    {loadingText}
                    <Spinner className="ml-2" />
                    </>
                );
            }
            return <Spinner />;
        }
        
        if (hasTextAndIcon) {
            // Add spacing between icon and text
            return React.Children.map(children, (child, index) => {
                if (index !== React.Children.count(children) - 1) {
                    return <>{child}<span className="mr-2" /></>;
                }
                return child;
            });
        }
        
        return children;
    };
    
    return (
        <button
            className={`inline-flex items-center justify-center ${
                disabled || loading ? 'cursor-not-allowed' : ''
            } ${className}`}
            disabled={disabled || loading}
            aria-disabled={disabled || loading}
            aria-busy={loading}
            {...props}
        >
            {renderContent()}
        </button>
    );
};

// IconButton props interface
interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    'aria-label': string; // Make aria-label required
    loading?: boolean;
}

// IconButton component
const IconButton: React.FC<IconButtonProps> = ({
    children,
    disabled,
    loading = false,
    className = '',
    'aria-label': ariaLabel,
    ...props
}) => {
    return (
        <button
            className={`inline-flex items-center justify-center ${
                disabled || loading ? 'cursor-not-allowed' : ''
            } ${className}`}
            disabled={disabled || loading}
            aria-label={ariaLabel}
            aria-disabled={disabled || loading}
            aria-busy={loading}
            {...props}
        >
            {loading ? <Spinner /> : children}
        </button>
    );
};

export {
    Button,
    IconButton,
    type ButtonProps,
    type IconButtonProps,
};