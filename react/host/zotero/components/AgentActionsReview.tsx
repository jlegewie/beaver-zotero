import React from 'react';
import { useAtomValue } from 'jotai';
import { AgentRun } from '@beaver/agent-core/agents/types';
import {
    getAgentActionsByRunAtom,
    isCreateItemAgentAction,
    isZoteroNoteAgentAction,
    isCreateNoteAgentAction,
    isCreateAnnotationsAgentAction,
    CreateItemAgentAction,
    AgentAction,
} from '../../../agents/agentActions';
import CreateItemAgentActionDisplay from './CreateItemAgentActionDisplay';
import NoteAgentActionDisplay from './NoteAgentActionDisplay';
import CreateAnnotationsAgentActionDisplay from './CreateAnnotationsAgentActionDisplay';
import ReviewChangesCard from './reviewChanges/ReviewChangesCard';
import { useReviewRows } from './reviewChanges/useReviewRows';

interface AgentActionsReviewProps {
    run: AgentRun;
}

/**
 * Displays agent actions for a terminal run.
 * Supports create_item actions from citations, zotero_note/create_note actions,
 * and bulk PDF annotation actions (create_highlight_annotations / create_note_annotations),
 * followed by the review card for actions the run left undecided.
 */
export const AgentActionsReview: React.FC<AgentActionsReviewProps> = ({ run }) => {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const reviewRows = useReviewRows(run.id);

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

    // Get note actions (both inline zotero_note and tool-based create_note)
    const noteActions = getAgentActionsByRun(
        run.id,
        (action) => isZoteroNoteAgentAction(action) || isCreateNoteAgentAction(action)
    ) as AgentAction[];

    // Get bulk PDF annotation actions (create_highlight_annotations / create_note_annotations)
    const annotationActions = getAgentActionsByRun(
        run.id,
        (action) => isCreateAnnotationsAgentAction(action)
    ) as AgentAction[];

    // Don't show during streaming
    if (run.status === 'in_progress') {
        return null;
    }

    const hasCreateItems = createItemActions.length > 0 &&
        !createItemActions.every(a => a.status === 'rejected' || a.status === 'undone');
    const hasNotes = noteActions.length > 0 &&
        !noteActions.every(a => a.status === 'rejected' || a.status === 'undone');
    const hasAnnotations = annotationActions.length > 0 &&
        !annotationActions.every(a => a.status === 'rejected' || a.status === 'undone');

    // The review card is a fourth, independent display: it renders whenever the run
    // stranded something, even with all three of the others empty.
    if (!hasCreateItems && !hasNotes && !hasAnnotations && reviewRows.length === 0) {
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
            {/* {hasAnnotations && (
                <CreateAnnotationsAgentActionDisplay
                    run={run}
                    actions={annotationActions}
                />
            )} */}
            {reviewRows.length > 0 && <ReviewChangesCard run={run} rows={reviewRows} />}
        </div>
    );
};

export default AgentActionsReview;
