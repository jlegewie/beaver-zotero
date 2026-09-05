import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
    clearRunApprovalPolicyAtom,
    DEFAULT_DEFERRED_TOOL_GROUPS,
    getPendingApprovalIdsCoveredByFullAccess,
    getActionToolGroup,
    getToolGroup,
    grantCreatedNoteEditsForRunAtom,
    isActionApprovedForCurrentRun,
    isActionApprovedForRun,
    isCoveredByFullAccess,
    isFullAccessGrantedForRun,
    RUN_APPROVAL_ACTION_TYPE_ALIASES,
    runApprovalPolicyAtom,
    setRunFullAccessAtom,
} from '../../../react/atoms/runApprovalPolicy';

describe('runApprovalPolicy', () => {
    it('approves every library-changing tool once a run has full access', () => {
        const store = createStore();

        store.set(setRunFullAccessAtom, { runId: 'run-1', fullAccess: true });

        const policy = store.get(runApprovalPolicyAtom);
        expect(isFullAccessGrantedForRun(policy, 'run-1')).toBe(true);
        expect(isActionApprovedForCurrentRun(policy, 'run-1', 'edit_metadata')).toBe(true);
        expect(isActionApprovedForCurrentRun(policy, 'run-1', 'edit_note')).toBe(true);
        expect(isActionApprovedForCurrentRun(policy, 'run-1', 'manage_tags')).toBe(true);
        expect(isActionApprovedForCurrentRun(policy, 'run-1', 'create_items')).toBe(true);
    });

    it('covers the groups that have no standing preference of their own', () => {
        const store = createStore();
        store.set(setRunFullAccessAtom, { runId: 'run-1', fullAccess: true });
        const policy = store.get(runApprovalPolicyAtom);

        // No carve-outs: a grant the user made on the card in front of them,
        // for this run only, reaches annotation deletion and destructive note
        // rewrites too.
        expect(
            isActionApprovedForCurrentRun(policy, 'run-1', 'edit_annotations', {
                operation: 'delete',
            }),
        ).toBe(true);
        expect(
            isActionApprovedForCurrentRun(policy, 'run-1', 'edit_note_batch', {
                library_id: 1,
                zotero_key: 'NOTE0001',
                destructive_rewrite: true,
            }),
        ).toBe(true);
    });

    it('leaves spend and off-device confirmations asking', () => {
        const store = createStore();
        store.set(setRunFullAccessAtom, { runId: 'run-1', fullAccess: true });
        const policy = store.get(runApprovalPolicyAtom);

        expect(isCoveredByFullAccess('confirm_extraction')).toBe(false);
        expect(isCoveredByFullAccess('confirm_external_search')).toBe(false);
        expect(isActionApprovedForCurrentRun(policy, 'run-1', 'confirm_extraction')).toBe(false);
        expect(isActionApprovedForCurrentRun(policy, 'run-1', 'confirm_external_search')).toBe(false);
    });

    it('does not carry a grant into another run', () => {
        const store = createStore();
        store.set(setRunFullAccessAtom, { runId: 'run-1', fullAccess: true });

        const policy = store.get(runApprovalPolicyAtom);
        expect(isActionApprovedForRun(policy, 'run-2', 'edit_metadata')).toBe(false);
        expect(isFullAccessGrantedForRun(policy, 'run-2')).toBe(false);
        expect(isFullAccessGrantedForRun(policy, null)).toBe(false);

        // A grant made against a later run replaces the earlier run's state
        // outright rather than accumulating.
        store.set(setRunFullAccessAtom, { runId: 'run-2', fullAccess: false });
        const next = store.get(runApprovalPolicyAtom);
        expect(next.runId).toBe('run-2');
        expect(isActionApprovedForCurrentRun(next, 'run-2', 'edit_metadata')).toBe(false);
    });

    it('stops approving once the grant is revoked', () => {
        const store = createStore();
        store.set(setRunFullAccessAtom, { runId: 'run-1', fullAccess: true });
        store.set(setRunFullAccessAtom, { runId: 'run-1', fullAccess: false });

        const policy = store.get(runApprovalPolicyAtom);
        expect(isFullAccessGrantedForRun(policy, 'run-1')).toBe(false);
        expect(isActionApprovedForCurrentRun(policy, 'run-1', 'edit_metadata')).toBe(false);
    });

    it('selects the pending approvals a full-access grant may answer', () => {
        const pending = [
            { actionId: 'metadata-1', actionType: 'edit_metadata' },
            { actionId: 'note-1', actionType: 'edit_note' },
            {
                actionId: 'delete-1',
                actionType: 'edit_annotations',
                actionData: { operation: 'delete' },
            },
            { actionId: 'confirm-1', actionType: 'confirm_extraction' },
        ];

        expect(getPendingApprovalIdsCoveredByFullAccess(pending)).toEqual([
            'metadata-1',
            'note-1',
            'delete-1',
        ]);
    });

    it('allows only edits to a note created during the same run', () => {
        const store = createStore();
        store.set(grantCreatedNoteEditsForRunAtom, {
            runId: 'run-1',
            libraryId: 1,
            zoteroKey: 'NOTE0001',
        });

        const policy = store.get(runApprovalPolicyAtom);
        expect(isActionApprovedForRun(policy, 'run-1', 'edit_note', {
            library_id: 1,
            zotero_key: 'NOTE0001',
        })).toBe(true);
        expect(isActionApprovedForRun(policy, 'run-1', 'edit_note_batch', {
            library_id: 1,
            zotero_key: 'NOTE0001',
        })).toBe(true);
        expect(isActionApprovedForRun(policy, 'run-1', 'edit_note', {
            library_id: 1,
            zotero_key: 'NOTE0002',
        })).toBe(false);
        expect(isActionApprovedForRun(policy, 'run-2', 'edit_note', {
            library_id: 1,
            zotero_key: 'NOTE0001',
        })).toBe(false);
        expect(isActionApprovedForRun(policy, 'run-1', 'create_note', {
            library_id: 1,
            zotero_key: 'NOTE0001',
        })).toBe(false);
    });

    it('keeps narrow resource grants alongside a full-access grant for the same run', () => {
        const store = createStore();
        store.set(grantCreatedNoteEditsForRunAtom, {
            runId: 'run-1',
            libraryId: 1,
            zoteroKey: 'NOTE0001',
        });
        store.set(setRunFullAccessAtom, { runId: 'run-1', fullAccess: true });

        const policy = store.get(runApprovalPolicyAtom);
        expect(isActionApprovedForCurrentRun(policy, 'run-1', 'edit_metadata')).toBe(true);
        expect(isActionApprovedForCurrentRun(policy, 'run-1', 'edit_note', {
            library_id: 1,
            zotero_key: 'NOTE0001',
        })).toBe(true);
    });

    it('does not treat a stale late grant as approval for the active run', () => {
        const store = createStore();
        store.set(grantCreatedNoteEditsForRunAtom, {
            runId: 'run-1',
            libraryId: 1,
            zoteroKey: 'NOTE0001',
        });
        store.set(clearRunApprovalPolicyAtom);
        store.set(grantCreatedNoteEditsForRunAtom, {
            runId: 'run-1',
            libraryId: 1,
            zoteroKey: 'NOTE0001',
        });

        const stalePolicy = store.get(runApprovalPolicyAtom);
        expect(stalePolicy.runId).toBe('run-1');
        expect(isActionApprovedForCurrentRun(stalePolicy, 'run-2', 'edit_note', {
            library_id: 1,
            zotero_key: 'NOTE0001',
        })).toBe(false);
        expect(isActionApprovedForCurrentRun(stalePolicy, null, 'edit_note', {
            library_id: 1,
            zotero_key: 'NOTE0001',
        })).toBe(false);
    });

    it('clears full-access and resource grants at the run lifecycle boundary', () => {
        const store = createStore();
        store.set(setRunFullAccessAtom, { runId: 'run-1', fullAccess: true });
        store.set(grantCreatedNoteEditsForRunAtom, {
            runId: 'run-1',
            libraryId: 1,
            zoteroKey: 'NOTE0001',
        });

        store.set(clearRunApprovalPolicyAtom);

        const policy = store.get(runApprovalPolicyAtom);
        expect(policy.runId).toBeNull();
        expect(policy.fullAccess).toBe(false);
        expect(policy.approvedResources.size).toBe(0);
    });

    it('does not offer action-group grants for cost confirmations', () => {
        expect(getToolGroup('confirm_extraction')).toBeNull();
        expect(getToolGroup('confirm_external_search')).toBeNull();
    });

    it('keeps action-type aliases out of persistent preference defaults', () => {
        expect(DEFAULT_DEFERRED_TOOL_GROUPS).not.toHaveProperty('zotero_note');
        expect(DEFAULT_DEFERRED_TOOL_GROUPS).not.toHaveProperty('highlight_annotation');
        expect(DEFAULT_DEFERRED_TOOL_GROUPS).not.toHaveProperty('note_annotation');
        expect(RUN_APPROVAL_ACTION_TYPE_ALIASES).toEqual({
            zotero_note: 'note_creation',
            highlight_annotation: 'annotations',
            note_annotation: 'annotations',
        });

        expect(getToolGroup('zotero_note')).toBe('note_creation');
        expect(getToolGroup('highlight_annotation')).toBe('annotations');
        expect(getToolGroup('note_annotation')).toBe('annotations');
    });

    it('classifies the shared edit_annotations action by operation', () => {
        expect(
            getActionToolGroup('edit_annotations', { operation: 'delete' }),
        ).toBe('annotation_deletion');
        expect(
            getActionToolGroup('edit_annotations', { operation: 'edit' }),
        ).toBe('annotations');
    });

    it('classifies a flagged edit_note_batch action as a destructive rewrite', () => {
        // The approval event carries the edit_note_batch action type, so the
        // flag validation put on the action data is what separates it from an
        // ordinary note edit here.
        expect(getToolGroup('destructive_note_rewrite')).toBe('note_rewrite');
        expect(
            getActionToolGroup('edit_note_batch', { destructive_rewrite: true }),
        ).toBe('note_rewrite');
        expect(getActionToolGroup('edit_note_batch', {})).toBe('note_edits');
    });

    it('still applies the created-note resource grant to a destructive rewrite', () => {
        const store = createStore();
        store.set(grantCreatedNoteEditsForRunAtom, {
            runId: 'run-1',
            libraryId: 1,
            zoteroKey: 'NOTE0001',
        });
        const policy = store.get(runApprovalPolicyAtom);

        // Beaver wrote this note during the same run, so a rewrite of it can
        // discard nothing the user authored.
        expect(
            isActionApprovedForCurrentRun(policy, 'run-1', 'destructive_note_rewrite', {
                library_id: 1,
                zotero_key: 'NOTE0001',
            }),
        ).toBe(true);
        expect(
            isActionApprovedForCurrentRun(policy, 'run-1', 'destructive_note_rewrite', {
                library_id: 1,
                zotero_key: 'OTHERKEY',
            }),
        ).toBe(false);
        // Same grant, reached through the approval event's action type.
        expect(
            isActionApprovedForCurrentRun(policy, 'run-1', 'edit_note_batch', {
                library_id: 1,
                zotero_key: 'NOTE0001',
                destructive_rewrite: true,
            }),
        ).toBe(true);
    });
});
