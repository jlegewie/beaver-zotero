import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { getAgentActionsByRunAtom, pendingApprovalsAtom } from '../../../../agents/agentActions';
import { buildReviewRows, ReviewRow, RunActionRowSet } from '../reviewChangeRows';

/** Action ids the in-stream card and PendingActionsBar own, keyed by actionId. */
function useLiveApprovalActionIds(): ReadonlySet<string> {
    const pendingApprovals = useAtomValue(pendingApprovalsAtom);
    return useMemo(() => new Set(pendingApprovals.keys()), [pendingApprovals]);
}

/**
 * One run's rows for one bottom-of-run surface, pending or settled.
 *
 * A hook rather than component-internal state so the surrounding review block
 * can tell whether a surface has anything to show: an empty one still counts as
 * a flex item in the run column and would add a `gap-2` row of blank space.
 */
function useRunActionRows(runId: string, include: RunActionRowSet): ReviewRow[] {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const liveApprovalActionIds = useLiveApprovalActionIds();

    const actions = useMemo(() => getAgentActionsByRun(runId), [getAgentActionsByRun, runId]);

    return useMemo(
        () => buildReviewRows(actions, { liveApprovalActionIds, include }),
        [actions, include, liveApprovalActionIds],
    );
}

/** What the run did to the library, for `ChangesCard`. Excludes artifacts. */
export function useChangesRows(runId: string): ReviewRow[] {
    return useRunActionRows(runId, 'changes');
}

/** What the run produced for the user to open, for `ArtifactsList`. */
export function useArtifactRows(runId: string): ReviewRow[] {
    return useRunActionRows(runId, 'artifacts');
}
