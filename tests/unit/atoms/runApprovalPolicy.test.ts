import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
    clearRunApprovalPolicyAtom,
    DEFAULT_DEFERRED_TOOL_GROUPS,
    getPendingApprovalIdsForToolGroup,
    getToolGroup,
    getToolGroupRunApprovalLabel,
    grantCreatedNoteEditsForRunAtom,
    grantToolGroupForRunAtom,
    isActionApprovedForCurrentRun,
    isActionApprovedForRun,
    isToolGroupApprovedForRun,
    RUN_APPROVAL_ACTION_TYPE_ALIASES,
    runApprovalPolicyAtom,
} from '../../../react/atoms/runApprovalPolicy';

describe('runApprovalPolicy', () => {
    it('shares a run grant across tools in the same user-facing group', () => {
        const store = createStore();

        store.set(grantToolGroupForRunAtom, {
            runId: 'run-1',
            toolName: 'edit_metadata',
        });

        const policy = store.get(runApprovalPolicyAtom);
        expect(isToolGroupApprovedForRun(policy, 'run-1', 'edit_metadata')).toBe(true);
        expect(isToolGroupApprovedForRun(policy, 'run-1', 'edit_item')).toBe(true);
        expect(isToolGroupApprovedForRun(policy, 'run-1', 'edit_note')).toBe(false);
        expect(isToolGroupApprovedForRun(policy, 'run-2', 'edit_metadata')).toBe(false);
    });

    it('replaces stale grants when a different run receives a grant', () => {
        const store = createStore();
        store.set(grantToolGroupForRunAtom, {
            runId: 'run-1',
            toolName: 'edit_metadata',
        });
        store.set(grantToolGroupForRunAtom, {
            runId: 'run-2',
            toolName: 'edit_note',
        });

        const policy = store.get(runApprovalPolicyAtom);
        expect(policy.runId).toBe('run-2');
        expect(isActionApprovedForCurrentRun(policy, 'edit_note')).toBe(true);
        expect(isActionApprovedForCurrentRun(policy, 'edit_metadata')).toBe(false);
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

    it('keeps narrow resource grants alongside group grants for the same run', () => {
        const store = createStore();
        store.set(grantCreatedNoteEditsForRunAtom, {
            runId: 'run-1',
            libraryId: 1,
            zoteroKey: 'NOTE0001',
        });
        store.set(grantToolGroupForRunAtom, {
            runId: 'run-1',
            toolName: 'edit_metadata',
        });

        const policy = store.get(runApprovalPolicyAtom);
        expect(isActionApprovedForCurrentRun(policy, 'edit_metadata')).toBe(true);
        expect(isActionApprovedForCurrentRun(policy, 'edit_note', {
            library_id: 1,
            zotero_key: 'NOTE0001',
        })).toBe(true);
    });

    it('clears group and resource grants at the run lifecycle boundary', () => {
        const store = createStore();
        store.set(grantToolGroupForRunAtom, {
            runId: 'run-1',
            toolName: 'manage_tags',
        });
        store.set(grantCreatedNoteEditsForRunAtom, {
            runId: 'run-1',
            libraryId: 1,
            zoteroKey: 'NOTE0001',
        });

        store.set(clearRunApprovalPolicyAtom);

        const policy = store.get(runApprovalPolicyAtom);
        expect(policy.runId).toBeNull();
        expect(policy.approvedGroups.size).toBe(0);
        expect(policy.approvedResources.size).toBe(0);
    });

    it('does not offer action-group grants for cost confirmations', () => {
        expect(getToolGroup('confirm_extraction')).toBeNull();
        expect(getToolGroup('confirm_external_search')).toBeNull();
        expect(getToolGroupRunApprovalLabel('confirm_extraction')).toBeNull();
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

    it('selects all currently pending approvals in the group and no others', () => {
        const pending = [
            { actionId: 'metadata-1', actionType: 'edit_metadata' },
            { actionId: 'metadata-2', actionType: 'edit_item' },
            { actionId: 'note-1', actionType: 'edit_note' },
        ];

        expect(getPendingApprovalIdsForToolGroup(pending, 'edit_metadata')).toEqual([
            'metadata-1',
            'metadata-2',
        ]);
    });

    it('uses explicit and distinguishable run-scoped labels', () => {
        expect(getToolGroupRunApprovalLabel('edit_note')).toBe(
            'Allow all note edits for this run',
        );
        expect(getToolGroupRunApprovalLabel('create_collection')).toBe(
            'Allow all item organization and collection creation for this run',
        );
        expect(getToolGroupRunApprovalLabel('manage_collections')).toBe(
            'Allow all library-wide tag and collection changes for this run',
        );
    });
});
