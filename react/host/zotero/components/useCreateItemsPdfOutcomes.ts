import { useEffect, useMemo, useState } from 'react';
import { type AgentAction, createdItemRef, isItemCreatingAgentAction } from '../../../agents/agentActions';
import { getTasksForItem, subscribeToTasks } from '../../../runtime/backgroundTasks';
import { isActiveAttachmentTask } from '../../../hooks/useBackgroundTasks';
import { resolveLibraryRef } from '../../../../src/utils/libraryIdentity';
import { getBestAttachmentByKind } from '../../../../src/utils/zoteroItemHelpers';
import type { ItemPdfOutcome } from './agentActionViewHelpers';

type StaleCheck = 'available' | 'failed';

interface PendingItem {
    actionId: string;
    libraryId: number | null;
    zoteroKey: string;
}

/** Whether Zotero is still fetching an attachment for the item. */
function isFetching(item: PendingItem): boolean {
    if (item.libraryId === null) return false;
    return getTasksForItem(item.libraryId, item.zoteroKey).some(isActiveAttachmentTask);
}

/** Whether the item has a PDF now, for a fetch that ended unreported. */
async function hasPdf(item: PendingItem): Promise<boolean> {
    if (item.libraryId === null) return false;
    const parent = await Zotero.Items.getByLibraryAndKeyAsync(item.libraryId, item.zoteroKey);
    if (!parent || parent.deleted) return false;
    return !!(await getBestAttachmentByKind(parent, 'pdf'));
}

/**
 * Where each applied item's PDF stands, read off the action rows for the
 * `create_items` header. A row still `pending` counts as fetching only while
 * Zotero runs its fetch. A fetch that ended without the backend hearing of it
 * (the chat was left or the socket closed meanwhile) leaves the stored row
 * `pending` for good, so the item itself is checked for a PDF instead.
 */
export function useCreateItemsPdfOutcomes(actions: AgentAction[], enabled: boolean): ItemPdfOutcome[] {
    const applied = useMemo(
        () => (enabled ? actions.filter((action) => action.status === 'applied' && isItemCreatingAgentAction(action)) : []),
        [actions, enabled],
    );
    const pending = useMemo<PendingItem[]>(() => applied.flatMap((action) => {
        const ref = createdItemRef(action);
        if (action.result_data?.attachment_status !== 'pending' || !ref) return [];
        return [{ actionId: action.id, libraryId: resolveLibraryRef(ref), zoteroKey: ref.zotero_key }];
    }), [applied]);

    // Re-read the task registry whenever a task of one of these items changes.
    const [taskRevision, setTaskRevision] = useState(0);
    const pendingKeys = pending.map((item) => `${item.libraryId}-${item.zoteroKey}`).join(',');
    useEffect(() => {
        if (!pendingKeys) return;
        const keys = new Set(pendingKeys.split(','));
        return subscribeToTasks((task) => {
            if (keys.has(`${task.libraryId}-${task.itemKey}`)) setTaskRevision((revision) => revision + 1);
        });
    }, [pendingKeys]);

    const fetching = useMemo(
        () => new Set(pending.filter(isFetching).map((item) => item.actionId)),
        // `taskRevision` stands for the registry, which is read rather than subscribed to here.
        [pending, taskRevision],
    );

    const [staleChecks, setStaleChecks] = useState<ReadonlyMap<string, StaleCheck>>(new Map());
    const unchecked = pending.filter((item) => !fetching.has(item.actionId) && !staleChecks.has(item.actionId));
    const uncheckedKey = unchecked.map((item) => item.actionId).join(',');
    useEffect(() => {
        if (unchecked.length === 0) return;
        let cancelled = false;
        void Promise.all(unchecked.map(async (item) => {
            const found = await hasPdf(item).catch(() => false);
            return [item.actionId, found ? 'available' : 'failed'] as const;
        })).then((results) => {
            if (cancelled) return;
            setStaleChecks((previous) => new Map([...previous, ...results]));
        });
        return () => { cancelled = true; };
        // The ids are the whole identity of the items to check.
    }, [uncheckedKey]);

    return useMemo(() => applied.map((action): ItemPdfOutcome => {
        const status = action.result_data?.attachment_status;
        if (status === 'available' || status === 'failed') return status;
        if (status !== 'pending') return 'none';
        if (fetching.has(action.id)) return 'fetching';
        // Unknown until the check settles.
        return staleChecks.get(action.id) ?? 'none';
    }), [applied, fetching, staleChecks]);
}
