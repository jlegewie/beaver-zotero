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
import { useCompletedRows, useReviewRows } from './reviewChanges/useReviewRows';

interface AgentActionsReviewProps {
    run: AgentRun;
}

/**
 * Displays agent actions for a terminal run: the citation imports, then the
 * changes the run left undecided, then the changes it has already written.
 */
export const AgentActionsReview: React.FC<AgentActionsReviewProps> = ({ run }) => {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const reviewRows = useReviewRows(run.id);
    const completedRows = useCompletedRows(run.id);

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

    // The two change cards are independent displays: either renders whenever the
    // run has rows for it, even with the citation import list empty.
    if (!hasCreateItems && reviewRows.length === 0 && completedRows.length === 0) {
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
            {reviewRows.length > 0 && <ChangesCard run={run} rows={reviewRows} />}
            {completedRows.length > 0 && (
                <ChangesCard run={run} rows={completedRows} mode="completed" />
            )}
        </div>
    );
};

export default AgentActionsReview;
