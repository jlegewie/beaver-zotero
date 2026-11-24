import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { AgentRun } from '@beaver/agent-core/agents/types';
import { dismissEarnedFeatureCreditAtom, earnedFeatureCreditsAtom } from '../../atoms/featureCreditRuns';
import FeatureCreditCompletionContent from './FeatureCreditCompletionContent';

/**
 * The reward card under a finished answer that earned a feature task's
 * credits, until the user closes it. `runs` is the answer's run chain: a
 * continued answer shows the card under its last run.
 */
const FeatureCreditRunCard: React.FC<{ runs: readonly AgentRun[] }> = ({ runs }) => {
    const earned = useAtomValue(earnedFeatureCreditsAtom);
    const dismiss = useSetAtom(dismissEarnedFeatureCreditAtom);
    const grant = earned.size > 0 ? runs.map((run) => earned.get(run.id)).find(Boolean) : undefined;
    if (!grant) return null;
    return (
        <div className="px-4">
            <FeatureCreditCompletionContent data={grant} runs={runs} onDismiss={() => dismiss(grant.runId)} />
        </div>
    );
};

export default FeatureCreditRunCard;
