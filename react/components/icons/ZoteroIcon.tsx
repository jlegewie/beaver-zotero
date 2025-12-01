import React from 'react';

interface ZoteroIconProps {
    // The path to the icon, relative to chrome://zotero/skin/
    icon: string;
    // Size in pixels (defaults to 16)
    size?: number;
    color?: string;
    // Optional className for additional styling
    className?: string;
    // Optional style for additional styling
    style?: React.CSSProperties;
}

export const ZoteroIcon: React.FC<ZoteroIconProps> = ({
    icon,
    size = 16,
    color,
    className = '',
    style = {}
}) => {
    const computedColor = color 
        ? (color.startsWith('--') ? `var(${color})` : color) 
        : 'currentColor';

    return (
        <div
            className={className}
            style={{
                width: `${size}px`,
                height: `${size}px`,
                backgroundColor: computedColor,
                maskImage: `url("chrome://zotero/skin/${icon}")`,
                maskRepeat: 'no-repeat',
                maskPosition: 'center',
                maskSize: 'contain',
                WebkitMaskImage: `url("chrome://zotero/skin/${icon}")`,
                WebkitMaskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center',
                WebkitMaskSize: 'contain',
                display: 'inline-block',
                flexShrink: 0,
                ...style
            }}
            role="presentation"
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