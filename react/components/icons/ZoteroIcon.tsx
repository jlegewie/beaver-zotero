import React from 'react';

interface ZoteroIconProps {
    // The path to the icon, relative to chrome://zotero/skin/
    icon: string;
    // Size in pixels (defaults to 16)
    size?: number;
    color?: string;
    // Optional className for additional styling
    className?: string;
}

export const ZoteroIcon: React.FC<ZoteroIconProps> = ({
    icon,
    size = 16,
    color,
    className = '',
}) => {
    return (
        <img
            src={`chrome://zotero/skin/${icon}`}
            className={className}
            style={{
                width: `${size}px`,
                height: `${size}px`,
                // Only set fill/stroke if color prop is provided
                ...(color ? {
                    fill: `var(${color})`,
                    stroke: `var(${color})`
                } : {
                    fill: 'currentColor',
                    stroke: 'currentColor'
                }),
                MozContextProperties: 'fill, fill-opacity, stroke, stroke-opacity'
            }}
        />
    );
};

// Common icon paths as constants for reuse
export const ZOTERO_ICONS = {
    PIN: '16/universal/pin.svg',
    TRASH: '16/universal/trash.svg',
    ATTACHMENTS: 'itempane/16/attachments.svg',
    // Add more icons as needed
} as const; 