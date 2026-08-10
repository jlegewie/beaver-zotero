import { describe, expect, it } from 'vitest';
import {
    buildBatchRowPreviewData,
    buildUndoByIndex,
    getBatchRewriteOldContent,
    getEditNotePreviewKind,
} from '../../../react/host/zotero/components/editNoteBatchPreviewData';

const rewriteRow = {
    editIndex: 4,
    operation: 'rewrite',
    oldString: '',
    newString: '<p>Rewritten body</p>',
    occurrencesReplaced: 1,
};

describe('edit_note_batch rewrite preview metadata', () => {
    it('preserves validation old_content in a row-scoped preview', () => {
        const preview = buildBatchRowPreviewData({
            actionType: 'edit_note_batch',
            actionData: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                edits: [],
            },
            currentValue: { old_content: '<p>Original validation snapshot</p>' },
        }, rewriteRow);

        expect(preview.currentValue).toEqual({
            old_content: '<p>Original validation snapshot</p>',
        });
        expect(getBatchRewriteOldContent(preview, 4)).toBe(
            '<p>Original validation snapshot</p>',
        );
    });

    it('preserves only the matching applied rewrite undo snapshot', () => {
        const matchingUndo = {
            index: 4,
            operation: 'rewrite',
            undo_old_html: '<p>Original applied snapshot</p>',
        };
        const resultData = {
            applied: [{ index: 4, occurrences_replaced: 1 }],
            undo: [
                { index: 2, undo_old_html: '<p>Unrelated snapshot</p>' },
                matchingUndo,
            ],
        };
        const preview = buildBatchRowPreviewData({
            actionType: 'edit_note_batch',
            actionData: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                edits: [],
            },
            resultData,
        }, rewriteRow, buildUndoByIndex(resultData));

        expect(preview.resultData?.undo).toEqual([matchingUndo]);
        expect(getBatchRewriteOldContent(preview, 4)).toBe(
            '<p>Original applied snapshot</p>',
        );
    });
});

describe('buildUndoByIndex', () => {
    it('indexes undo records by their edit index', () => {
        const first = { index: 0, undo_old_html: '<p>a</p>' };
        const second = { index: 2, undo_old_html: '<p>b</p>' };
        const map = buildUndoByIndex({ undo: [first, second] });

        expect(map.get(0)).toBe(first);
        expect(map.get(2)).toBe(second);
        expect(map.get(1)).toBeUndefined();
    });

    it('returns an empty map when there is no undo array', () => {
        expect(buildUndoByIndex(undefined).size).toBe(0);
        expect(buildUndoByIndex({}).size).toBe(0);
        expect(buildUndoByIndex({ undo: 'nope' as any }).size).toBe(0);
    });

    it('skips undo records that lack a numeric index', () => {
        const valid = { index: 3, undo_old_html: '<p>c</p>' };
        const map = buildUndoByIndex({ undo: [{ undo_old_html: '<p>x</p>' }, null, valid] });

        expect(map.size).toBe(1);
        expect(map.get(3)).toBe(valid);
    });
});

describe('edit note preview routing', () => {
    it('routes the model-facing edit_note tool to the batch preview when the action is batched', () => {
        expect(getEditNotePreviewKind('edit_note', 'edit_note_batch')).toBe('batch');
    });

    it('continues to route legacy edit_note actions to the legacy preview', () => {
        expect(getEditNotePreviewKind('edit_note', 'edit_note')).toBe('legacy');
    });

    it('routes the model-facing edit_note tool to the blocks preview when the action is block-addressed', () => {
        expect(getEditNotePreviewKind('edit_note', 'edit_note_blocks')).toBe('blocks');
    });

    it('lets the action type override a batch tool name, so a sliced blocks row still renders as blocks', () => {
        // EditNoteRowView labels multi-edit rows from the action type; this
        // pins the most-specific-first ordering that makes any residual
        // 'edit_note_batch' tool name harmless.
        expect(getEditNotePreviewKind('edit_note_batch', 'edit_note_blocks')).toBe('blocks');
    });

    it('returns null for a non-note tool', () => {
        expect(getEditNotePreviewKind('edit_metadata', 'edit_metadata')).toBeNull();
    });
});

describe('buildBatchRowPreviewData — edit_note_blocks rows', () => {
    const blockEdit = {
        index: 1,
        op: 'delete',
        block: 4,
        to: 7,
        operation: 'str_replace',
        old_string: '<p>Four</p>',
        new_string: '',
        target_before_context: '<p>three</p>',
        target_after_context: '<p>eight</p>',
    };

    const base = {
        actionType: 'edit_note_blocks',
        actionData: {
            library_id: 1,
            zotero_key: 'AAAAA',
            snapshot: 'snap-token',
            edits: [{ index: 0, op: 'replace', block: 2, operation: 'str_replace', old_string: 'a', new_string: 'A' }, blockEdit],
        },
    };

    const row = {
        editIndex: 1,
        operation: 'str_replace',
        oldString: '<p>Four</p>',
        newString: '',
        label: 'delete · blocks 4-7',
    };

    it('keeps the blocks variant on the scoped copy', () => {
        expect(buildBatchRowPreviewData(base, row).actionType).toBe('edit_note_blocks');
    });

    it('passes the addressed edit through verbatim so the row keeps its addressing and skip fields', () => {
        const scoped = buildBatchRowPreviewData(base, row);
        expect(scoped.actionData.edits).toEqual([blockEdit]);
        expect(scoped.actionData.edits[0]).toBe(blockEdit);
    });

    it('scopes a blocks row to its own undo record', () => {
        const undoRecord = { index: 1, op: 'delete', undo_old_html: '<p>Four</p>', undo_new_html: '' };
        const scoped = buildBatchRowPreviewData(
            base,
            row,
            buildUndoByIndex({ undo: [{ index: 0, op: 'replace' }, undoRecord] }),
        );
        expect(scoped.resultData?.undo).toEqual([undoRecord]);
    });

    it('still rebuilds the edit for a batch row', () => {
        const batchBase = {
            actionType: 'edit_note_batch',
            actionData: {
                library_id: 1,
                zotero_key: 'AAAAA',
                edits: [{ index: 0, operation: 'str_replace', old_string: 'a', new_string: 'A' }],
            },
        };
        const scoped = buildBatchRowPreviewData(batchBase, {
            editIndex: 0,
            operation: 'str_replace',
            oldString: 'a',
            newString: 'A',
        });

        expect(scoped.actionType).toBe('edit_note_batch');
        expect(scoped.actionData.edits).toEqual([{
            index: 0,
            operation: 'str_replace',
            old_string: 'a',
            new_string: 'A',
        }]);
    });
});
