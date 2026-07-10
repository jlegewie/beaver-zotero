import React from 'react';
import { Icon, InformationCircleIcon } from '../../icons/icons';
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

/** Readability note line, shown only when an attachment's content can't be read. */
export interface ChipPopupStatus {
    label: string;
}

export interface ChipPopupContent {
    /** Pre-rendered icon node — mirrors the icon shown on the chip itself. Omit for text-only headers (e.g. action pills). */
    icon?: React.ReactNode;
    /** Primary line: bibliographic display name / attachment title / note title. */
    title: string;
    /** Optional relationship/second line. */
    subtitle?: ChipPopupSubtitle | null;
    /** Optional readability status line. */
    status?: ChipPopupStatus | null;
    /** Optional rich preview rendered between the summary and action footer. */
    media?: React.ReactNode;
    /** Optional action hint footer. */
    action?: ChipPopupAction | null;
}

/** One listed item in a multi-item chip popup: icon + title + optional subtitle. */
export interface ChipListPopupRow {
    /** Stable key for the row. */
    key: string;
    /** Pre-rendered icon node — mirrors the icon shown on the chip itself. */
    icon: React.ReactNode;
    /** Primary line: bibliographic display name / attachment title / note title. */
    title: string;
    /** Optional relationship/second line. */
    subtitle?: ChipPopupSubtitle | null;
}

/** Content for a chip popup that lists several items (e.g. the "+N" overflow chip). */
export interface ChipListPopupContent {
    /** Item rows to list (already capped by the caller). */
    rows: ChipListPopupRow[];
    /** Optional trailing summary line, e.g. "3 more attachments". */
    footer?: string | null;
}

const POPUP_WIDTH = '260px';

export const ChipPopupCard: React.FC<ChipPopupContent> = ({ icon, title, subtitle, status, media, action }) => (
    <span className="block" style={{ overflow: 'hidden' }}>
        <span className="px-3 py-15 mt-1 display-flex flex-row items-start gap-2">
            {icon && <span className="flex-shrink-0">{icon}</span>}
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
                {status && (
                    <span
                        className="text-sm display-flex flex-row items-start gap-1 font-color-secondary"
                        style={{ fontSize: '0.9rem' }}
                    >
                        <Icon icon={InformationCircleIcon} className="scale-95 font-color-secondary flex-shrink-0 mt-020" />
                        <span style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{status.label}</span>
                    </span>
                )}
            </span>
        </span>
        {media && (
            <span className="px-3 pb-2 block">
                {media}
            </span>
        )}
        {action && (
            <span className="px-3 ml-05 py-15 block border-top-quinary">
                <span className="display-flex flex-row items-center gap-15">
                    <Icon icon={action.icon} className={`font-color-secondary ${action.iconClassName ?? ''}`} />
                    <span className="text-sm font-color-secondary">{action.label}</span>
                </span>
            </span>
        )}
    </span>
);

/**
 * Hover-card that lists several items (used by the "+N" overflow chip). Each row
 * mirrors a single-item popup header — icon, display name, and optional subtitle —
 * with an optional trailing summary line for any items beyond those listed.
 */
const ChipListPopupCard: React.FC<ChipListPopupContent> = ({ rows, footer }) => (
    <span className="block px-3 py-2" style={{ overflow: 'hidden' }}>
        <span className="display-flex flex-col gap-15">
            {rows.map((row) => (
                <span key={row.key} className="display-flex flex-row items-start gap-2">
                    <span className="flex-shrink-0">{row.icon}</span>
                    <span className="display-flex flex-col gap-1 min-w-0">
                        <span
                            className="font-color-primary"
                            style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                        >
                            {row.title}
                        </span>
                        {row.subtitle && (
                            <span
                                className="font-color-secondary text-sm"
                                style={{ fontSize: '0.9rem', wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                            >
                                {row.subtitle.prefix}
                                {row.subtitle.italic ? <span className="font-italic">{row.subtitle.text}</span> : row.subtitle.text}
                            </span>
                        )}
                    </span>
                </span>
            ))}
            {footer && (
                <span className="font-color-secondary text-base mt-1" style={{ fontSize: '0.9rem' }}>
                    {footer}
                </span>
            )}
        </span>
    </span>
);

/**
 * Wraps a chip with its hover-card. The chip (`children`) stays the click
 * target; the card only appears on hover. `content` feeds the tooltip's
 * non-empty check — the card itself is supplied via `customContent`.
 *
 * `suppressed` force-closes the card and blocks it from reopening. Editable
 * chips pass their context-menu open state here so a right-click menu (rendered
 * at a lower z-index than the card) is never covered or intercepted by it.
 */
export function ChipWithPopup({
    popup,
    children,
    suppressed = false,
}: {
    popup: ChipPopupContent;
    children: React.ReactNode;
    suppressed?: boolean;
}) {
    return (
        <Tooltip
            content={popup.title}
            customContent={<ChipPopupCard {...popup} />}
            width={POPUP_WIDTH}
            padding={false}
            disabled={suppressed}
        >
            {children}
        </Tooltip>
    );
}

/**
 * Wraps the "+N" overflow chip with a hover-card listing the collapsed items.
 * Mirrors {@link ChipWithPopup} but renders a {@link ChipListPopupCard}.
 */
export function ChipWithListPopup({
    content,
    children,
    suppressed = false,
}: {
    content: ChipListPopupContent;
    children: React.ReactNode;
    suppressed?: boolean;
}) {
    return (
        <Tooltip
            content={content.rows.map((row) => row.title).join(', ')}
            customContent={<ChipListPopupCard {...content} />}
            width={POPUP_WIDTH}
            padding={false}
            disabled={suppressed || content.rows.length === 0}
        >
            {children}
        </Tooltip>
    );
}

export default ChipWithPopup;
