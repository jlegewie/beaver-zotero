/**
 * Answering the pending approval cards in bulk.
 *
 * While a run is blocked on approval cards the composer cannot send a message,
 * so a draft sitting in it is instructions for the decision. Those instructions
 * have to travel with whichever verdict the user picks — reading them as a
 * rejection on their own inverted "you can apply all" into a decline of exactly
 * the changes the user was approving.
 *
 * The other bulk answer is the run's permission mode: granting full access says
 * yes to every library change the run still has waiting, without touching the
 * confirmations that are about spend rather than the library.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSupabase } = vi.hoisted(() => ({
    mockSupabase: {
        auth: {
            getSession: vi.fn(),
            refreshSession: vi.fn(),
        },
    },
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: mockSupabase,
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    loadFullItemDataWithAllTypes: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/services/agentDataProvider', () => ({
    handleZoteroDataRequest: vi.fn(),
    handleExternalReferenceCheckRequest: vi.fn(),
    handleZoteroDocumentRequest: vi.fn(),
    handleZoteroAttachmentPageImagesRequest: vi.fn(),
    handleZoteroAttachmentImageRequest: vi.fn(),
    handleZoteroViewImagesRequest: vi.fn(),
    handleZoteroAttachmentSearchRequest: vi.fn(),
    handleItemSearchByMetadataRequest: vi.fn(),
    handleItemSearchByTopicRequest: vi.fn(),
    handleZoteroSearchRequest: vi.fn(),
    handleListItemsRequest: vi.fn(),
    handleListCollectionsRequest: vi.fn(),
    handleListTagsRequest: vi.fn(),
    handleListLibrariesRequest: vi.fn(),
    handleGetMetadataRequest: vi.fn(),
    handleGetAnnotationsRequest: vi.fn(),
    handleFindAnnotationsRequest: vi.fn(),
    handleAgentActionValidateRequest: vi.fn(),
    handleAgentActionExecuteRequest: vi.fn(),
    handleReadNoteRequest: vi.fn(),
}));
import { createStore } from 'jotai';
import type { AgentActionType } from '@beaver/agent-core/protocol/agentProtocol';
import { agentService } from '@beaver/agent-core/transport/agentService';
import {
    answerPendingApprovalsAtom,
    approvalVerdictInFlightAtom,
    beginApprovalVerdictAtom,
    releaseApprovalVerdictAtom,
    setRunPermissionModeAtom,
} from '../../../react/atoms/agentRunAtoms';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { pendingApprovalsAtom } from '../../../react/agents/agentActions';
import {
    isFullAccessGrantedForRun,
    runApprovalPolicyAtom,
} from '../../../react/atoms/runApprovalPolicy';

function approval(actionId: string, actionType: string, actionData: Record<string, any> = {}) {
    return [actionId, {
        actionId,
        toolcallId: `call-${actionId}`,
        actionType: actionType as AgentActionType,
        actionData,
    }] as const;
}

describe('answering the pending approvals the user decided on', () => {
    let sendApprovalResponse: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        sendApprovalResponse = vi
            .spyOn(agentService, 'sendApprovalResponse')
            .mockReturnValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('carries the typed instructions with an approval, not only with a decline', () => {
        const store = createStore();
        store.set(pendingApprovalsAtom, new Map([
            approval('action-1', 'organize_items'),
            approval('action-2', 'organize_items'),
        ]));

        const answered = store.set(answerPendingApprovalsAtom, {
            actionIds: ['action-1', 'action-2'],
            approved: true,
            userInstructions: 'You can apply all',
        });

        expect(answered).toBe(2);
        expect(sendApprovalResponse.mock.calls).toEqual([
            ['action-1', true, 'You can apply all'],
            ['action-2', true, 'You can apply all'],
        ]);
        expect(store.get(pendingApprovalsAtom).size).toBe(0);
    });

    it('carries them with a decline too', () => {
        const store = createStore();
        store.set(pendingApprovalsAtom, new Map([approval('action-1', 'edit_metadata')]));

        store.set(answerPendingApprovalsAtom, {
            actionIds: ['action-1'],
            approved: false,
            userInstructions: 'Use the subtitle instead',
        });

        expect(sendApprovalResponse).toHaveBeenCalledWith(
            'action-1',
            false,
            'Use the subtitle instead',
        );
    });

    it('sends no instructions when the composer holds only whitespace', () => {
        const store = createStore();
        store.set(pendingApprovalsAtom, new Map([approval('action-1', 'edit_metadata')]));

        store.set(answerPendingApprovalsAtom, {
            actionIds: ['action-1'],
            approved: true,
            userInstructions: '   ',
        });

        expect(sendApprovalResponse).toHaveBeenCalledWith('action-1', true, null);
    });

    it('does nothing when no card is waiting', () => {
        const store = createStore();

        expect(store.set(answerPendingApprovalsAtom, {
            actionIds: ['action-1'],
            approved: false,
        })).toBe(0);
        expect(sendApprovalResponse).not.toHaveBeenCalled();
    });

    it('leaves an approval that arrived after the user decided', () => {
        // Tearing down a note preview before the answer can take over a second.
        // A card that appears in that window was not counted on the button the
        // user pressed and was never on screen for them to read, so it must not
        // inherit their verdict — it gets its own card instead.
        const store = createStore();
        store.set(pendingApprovalsAtom, new Map([approval('seen-1', 'organize_items')]));
        const decidedOn = ['seen-1'];

        store.set(pendingApprovalsAtom, new Map([
            approval('seen-1', 'organize_items'),
            approval('late-1', 'manage_tags'),
        ]));
        const answered = store.set(answerPendingApprovalsAtom, {
            actionIds: decidedOn,
            approved: true,
            userInstructions: 'Fine by me',
        });

        expect(answered).toBe(1);
        expect([...store.get(pendingApprovalsAtom).keys()]).toEqual(['late-1']);
        expect(sendApprovalResponse).toHaveBeenCalledTimes(1);
        expect(sendApprovalResponse).toHaveBeenCalledWith('seen-1', true, 'Fine by me');
    });

    it('does not answer a card that was already answered on its own', () => {
        const store = createStore();
        store.set(pendingApprovalsAtom, new Map([approval('action-2', 'organize_items')]));

        const answered = store.set(answerPendingApprovalsAtom, {
            actionIds: ['action-1', 'action-2'],
            approved: false,
        });

        expect(answered).toBe(1);
        expect(sendApprovalResponse).toHaveBeenCalledTimes(1);
        expect(sendApprovalResponse).toHaveBeenCalledWith('action-2', false, null);
    });
});

describe('the claim that holds while a verdict is delivered', () => {
    it('lets only the first verdict through until it is released', () => {
        // Delivering waits on the note preview being torn down, and that
        // teardown short-circuits for whoever asks second — so without the
        // claim the later click would overtake the earlier one and be the one
        // that decided the changes.
        const store = createStore();

        expect(store.set(beginApprovalVerdictAtom)).toBe(true);
        expect(store.set(beginApprovalVerdictAtom)).toBe(false);
        expect(store.get(approvalVerdictInFlightAtom)).toBe(true);

        store.set(releaseApprovalVerdictAtom);

        expect(store.get(approvalVerdictInFlightAtom)).toBe(false);
        expect(store.set(beginApprovalVerdictAtom)).toBe(true);
    });
});

describe('granting full access for a run', () => {
    let sendApprovalResponse: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        sendApprovalResponse = vi
            .spyOn(agentService, 'sendApprovalResponse')
            .mockReturnValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('approves every library change already waiting, whatever tool asked', () => {
        const store = createStore();
        store.set(activeRunAtom, { id: 'run-1' } as any);
        store.set(pendingApprovalsAtom, new Map([
            approval('tags-1', 'organize_items'),
            approval('note-1', 'edit_note', { library_id: 1, zotero_key: 'NOTE0001' }),
            approval('delete-1', 'edit_annotations', { operation: 'delete' }),
        ]));

        const approved = store.set(setRunPermissionModeAtom, { runId: 'run-1', fullAccess: true });

        expect(approved).toBe(3);
        expect(store.get(pendingApprovalsAtom).size).toBe(0);
        expect(isFullAccessGrantedForRun(store.get(runApprovalPolicyAtom), 'run-1')).toBe(true);
    });

    it('leaves a spend confirmation waiting for its own answer', () => {
        const store = createStore();
        store.set(activeRunAtom, { id: 'run-1' } as any);
        store.set(pendingApprovalsAtom, new Map([
            approval('tags-1', 'organize_items'),
            approval('cost-1', 'confirm_extraction'),
        ]));

        const approved = store.set(setRunPermissionModeAtom, { runId: 'run-1', fullAccess: true });

        expect(approved).toBe(1);
        expect([...store.get(pendingApprovalsAtom).keys()]).toEqual(['cost-1']);
        expect(sendApprovalResponse).toHaveBeenCalledTimes(1);
        expect(sendApprovalResponse).toHaveBeenCalledWith('tags-1', true, undefined);
    });

    it('answers nothing when the grant is switched back off', () => {
        const store = createStore();
        store.set(activeRunAtom, { id: 'run-1' } as any);
        store.set(setRunPermissionModeAtom, { runId: 'run-1', fullAccess: true });
        store.set(pendingApprovalsAtom, new Map([approval('tags-1', 'organize_items')]));

        const approved = store.set(setRunPermissionModeAtom, { runId: 'run-1', fullAccess: false });

        expect(approved).toBe(0);
        expect(store.get(pendingApprovalsAtom).size).toBe(1);
        expect(isFullAccessGrantedForRun(store.get(runApprovalPolicyAtom), 'run-1')).toBe(false);
    });

    it('does not grant to a run that is no longer the active one', () => {
        // The grant is taken after an awaited preview teardown, so the user can
        // stop the run in between. Reviving the policy for a dead run would fly
        // the composer's banner over nothing and sweep approvals belonging to a
        // run the user granted nothing.
        const store = createStore();
        store.set(activeRunAtom, null);
        store.set(pendingApprovalsAtom, new Map([approval('tags-1', 'organize_items')]));

        const approved = store.set(setRunPermissionModeAtom, { runId: 'run-1', fullAccess: true });

        expect(approved).toBe(0);
        expect(isFullAccessGrantedForRun(store.get(runApprovalPolicyAtom), 'run-1')).toBe(false);
        expect(store.get(pendingApprovalsAtom).size).toBe(1);
        expect(sendApprovalResponse).not.toHaveBeenCalled();
    });

    it('still lets the user take a live grant back', () => {
        const store = createStore();
        store.set(activeRunAtom, { id: 'run-1' } as any);
        store.set(setRunPermissionModeAtom, { runId: 'run-1', fullAccess: true });

        // The run ends between granting and revoking; removing authority must
        // not be refused just because the grant can no longer be renewed.
        store.set(activeRunAtom, null);
        store.set(setRunPermissionModeAtom, { runId: 'run-1', fullAccess: false });

        expect(isFullAccessGrantedForRun(store.get(runApprovalPolicyAtom), 'run-1')).toBe(false);
    });

    it('does not rebind the policy when revoking against another run', () => {
        const store = createStore();
        store.set(activeRunAtom, { id: 'run-1' } as any);
        store.set(setRunPermissionModeAtom, { runId: 'run-1', fullAccess: true });

        store.set(setRunPermissionModeAtom, { runId: 'run-2', fullAccess: false });

        const policy = store.get(runApprovalPolicyAtom);
        expect(policy.runId).toBe('run-1');
        expect(isFullAccessGrantedForRun(policy, 'run-1')).toBe(true);
    });
});
