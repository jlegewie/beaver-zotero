import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

vi.mock('../../../react/utils/editNoteActions', () => ({
    executeEditNoteOrBatchAction: vi.fn(),
    undoEditNoteOrBatchAction: vi.fn(),
    getUserFacingErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

vi.mock('../../../react/utils/createNoteActions', () => ({
    executeCreateNoteAction: vi.fn(),
    undoCreateNoteAction: vi.fn(),
}));

vi.mock('../../../react/utils/editMetadataActions', () => ({
    executeEditMetadataAction: vi.fn(),
    undoEditMetadataAction: vi.fn(),
}));

vi.mock('../../../react/utils/manageTagsActions', () => ({
    executeManageTagsAction: vi.fn(),
    undoManageTagsAction: vi.fn(),
}));

vi.mock('../../../react/host/zotero/editNotePreviewLifecycle', () => ({
    dismissActiveEditNotePreview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@beaver/agent-core/transport/clients/agentActionsService', () => ({
    agentActionsService: {
        acknowledgeActions: vi.fn().mockResolvedValue({ success: true, errors: [] }),
        updateAction: vi.fn().mockResolvedValue({ success: true, errors: [] }),
    },
}));

import { executeEditNoteOrBatchAction } from '../../../react/utils/editNoteActions';
import { undoCreateNoteAction } from '../../../react/utils/createNoteActions';
import { undoManageTagsAction } from '../../../react/utils/manageTagsActions';
import { undoEditMetadataAction } from '../../../react/utils/editMetadataActions';
import { threadAgentActionsAtom } from '../../../react/agents/agentActions';
import { UNVERIFIABLE_UNDO_MESSAGE } from '../../../react/utils/undoActionOutcome';
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

    it('keeps undo metadata when the undo could not be confirmed', async () => {
        const store = createStore();
        const appliedAction: AgentAction = {
            ...action(),
            id: 'created-note-1',
            action_type: 'create_note',
            status: 'applied',
            result_data: {
                library_id: 5,
                library_ref: 'group:unavailable',
                zotero_key: 'NOTEKEY1',
            },
        };
        store.set(threadAgentActionsAtom, [appliedAction]);
        vi.mocked(undoCreateNoteAction).mockResolvedValueOnce('unverifiable');

        const result = await store.set(undoAgentActionsAtom, { actions: [appliedAction] });

        expect(result.undone).toEqual([]);
        expect(result.failed).toEqual([
            expect.objectContaining({
                actionId: appliedAction.id,
                error: UNVERIFIABLE_UNDO_MESSAGE,
            }),
        ]);
        expect(store.get(threadAgentActionsAtom)[0]).toEqual(expect.objectContaining({
            status: 'error',
            result_data: appliedAction.result_data,
        }));
    });

    it('keeps undo metadata when a field could not be read or written', async () => {
        const store = createStore();
        const appliedAction: AgentAction = {
            ...action(),
            id: 'metadata-1',
            action_type: 'edit_metadata',
            status: 'applied',
            result_data: { applied_edits: [{ field: 'publisher', old_value: 'Old', applied_value: 'New' }] },
        };
        store.set(threadAgentActionsAtom, [appliedAction]);
        vi.mocked(undoEditMetadataAction).mockResolvedValueOnce({
            fieldsReverted: 0,
            alreadyReverted: [],
            manuallyModified: [],
            needsConfirmation: false,
            failed: ['publisher'],
        });

        const result = await store.set(undoAgentActionsAtom, { actions: [appliedAction] });

        expect(result.undone).toEqual([]);
        expect(result.failed).toEqual([
            expect.objectContaining({ actionId: 'metadata-1', error: UNVERIFIABLE_UNDO_MESSAGE }),
        ]);
        expect(store.get(threadAgentActionsAtom)[0]).toEqual(expect.objectContaining({
            status: 'error',
            result_data: appliedAction.result_data,
        }));
    });

    it('marks a knowingly incomplete undo as undone rather than an error', async () => {
        // Undoing a tag merge leaves the merged-into tag behind, and no second
        // attempt would get further. Erroring would leave the card offering a
        // Retry that can only repeat the same incomplete revert.
        const store = createStore();
        const appliedAction: AgentAction = {
            ...action(),
            id: 'merge-1',
            action_type: 'manage_tags',
            status: 'applied',
            proposed_data: { library_ref: 'u', action: 'rename', name: 'reviewed', new_name: 'read' },
            result_data: { is_merge: true, affected_item_ids: ['u-ITEMKEY1'] },
        };
        store.set(threadAgentActionsAtom, [appliedAction]);
        vi.mocked(undoManageTagsAction).mockResolvedValueOnce('partial');

        const result = await store.set(undoAgentActionsAtom, { actions: [appliedAction] });

        expect(result.failed).toEqual([]);
        expect(result.undone).toEqual(['merge-1']);
        expect(store.get(threadAgentActionsAtom)[0].status).toBe('undone');
    });
});
