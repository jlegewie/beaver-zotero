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
    PIN_REMOVE: '16/universal/pin-remove.svg',
    TRASH: '16/universal/trash.svg',
    EDIT: '16/universal/edit.svg',
    ATTACHMENTS: 'itempane/16/attachments.svg',
    NOTES: 'itempane/16/notes.svg',
    OPEN: '16/universal/open-link.svg',
    VIEW: '16/universal/view.svg',
    TICK: '16/universal/tick.svg',
    CROSS: '16/universal/cross.svg',
    PLUS: '16/universal/plus.svg',
    MINUS: '16/universal/minus.svg',
    SHOW_ITEM: '16/universal/show-item.svg',
    ANNOTATE_AREA: '16/universal/annotate-area.svg',
    ANNOTATE_HIGHLIGHT: '16/universal/annotate-highlight.svg',
    ANNOTATE_NOTE: '16/universal/annotate-note.svg',
    ANNOTATE_TEXT: '16/universal/annotate-text.svg',
    ANNOTATE_UNDERLINE: '16/universal/annotate-underline.svg',
    ANNOTATION: '16/universal/annotation.svg'
} as const; 