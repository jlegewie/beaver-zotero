import React, { ReactNode } from 'react';
import Tooltip from '../ui/Tooltip';
import { HighlighterIcon, Icon, NoteIcon } from '../icons/icons';

const DEFAULT_TOOLTIP_WIDTH = '250px';

interface AnnotationTooltipProps {
    children: ReactNode;
    typeLabel: string;
    pageDisplay?: string | null;
    body?: string | null;
    footerLabel: string;
    footerClassName?: string;
    typeIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    width?: string;
    stayOpenOnAnchorClick?: boolean;
}

/**
 * Shared tooltip for annotation rows in agent previews and tool results.
 */
export const AnnotationTooltip: React.FC<AnnotationTooltipProps> = ({
    children,
    typeLabel,
    pageDisplay,
    body,
    footerLabel,
    footerClassName = 'font-color-tertiary',
    typeIcon = NoteIcon,
    width = DEFAULT_TOOLTIP_WIDTH,
    stayOpenOnAnchorClick = false,
}) => {
    const tooltipBody = typeof body === 'string' ? body.trim() : '';
    const tooltipContent = tooltipBody || typeLabel;
    const customContent = (
        <span className="block" style={{ overflow: 'hidden' }}>
            <span className="px-3 py-15 display-flex flex-row border-bottom-quinary gap-1">
                <Icon icon={typeIcon} size={12} className="mt-015" />
                <span className="font-color-primary text-sm">
                    {typeLabel}
                </span>
                <span className="flex-1" />
                {pageDisplay && (
                    <span className="font-color-secondary text-sm">{`Page ${pageDisplay}`}</span>
                )}
            </span>
            {tooltipBody && (
                <span className="px-3 py-15 block">
                    <span
                        className="font-color-secondary text-sm block"
                        style={{
                            wordBreak: 'break-word',
                            overflowWrap: 'anywhere',
                            whiteSpace: 'pre-wrap',
                            display: '-webkit-box',
                            WebkitLineClamp: 5,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                        }}
                    >
                        {tooltipBody}
                    </span>
                </span>
            )}
            <span className="px-3 py-15 border-top-quinary block">
                <span className="display-flex flex-row items-center gap-15">
                    <span className={`text-sm ${footerClassName}`}>
                        {footerLabel}
                    </span>
                </span>
            </span>
        </span>
    );

    return (
        <Tooltip
            content={tooltipContent}
            customContent={customContent}
            width={width}
            padding={false}
            stayOpenOnAnchorClick={stayOpenOnAnchorClick}
            anchorDisplay="block"
        >
            {children}
        </Tooltip>
    );
};

/**
 * Convert Zotero annotation types into user-facing labels for compact UI.
 */
export function getAnnotationTypeLabel(type: string | undefined): string {
    switch (type) {
        case 'highlight':
            return 'Highlight Annotation';
        case 'underline':
            return 'Underline Annotation';
        case 'note':
            return 'Sticky Note';
        case 'image':
            return 'Area Annotation';
        case 'text':
            return 'Text Annotation';
        default:
            return 'Annotation';
    }
}

/**
 * Pick a compact SVG icon for the tooltip header.
 */
export function getAnnotationTooltipIcon(type: string | undefined): React.ComponentType<React.SVGProps<SVGSVGElement>> {
    switch (type) {
        case 'highlight':
        case 'underline':
            return HighlighterIcon;
        default:
            return NoteIcon;
    }
}

export default AnnotationTooltip;
