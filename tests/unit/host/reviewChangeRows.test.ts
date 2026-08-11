import { describe, expect, it } from 'vitest';

import {
    buildReviewRows,
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

    it('drops action types the shared executor cannot apply', () => {
        const rows = buildReviewRows([
            action({ action_type: 'edit_note', toolcall_id: 'call-1' }),
            action({ action_type: 'edit_note_batch', toolcall_id: 'call-2' }),
            action({ action_type: 'zotero_note', toolcall_id: 'call-3' }),
            action({ action_type: 'highlight_annotation', toolcall_id: 'call-4' }),
            action({ action_type: 'note_annotation', toolcall_id: 'call-5' }),
            action({ action_type: 'create_note', toolcall_id: 'call-6' }),
        ]);

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-6']);
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
