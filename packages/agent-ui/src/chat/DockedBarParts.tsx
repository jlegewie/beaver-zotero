import React from 'react';
import { ArrowDownIcon, Icon } from '../icons';

/*
 * The pieces every bar docked above the composer shares — the batch progress
 * bar and the job bar. Keeping them here is what keeps the two matching: the
 * 2px hairline, the header row, the expand chevron and the details frame.
 */

/** One run of the hairline: its share of the track (0–100) and its colour. */
export interface HairlineSegment {
    share: number;
    color: string;
}

export interface DockedBarHairlineProps {
    /** Coloured runs, in order. Ignored while `indeterminate`. */
    segments?: readonly HairlineSegment[];
    /** A sweep instead of segments, for work whose size is not known yet. */
    indeterminate?: boolean;
    /** Fade the hairline out (the bar's end, or a body that draws the track). */
    hidden?: boolean;
    /** Muted sweep colour, for work this window is not driving. */
    neutral?: boolean;
    valueMin?: number;
    valueMax?: number;
    valueNow?: number;
    valueText?: string;
}

/**
 * The 2px segmented hairline along a docked bar's top edge. Overlaid on the
 * bar (absolute) so it does not stack on the composer's 1px top border; the
 * bar must be `position: relative`.
 *
 * A plain function rather than a component so the DOM node sits in the
 * caller's own element tree.
 */
export function renderDockedBarHairline({
    segments = [],
    indeterminate = false,
    hidden = false,
    neutral = false,
    valueMin,
    valueMax,
    valueNow,
    valueText,
}: DockedBarHairlineProps): React.ReactElement {
    return (
        <div
            className={`display-flex flex-row batch-progress-hairline${neutral ? ' job-bar-hairline-neutral' : ''}`}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: 2,
                opacity: hidden ? 0 : 1,
                overflow: 'hidden',
                pointerEvents: 'none',
                transition: 'opacity 0.7s ease',
            }}
            role="progressbar"
            aria-valuemin={valueMin}
            aria-valuemax={valueMax}
            aria-valuenow={valueNow}
            aria-valuetext={valueText}
        >
            {indeterminate ? (
                <div className="batch-progress-indeterminate" />
            ) : (
                segments.map((segment, i) => (
                    <div
                        key={i}
                        style={{ width: `${segment.share}%`, backgroundColor: segment.color }}
                    />
                ))
            )}
        </div>
    );
}

/** The bar's first line: a flex row whose children are glyph, title and controls. */
export const DockedBarHeaderRow: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <div className="display-flex flex-row items-center gap-2 min-w-0">{children}</div>
);

/** The expand/collapse arrow; points down when closed, up when open. */
export const DockedBarChevron: React.FC<{ expanded: boolean }> = ({ expanded }) => (
    <Icon
        icon={ArrowDownIcon}
        className="font-color-secondary flex-none scale-85 transition"
        style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
    />
);

/**
 * The frame of a bar's expanded part: padded to the bar's edges, blocks
 * separated by `gap-5`. Bounded, it scrolls inside a viewport-relative cap
 * rather than growing — the composer block never shrinks and would otherwise
 * push the pane down.
 */
export const DockedBarDetails: React.FC<{
    bounded?: boolean;
    className?: string;
    children?: React.ReactNode;
}> = ({ bounded = true, className, children }) => (
    <div
        className={['display-flex flex-col gap-5 px-3 pb-3 min-w-0', className].filter(Boolean).join(' ')}
        style={
            bounded
                ? {
                      maxHeight: 'max(120px, calc(100vh - 320px))',
                      overflowY: 'auto',
                      overflowX: 'hidden',
                  }
                : undefined
        }
    >
        {children}
    </div>
);
