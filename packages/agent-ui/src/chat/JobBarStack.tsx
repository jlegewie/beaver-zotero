import React, { useState } from 'react';
import { DockedBarChevron, DockedBarHeaderRow } from './DockedBarParts';
import JobBar from './JobBar';
import type { JobView } from './JobBar';

/** Bars shown before the rest fold into "+N more". */
const VISIBLE_BARS = 2;

export interface JobBarStackProps {
    jobs: readonly JobView[];
}

/**
 * The thread's jobs, one bar each, stacked flush like any docked bars. Up to
 * two show as they are; from three on, the first two stay and the rest fold
 * into a "+N more" toggle that opens them all.
 *
 * Bars are direct siblings (a fragment, no wrapper): the docked-bar stacking
 * rule is an adjacent-sibling selector.
 */
export const JobBarStack: React.FC<JobBarStackProps> = ({ jobs }) => {
    const [showAll, setShowAll] = useState(false);
    const folds = jobs.length > VISIBLE_BARS;
    const hidden = folds ? jobs.length - VISIBLE_BARS : 0;
    const visible = folds && !showAll ? jobs.slice(0, VISIBLE_BARS) : jobs;

    return (
        <>
            {visible.map((job) => (
                <JobBar key={job.id} job={job} />
            ))}
            {folds && (
                <div className="composer-docked-bar batch-progress-bar job-bar job-bar-more border-bottom-quinary">
                    <button
                        type="button"
                        className="job-bar-more-toggle px-3 py-1"
                        aria-expanded={showAll}
                        onClick={() => setShowAll(!showAll)}
                    >
                        <DockedBarHeaderRow>
                            <span className="font-color-secondary text-sm">
                                {showAll ? 'Show fewer' : `+${hidden} more`}
                            </span>
                            <div className="flex-1" />
                            <DockedBarChevron expanded={showAll} />
                        </DockedBarHeaderRow>
                    </button>
                </div>
            )}
        </>
    );
};

export default JobBarStack;
