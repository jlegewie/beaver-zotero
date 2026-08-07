import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
    clearRunApprovalPolicyAtom,
    DEFAULT_DEFERRED_TOOL_GROUPS,
    getPendingApprovalIdsForToolGroup,
    getActionToolGroup,
    getToolGroup,
    getToolGroupRunApprovalLabel,
    getToolGroupRunApprovalScope,
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
        expect(isActionApprovedForCurrentRun(policy, 'run-2', 'edit_note')).toBe(true);
        expect(isActionApprovedForCurrentRun(policy, 'run-2', 'edit_metadata')).toBe(false);
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
            { actionId: 'note-batch-1', actionType: 'edit_note_batch' },
        ];

        expect(getPendingApprovalIdsForToolGroup(pending, 'edit_metadata')).toEqual([
            'metadata-1',
            'metadata-2',
        ]);
        expect(getPendingApprovalIdsForToolGroup(pending, 'edit_note')).toEqual([
            'note-1',
            'note-batch-1',
        ]);
        expect(getToolGroup('edit_note_batch')).toBe('note_edits');
    });

    it('classifies the shared edit_annotations action by operation', () => {
        expect(
            getActionToolGroup('edit_annotations', { operation: 'delete' }),
        ).toBe('annotation_deletion');
        expect(
            getActionToolGroup('edit_annotations', { operation: 'edit' }),
        ).toBe('annotations');

        const pending = [
            {
                actionId: 'delete-1',
                actionType: 'edit_annotations',
                actionData: { operation: 'delete' },
            },
            {
                actionId: 'edit-1',
                actionType: 'edit_annotations',
                actionData: { operation: 'edit' },
            },
        ];
        expect(
            getPendingApprovalIdsForToolGroup(pending, 'delete_annotations'),
        ).toEqual(['delete-1']);
        expect(
            getPendingApprovalIdsForToolGroup(pending, 'edit_annotations'),
        ).toEqual(['edit-1']);
    });

    it('keeps a destructive note rewrite out of the note_edits group', () => {
        expect(getToolGroup('destructive_note_rewrite')).toBe('note_rewrite');

        const policy = {
            runId: 'run-1',
            approvedGroups: new Set(['note_edits']),
            approvedResources: new Set<string>(),
        };
        // A run grant for ordinary note edits must not carry a rewrite with it.
        expect(
            isActionApprovedForCurrentRun(policy, 'run-1', 'destructive_note_rewrite', {
                library_id: 1,
                zotero_key: 'NOTE0001',
            }),
        ).toBe(false);
    });

    it('classifies a flagged edit_note_batch action as a destructive rewrite', () => {
        // The approval event carries the edit_note_batch action type, so the
        // flag validation put on the action data is what separates it from an
        // ordinary note edit here.
        expect(
            getActionToolGroup('edit_note_batch', { destructive_rewrite: true }),
        ).toBe('note_rewrite');
        expect(getActionToolGroup('edit_note_batch', {})).toBe('note_edits');

        const policy = {
            runId: 'run-1',
            approvedGroups: new Set(['note_edits']),
            approvedResources: new Set<string>(),
        };
        expect(
            isActionApprovedForCurrentRun(policy, 'run-1', 'edit_note_batch', {
                library_id: 1,
                zotero_key: 'NOTE0001',
                destructive_rewrite: true,
            }),
        ).toBe(false);
        expect(
            isActionApprovedForCurrentRun(policy, 'run-1', 'edit_note_batch', {
                library_id: 1,
                zotero_key: 'NOTE0001',
            }),
        ).toBe(true);
    });

    it('leaves a flagged rewrite out of a note_edits pending-approval sweep', () => {
        const pending = [
            {
                actionId: 'rewrite-1',
                actionType: 'edit_note_batch',
                actionData: { library_id: 1, zotero_key: 'NOTE0001', destructive_rewrite: true },
            },
            {
                actionId: 'edit-1',
                actionType: 'edit_note_batch',
                actionData: { library_id: 1, zotero_key: 'NOTE0002' },
            },
        ];
        expect(getPendingApprovalIdsForToolGroup(pending, 'edit_note')).toEqual(['edit-1']);
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

    it('uses a deletion grant for late shared-action approval events', () => {
        const policy = {
            runId: 'run-1',
            approvedGroups: new Set(['annotation_deletion']),
            approvedResources: new Set<string>(),
        };

        expect(
            isActionApprovedForCurrentRun(
                policy,
                'run-1',
                'edit_annotations',
                { operation: 'delete' },
            ),
        ).toBe(true);
        expect(
            isActionApprovedForCurrentRun(
                policy,
                'run-1',
                'edit_annotations',
                { operation: 'edit' },
            ),
        ).toBe(false);
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
        expect(getToolGroupRunApprovalScope('create_collection')).toBe(
            'item organization and collection creation',
        );
    });
});
