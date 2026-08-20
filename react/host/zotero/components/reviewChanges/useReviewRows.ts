import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { getAgentActionsByRunAtom, pendingApprovalsAtom } from '../../../../agents/agentActions';
import { retainedReviewActionsAtom, sessionAppliedActionIdsAtom } from '../../../../atoms/messageUIState';
import { buildReviewRows, ReviewRow } from '../reviewChangeRows';

/** Action ids the in-stream card and PendingActionsBar own, keyed by actionId. */
function useLiveApprovalActionIds(): ReadonlySet<string> {
    const pendingApprovals = useAtomValue(pendingApprovalsAtom);
    return useMemo(() => new Set(pendingApprovals.keys()), [pendingApprovals]);
}

/** Action ids the currently rendered review card retains for this run. */
function useRetainedActionIds(runId: string): ReadonlySet<string> {
    const retainedActions = useAtomValue(retainedReviewActionsAtom);
    return useMemo(() => {
        const prefix = `${runId}:`;
        const ids = new Set<string>();
        for (const [key, retained] of Object.entries(retainedActions)) {
            if (retained && key.startsWith(prefix)) ids.add(key.slice(prefix.length));
        }
        return ids;
    }, [retainedActions, runId]);
}

/**
 * The pending review rows for one run.
 *
 * A hook rather than card-internal state so the surrounding review block can
 * tell whether the card has anything to show: an empty card still counts as a
 * flex item in the run column and would add a `gap-4` row of blank space.
 */
export function useReviewRows(runId: string): ReviewRow[] {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const liveApprovalActionIds = useLiveApprovalActionIds();
    const retainedActionIds = useRetainedActionIds(runId);

    const actions = useMemo(() => getAgentActionsByRun(runId), [getAgentActionsByRun, runId]);

    return useMemo(
        () => buildReviewRows(actions, { liveApprovalActionIds, retainedActionIds }),
        [actions, liveApprovalActionIds, retainedActionIds],
    );
}

/**
 * The rows of changes this run wrote to Zotero itself, for the same reason
 * `useReviewRows` is a hook. Scoped to writes the run made while it was live —
 * see `sessionAppliedActionIdsAtom`.
 */
export function useCompletedRows(runId: string): ReviewRow[] {
    const getAgentActionsByRun = useAtomValue(getAgentActionsByRunAtom);
    const liveApprovalActionIds = useLiveApprovalActionIds();
    const retainedActionIds = useRetainedActionIds(runId);
    const appliedActionIds = useAtomValue(sessionAppliedActionIdsAtom);

    const actions = useMemo(() => getAgentActionsByRun(runId), [getAgentActionsByRun, runId]);

    return useMemo(
        () => buildReviewRows(actions, {
            mode: 'completed',
            liveApprovalActionIds,
            retainedActionIds,
            appliedActionIds,
        }),
        [actions, appliedActionIds, liveApprovalActionIds, retainedActionIds],
    );
}
