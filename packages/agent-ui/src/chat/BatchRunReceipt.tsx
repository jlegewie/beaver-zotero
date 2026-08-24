import React, { useMemo } from 'react';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { isRunActive } from '@beaver/agent-core/agents/types';
import { selectChainBatchOutcomes } from '@beaver/agent-core/run-state/batchProgress';
import BatchDoneRows from './BatchDoneRows';

export interface BatchRunReceiptProps {
    /**
     * The runs that make up one answer, oldest first. An ordinary run is a
     * chain of one; a response continued after an interruption is several, and
     * the receipt reports on all of them. Draws nothing until they are terminal.
     */
    runs: readonly AgentRun[];
}

/** Whether `BatchRunReceipt` draws anything for these runs. */
export function hasBatchReceipt(runs: readonly AgentRun[]): boolean {
    return !runs.some(isRunActive) && selectChainBatchOutcomes(runs).length > 0;
}

/**
 * Completed batches for a terminal answer, kept in the transcript.
 *
 * Renders nothing while a run is live (the panel has its batches) or when the
 * answer finished no batch. Distinct from the changes card below it: this
 * reports how each batch as a whole came out, that one lists the individual
 * changes and offers the apply and undo for them.
 */
export const BatchRunReceipt: React.FC<BatchRunReceiptProps> = ({ runs }) => {
    // A finished run's messages no longer change, so this is computed once.
    const outcomes = useMemo(() => selectChainBatchOutcomes(runs), [runs]);
    if (runs.some(isRunActive) || outcomes.length === 0) return null;
    return (
        <div className="px-4">
            <BatchDoneRows batches={outcomes} />
        </div>
    );
};

export default BatchRunReceipt;
