import { describe, expect, it } from 'vitest';

import {
    buildReviewRows,
    getReviewHeaderCopy,
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
});

describe('buildReviewRows sticky resolution', () => {
    it('keeps a resolved tool call visible and reports it resolved', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'applied' }),
            action({ toolcall_id: 'call-2', status: 'rejected' }),
        ], {
            resolvedToolcallIds: new Set(['call-1', 'call-2']),
        });

        expect(rows.map((row) => row.toolcallId)).toEqual(['call-1', 'call-2']);
        expect(rows.every((row) => row.resolved)).toBe(true);
    });

    it('reports a partly applied tool call as unresolved', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'applied' }),
            action({ toolcall_id: 'call-1', status: 'pending' }),
        ], {
            resolvedToolcallIds: new Set(['call-1']),
        });

        expect(rows).toHaveLength(1);
        expect(rows[0].actions).toHaveLength(2);
        expect(rows[0].resolved).toBe(false);
    });

    it('still drops a live approval whose tool call is resolved', () => {
        const live = action({ toolcall_id: 'call-1', status: 'applied' });

        const rows = buildReviewRows([live], {
            liveApprovalActionIds: new Set([live.id]),
            resolvedToolcallIds: new Set(['call-1']),
        });

        expect(rows).toEqual([]);
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

    it('stays in review while anything is pending', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'applied' }),
            action({ toolcall_id: 'call-2' }),
        ], {
            resolvedToolcallIds: new Set(['call-1']),
        });

        expect(getReviewHeaderCopy(rows)).toEqual({
            text: '2 changes need your review',
            tone: 'review',
        });
    });

    it('reports applied when every counted action was applied', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'applied' }),
            action({ toolcall_id: 'call-2', status: 'applied' }),
        ], {
            resolvedToolcallIds: new Set(['call-1', 'call-2']),
        });

        expect(getReviewHeaderCopy(rows)).toEqual({
            text: '2 changes applied',
            tone: 'resolved',
        });
        expect(getReviewHeaderCopy([rows[0]])).toEqual({
            text: '1 change applied',
            tone: 'resolved',
        });
    });

    it('reports reviewed when a resolved action was not applied', () => {
        const rows = buildReviewRows([
            action({ toolcall_id: 'call-1', status: 'applied' }),
            action({ toolcall_id: 'call-2', status: 'rejected' }),
        ], {
            resolvedToolcallIds: new Set(['call-1', 'call-2']),
        });

        expect(getReviewHeaderCopy(rows)).toEqual({
            text: '2 changes reviewed',
            tone: 'resolved',
        });
        expect(getReviewHeaderCopy([rows[1]])).toEqual({
            text: '1 change reviewed',
            tone: 'resolved',
        });
    });

    it('counts a shared action once across rows', () => {
        const shared = action({ toolcall_id: 'call-1' });
        const rows = buildReviewRows([shared, action({ toolcall_id: 'call-2' })]);

        expect(getReviewHeaderCopy([...rows, rows[0]]).text).toBe('2 changes need your review');
    });

    it('treats no rows as resolved', () => {
        expect(getReviewHeaderCopy([])).toEqual({
            text: '0 changes applied',
            tone: 'resolved',
        });
    });
});
