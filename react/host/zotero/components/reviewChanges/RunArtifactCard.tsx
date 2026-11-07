import React from 'react';
import { DownloadIcon } from '@beaver/agent-ui/icons';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import MenuButton from '@beaver/agent-ui/primitives/MenuButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { ArrowDownIcon, ArrowRightIcon, ArrowUpRightIcon, Icon } from '../../../../components/icons/icons';

type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

export interface RunArtifactCardProps {
    icon: IconComponent;
    /** Line one: the artifact, or what the answer changed about it. */
    headline: string;
    /** Line two: its condition now. */
    condition?: string;
    /** Line two's marked tail, after the condition. */
    warning?: string | null;
    /** What a click on the card does: open the artifact, or unfold a group. Absent, the card is not clickable. */
    onActivate?: (event: React.SyntheticEvent) => void;
    /** The accessible name of that click, e.g. "Open note Summary". */
    activateLabel?: string;
    /** For a card that unfolds: whether it is open. */
    expanded?: boolean;
    /** The artifact is gone: line two in grey, nothing to press. */
    muted?: boolean;
    /** Drawn along the card's top edge (a fill's progress). */
    top?: React.ReactNode;
    /** The card's buttons, at the right. Clicks on them never reach the card. */
    actions?: React.ReactNode;
    /** A status line under the card (an export failure, an Undo's outcome). */
    message?: string;
    /** Rendered under the card, inside it (a group's members). */
    children?: React.ReactNode;
}

/**
 * One artifact at the end of a run, a note or a table, in one shape: a glyph,
 * two lines, and the buttons. The whole card opens the artifact; the lines
 * are also a button, so the keyboard reaches the same action.
 */
export const RunArtifactCard: React.FC<RunArtifactCardProps> = ({
    icon,
    headline,
    condition,
    warning,
    onActivate,
    activateLabel,
    expanded,
    muted = false,
    top,
    actions,
    message,
    children,
}) => {
    const interactive = !!onActivate && !muted;
    // The lines' button bubbles its click (mouse or keyboard) to here, so the
    // card handles every activation once. A click belongs to the nearest
    // card, so a group's member cards keep theirs, and the card's own buttons
    // keep theirs.
    const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!interactive) return;
        const target = event.target as Element;
        if (target.closest?.('.run-artifact') !== event.currentTarget) return;
        if (target.closest('.run-artifact-actions')) return;
        onActivate!(event);
    };

    const lines = (
        <>
            <Icon icon={icon} className="run-artifact-glyph" />
            <span className="run-artifact-lines">
                <span className="run-artifact-headline truncate" title={headline}>{headline}</span>
                {(condition || warning) && (
                    <span className="run-artifact-condition">
                        {condition}
                        {warning ? (
                            <span className="run-artifact-warning">{condition ? ' · ' : ''}{warning}</span>
                        ) : null}
                    </span>
                )}
            </span>
        </>
    );

    return (
        <div
            className={`run-artifact${interactive ? ' run-artifact-interactive' : ''}${muted ? ' run-artifact-muted' : ''}`}
            onClick={handleClick}
        >
            {top}
            <div className="run-artifact-body">
                {interactive ? (
                    <button
                        type="button"
                        className="run-artifact-target"
                        aria-label={activateLabel}
                        aria-expanded={expanded}
                    >
                        {lines}
                    </button>
                ) : (
                    <div className="run-artifact-target">{lines}</div>
                )}
                {actions && <div className="run-artifact-actions">{actions}</div>}
            </div>
            {message && <div role="status" className="run-artifact-message">{message}</div>}
            {children && <div className="run-artifact-members">{children}</div>}
        </div>
    );
};

/** A card's Export: a menu of formats, a spinner while one is written. */
export const RunArtifactExportButton: React.FC<{ items: MenuItem[]; exporting: boolean }> = ({ items, exporting }) =>
    exporting ? (
        <IconButton
            icon={DownloadIcon}
            variant="ghost-secondary"
            iconClassName="font-color-secondary scale-11"
            onClick={() => {}}
            loading
            ariaLabel="Exporting"
        />
    ) : (
        <MenuButton
            icon={DownloadIcon}
            variant="ghost-secondary"
            iconClassName="font-color-secondary scale-11"
            menuItems={items}
            tooltipContent="Export"
            ariaLabel="Export"
        />
    );

/** A card's Open (↗), the rightmost button: what a click on the card does too. */
export const RunArtifactOpenButton: React.FC<{ label: string; onClick: (event: React.SyntheticEvent) => void }> = ({
    label,
    onClick,
}) => (
    <Tooltip content={label} showArrow singleLine>
        <IconButton
            icon={ArrowUpRightIcon}
            variant="ghost-secondary"
            className="run-artifact-open"
            iconClassName="font-color-secondary scale-11"
            onClick={(event) => onClick(event as React.SyntheticEvent)}
            ariaLabel={label}
        />
    </Tooltip>
);

/** A group card's disclosure, in Open's place. */
export const RunArtifactToggleButton: React.FC<{ expanded: boolean; onClick: () => void }> = ({ expanded, onClick }) => (
    <IconButton
        icon={expanded ? ArrowDownIcon : ArrowRightIcon}
        variant="ghost-secondary"
        className="run-artifact-open"
        iconClassName="font-color-secondary scale-11"
        onClick={onClick}
        ariaLabel={expanded ? 'Hide' : 'Show all'}
    />
);

export default RunArtifactCard;
