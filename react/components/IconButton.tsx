import React from 'react';
import { Icon } from './icons';

interface IconButtonProps {
    /** Icon to display */
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
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
    /** Optional title attribute for tooltips */
    title?: string;
}

/**
 * A button that displays an icon
 */
const IconButton: React.FC<IconButtonProps> = ({
    icon,
    onClick,
    className = '',
    iconClassName = '',
    ariaLabel,
    disabled = false,
    title
}) => {
  return (
    <button
        className={`icon-button ${className}`}
        onClick={onClick}
        aria-label={ariaLabel}
        disabled={disabled}
        title={title}
        type="button"
    >
        <Icon icon={icon} className={iconClassName} />
    </button>
  );
};

export default IconButton; 