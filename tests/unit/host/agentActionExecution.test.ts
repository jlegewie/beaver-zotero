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

vi.mock('@beaver/agent-core/transport/clients/agentActionsService', () => ({
    agentActionsService: {
        acknowledgeActions: vi.fn().mockResolvedValue({ success: true, errors: [] }),
        updateAction: vi.fn().mockResolvedValue({ success: true, errors: [] }),
    },
}));

import { executeEditNoteOrBatchAction } from '../../../react/utils/editNoteActions';
import { threadAgentActionsAtom } from '../../../react/agents/agentActions';
import {
    applyAgentActionsAtom,
    inFlightAgentActionIdsAtom,
    rejectAgentActionsAtom,
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
