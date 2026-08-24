import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { getAgentActionsByRunAtom, pendingApprovalsAtom } from '../../../../agents/agentActions';
import { buildReviewRows, ReviewRow } from '../reviewChangeRows';

/** Action ids the in-stream card and PendingActionsBar own, keyed by actionId. */
function useLiveApprovalActionIds(): ReadonlySet<string> {
    const pendingApprovals = useAtomValue(pendingApprovalsAtom);
    return useMemo(() => new Set(pendingApprovals.keys()), [pendingApprovals]);
}

/**
 * Every change one run proposed, pending or settled, as the changes card's rows.
 *
 * A hook rather than card-internal state so the surrounding review block can
 * tell whether the card has anything to show: an empty card still counts as a
 * flex item in the run column and would add a `gap-4` row of blank space.
 */
export function useChangesRows(runId: string): ReviewRow[] {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const liveApprovalActionIds = useLiveApprovalActionIds();

    const actions = useMemo(() => getAgentActionsByRun(runId), [getAgentActionsByRun, runId]);

    return useMemo(
        () => buildReviewRows(actions, { liveApprovalActionIds }),
        [actions, liveApprovalActionIds],
    );
}
