import React from 'react';
import { useAtomValue } from 'jotai';
import { AgentRun } from '../../agents/types';
import {
    getAgentActionsByRunAtom,
    isCreateItemAgentAction,
    CreateItemAgentAction,
} from '../../agents/agentActions';
import CreateItemAgentActionDisplay from './CreateItemAgentActionDisplay';

interface AgentActionsDisplayProps {
    run: AgentRun;
}

/**
 * Displays agent actions for a completed run.
 * Currently supports create_item actions from citations.
 */
export const AgentActionsDisplay: React.FC<AgentActionsDisplayProps> = ({ run }) => {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);

    // Get create item actions with toolcall_id 'citations' (from citation extraction)
    const createItemActions = getAgentActionsByRun(
        run.id,
        (action) => isCreateItemAgentAction(action) && action.toolcall_id === 'citations'
    ) as CreateItemAgentAction[];

    // Don't show during streaming
    if (run.status === 'in_progress') {
        return null;
    }

    // Don't show if no actions or all are rejected/undone/error
    if (
        createItemActions.length === 0 ||
        createItemActions.every(
            (action) =>
                action.status === 'rejected' ||
                action.status === 'undone' ||
                action.status === 'error'
        )
    ) {
        return null;
    }

    return (
        <CreateItemAgentActionDisplay
            runId={run.id}
            actions={createItemActions}
        />
    );
};

export default AgentActionsDisplay;

