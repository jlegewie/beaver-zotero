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
    run: AgentRun;
}

/**
 * Displays agent actions for a terminal run: what it produced, then the imports
 * it suggests, then the card of every library change it proposed, pending or
 * settled.
 *
 * The three are disjoint by construction, so a run's work is never reported
 * twice. Most runs show exactly one of them.
 */
export const AgentActionsReview: React.FC<AgentActionsReviewProps> = ({ run }) => {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const changesRows = useChangesRows(run.id);
    const artifactRows = useArtifactRows(run.id);

    // Get create item actions with toolcall_id 'citations' (from citation extraction)
    // Sort by citation count (descending) for consistent ordering
    const createItemActions = (getAgentActionsByRun(
        run.id,
        (action) => isCreateItemAgentAction(action) && action.toolcall_id === 'citations'
    ) as CreateItemAgentAction[]).sort((a, b) => {
        const countA = a.proposed_data.item.citation_count ?? 0;
        const countB = b.proposed_data.item.citation_count ?? 0;
        return countB - countA;
    });

    // Don't show during streaming
    if (run.status === 'in_progress') {
        return null;
    }

    const hasCreateItems = createItemActions.length > 0 &&
        !createItemActions.every(a => a.status === 'rejected' || a.status === 'undone');

    // Every change the run touched gets the card, whatever their number and
    // whatever became of them: one place, one label, so "what did this do to my
    // library" is answered the same way for every run.
    const showChangesCard = changesRows.length > 0;

    // The three displays are independent: each renders whenever the run has
    // something for it, and a run commonly has something for only one.
    if (!hasCreateItems && !showChangesCard && artifactRows.length === 0) {
        return null;
    }

    return (
        <div className="px-4 display-flex flex-col gap-2">
            {/* What the run made comes first: it is the most likely thing to be
                opened, and the answer above it has just finished describing it. */}
            <ArtifactsList runId={run.id} rows={artifactRows} />
            {hasCreateItems && (
                <CreateItemAgentActionDisplay
                    runId={run.id}
                    actions={createItemActions}
                />
            )}
            {showChangesCard && <ChangesCard run={run} rows={changesRows} />}
        </div>
    );
};

export default AgentActionsReview;
