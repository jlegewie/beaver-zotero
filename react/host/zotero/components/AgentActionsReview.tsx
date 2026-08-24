import React from 'react';
import { useAtomValue } from 'jotai';
import { AgentRun } from '@beaver/agent-core/agents/types';
import {
    getAgentActionsByRunAtom,
    isCreateItemAgentAction,
    CreateItemAgentAction,
} from '../../../agents/agentActions';
import CreateItemAgentActionDisplay from './CreateItemAgentActionDisplay';
import ChangesCard from './reviewChanges/ChangesCard';
import { shouldShowChangesCard } from './reviewChangeRows';
import { useChangesRows } from './reviewChanges/useChangesRows';

interface AgentActionsReviewProps {
    run: AgentRun;
}

/**
 * Displays agent actions for a terminal run: the citation imports, then the
 * card of every library change the run proposed, pending or settled.
 */
export const AgentActionsReview: React.FC<AgentActionsReviewProps> = ({ run }) => {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const changesRows = useChangesRows(run.id);

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

    // A single changed unit is already the in-stream action card, except a
    // created note — this card replaced that dedicated display.
    const showChangesCard = shouldShowChangesCard(changesRows);

    // The two displays are independent: either renders whenever the run has
    // something for it, even with the citation import list empty.
    if (!hasCreateItems && !showChangesCard) {
        return null;
    }

    return (
        <div className="px-4 display-flex flex-col gap-2">
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
