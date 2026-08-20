import { describe, expect, it } from 'vitest';

import {
    buildReviewRows,
    getCompletedHeaderCopy,
    getReviewHeaderCopy,
    hasPendingReviewRows,
    isBulkApplicable,
} from '../../../react/host/zotero/components/reviewChangeRows';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

let idCounter = 0;

const action = (overrides: Partial<AgentAction> = {}): AgentAction => ({
    id: `action-${++idCounter}`,
    run_id: 'run-1',
    toolcall_id: 'call-1',
    action_type: 'organize_items',
    status: 'pending',
    proposed_data: {},
    ...overrides,
} as AgentAction);

describe('buildReviewRows exclusions', () => {
    it('drops run-gating confirmations', () => {
        const rows = buildReviewRows([
            action({ action_type: 'confirm_extraction', toolcall_id: 'call-1' }),
            action({ action_type: 'confirm_external_search', toolcall_id: 'call-2' }),
            action({ toolcall_id: 'call-3' }),
        ]);

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-3']);
    });

    it('drops legacy action types the shared executor cannot apply', () => {
        const rows = buildReviewRows([
            action({ action_type: 'edit_note', toolcall_id: 'call-1' }),
            action({ action_type: 'edit_note_batch', toolcall_id: 'call-2' }),
            action({ action_type: 'zotero_note', toolcall_id: 'call-3' }),
            action({ action_type: 'highlight_annotation', toolcall_id: 'call-4' }),
            action({ action_type: 'note_annotation', toolcall_id: 'call-5' }),
            action({ action_type: 'create_note', toolcall_id: 'call-6' }),
        ]);

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-1', 'call-2', 'call-6']);
    });

    it('drops actions with a live approval, by action id', () => {
        const live = action({ toolcall_id: 'call-1' });
        const other = action({ toolcall_id: 'call-2' });

        const rows = buildReviewRows([live, other], {
            liveApprovalActionIds: new Set([live.id]),
        });

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-2']);
    });

    it('drops the whole tool call when one of its actions has a live approval', () => {
        const approved = action({ toolcall_id: 'call-1', action_type: 'create_item' });

        const rows = buildReviewRows([
            approved,
            action({ toolcall_id: 'call-1', action_type: 'create_item' }),
            action({ toolcall_id: 'call-1', action_type: 'create_item' }),
            action({ toolcall_id: 'call-2' }),
        ], {
            liveApprovalActionIds: new Set([approved.id]),
        });

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-2']);
    });

    it('drops citation imports and actions without a tool call', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'citations' }),
            action({ toolcall_id: undefined }),
            action({ toolcall_id: '' }),
            action({ toolcall_id: 'call-9' }),
        ]);

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-9']);
    });

    it('drops non-pending actions, including errors', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'error' }),
            action({ toolcall_id: 'call-2', status: 'applied' }),
            action({ toolcall_id: 'call-3', status: 'rejected' }),
            action({ toolcall_id: 'call-4', status: 'undone' }),
            action({ toolcall_id: 'call-5' }),
        ]);

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-5']);
    });

    it('keeps only pending actions within a mixed-status tool call', () => {
        const pending = action({ toolcall_id: 'call-1' });
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'error' }),
            action({ toolcall_id: 'call-1', status: 'applied' }),
            action({ toolcall_id: 'call-1', status: 'rejected' }),
            pending,
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0].actions).toEqual([pending]);
    });

    it('retains exactly the resolved actions from the current card snapshot', () => {
        const applied = action({ toolcall_id: 'call-1', status: 'applied' });
        const oldError = action({ toolcall_id: 'call-1', status: 'error' });
        const pending = action({ toolcall_id: 'call-2' });
        const rows = buildReviewRows([applied, oldError, pending], {
            retainedActionIds: new Set([applied.id]),
        });

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-1', 'call-2']);
        expect(rows[0].actions).toEqual([applied]);
        expect(rows[0].resolved).toBe(true);
        expect(rows[1].actions).toEqual([pending]);
        expect(rows[1].resolved).toBe(false);
    });
});

describe('buildReviewRows grouping', () => {
    it('groups a multi-item create_item tool call into one row', () => {
        const first = action({ toolcall_id: 'call-1', action_type: 'create_item' });
        const rows = buildReviewRows([
            first,
            action({ toolcall_id: 'call-1', action_type: 'create_item' }),
            action({ toolcall_id: 'call-1', action_type: 'create_item' }),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0].toolcallId).toBe('call-1');
        expect(rows[0].actionType).toBe('create_item');
        expect(rows[0].actions).toHaveLength(3);
        expect(rows[0].actions[0]).toBe(first);
    });

    it('preserves first-appearance order of tool calls and of actions inside a row', () => {
        const rows = buildReviewRows([
            action({ id: 'a1', toolcall_id: 'call-b' }),
            action({ id: 'a2', toolcall_id: 'call-a' }),
            action({ id: 'a3', toolcall_id: 'call-b' }),
        ]);

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-b', 'call-a']);
        expect(rows[0].actions.map((item) => item.id)).toEqual(['a1', 'a3']);
    });
});

describe('hasPendingReviewRows', () => {
    it('keeps the snapshot while any row is pending and drops it once all resolve', () => {
        const applied = action({ toolcall_id: 'call-1', status: 'applied' });
        const pending = action({ toolcall_id: 'call-2' });
        const retained = new Set([applied.id]);

        const activeRows = buildReviewRows([applied, pending], { retainedActionIds: retained });
        expect(hasPendingReviewRows(activeRows)).toBe(true);

        const settledRows = buildReviewRows([
            applied,
            { ...pending, status: 'rejected' },
        ], { retainedActionIds: new Set([applied.id, pending.id]) });
        expect(settledRows).toHaveLength(2);
        expect(hasPendingReviewRows(settledRows)).toBe(false);
    });
});

describe('isBulkApplicable', () => {
    it('excludes annotation deletions', () => {
        expect(isBulkApplicable(action({
            action_type: 'edit_annotations',
            proposed_data: { operation: 'delete' },
        }))).toBe(false);
    });

    it('excludes destructive note rewrites', () => {
        expect(isBulkApplicable(action({
            action_type: 'edit_note_batch',
            proposed_data: { destructive_rewrite: true },
        }))).toBe(false);
    });

    it('includes ordinary edits, organization and creation', () => {
        expect(isBulkApplicable(action({
            action_type: 'edit_annotations',
            proposed_data: { operation: 'edit' },
        }))).toBe(true);
        expect(isBulkApplicable(action({ action_type: 'organize_items' }))).toBe(true);
        expect(isBulkApplicable(action({ action_type: 'create_item' }))).toBe(true);
        expect(isBulkApplicable(action({
            action_type: 'edit_note_batch',
            proposed_data: { destructive_rewrite: false },
        }))).toBe(true);
    });

    it('marks a row holding one non-applicable action as not bulk applicable', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', action_type: 'edit_annotations', proposed_data: { operation: 'edit' } }),
            action({ toolcall_id: 'call-1', action_type: 'edit_annotations', proposed_data: { operation: 'delete' } }),
            action({ toolcall_id: 'call-2', action_type: 'organize_items' }),
        ]);

        expect(rows[0].bulkApplicable).toBe(false);
        expect(rows[1].bulkApplicable).toBe(true);
    });
});

describe('getReviewHeaderCopy', () => {
    it('counts actions rather than rows', () => {
        const rows = buildReviewRows(
            Array.from({ length: 5 }, () => action({ toolcall_id: 'call-1', action_type: 'create_item' })),
        );

        expect(rows).toHaveLength(1);
        expect(getReviewHeaderCopy(rows)).toEqual({
            text: '5 changes need your review',
            tone: 'review',
        });
    });

    it('uses the singular for one pending action', () => {
        expect(getReviewHeaderCopy(buildReviewRows([action()]))).toEqual({
            text: '1 change needs your review',
            tone: 'review',
        });
    });

    it('counts only pending actions', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'applied' }),
            action({ toolcall_id: 'call-2' }),
        ]);

        expect(getReviewHeaderCopy(rows)).toEqual({
            text: '1 change needs your review',
            tone: 'review',
        });
    });

    it('counts retained resolved actions while another action is pending', () => {
        const applied = action({ toolcall_id: 'call-1', status: 'applied' });
        const pending = action({ toolcall_id: 'call-2' });
        const rows = buildReviewRows([applied, pending], {
            retainedActionIds: new Set([applied.id]),
        });

        expect(getReviewHeaderCopy(rows)).toEqual({
            text: '2 changes need your review',
            tone: 'review',
        });
    });

    it('counts a shared action once across rows', () => {
        const shared = action({ toolcall_id: 'call-1' });
        const rows = buildReviewRows([shared, action({ toolcall_id: 'call-2' })]);

        expect(getReviewHeaderCopy([...rows, rows[0]]).text).toBe('2 changes need your review');
    });

});

describe('buildReviewRows in completed mode', () => {
    const completed = (actions: AgentAction[], appliedIds: string[], retainedIds: string[] = []) =>
        buildReviewRows(actions, {
            mode: 'completed',
            appliedActionIds: new Set(appliedIds),
            retainedActionIds: new Set(retainedIds),
        });

    it('offers only the actions applied in this session', () => {
        const applied = action({ toolcall_id: 'call-1', status: 'applied' });
        const appliedLongAgo = action({ toolcall_id: 'call-2', status: 'applied' });
        const pending = action({ toolcall_id: 'call-3' });

        const rows = completed([applied, appliedLongAgo, pending], [applied.id]);

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-1']);
        expect(rows[0].actions).toEqual([applied]);
    });

    it('keeps a row the user has since undone or failed to undo', () => {
        const undone = action({ toolcall_id: 'call-1', status: 'undone' });
        const failed = action({ toolcall_id: 'call-2', status: 'error' });

        const rows = completed([undone, failed], [undone.id, failed.id]);

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-1', 'call-2']);
    });

    it('leaves actions the review card still retains to that card', () => {
        const justApplied = action({ toolcall_id: 'call-1', status: 'applied' });
        const handedOver = action({ toolcall_id: 'call-2', status: 'applied' });

        const rows = completed(
            [justApplied, handedOver],
            [justApplied.id, handedOver.id],
            [justApplied.id],
        );

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-2']);
    });

    it('applies the same exclusions as the review card', () => {
        const actions = [
            action({ toolcall_id: 'citations', action_type: 'create_item', status: 'applied' }),
            action({ toolcall_id: 'call-1', action_type: 'confirm_extraction', status: 'applied' }),
            action({ toolcall_id: 'call-2', action_type: 'highlight_annotation', status: 'applied' }),
            action({ toolcall_id: undefined, status: 'applied' }),
            action({ toolcall_id: 'call-3', status: 'applied' }),
        ];

        const rows = completed(actions, actions.map((item) => item.id));

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-3']);
    });

    it('groups a multi-item tool call into one row', () => {
        const actions = Array.from({ length: 3 }, () =>
            action({ toolcall_id: 'call-1', action_type: 'create_item', status: 'applied' }));

        const rows = completed(actions, actions.map((item) => item.id));

        expect(rows).toHaveLength(1);
        expect(rows[0].actions).toHaveLength(3);
    });
});

describe('getCompletedHeaderCopy', () => {
    const completedRows = (actions: AgentAction[]) => buildReviewRows(actions, {
        mode: 'completed',
        appliedActionIds: new Set(actions.map((item) => item.id)),
    });

    it('names a single kind of change', () => {
        const rows = completedRows(Array.from({ length: 4 }, (_, index) =>
            action({ toolcall_id: `call-${index}`, action_type: 'create_note', status: 'applied' })));

        expect(getCompletedHeaderCopy(rows)).toBe('Created 4 notes');
    });

    it('uses the singular for one change', () => {
        const rows = completedRows([action({ action_type: 'create_note', status: 'applied' })]);

        expect(getCompletedHeaderCopy(rows)).toBe('Created 1 note');
    });

    it('counts the items a batch tool changed, not its actions', () => {
        const rows = completedRows([action({
            action_type: 'organize_items',
            status: 'applied',
            proposed_data: { item_ids: Array.from({ length: 45 }, (_, index) => index) },
        })]);

        expect(getCompletedHeaderCopy(rows)).toBe('Organized 45 items');
    });

    it('counts the annotations an apply created rather than the ones it proposed', () => {
        const rows = completedRows([action({
            action_type: 'create_highlight_annotations',
            status: 'applied',
            proposed_data: { items: [1, 2, 3, 4] },
            result_data: { created: [1, 2, 3] },
        } as Partial<AgentAction>)]);

        expect(getCompletedHeaderCopy(rows)).toBe('Created 3 highlights');
    });

    it('says deleted for an annotation deletion, which shares the edit action type', () => {
        const rows = completedRows([action({
            action_type: 'edit_annotations',
            status: 'applied',
            proposed_data: { operation: 'delete', annotation_refs: [1, 2] },
        })]);

        expect(getCompletedHeaderCopy(rows)).toBe('Deleted 2 annotations');
    });

    it('treats tool-name aliases as one kind', () => {
        const rows = completedRows([
            action({ toolcall_id: 'call-1', action_type: 'create_item', status: 'applied' }),
            action({ toolcall_id: 'call-2', action_type: 'create_items', status: 'applied' }),
        ]);

        expect(getCompletedHeaderCopy(rows)).toBe('Imported 2 items');
    });

    it('falls back to a generic count for mixed kinds', () => {
        const rows = completedRows([
            action({ toolcall_id: 'call-1', action_type: 'create_note', status: 'applied' }),
            action({ toolcall_id: 'call-2', action_type: 'manage_tags', status: 'applied' }),
        ]);

        expect(getCompletedHeaderCopy(rows)).toBe('Completed 2 library changes');
    });

    it('falls back to a generic count when a kind has no phrase or no countable unit', () => {
        const unknown = completedRows([action({ action_type: 'future_tool', status: 'applied' })]);
        expect(getCompletedHeaderCopy(unknown)).toBe('Completed 1 library change');

        const empty = completedRows([action({
            action_type: 'organize_items',
            status: 'applied',
            proposed_data: { item_ids: [] },
        })]);
        expect(getCompletedHeaderCopy(empty)).toBe('Completed 1 library change');
    });
});

describe('getCompletedHeaderCopy counting', () => {
    const completedRows = (actions: AgentAction[]) => buildReviewRows(actions, {
        mode: 'completed',
        appliedActionIds: new Set(actions.map((item) => item.id)),
    });

    it('counts an edit_note_batch as the one note it edits, not as its edits', () => {
        const rows = completedRows([action({
            action_type: 'edit_note_batch',
            status: 'applied',
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE1',
                edits: [{}, {}, {}, {}, {}, {}],
            },
        })]);

        expect(getCompletedHeaderCopy(rows)).toBe('Edited 1 note');
    });

    it('treats the two note-edit tools as one kind', () => {
        const rows = completedRows([
            action({
                toolcall_id: 'call-1',
                action_type: 'edit_note',
                status: 'applied',
                proposed_data: { library_id: 1, zotero_key: 'NOTE1' },
            }),
            action({
                toolcall_id: 'call-2',
                action_type: 'edit_note_batch',
                status: 'applied',
                proposed_data: { library_id: 1, zotero_key: 'NOTE2', edits: [{}, {}] },
            }),
        ]);

        expect(getCompletedHeaderCopy(rows)).toBe('Edited 2 notes');
    });

    it('counts a note edited twice in one run once', () => {
        const rows = completedRows([
            action({
                toolcall_id: 'call-1',
                action_type: 'edit_note',
                status: 'applied',
                proposed_data: { library_id: 1, zotero_key: 'NOTE1' },
            }),
            action({
                toolcall_id: 'call-2',
                action_type: 'edit_note_batch',
                status: 'applied',
                proposed_data: { library_id: 1, zotero_key: 'NOTE1', edits: [{}] },
            }),
        ]);

        expect(getCompletedHeaderCopy(rows)).toBe('Edited 1 note');
    });

    it('counts a note-edit batch without an identifiable note by its one action', () => {
        const rows = completedRows([action({
            action_type: 'edit_note_batch',
            status: 'applied',
            proposed_data: { edits: [{}, {}, {}] },
        })]);

        expect(getCompletedHeaderCopy(rows)).toBe('Edited 1 note');
    });

    it('counts an item edited twice in one run once', () => {
        const rows = completedRows([
            action({
                toolcall_id: 'call-1',
                action_type: 'edit_metadata',
                status: 'applied',
                proposed_data: { library_id: 1, zotero_key: 'ITEM1' },
            }),
            action({
                toolcall_id: 'call-2',
                action_type: 'edit_item',
                status: 'applied',
                proposed_data: { library_id: 1, zotero_key: 'ITEM1' },
            }),
        ]);

        expect(getCompletedHeaderCopy(rows)).toBe('Edited 1 item');
    });

    it('reports the annotations a delete removed, not the ones it targeted', () => {
        const rows = completedRows([action({
            action_type: 'edit_annotations',
            status: 'applied',
            proposed_data: { operation: 'delete', annotation_refs: [1, 2, 3] },
            result_data: { applied_refs: [1, 2] },
        } as Partial<AgentAction>)]);

        expect(getCompletedHeaderCopy(rows)).toBe('Deleted 2 annotations');
    });

    it('reports what an organize_items apply modified, not what it proposed', () => {
        const rows = completedRows([action({
            action_type: 'organize_items',
            status: 'applied',
            proposed_data: { item_ids: Array.from({ length: 45 }, (_, index) => index) },
            result_data: { items_modified: 40 },
        } as Partial<AgentAction>)]);

        expect(getCompletedHeaderCopy(rows)).toBe('Organized 40 items');
    });

    it('reports the annotation edits that landed, not the ones proposed', () => {
        const rows = completedRows([action({
            action_type: 'edit_annotations',
            status: 'applied',
            proposed_data: { operation: 'edit', edits: [{ annotation_refs: [1, 2] }, { annotation_refs: [3] }] },
            result_data: { applied_refs: [1, 2] },
        } as Partial<AgentAction>)]);

        expect(getCompletedHeaderCopy(rows)).toBe('Edited 2 annotations');
    });

    it('counts the per-group shape of an annotation edit that has no result yet', () => {
        const rows = completedRows([action({
            action_type: 'edit_annotations',
            status: 'applied',
            proposed_data: { operation: 'edit', edits: [{ annotation_refs: [1, 2] }, { annotation_ids: [3] }] },
        })]);

        expect(getCompletedHeaderCopy(rows)).toBe('Edited 3 annotations');
    });

    it('describes only the changes still in effect', () => {
        const undone = action({ toolcall_id: 'call-1', action_type: 'create_note', status: 'undone' });
        const applied = action({ toolcall_id: 'call-2', action_type: 'create_note', status: 'applied' });
        const rows = buildReviewRows([undone, applied], {
            mode: 'completed',
            appliedActionIds: new Set([undone.id, applied.id]),
        });

        expect(getCompletedHeaderCopy(rows)).toBe('Created 1 note');
    });

    it('says reverted once every change has been undone or rejected', () => {
        const actions = [
            action({ toolcall_id: 'call-1', action_type: 'create_note', status: 'undone' }),
            action({ toolcall_id: 'call-2', action_type: 'create_note', status: 'undone' }),
        ];
        const rows = buildReviewRows(actions, {
            mode: 'completed',
            appliedActionIds: new Set(actions.map((item) => item.id)),
        });

        expect(getCompletedHeaderCopy(rows)).toBe('Reverted 2 library changes');
    });

    it('drops a change whose re-apply failed, since it never landed', () => {
        const applied = action({ toolcall_id: 'call-1', action_type: 'create_note', status: 'applied' });
        // An undone row offers a re-apply; a failure there clears result_data.
        const failedReapply = action({
            toolcall_id: 'call-2',
            action_type: 'create_note',
            status: 'error',
            result_data: undefined,
        });
        const rows = buildReviewRows([applied, failedReapply], {
            mode: 'completed',
            appliedActionIds: new Set([applied.id, failedReapply.id]),
        });

        expect(getCompletedHeaderCopy(rows)).toBe('Created 1 note');
    });

    it('keeps describing a change whose undo failed, since it is still applied', () => {
        const rows = completedRows([action({
            toolcall_id: 'call-1',
            action_type: 'create_note',
            status: 'error',
            result_data: { library_id: 1, zotero_key: 'NOTE1' },
        } as Partial<AgentAction>)]);

        expect(getCompletedHeaderCopy(rows)).toBe('Created 1 note');
    });
});
