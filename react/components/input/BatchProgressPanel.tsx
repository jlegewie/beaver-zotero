import React, { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import BatchProgressBar from '@beaver/agent-ui/chat/BatchProgressBar';
import { selectTrackedBatch } from '@beaver/agent-core/run-state/batchProgress';
import { batchProgressAtom } from '../../atoms/agentRunAtoms';

/**
 * Live batch progress above the composer.
 *
 * Renders the backend record verbatim. Nothing when no batch is open, or when
 * every open batch is below the backend's progress-bar threshold.
 */
const BatchProgressPanel: React.FC = () => {
    const stamp = useAtomValue(batchProgressAtom);

    const tracked = useMemo(() => selectTrackedBatch(stamp), [stamp]);
    const others = useMemo(
        () => (stamp?.batches ?? []).filter((entry) => entry !== tracked),
        [stamp, tracked],
    );

    if (!tracked) return null;

    return <BatchProgressBar batch={tracked} otherBatches={others} />;
};

export default BatchProgressPanel;
