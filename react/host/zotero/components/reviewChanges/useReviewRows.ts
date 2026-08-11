import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { getAgentActionsByRunAtom, pendingApprovalsAtom } from '../../../../agents/agentActions';
import { retainedReviewActionsAtom } from '../../../../atoms/messageUIState';
import { buildReviewRows, hasPendingReviewRows, ReviewRow } from '../reviewChangeRows';

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
    const retainedActions = useAtomValue(retainedReviewActionsAtom);

    const actions = useMemo(() => getAgentActionsByRun(runId), [getAgentActionsByRun, runId]);

    // Keyed by actionId; those actions belong to the in-stream card and PendingActionsBar.
    const liveApprovalActionIds = useMemo(
        () => new Set(pendingApprovals.keys()),
        [pendingApprovals],
    );

    const retainedActionIds = useMemo(() => {
        const prefix = `${runId}:`;
        const ids = new Set<string>();
        for (const [key, retained] of Object.entries(retainedActions)) {
            if (retained && key.startsWith(prefix)) ids.add(key.slice(prefix.length));
        }
        return ids;
    }, [retainedActions, runId]);

    return useMemo(() => {
        const rows = buildReviewRows(actions, { liveApprovalActionIds, retainedActionIds });
        // Retained rows stabilize the card only while work remains. Once the last
        // pending action settles, remove the entire card in one render.
        return hasPendingReviewRows(rows) ? rows : [];
    }, [actions, liveApprovalActionIds, retainedActionIds]);
}
