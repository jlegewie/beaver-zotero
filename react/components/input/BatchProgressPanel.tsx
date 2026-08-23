import React, { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import BatchProgressBar from '@beaver/agent-ui/chat/BatchProgressBar';
import BatchDoneRows from '@beaver/agent-ui/chat/BatchDoneRows';
import { selectBatchPanelGroups } from '@beaver/agent-core/run-state/batchProgress';
import { batchProgressAtom } from '../../atoms/agentRunAtoms';

/**
 * Live batch progress above the composer.
 *
 * Renders the backend record verbatim: the batch being worked, what is still to
 * come, and — below it, so the bar's progress hairline stays the composer's top
 * edge — what this run has already finished. Nothing when no batch is open, or
 * when every open batch is below the backend's progress-bar threshold.
 */
const BatchProgressPanel: React.FC = () => {
    const stamp = useAtomValue(batchProgressAtom);

    const { tracked, done, queued } = useMemo(() => selectBatchPanelGroups(stamp), [stamp]);

    if (!tracked) return null;

    return (
        <>
            <BatchProgressBar batch={tracked} queuedBatches={queued} />
            <BatchDoneRows batches={done} />
        </>
    );
};

export default BatchProgressPanel;
