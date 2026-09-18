import React, { useMemo, useRef } from 'react';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { isRunActive } from '@beaver/agent-core/agents/types';
import {
    selectChainBatchItems,
    selectChainBatchOutcomes,
    selectChainBatchPopulations,
} from '@beaver/agent-core/run-state/batchProgress';
import BatchDoneRows from './BatchDoneRows';

export interface BatchRunReceiptProps {
    /**
     * Every run of the thread, oldest first, when the caller has them. Both
     * item records are written once and can sit in an earlier answer than the
     * one this receipt is under: the population record where the batch
     * STARTED, and the outcome record where it ENDED, which a later answer
     * that only restated the batch (a goal update) does not carry again. So
     * the records are looked up through the thread up to this answer's last
     * run — never past it, since a record written after this answer describes
     * a newer state than the counts drawn here. Which batches the receipt
     * draws stays decided by `runs` alone. Falls back to `runs` when absent.
     */
    historyRuns?: readonly AgentRun[];
    /**
     * The runs that make up one answer, oldest first. An ordinary run is a
     * chain of one; a response continued after an interruption is several, and
     * the receipt reports on all of them. Draws nothing until they are terminal.
     */
    runs: readonly AgentRun[];
}

/**
 * The thread through this answer's last run, oldest first, plus any run of
 * the answer the thread does not hold yet — a run that failed or was stopped
 * stays in the active slot until the next send, and its answer is the one
 * whose receipt most needs the records written before it. Without a thread,
 * the answer's own runs.
 */
function historyThrough(
    historyRuns: readonly AgentRun[] | undefined,
    runs: readonly AgentRun[],
): readonly AgentRun[] {
    if (!historyRuns) return runs;
    const known = new Set(historyRuns.map((run) => run.id));
    const missing = runs.filter((run) => !known.has(run.id));
    let end = historyRuns.length;
    for (let index = runs.length - 1; index >= 0; index--) {
        const position = historyRuns.findIndex((run) => run.id === runs[index].id);
        if (position !== -1) {
            end = position + 1;
            break;
        }
    }
    return missing.length ? [...historyRuns.slice(0, end), ...missing] : historyRuns.slice(0, end);
}

const NO_RUNS: readonly AgentRun[] = [];

/**
 * The previous array when it holds the very same run objects in the same
 * order, else the new one — so a memo keyed on it re-runs on a changed run,
 * not on a rebuilt list of unchanged ones.
 */
function useSameRuns(runs: readonly AgentRun[]): readonly AgentRun[] {
    const previous = useRef(runs);
    const same =
        previous.current.length === runs.length
        && previous.current.every((run, index) => run === runs[index]);
    if (!same) previous.current = runs;
    return previous.current;
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
export const BatchRunReceipt: React.FC<BatchRunReceiptProps> = ({ runs, historyRuns }) => {
    const active = runs.some(isRunActive);
    // A finished run's messages no longer change, so this is computed once.
    const outcomes = useMemo(() => selectChainBatchOutcomes(runs), [runs]);
    // The item records ride on the same carrier, wherever in the thread up to
    // here they were written; older threads have none. The thread array is
    // replaced on every append while the runs already in it keep their
    // objects, so the walk is keyed on the run objects, not the array: a long
    // thread with many receipts must not re-read all of its messages per
    // receipt on every new run, and a run replaced by a reload — the same id,
    // its records now filled in — is a new object and is read again. Nothing
    // is read while the answer is live, since the receipt draws nothing then.
    const recordRuns = useMemo(() => historyThrough(historyRuns, runs), [historyRuns, runs]);
    const recordSource = useSameRuns(active ? NO_RUNS : recordRuns);
    const itemsByBatch = useMemo(() => selectChainBatchItems(recordSource), [recordSource]);
    const populationsByBatch = useMemo(() => selectChainBatchPopulations(recordSource), [recordSource]);
    if (active || outcomes.length === 0) return null;
    return (
        <div className="px-4">
            <BatchDoneRows batches={outcomes} itemsByBatch={itemsByBatch} populationsByBatch={populationsByBatch} />
        </div>
    );
};

export default BatchRunReceipt;
