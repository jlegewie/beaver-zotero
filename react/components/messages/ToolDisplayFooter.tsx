import React, { useState } from 'react';
import { Icon, ArrowUpIcon } from '../icons/icons';

interface ToolDisplayFooterProps {
    toggleContent: () => void;
}

export const ToolDisplayFooter = React.memo(function ToolDisplayFooter(props: ToolDisplayFooterProps) {
    const { toggleContent } = props;
    const [isHovered, setIsHovered] = useState(false);

    return (
        <div 
            className={`display-flex flex-row justify-center items-center cursor-pointer pb-1 mt-1 transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''}`}
            onClick={toggleContent}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <Icon
                icon={ArrowUpIcon}
                className={`scale-75 -mb-1 transition-colors duration-150 ${isHovered ? 'font-color-primary' : 'font-color-secondary'}`}
                aria-label="Toggle content"
            />
        </div>
    );
});