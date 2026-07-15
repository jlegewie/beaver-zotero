import { describe, expect, it } from 'vitest';
import {
    buildBatchRowPreviewData,
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
        const preview = buildBatchRowPreviewData({
            actionType: 'edit_note_batch',
            actionData: {
                library_id: 1,
                zotero_key: 'NOTE0001',
                edits: [],
            },
            resultData: {
                applied: [{ index: 4, occurrences_replaced: 1 }],
                undo: [
                    { index: 2, undo_old_html: '<p>Unrelated snapshot</p>' },
                    matchingUndo,
                ],
            },
        }, rewriteRow);

        expect(preview.resultData?.undo).toEqual([matchingUndo]);
        expect(getBatchRewriteOldContent(preview, 4)).toBe(
            '<p>Original applied snapshot</p>',
        );
    });
});

describe('edit note preview routing', () => {
    it('routes the model-facing edit_note tool to the batch preview when the action is batched', () => {
        expect(getEditNotePreviewKind('edit_note', 'edit_note_batch')).toBe('batch');
    });

    it('continues to route legacy edit_note actions to the legacy preview', () => {
        expect(getEditNotePreviewKind('edit_note', 'edit_note')).toBe('legacy');
    });
});
