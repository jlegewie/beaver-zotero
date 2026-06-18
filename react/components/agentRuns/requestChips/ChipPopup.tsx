import React from 'react';
import { Icon } from '../../icons/icons';
import Tooltip from '../../ui/Tooltip';

/**
 * Hover-card for a request chip.
 *
 * Presentational and client-agnostic: it renders only from the hydrated
 * attachment data the chip already holds.
 */

/**
 * Second line of the card. `prefix` (e.g. "Attached to ") stays upright; `text`
 * is the body and is italicized only when it is parent bibliographic identity.
 */
export interface ChipPopupSubtitle {
    prefix?: string | null;
    text: string;
    italic?: boolean;
}

/** Footer hint describing what clicking the chip does. */
export interface ChipPopupAction {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    label: string;
    /** Extra classes for the footer icon (e.g. `scale-75` to shrink a large glyph). */
    iconClassName?: string;
}

export interface ChipPopupContent {
    /** Pre-rendered icon node — mirrors the icon shown on the chip itself. */
    icon: React.ReactNode;
    /** Primary line: bibliographic display name / attachment title / note title. */
    title: string;
    /** Optional relationship/second line. */
    subtitle?: ChipPopupSubtitle | null;
    /** Optional action hint footer. */
    action?: ChipPopupAction | null;
}

const POPUP_WIDTH = '260px';

const ChipPopupCard: React.FC<ChipPopupContent> = ({ icon, title, subtitle, action }) => (
    <span className="block" style={{ overflow: 'hidden' }}>
        <span className="px-3 py-15 mt-1 display-flex flex-row items-start gap-2">
            <span className="flex-shrink-0">{icon}</span>
            <span className="display-flex flex-col gap-1 min-w-0">
                <span
                    className="font-color-primary"
                    style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                >
                    {title}
                </span>
                {subtitle && (
                    <span
                        className="font-color-secondary text-sm"
                        style={{ fontSize: '0.9rem', wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                    >
                        {subtitle.prefix}
                        {subtitle.italic ? <span className="font-italic">{subtitle.text}</span> : subtitle.text}
                    </span>
                )}
            </span>
        </span>
        {action && (
            <span className="px-3 py-15 block border-top-quinary">
                <span className="display-flex flex-row items-center gap-15">
                    <Icon icon={action.icon} className={`font-color-secondary ${action.iconClassName ?? ''}`} />
                    <span className="text-sm font-color-secondary">{action.label}</span>
                </span>
            </span>
        )}
    </span>
);

/**
 * Wraps a chip with its hover-card. The chip (`children`) stays the click
 * target; the card only appears on hover. `content` feeds the tooltip's
 * non-empty check — the card itself is supplied via `customContent`.
 */
export function ChipWithPopup({
    popup,
    children,
}: {
    popup: ChipPopupContent;
    children: React.ReactNode;
}) {
    return (
        <Tooltip
            content={popup.title}
            customContent={<ChipPopupCard {...popup} />}
            width={POPUP_WIDTH}
            padding={false}
        >
            {children}
        </Tooltip>
    );
}

export default ChipWithPopup;
