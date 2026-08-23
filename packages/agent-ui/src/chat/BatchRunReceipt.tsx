import React, { useMemo } from 'react';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { isRunActive } from '@beaver/agent-core/agents/types';
import { selectRunBatchOutcomes } from '@beaver/agent-core/run-state/batchProgress';
import BatchDoneRows from './BatchDoneRows';

export interface BatchRunReceiptProps {
    /** The run to report on. Draws nothing until it is terminal. */
    run: AgentRun;
}

/**
 * What a run's batch operations ended up doing, kept in the transcript.
 *
 * The live panel above the composer is a "now" surface: it says what is
 * running and what just landed, and its finished batches retire with the run.
 * This is the durable half of that. Each batch the run finished stays as one
 * line under the run, opening onto the same record the bar showed while it
 * worked — so the numbers a user watched for ten minutes are still there
 * afterwards, without scrolling back to the `batch_start` card that declared
 * the batch hundreds of tool rows earlier.
 *
 * Deliberately not the run's review card: that one asks what to keep, per
 * change and undoable. This says what the batch did — the distribution above
 * all, which is the one thing a list of 184 rows cannot show. Rendered above
 * it, so the two read as summary then detail.
 *
 * Draws nothing while the run is live, because its batches are the panel's
 * until then. That is the whole of the no-double-draw rule, and it is enforced
 * here rather than left to the caller: `selectLiveBatchProgress` gives an ended
 * batch up on exactly the condition this takes it on, and the two must not be
 * able to drift. Renders nothing for a run that finished no batch either, which
 * is nearly all of them.
 */
export const BatchRunReceipt: React.FC<BatchRunReceiptProps> = ({ run }) => {
    // A finished run's messages no longer change, so this is computed once.
    const outcomes = useMemo(() => selectRunBatchOutcomes(run), [run]);
    if (isRunActive(run) || outcomes.length === 0) return null;
    return (
        <div className="px-4">
            <BatchDoneRows batches={outcomes} variant="receipt" />
        </div>
    );
};

export default BatchRunReceipt;
