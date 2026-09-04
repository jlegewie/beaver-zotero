import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { getAgentActionsByRunAtom, pendingApprovalsAtom } from '../../../../agents/agentActions';
import { buildReviewRowsForRunChain, ReviewRow, RunActionRowSet } from '../reviewChangeRows';

/** Action ids the in-stream card and PendingActionsBar own, keyed by actionId. */
function useLiveApprovalActionIds(): ReadonlySet<string> {
    const pendingApprovals = useAtomValue(pendingApprovalsAtom);
    return useMemo(() => new Set(pendingApprovals.keys()), [pendingApprovals]);
}

/**
 * One answer's rows for one bottom-of-run surface, pending or settled. A
 * continued answer can span several durable run records.
 *
 * A hook rather than component-internal state so the surrounding review block
 * can tell whether a surface has anything to show: an empty one still counts as
 * a flex item in the run column and would add a `gap-2` row of blank space.
 */
function useRunActionRows(runIds: string[], include: RunActionRowSet): ReviewRow[] {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const liveApprovalActionIds = useLiveApprovalActionIds();

    const actionsByRun = useMemo(
        () => runIds.map((runId) => getAgentActionsByRun(runId)),
        [getAgentActionsByRun, runIds],
    );

    return useMemo(
        () => buildReviewRowsForRunChain(actionsByRun, { liveApprovalActionIds, include }),
        [actionsByRun, include, liveApprovalActionIds],
    );
}

/** What the answer did to the library, for `ChangesCard`. Excludes artifacts. */
export function useChangesRows(runIds: string[]): ReviewRow[] {
    return useRunActionRows(runIds, 'changes');
}

/** What the answer produced for the user to open, for `ArtifactsList`. */
export function useArtifactRows(runIds: string[]): ReviewRow[] {
    return useRunActionRows(runIds, 'artifacts');
}
