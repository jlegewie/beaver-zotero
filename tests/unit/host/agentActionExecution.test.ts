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

vi.mock('@beaver/agent-core/transport/clients/agentActionsService', () => ({
    agentActionsService: {
        acknowledgeActions: vi.fn().mockResolvedValue({ success: true, errors: [] }),
        updateAction: vi.fn().mockResolvedValue({ success: true, errors: [] }),
    },
}));

import { executeEditNoteOrBatchAction } from '../../../react/utils/editNoteActions';
import { undoCreateItemActions } from '../../../react/utils/createItemActions';
import { threadAgentActionsAtom } from '../../../react/agents/agentActions';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
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
