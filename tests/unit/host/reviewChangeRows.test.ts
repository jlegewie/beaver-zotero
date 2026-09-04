import { describe, expect, it } from 'vitest';

import {
    buildReviewRows,
    buildReviewRowsForRunChain,
    getChangesCardHeading,
    hasPendingReviewRows,
    getOpenNoteTarget,
    isArtifactAction,
    isBulkApplicable,
} from '../../../react/host/zotero/components/reviewChangeRows';
import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

let idCounter = 0;

/** `action_type` is a string so tests can pass tool-name aliases (`create_items`) and unknown kinds. */
const action = (
    overrides: Partial<Omit<AgentAction, 'action_type'>> & { action_type?: string } = {},
): AgentAction => ({
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
            action({ action_type: 'create_collection', toolcall_id: 'call-6' }),
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

    it('keeps a change whatever became of it', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'error' }),
            action({ toolcall_id: 'call-2', status: 'applied' }),
            action({ toolcall_id: 'call-3', status: 'rejected' }),
            action({ toolcall_id: 'call-4', status: 'undone' }),
            action({ toolcall_id: 'call-5' }),
        ]);

        // Pending first, then the settled rows in their original order.
        expect(rows.map((row) => row.toolcallId))
            .toEqual(['call-5', 'call-1', 'call-2', 'call-3', 'call-4']);
    });

    it('keeps every status of a mixed-status tool call in its one row', () => {
        const pending = action({ toolcall_id: 'call-1' });
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'error' }),
            action({ toolcall_id: 'call-1', status: 'applied' }),
            action({ toolcall_id: 'call-1', status: 'rejected' }),
            pending,
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0].actions).toHaveLength(4);
        expect(rows[0].resolved).toBe(false);
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

    it('puts undecided rows first so `Show all` cannot hide them', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'applied' }),
            action({ toolcall_id: 'call-2', status: 'pending' }),
            action({ toolcall_id: 'call-3', status: 'undone' }),
            action({ toolcall_id: 'call-4', status: 'pending' }),
        ]);

        expect(rows.map((row) => row.toolcallId))
            .toEqual(['call-2', 'call-4', 'call-1', 'call-3']);
    });

    it('keeps a reused tool-call id separate across continuation runs', () => {
        const first = action({ id: 'a1', run_id: 'run-1', toolcall_id: 'call-1' });
        const continuation = action({ id: 'a2', run_id: 'run-2', toolcall_id: 'call-1' });

        const rows = buildReviewRowsForRunChain([[first], [continuation]]);

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.runId)).toEqual(['run-1', 'run-2']);
        expect(rows[0].actions).toEqual([first]);
        expect(rows[1].actions).toEqual([continuation]);
    });

    it('scopes a live approval exclusion to its originating run', () => {
        const live = action({ id: 'a1', run_id: 'run-1', toolcall_id: 'call-1' });
        const continuation = action({ id: 'a2', run_id: 'run-2', toolcall_id: 'call-1' });

        const rows = buildReviewRowsForRunChain([[live], [continuation]], {
            liveApprovalActionIds: new Set([live.id]),
        });

        expect(rows).toHaveLength(1);
        expect(rows[0].runId).toBe('run-2');
        expect(rows[0].actions).toEqual([continuation]);
    });
});

describe('hasPendingReviewRows', () => {
    it('is true while any row is pending and false once all are decided', () => {
        const applied = action({ toolcall_id: 'call-1', status: 'applied' });
        const pending = action({ toolcall_id: 'call-2' });

        expect(hasPendingReviewRows(buildReviewRows([applied, pending]))).toBe(true);

        const settledRows = buildReviewRows([applied, { ...pending, status: 'rejected' }]);
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

describe('getChangesCardHeading trail', () => {
    const rowsOf = (actions: AgentAction[]) => buildReviewRows(actions);

    it('names the changes when the whole run applied cleanly', () => {
        const rows = rowsOf(Array.from({ length: 10 }, (_, index) =>
            action({
                toolcall_id: `call-${index}`,
                action_type: 'edit_metadata',
                status: 'applied',
                proposed_data: { library_id: 1, zotero_key: `ITEM${index}` },
            })));

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '10 edited items' });
    });

    it('counts changes of mixed kinds rather than naming them', () => {
        const rows = rowsOf([
            action({ toolcall_id: 'call-1', action_type: 'create_collection', status: 'applied' }),
            action({ toolcall_id: 'call-2', action_type: 'manage_tags', status: 'applied' }),
        ]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '2 changes' });
    });

    it('counts changes of an unknown kind rather than naming them', () => {
        const rows = rowsOf([action({ action_type: 'future_tool', status: 'applied' })]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '1 change' });
    });

    it('reports what is still pending beside what has landed', () => {
        const rows = rowsOf([
            ...Array.from({ length: 10 }, (_, index) =>
                action({ toolcall_id: `applied-${index}`, action_type: 'create_collection', status: 'applied' })),
            action({ toolcall_id: 'call-a', action_type: 'create_collection' }),
            action({ toolcall_id: 'call-b', action_type: 'create_collection' }),
        ]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '2 pending, 10 applied' });
    });

    it('leads with failures and drops the applied count to stay short', () => {
        const rows = rowsOf([
            ...Array.from({ length: 3 }, (_, index) =>
                action({ toolcall_id: `failed-${index}`, action_type: 'create_collection', status: 'error' })),
            action({ toolcall_id: 'call-a', action_type: 'create_collection' }),
            action({ toolcall_id: 'call-b', action_type: 'create_collection' }),
            action({ toolcall_id: 'call-c', action_type: 'create_collection', status: 'applied' }),
        ]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '3 failed, 2 pending' });
    });

    it('separates an errored change still in the library from an apply that wrote nothing', () => {
        const rows = rowsOf([
            // No result: the apply wrote nothing.
            action({ toolcall_id: 'call-1', action_type: 'create_collection', status: 'error' }),
            // A surviving result: the note is in the library, undo or ack failed.
            action({
                toolcall_id: 'call-2',
                action_type: 'create_collection',
                status: 'error',
                result_data: { library_id: 1, zotero_key: 'NOTE1' },
            } as Partial<AgentAction>),
        ]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '1 failed, 1 applied with errors' });
    });

    it('keeps a change whose outcome Zotero never reported out of the failed count', () => {
        const rows = rowsOf([
            // Sent, then the plugin went quiet: whether it landed is unknown.
            action({
                toolcall_id: 'call-1',
                action_type: 'create_collection',
                status: 'error',
                error_details: { outcome: 'unconfirmed', reason: 'acked_cap' },
            } as Partial<AgentAction>),
            // Queued behind it and never sent: that one really did not land.
            action({
                toolcall_id: 'call-2',
                action_type: 'create_collection',
                status: 'error',
                error_details: { outcome: 'not_sent', reason: 'acked_cap' },
            } as Partial<AgentAction>),
        ]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '1 unconfirmed, 1 failed' });
    });

    it('does not report a change that landed and lost its acknowledgement as unconfirmed', () => {
        const rows = rowsOf([
            action({
                toolcall_id: 'call-1',
                action_type: 'create_collection',
                status: 'error',
                result_data: { library_id: 1, zotero_key: 'NOTE1' },
            } as Partial<AgentAction>),
        ]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '1 applied with errors' });
    });

    it('reports a run the user undid entirely', () => {
        const rows = rowsOf([
            action({ toolcall_id: 'call-1', action_type: 'create_collection', status: 'undone' }),
            action({ toolcall_id: 'call-2', action_type: 'create_collection', status: 'undone' }),
        ]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '2 undone' });
    });

    it('reports a run the user refused entirely', () => {
        const rows = rowsOf([
            action({ toolcall_id: 'call-1', action_type: 'create_collection', status: 'rejected' }),
            action({ toolcall_id: 'call-2', action_type: 'create_collection', status: 'rejected' }),
        ]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '2 rejected' });
    });

    it('counts a run that has done nothing yet', () => {
        expect(getChangesCardHeading(buildReviewRows([action({ action_type: 'create_collection' })])))
            .toEqual({ lead: 'Library changes', trail: '1 pending' });
    });

    it('counts the actions of a multi-item tool call, not its one row', () => {
        const rows = buildReviewRows(Array.from({ length: 5 }, () =>
            action({ toolcall_id: 'call-1', action_type: 'create_item' })));

        expect(rows).toHaveLength(1);
        expect(getChangesCardHeading(rows).trail).toBe('5 pending');
    });

    it('counts an action shared by two rows once', () => {
        const shared = action({ toolcall_id: 'call-1', action_type: 'create_item' });
        const rows = buildReviewRows([shared, action({ toolcall_id: 'call-2', action_type: 'create_item' })]);

        expect(getChangesCardHeading([...rows, rows[0]]).trail).toBe('2 pending');
    });
});

describe('getChangesCardHeading counting', () => {
    const rowsOf = (actions: AgentAction[]) => buildReviewRows(actions);

    it('counts an edit_note_batch as the one note it edits, not as its edits', () => {
        const rows = rowsOf([action({
            action_type: 'edit_note_batch',
            status: 'applied',
            proposed_data: {
                library_id: 1,
                zotero_key: 'NOTE1',
                edits: [{}, {}, {}, {}, {}, {}],
            },
        })]);

        expect(getChangesCardHeading(rows).trail).toBe('1 edited note');
    });

    it('treats the two note-edit tools as one kind', () => {
        const rows = rowsOf([
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

        expect(getChangesCardHeading(rows).trail).toBe('2 edited notes');
    });

    it('counts a note edited twice in one run once', () => {
        const rows = rowsOf([
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

        expect(getChangesCardHeading(rows).trail).toBe('1 edited note');
    });

    it('counts a note-edit batch without an identifiable note by its one action', () => {
        const rows = rowsOf([action({
            action_type: 'edit_note_batch',
            status: 'applied',
            proposed_data: { edits: [{}, {}, {}] },
        })]);

        expect(getChangesCardHeading(rows).trail).toBe('1 edited note');
    });

    it('counts an item edited twice in one run once', () => {
        const rows = rowsOf([
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

        expect(getChangesCardHeading(rows).trail).toBe('1 edited item');
    });

    it('reports the annotations a delete removed, not the ones it targeted', () => {
        const rows = rowsOf([action({
            action_type: 'edit_annotations',
            status: 'applied',
            proposed_data: { operation: 'delete', annotation_refs: [1, 2, 3] },
            result_data: { applied_refs: [1, 2] },
        } as Partial<AgentAction>)]);

        expect(getChangesCardHeading(rows).trail).toBe('2 deleted annotations');
    });

    it('reports what an organize_items apply modified, not what it proposed', () => {
        const rows = rowsOf([action({
            action_type: 'organize_items',
            status: 'applied',
            proposed_data: { item_ids: Array.from({ length: 45 }, (_, index) => index) },
            result_data: { items_modified: 40 },
        } as Partial<AgentAction>)]);

        expect(getChangesCardHeading(rows).trail).toBe('40 organized items');
    });

    it('reports the annotation edits that landed, not the ones proposed', () => {
        const rows = rowsOf([action({
            action_type: 'edit_annotations',
            status: 'applied',
            proposed_data: { operation: 'edit', edits: [{ annotation_refs: [1, 2] }, { annotation_refs: [3] }] },
            result_data: { applied_refs: [1, 2] },
        } as Partial<AgentAction>)]);

        expect(getChangesCardHeading(rows).trail).toBe('2 edited annotations');
    });

    it('counts the per-group shape of an annotation edit that has no result yet', () => {
        const rows = rowsOf([action({
            action_type: 'edit_annotations',
            status: 'applied',
            proposed_data: { operation: 'edit', edits: [{ annotation_refs: [1, 2] }, { annotation_ids: [3] }] },
        })]);

        expect(getChangesCardHeading(rows).trail).toBe('3 edited annotations');
    });

    it('names only the changes still in effect and counts the rest apart', () => {
        const rows = rowsOf([
            action({ toolcall_id: 'call-1', action_type: 'create_collection', status: 'undone' }),
            action({ toolcall_id: 'call-2', action_type: 'create_collection', status: 'applied' }),
        ]);

        expect(getChangesCardHeading(rows).trail).toBe('1 applied, 1 undone');
    });
});

describe('the changes / artifacts split', () => {
    const note = () => action({ toolcall_id: 'note-1', action_type: 'create_note', status: 'applied' });
    const edit = () => action({
        toolcall_id: 'edit-1',
        action_type: 'edit_metadata',
        status: 'applied',
        proposed_data: { library_id: 1, zotero_key: 'ITEM1' },
    });

    it('sends a created note to the artifacts surface and nowhere else', () => {
        const actions = [note(), edit()];

        expect(buildReviewRows(actions).map((row) => row.toolcallId)).toEqual(['edit-1']);
        expect(buildReviewRows(actions, { include: 'artifacts' }).map((row) => row.toolcallId))
            .toEqual(['note-1']);
    });

    it('keeps a note out of the changes heading, so nothing is counted twice', () => {
        const rows = buildReviewRows([note(), edit()]);

        expect(getChangesCardHeading(rows).trail).toBe('1 edited item');
    });

    it('leaves a run that only wrote a note with no changes rows at all', () => {
        expect(buildReviewRows([note()])).toEqual([]);
    });

    it('holds on to a note the user deleted, rather than moving it between surfaces', () => {
        const undone = [action({ toolcall_id: 'note-1', action_type: 'create_note', status: 'undone' })];

        expect(buildReviewRows(undone, { include: 'artifacts' }).map((row) => row.toolcallId))
            .toEqual(['note-1']);
        expect(buildReviewRows(undone)).toEqual([]);
    });

    it('offers an undecided note as an artifact, so approving it does not move it', () => {
        const pending = [action({ toolcall_id: 'note-1', action_type: 'create_note' })];

        expect(buildReviewRows(pending, { include: 'artifacts' })).toHaveLength(1);
        expect(buildReviewRows(pending)).toEqual([]);
    });

    it('applies the same exclusions to both surfaces', () => {
        const actions = [
            action({ toolcall_id: 'citations', action_type: 'create_note', status: 'applied' }),
            action({ toolcall_id: undefined, action_type: 'create_note', status: 'applied' }),
            action({ toolcall_id: 'note-1', action_type: 'create_note', status: 'applied' }),
        ];

        expect(buildReviewRows(actions, { include: 'artifacts' }).map((row) => row.toolcallId))
            .toEqual(['note-1']);
    });

    it('leaves a live approval to the in-stream card on either surface', () => {
        const live = action({ toolcall_id: 'note-1', action_type: 'create_note' });

        expect(buildReviewRows([live], {
            include: 'artifacts',
            liveApprovalActionIds: new Set([live.id]),
        })).toEqual([]);
    });

    it('names the note as an artifact and ordinary changes as changes', () => {
        expect(isArtifactAction(action({ action_type: 'create_note' }))).toBe(true);
        expect(isArtifactAction(action({ action_type: 'edit_note' }))).toBe(false);
        expect(isArtifactAction(action({ action_type: 'create_collection' }))).toBe(false);
        expect(isArtifactAction(action({ action_type: 'create_item' }))).toBe(false);
    });
});

describe('getChangesCardHeading applied-with-errors', () => {
    it('reports a lone errored change that is still in the library as that alone', () => {
        const rows = buildReviewRows([action({
            toolcall_id: 'call-1',
            action_type: 'create_collection',
            status: 'error',
            result_data: { library_id: 1, zotero_key: 'NOTE1' },
        } as Partial<AgentAction>)]);

        expect(getChangesCardHeading(rows))
            .toEqual({ lead: 'Library changes', trail: '1 applied with errors' });
    });

    it('keeps an errored change out of the count of clean applies', () => {
        const rows = buildReviewRows([
            ...Array.from({ length: 9 }, (_, index) =>
                action({ toolcall_id: `ok-${index}`, action_type: 'create_collection', status: 'applied' })),
            action({
                toolcall_id: 'call-x',
                action_type: 'create_collection',
                status: 'error',
                result_data: { library_id: 1, zotero_key: 'NOTE1' },
            } as Partial<AgentAction>),
        ]);

        expect(getChangesCardHeading(rows).trail).toBe('1 applied with errors, 9 applied');
    });
});

describe('getChangesCardHeading zero-target actions', () => {
    it('counts a tool call whose apply reports no targets as the one change it is', () => {
        const rows = buildReviewRows([
            action({
                toolcall_id: 'call-1',
                action_type: 'organize_items',
                status: 'applied',
                proposed_data: { item_ids: [] },
                result_data: { items_modified: 0 },
            } as Partial<AgentAction>),
            action({ toolcall_id: 'call-2', action_type: 'create_collection', status: 'undone' }),
        ]);

        // Without the fallback the organize row would vanish from the trail and
        // the heading would report only the undo.
        expect(getChangesCardHeading(rows).trail).toBe('1 applied, 1 undone');
    });

    it('always reports pending work, so the heading agrees with the bulk buttons', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', action_type: 'organize_items', proposed_data: { item_ids: [] } }),
            action({ toolcall_id: 'call-2', action_type: 'create_collection', status: 'applied' }),
        ]);

        expect(hasPendingReviewRows(rows)).toBe(true);
        expect(getChangesCardHeading(rows).trail).toBe('1 pending, 1 applied');
    });
});

describe('getOpenNoteTarget', () => {
    const noteRow = (overrides: Partial<AgentAction>) =>
        buildReviewRows([action({ action_type: 'create_note', ...overrides })], { include: 'artifacts' })[0];

    it('opens the note a run wrote', () => {
        const row = noteRow({
            status: 'applied',
            result_data: { library_id: 1, library_ref: 'user', zotero_key: 'NOTE1' },
        } as Partial<AgentAction>);

        expect(getOpenNoteTarget(row))
            .toEqual({ library_id: 1, library_ref: 'user', zotero_key: 'NOTE1' });
    });

    it('has nothing to open before the note exists', () => {
        expect(getOpenNoteTarget(noteRow({ status: 'pending' }))).toBeNull();
    });

    it('has nothing to open once the note has been deleted', () => {
        expect(getOpenNoteTarget(noteRow({
            status: 'undone',
            result_data: { library_id: 1, zotero_key: 'NOTE1' },
        } as Partial<AgentAction>))).toBeNull();
    });

    it('falls back to reveal when the write recorded no note key', () => {
        expect(getOpenNoteTarget(noteRow({ status: 'applied', result_data: {} } as Partial<AgentAction>)))
            .toBeNull();
    });

    it('is not offered for other kinds of change', () => {
        const rows = buildReviewRows([action({
            action_type: 'create_collection',
            status: 'applied',
            result_data: { library_id: 1, zotero_key: 'COLL1' },
        } as Partial<AgentAction>)]);

        expect(getOpenNoteTarget(rows[0])).toBeNull();
    });
});
