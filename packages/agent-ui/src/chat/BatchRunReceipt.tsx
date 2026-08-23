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
 * Completed batches for a terminal run, kept in the transcript.
 *
 * Renders nothing while the run is live (the panel has them) or when the run
 * finished no batch. Distinct from the review card: this is the distribution,
 * that one is the per-change list. Rendered above it.
 */
export const BatchRunReceipt: React.FC<BatchRunReceiptProps> = ({ run }) => {
    // A finished run's messages no longer change, so this is computed once.
    const outcomes = useMemo(() => selectRunBatchOutcomes(run), [run]);
    if (isRunActive(run) || outcomes.length === 0) return null;
    return (
        <div className="px-4">
            <BatchDoneRows batches={outcomes} />
        </div>
    );
};

export default BatchRunReceipt;
