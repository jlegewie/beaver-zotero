import React from 'react';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';

/**
 * A running fill's rule along the top edge of its row: rows filled in blue,
 * rows that could not be read in orange, a sweep until the first row
 * finishes, faded while stopping. The fill bar above the composer and the
 * table receipt under an answer both draw it.
 */
export function FillProgressRule({ job }: { job: TableFillJobSnapshot }): React.ReactElement {
    const total = job.rows_total;
    const done = job.rows_done;
    const stopping = job.state === 'stopping';
    const share = total > 0 ? (done / total) * 100 : 0;
    const failedShare = total > 0 ? (Math.min(job.rows_failed, done) / total) * 100 : 0;
    return (
        <div
            className={`table-fill-progress-rule${stopping ? ' table-fill-progress-rule-stopping' : ''}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-valuetext={`${done} of ${total} items filled`}
        >
            {done === 0 && !stopping ? (
                <div className="batch-progress-indeterminate" />
            ) : (
                <>
                    <span className="table-fill-progress-filled" style={{ width: `${share - failedShare}%` }} />
                    <span className="table-fill-progress-failed" style={{ width: `${failedShare}%` }} />
                </>
            )}
        </div>
    );
}
