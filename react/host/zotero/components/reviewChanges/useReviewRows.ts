import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { getAgentActionsByRunAtom, pendingApprovalsAtom } from '../../../../agents/agentActions';
import { buildReviewRows, ReviewRow } from '../reviewChangeRows';

/**
 * The review rows for one run.
 *
 * A hook rather than card-internal state so the surrounding review block can
 * tell whether the card has anything to show: an empty card still counts as a
 * flex item in the run column and would add a `gap-4` row of blank space.
 */
export function useReviewRows(runId: string): ReviewRow[] {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const pendingApprovals = useAtomValue(pendingApprovalsAtom);

    const actions = useMemo(() => getAgentActionsByRun(runId), [getAgentActionsByRun, runId]);

    // Keyed by actionId; those actions belong to the in-stream card and PendingActionsBar.
    const liveApprovalActionIds = useMemo(
        () => new Set(pendingApprovals.keys()),
        [pendingApprovals],
    );

    return useMemo(
        () => buildReviewRows(actions, { liveApprovalActionIds }),
        [actions, liveApprovalActionIds],
    );
}
