import React from 'react';
import { useAtomValue } from 'jotai';
import { AgentRun } from '../../agents/types';
import {
    getAgentActionsByRunAtom,
    isCreateItemAgentAction,
    isZoteroNoteAgentAction,
    CreateItemAgentAction,
    AgentAction,
} from '../../agents/agentActions';
import CreateItemAgentActionDisplay from './CreateItemAgentActionDisplay';
import NoteAgentActionDisplay from './NoteAgentActionDisplay';

interface AgentActionsReviewProps {
    run: AgentRun;
}

/**
 * Displays agent actions for a completed run.
 * Supports create_item actions from citations and zotero_note actions.
 */
export const AgentActionsReview: React.FC<AgentActionsReviewProps> = ({ run }) => {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);

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

    // Get note actions
    const noteActions = getAgentActionsByRun(
        run.id,
        (action) => isZoteroNoteAgentAction(action)
    ) as AgentAction[];

    // Don't show during streaming
    if (run.status === 'in_progress') {
        return null;
    }

    const hasCreateItems = createItemActions.length > 0 &&
        !createItemActions.every(a => a.status === 'rejected' || a.status === 'undone');
    const hasNotes = noteActions.length > 0 &&
        !noteActions.every(a => a.status === 'rejected' || a.status === 'undone');

    if (!hasCreateItems && !hasNotes) {
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
            {hasNotes && (
                <NoteAgentActionDisplay
                    run={run}
                    actions={noteActions}
                />
            )}
        </div>
    );
};

export default AgentActionsReview;
