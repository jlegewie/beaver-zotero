import React from 'react';
import { Icon, ArrowDownIcon } from './icons';

interface ScrollDownButtonProps extends React.HTMLProps<HTMLButtonElement> {
    onClick: () => void;
}

export const ScrollDownButton: React.FC<ScrollDownButtonProps> = ({
    onClick,
    className,
    style
}) => {
    return (
        // <div className="absolute -top-4 left-1/2 -translate-x-1/2 -translate-y-full">
        <div className="absolute left-1/2 -translate-x-1/2">
            <button
                onClick={onClick}
                className={`scroll-down-button ${className || ''}`}
                style={style}
            >
                <Icon icon={ArrowDownIcon} />
            </button>
        </div>
    );
};
