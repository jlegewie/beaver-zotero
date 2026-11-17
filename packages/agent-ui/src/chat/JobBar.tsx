import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertIcon, ArrowUpRightIcon, CancelCircleIcon, CheckmarkCircleIcon, Icon, Spinner } from '../icons';
import Button from '../primitives/Button';
import IconButton from '../primitives/IconButton';
import {
    DockedBarChevron,
    DockedBarDetails,
    DockedBarHeaderRow,
    renderDockedBarHairline,
} from './DockedBarParts';
import type { HairlineSegment } from './DockedBarParts';

export interface JobViewAction {
    id: string;
    label: string;
    /** The one action the job is waiting on (Continue); drawn solid. */
    primary?: boolean;
    disabled?: boolean;
    onClick: () => void;
}

export interface JobViewLink {
    label: string;
    onClick: () => void;
}

/**
 * What the job bar renders. Each kind of background job (table fill, PDF
 * retrieval, …) builds one from client-agnostic state; the bar knows nothing
 * of the job itself.
 */
export interface JobView {
    /** Stable key among the thread's jobs. */
    id: string;
    /** 'table_fill', 'pdf_retrieval', … — for the adapter's own use. */
    kind: string;
    /** Line one: what the job does, or how it ended ("Filling table", "Table filled"). */
    verb: string;
    /** What it works on ("Soil carbon studies"): names the subject link; not shown on the bar. */
    subject?: string;
    state: 'running' | 'stopping' | 'elsewhere' | 'ready';
    /** How a `ready` job ended; drives the glyph. Defaults to clean. */
    tone?: 'clean' | 'warning' | 'error';
    /**
     * Hairline shape. `done` and `failed` are disjoint counts out of `total`
     * (a failed unit is not also counted in `done`). 'indeterminate', or none,
     * sweeps while the total is unknown.
     */
    progress?: { done: number; failed: number; total: number } | 'indeterminate';
    /** Line two: progress or result in one sentence. */
    status: string;
    /** Failures so far, after the status in the warning color ("1 failed"). */
    statusWarning?: string;
    /** The device running a job in the `elsewhere` state. */
    device?: string;
    /** The subject link (open the table). */
    open?: () => void;
    /** Short links after the status ("Show", "Add credits"). */
    links: JobViewLink[];
    /** Small buttons on line one (Stop, Continue). */
    actions: JobViewAction[];
    /** The expanded part, per job kind. Without it the bar has no toggle. */
    details?: React.ReactNode;
}

export interface JobBarProps {
    job: JobView;
    /**
     * Whether the details are open. Omit it for the bar to own the state; set
     * it (with `onExpandedChange`) when the caller must keep a bar open
     * through completion. Open stays open across changes to `job`.
     */
    expanded?: boolean;
    onExpandedChange?: (expanded: boolean) => void;
}

const GLYPH_CLASS = 'job-bar-glyph flex-none';

function JobGlyph({ job }: { job: JobView }): React.ReactElement {
    if (job.state !== 'ready') {
        return <Spinner size={14} className={`${GLYPH_CLASS} font-color-secondary`} />;
    }
    if (job.tone === 'error') {
        return <Icon icon={CancelCircleIcon} className={`${GLYPH_CLASS} font-color-red`} />;
    }
    if (job.tone === 'warning') {
        return <Icon icon={AlertIcon} className={`${GLYPH_CLASS} font-color-orange`} />;
    }
    return <Icon icon={CheckmarkCircleIcon} className={`${GLYPH_CLASS} font-color-green`} />;
}

/** The hairline for the job's state, or null where there is none (`ready`). */
function renderHairline(job: JobView): React.ReactElement | null {
    if (job.state === 'ready') return null;
    const progress = job.progress;
    const label = job.status || undefined;
    if (job.state === 'elsewhere') {
        return renderDockedBarHairline({ indeterminate: true, neutral: true, valueText: label });
    }
    // A determinate track at zero reads as stalled before the first outcome.
    if (
        !progress ||
        progress === 'indeterminate' ||
        progress.total <= 0 ||
        progress.done + progress.failed <= 0
    ) {
        return renderDockedBarHairline({ indeterminate: true, valueText: label });
    }
    const { done, failed, total } = progress;
    const failedShare = Math.min(100, (failed / total) * 100);
    const doneShare = Math.min(100 - failedShare, (done / total) * 100);
    const segments: HairlineSegment[] = [
        { share: doneShare, color: 'var(--accent-blue)' },
        { share: failedShare, color: 'var(--tag-orange)' },
    ];
    return renderDockedBarHairline({
        segments,
        valueMin: 0,
        valueMax: total,
        valueNow: Math.min(total, done + failed),
        valueText: label,
    });
}

/**
 * A background job's bar, docked to the composer's top edge in the batch bar's
 * visual language. Collapsed (the default): glyph, `verb · subject`, the
 * subject link and the actions on line one, the status and its links on line
 * two, and the hairline on the top edge. Expanded: the kind's `details` below.
 *
 * Presentational: it renders a {@link JobView} and calls back. Dismissing the
 * bar once the run resumes is the caller's business — the bar offers nothing
 * to close it.
 */
export const JobBar: React.FC<JobBarProps> = ({ job, expanded: expandedProp, onExpandedChange }) => {
    const [ownExpanded, setOwnExpanded] = useState(false);
    const expanded = expandedProp ?? ownExpanded;
    const setExpanded = (next: boolean) => {
        if (expandedProp === undefined) setOwnExpanded(next);
        onExpandedChange?.(next);
    };
    const detailsId = useId();

    // Tell screen readers when the job ends: the bar leaves a moment later.
    const [announcement, setAnnouncement] = useState('');
    const wasReady = useRef(false);
    const isReady = job.state === 'ready';
    const announcementText = [job.verb, job.status, job.statusWarning].filter(Boolean).join(' · ');
    useEffect(() => {
        if (isReady && !wasReady.current) setAnnouncement(announcementText);
        else if (!isReady) setAnnouncement('');
        wasReady.current = isReady;
    }, [isReady, announcementText]);

    const hasDetails = job.details != null && job.details !== false;
    const statusText =
        job.status || (job.state === 'elsewhere' && job.device ? `Running on ${job.device}` : '');

    return (
        <div
            className={[
                'composer-docked-bar batch-progress-bar job-bar border-bottom-quinary',
                `job-bar-${job.state}`,
            ].join(' ')}
            style={{ position: 'relative' }}
            role="group"
            aria-label={job.verb}
        >
            {renderHairline(job)}

            <div className="job-bar-body">
                <DockedBarHeaderRow>
                    <JobGlyph job={job} />
                    <span className="job-bar-title font-color-primary text-base truncate" title={job.verb}>
                        <span className="font-medium">{job.verb}</span>
                    </span>
                    {job.open && (
                        <IconButton
                            icon={ArrowUpRightIcon}
                            variant="ghost-secondary"
                            ariaLabel={job.subject ? `Open ${job.subject}` : 'Open'}
                            title={job.subject ? `Open ${job.subject}` : 'Open'}
                            onClick={() => job.open?.()}
                        />
                    )}
                    <div className="flex-1" />
                    {job.actions.map((action) => (
                        <Button
                            key={action.id}
                            variant={action.primary ? 'solid' : 'ghost'}
                            onClick={() => action.onClick()}
                            disabled={action.disabled}
                            className="flex-none whitespace-nowrap"
                            style={{ padding: action.primary ? '2px 6px' : '1px 4px' }}
                        >
                            {action.label}
                        </Button>
                    ))}
                    {hasDetails && (
                        <button
                            type="button"
                            className="variant-ghost-secondary icon-only job-bar-toggle"
                            aria-expanded={expanded}
                            aria-controls={expanded ? detailsId : undefined}
                            aria-label={expanded ? 'Hide details' : 'Show details'}
                            onClick={() => setExpanded(!expanded)}
                        >
                            <DockedBarChevron expanded={expanded} />
                        </button>
                    )}
                </DockedBarHeaderRow>

                {(statusText || job.statusWarning || job.links.length > 0) && (
                    <div className="job-bar-status text-sm">
                        {statusText && <span className="job-bar-status-text">{statusText}</span>}
                        {job.statusWarning && <span className="job-bar-status-warning">{job.statusWarning}</span>}
                        {job.links.map((link) => (
                            <button
                                key={link.label}
                                type="button"
                                className="job-bar-link"
                                onClick={() => link.onClick()}
                            >
                                {link.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {hasDetails && expanded && (
                <div id={detailsId}>
                    <DockedBarDetails>{job.details}</DockedBarDetails>
                </div>
            )}

            <div className="job-bar-live" aria-live="polite" role="status">
                {announcement}
            </div>
        </div>
    );
};

export default JobBar;
