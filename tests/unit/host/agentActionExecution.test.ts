import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

vi.mock('../../../react/utils/editNoteActions', () => ({
    executeEditNoteOrBatchAction: vi.fn(),
    undoEditNoteOrBatchAction: vi.fn(),
    getUserFacingErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock('../../../react/host/zotero/editNotePreviewLifecycle', () => ({
    dismissActiveEditNotePreview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../react/utils/createItemActions', () => ({
    executeCreateItemActions: vi.fn(),
    undoCreateItemActions: vi.fn(),
}));

vi.mock('../../../react/utils/mergeItemsActions', () => ({
    executeMergeItemsAction: vi.fn(),
    undoMergeItemsAction: vi.fn(),
    refreshMergeItemsProposal: vi.fn(),
}));

vi.mock('@beaver/agent-core/transport/clients/agentActionsService', () => ({
    agentActionsService: {
        acknowledgeActions: vi.fn().mockResolvedValue({ success: true, errors: [] }),
        updateAction: vi.fn().mockResolvedValue({ success: true, errors: [] }),
    },
}));

import { executeEditNoteOrBatchAction } from '../../../react/utils/editNoteActions';
import { executeCreateItemActions, undoCreateItemActions } from '../../../react/utils/createItemActions';
import { executeMergeItemsAction, refreshMergeItemsProposal } from '../../../react/utils/mergeItemsActions';
import { agentActionsService } from '@beaver/agent-core/transport/clients/agentActionsService';
import { threadAgentActionsAtom } from '../../../react/agents/agentActions';
import { mergeItemsChoicesAtom } from '../../../react/atoms/mergeItemsChoices';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
    refreshMergeProposalsAtom,
    rejectAgentActionsAtom,
    undoAgentActionsAtom,
} from '../../../react/host/zotero/agentActionExecution';

const action = (): AgentAction => ({
    id: 'note-edit-1',
    run_id: 'run-1',
    toolcall_id: 'call-1',
    action_type: 'edit_note',
    status: 'pending',
    proposed_data: {},
});

describe('note-edit action execution', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('refuses a rejection while the same action is being applied', async () => {
        const store = createStore();
        const pendingAction = action();
        store.set(threadAgentActionsAtom, [pendingAction]);

        let finishApply!: (result: Record<string, unknown>) => void;
        vi.mocked(executeEditNoteOrBatchAction).mockImplementationOnce(
            () => new Promise((resolve) => {
                finishApply = resolve;
            }) as any,
        );

        const applyPromise = store.set(applyAgentActionsAtom, {
            actions: [pendingAction],
            runId: pendingAction.run_id,
        });

        expect(store.get(inFlightAgentActionIdsAtom).has(pendingAction.id)).toBe(true);

        store.set(rejectAgentActionsAtom, { actions: [pendingAction] });
        expect(store.get(threadAgentActionsAtom)[0].status).toBe('pending');

        // Let the executor reach the mocked note write after dismissing the
        // preview, then complete it and verify the action settles as applied.
        await Promise.resolve();
        finishApply({ library_id: 1, zotero_key: 'NOTEKEY1' });
        await applyPromise;

        expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
        expect(store.get(inFlightAgentActionIdsAtom).has(pendingAction.id)).toBe(false);
    });
});

const createItemAction = (id: string, overrides: Partial<AgentAction> = {}): AgentAction => ({
    id,
    run_id: 'run-1',
    toolcall_id: 'call-import',
    action_type: 'create_item',
    status: 'applied',
    proposed_data: { item: {} },
    result_data: { library_id: 1, zotero_key: `KEY-${id}` },
    ...overrides,
} as AgentAction);

describe('create_item undo retry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('retries the items whose undo failed rather than skipping them', async () => {
        const store = createStore();
        // A batch import where undoing the third item failed: it kept its
        // result_data because the item is still in the library.
        const undoneA = createItemAction('a', { status: 'undone', result_data: undefined });
        const undoneB = createItemAction('b', { status: 'undone', result_data: undefined });
        const failedC = createItemAction('c', { status: 'error' });
        store.set(threadAgentActionsAtom, [undoneA, undoneB, failedC]);

        vi.mocked(undoCreateItemActions).mockResolvedValue({ successes: ['c'], failures: [] });

        const result = await store.set(undoAgentActionsAtom, {
            actions: [undoneA, undoneB, failedC],
        });

        expect(vi.mocked(undoCreateItemActions).mock.calls[0][0].map((item) => item.id)).toEqual(['c']);
        expect(result.undone).toEqual(['c']);
        expect(store.get(threadAgentActionsAtom).find((item) => item.id === 'c')?.status).toBe('undone');
    });

    it('leaves a failed apply alone, since it created nothing to undo', async () => {
        const store = createStore();
        const failedApply = createItemAction('a', { status: 'error', result_data: undefined });
        store.set(threadAgentActionsAtom, [failedApply]);

        const result = await store.set(undoAgentActionsAtom, { actions: [failedApply] });

        expect(undoCreateItemActions).not.toHaveBeenCalled();
        expect(result.undone).toEqual([]);
    });
});

describe('create_item batch apply', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('leaves an unconfirmed action out, since it may already be in the library', async () => {
        const store = createStore();
        const pending = createItemAction('a', { status: 'pending', result_data: undefined });
        const unconfirmed = createItemAction('b', {
            status: 'error',
            result_data: undefined,
            error_details: { outcome: 'unconfirmed', reason: 'no_result' },
        });
        store.set(threadAgentActionsAtom, [pending, unconfirmed]);
        vi.mocked(executeCreateItemActions).mockResolvedValue({ successes: [], failures: [] } as any);

        await store.set(applyAgentActionsAtom, { actions: [pending, unconfirmed], runId: 'run-1' });

        expect(vi.mocked(executeCreateItemActions).mock.calls[0][0].map((item) => item.id)).toEqual(['a']);
    });

    it('records a failed batch only on the actions it attempted', async () => {
        const store = createStore();
        const pending = createItemAction('a', { status: 'pending', result_data: undefined });
        const unconfirmed = createItemAction('b', {
            status: 'error',
            result_data: undefined,
            error_details: { outcome: 'unconfirmed', reason: 'no_result' },
        });
        store.set(threadAgentActionsAtom, [pending, unconfirmed]);
        vi.mocked(executeCreateItemActions).mockRejectedValue(new Error('Zotero failed'));

        const result = await store.set(applyAgentActionsAtom, { actions: [pending, unconfirmed], runId: 'run-1' });

        expect(result.failed.map((failure) => failure.actionId)).toEqual(['a']);
        const stored = store.get(threadAgentActionsAtom);
        expect(stored.find((item) => item.id === 'a')?.status).toBe('error');
        expect(stored.find((item) => item.id === 'b')?.error_details).toEqual({ outcome: 'unconfirmed', reason: 'no_result' });
    });
});


const staleMerge = (overrides: Partial<AgentAction> = {}): AgentAction => ({
    id: 'merge-1',
    run_id: 'run-1',
    toolcall_id: 'call-merge',
    action_type: 'merge_items',
    status: 'error',
    proposed_data: {
        master_item_id: 'u-AAAA1111',
        other_item_ids: ['u-BBBB2222'],
        field_sources: {},
        snapshot: { 'u-AAAA1111': { title: 'Old' } },
    },
    error_message: 'Items changed since this merge was proposed. Inspect and propose the merge again.',
    error_details: { error_code: 'stale_snapshot' },
    ...overrides,
} as AgentAction);

describe('refreshing a stale merge proposal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('re-proposes the merge with the reviewed choices and returns it to review', async () => {
        const store = createStore();
        const stale = staleMerge();
        store.set(threadAgentActionsAtom, [stale]);
        store.set(mergeItemsChoicesAtom, {
            [stale.id]: { master_item_id: 'u-BBBB2222', field_sources: { title: 'u-AAAA1111' }, creators_source_item_id: null },
        });
        const fresh = {
            master_item_id: 'u-BBBB2222',
            other_item_ids: ['u-AAAA1111'],
            field_sources: { title: 'u-AAAA1111' },
            snapshot: { 'u-AAAA1111': { title: 'New' } },
        };
        vi.mocked(refreshMergeItemsProposal).mockResolvedValue(fresh as any);

        const result = await store.set(refreshMergeProposalsAtom, { actions: [stale] });

        expect(result).toEqual({ refreshed: [stale.id], failed: [] });
        expect(vi.mocked(refreshMergeItemsProposal).mock.calls[0][0]).toMatchObject({
            master_item_id: 'u-BBBB2222',
            other_item_ids: ['u-AAAA1111'],
            field_sources: { title: 'u-AAAA1111' },
        });
        const refreshed = store.get(threadAgentActionsAtom)[0];
        expect(refreshed.status).toBe('pending');
        expect(refreshed.proposed_data).toEqual(fresh);
        expect(refreshed.error_message).toBeUndefined();
        expect(refreshed.error_details).toBeUndefined();
        expect(store.get(inFlightAgentActionIdsAtom).size).toBe(0);
    });

    it('applies the refreshed proposal, not the stale one', async () => {
        const store = createStore();
        const stale = staleMerge();
        store.set(threadAgentActionsAtom, [stale]);
        const fresh = { ...stale.proposed_data, snapshot: { 'u-AAAA1111': { title: 'New' } } };
        vi.mocked(refreshMergeItemsProposal).mockResolvedValue(fresh as any);
        vi.mocked(executeMergeItemsAction).mockResolvedValue({ changes: [] } as any);

        await store.set(refreshMergeProposalsAtom, { actions: [stale] });
        const refreshed = store.get(threadAgentActionsAtom)[0];
        await store.set(applyAgentActionsAtom, { actions: [refreshed], runId: 'run-1' });

        expect(vi.mocked(executeMergeItemsAction).mock.calls[0][0].proposed_data).toMatchObject({ snapshot: fresh.snapshot });
        expect(store.get(threadAgentActionsAtom)[0].status).toBe('applied');
    });

    it('records why the merge could not be proposed again', async () => {
        const store = createStore();
        const stale = staleMerge();
        store.set(threadAgentActionsAtom, [stale]);
        vi.mocked(refreshMergeItemsProposal).mockRejectedValue(
            Object.assign(new Error('Item u-BBBB2222 is unavailable or trashed.'), { name: 'DuplicateError', code: 'item_unavailable' }),
        );

        const result = await store.set(refreshMergeProposalsAtom, { actions: [stale] });

        expect(result.refreshed).toEqual([]);
        expect(result.failed[0]).toMatchObject({ actionId: stale.id, error: 'Item u-BBBB2222 is unavailable or trashed.' });
        const failed = store.get(threadAgentActionsAtom)[0];
        expect(failed.status).toBe('error');
        expect(failed.error_details).toMatchObject({ error_code: 'item_unavailable' });
        expect(agentActionsService.updateAction).toHaveBeenCalledWith(stale.id, expect.objectContaining({ status: 'error' }));
    });

    it('leaves merges that are not stale alone', async () => {
        const store = createStore();
        const timedOut = staleMerge({ error_message: 'TimeoutError', error_details: { error_code: 'timeout' } });
        store.set(threadAgentActionsAtom, [timedOut]);

        const result = await store.set(refreshMergeProposalsAtom, { actions: [timedOut] });

        expect(result).toEqual({ refreshed: [], failed: [] });
        expect(refreshMergeItemsProposal).not.toHaveBeenCalled();
    });

    it('records what changed when an apply finds the merge stale', async () => {
        const store = createStore();
        const pending = staleMerge({ status: 'pending', error_message: undefined, error_details: undefined });
        store.set(threadAgentActionsAtom, [pending]);
        const stale = [{ item_id: 'u-BBBB2222', change: 'changed', fields: ['title'] }];
        vi.mocked(executeMergeItemsAction).mockRejectedValue(
            Object.assign(new Error('Items changed since this merge was proposed (u-BBBB2222: title). Inspect and propose the merge again.'), {
                name: 'DuplicateError',
                code: 'stale_snapshot',
                details: { stale_changes: stale },
            }),
        );

        await store.set(applyAgentActionsAtom, { actions: [pending], runId: 'run-1' });

        expect(store.get(threadAgentActionsAtom)[0].error_details).toMatchObject({
            error_code: 'stale_snapshot',
            stale_changes: stale,
        });
    });
});
