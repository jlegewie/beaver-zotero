import React from 'react';
import { useAtomValue } from 'jotai';
import { AgentRun } from '@beaver/agent-core/agents/types';
import {
    getAgentActionsByRunAtom,
    isCreateItemAgentAction,
    CreateItemAgentAction,
} from '../../../agents/agentActions';
import CreateItemAgentActionDisplay from './CreateItemAgentActionDisplay';
import ArtifactsList from './reviewChanges/ArtifactsList';
import ChangesCard from './reviewChanges/ChangesCard';
import { useArtifactRows, useChangesRows } from './reviewChanges/useRunActionRows';

interface AgentActionsReviewProps {
    /** The one or more runs that make up a single answer. */
    runs: AgentRun[];
}

/**
 * Displays agent actions for one terminal answer: what it produced, then the
 * imports it suggests, then one card containing every library change it
 * proposed, pending or settled. A continued answer spans several runs, but is
 * still one answer and therefore gets one review block.
 *
 * The three are disjoint by construction, so an answer's work is never
 * reported twice. Most answers show exactly one of them.
 */
export const AgentActionsReview: React.FC<AgentActionsReviewProps> = ({ runs }) => {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const runIds = React.useMemo(() => runs.map((run) => run.id), [runs]);
    const changesRows = useChangesRows(runIds);
    const artifactRows = useArtifactRows(runIds);
    const lastRun = runs[runs.length - 1];

    // Citation imports retain their per-run control because that component's
    // mutations are scoped to a run. The library changes below are aggregated.
    const createItemActionsByRun = React.useMemo(() => runs.map((run) => ({
        runId: run.id,
        actions: (getAgentActionsByRun(
            run.id,
            (action) => isCreateItemAgentAction(action) && action.toolcall_id === 'citations'
        ) as CreateItemAgentAction[]).sort((a, b) => {
            const countA = a.proposed_data.item.citation_count ?? 0;
            const countB = b.proposed_data.item.citation_count ?? 0;
            return countB - countA;
        }),
    })).filter(({ actions }) =>
        actions.length > 0 &&
        !actions.every((action) => action.status === 'rejected' || action.status === 'undone')
    ), [getAgentActionsByRun, runs]);

    // Don't show during streaming
    if (!lastRun || lastRun.status === 'in_progress') {
        return null;
    }

    const hasCreateItems = createItemActionsByRun.length > 0;

    // Every change the answer touched gets the card, whatever their number and
    // whatever became of them: one place, one label, so "what did this do to my
    // library" is answered the same way for every run.
    const showChangesCard = changesRows.length > 0;

    // The three displays are independent: each renders whenever the answer has
    // something for it, and an answer commonly has something for only one.
    if (!hasCreateItems && !showChangesCard && artifactRows.length === 0) {
        return null;
    }

    return (
        <div className="px-4 display-flex flex-col gap-2">
            {/* What the answer made comes first: it is the most likely thing to be
                opened, and the answer above it has just finished describing it. */}
            <ArtifactsList rows={artifactRows} />
            {createItemActionsByRun.map(({ runId, actions }) => (
                <CreateItemAgentActionDisplay
                    key={runId}
                    runId={runId}
                    actions={actions}
                />
            ))}
            {showChangesCard && <ChangesCard runId={lastRun.id} rows={changesRows} />}
        </div>
    );
};

export default AgentActionsReview;
