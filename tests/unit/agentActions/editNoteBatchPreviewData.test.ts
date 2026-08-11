import { describe, expect, it } from 'vitest';
import {
    buildBatchRowPreviewData,
    buildUndoByIndex,
    getBatchRewriteOldContent,
    getEditNotePreviewKind,
} from '../../../react/host/zotero/components/editNoteBatchPreviewData';
import { deriveEditNoteRows } from '../../../react/components/agentRuns/editNoteShared';

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

/**
 * The blocks preview does not render the scoped payload directly — it re-derives
 * its row from it (`ActionPreview` → `deriveEditNoteRows`). So the round trip is
 * what has to hold, and these compose the two rather than asserting on the
 * intermediate shape.
 *
 * The case that matters is an edit VALIDATION accepted and EXECUTE refused:
 * execute re-resolves every edit, and citation identity or library exclusion can
 * change while the action waits for approval. Such an edit carries no
 * `skip_reason_code` — the only record that it never reached the note is
 * `resultData.skipped`.
 */
describe('buildBatchRowPreviewData — execute-time skips survive the round trip', () => {
    const accepted = { index: 0, op: 'replace', block: 2, operation: 'str_replace', old_string: 'a', new_string: 'A' };
    // No skip_reason_code: validation was happy with this one.
    const refusedByExecute = { index: 1, op: 'replace', block: 4, operation: 'str_replace', old_string: 'b', new_string: 'B' };

    const base = {
        actionType: 'edit_note_blocks',
        actionData: { library_id: 1, zotero_key: 'AAAAA', edits: [accepted, refusedByExecute] },
        resultData: {
            applied: [{ index: 0, blocks: '2' }],
            skipped: [{ index: 1, reason_code: 'expansion_failed', reason: 'Cited item does not exist.' }],
        },
    };

    const rowFor = (editIndex: number) => ({
        editIndex,
        operation: 'str_replace',
        oldString: editIndex === 0 ? 'a' : 'b',
        newString: editIndex === 0 ? 'A' : 'B',
    });

    const deriveScopedRow = (previewBase: any, editIndex: number) => {
        const scoped = buildBatchRowPreviewData(previewBase, rowFor(editIndex));
        return deriveEditNoteRows({
            actionType: scoped.actionType,
            actionData: scoped.actionData,
            resultData: scoped.resultData,
        })[0];
    };

    it('renders the skipped row as skipped rather than as an applied diff', () => {
        expect(deriveScopedRow(base, 1).skippedReason).toBe('Cited item does not exist.');
    });

    it('does not leak one row\'s skip onto its applied sibling', () => {
        expect(deriveScopedRow(base, 0).skippedReason).toBeUndefined();
    });

    // The empty case is the subtle one: `deriveEditNoteRows` reads "skipped is an
    // array" as "this action has executed", so forwarding only NON-empty skips
    // would quietly send a fully-applied action back to the validation-time
    // fallback. Defense in depth rather than a fix for a live symptom — execute
    // carries validation's skips into `skipped`, so an action with `skipped: []`
    // has no edit holding a `skip_reason_code` for the fallback to find. The
    // point is that the scoped payload stays semantically identical to the
    // unscoped one, which is what stops the next reader of this function from
    // inheriting the bug above.
    it('keeps an executed action legible as executed when nothing was skipped', () => {
        const allApplied = {
            ...base,
            resultData: { applied: [{ index: 0, blocks: '2' }, { index: 1, blocks: '4' }], skipped: [] },
        };
        const scoped = buildBatchRowPreviewData(allApplied, rowFor(1));

        expect(scoped.resultData?.skipped).toEqual([]);
        expect(deriveScopedRow(allApplied, 1).skippedReason).toBeUndefined();
    });

    // Before execute there is no `skipped` array to consult, and validation's
    // marker is the only signal there is — it must still reach the row.
    it('falls back to the validation skip marker while the action is still pending', () => {
        const pending = {
            actionType: 'edit_note_blocks',
            actionData: {
                library_id: 1,
                zotero_key: 'AAAAA',
                edits: [accepted, { ...refusedByExecute, skip_reason_code: 'expansion_failed', skip_reason: 'Cited item does not exist.' }],
            },
        };

        expect(buildBatchRowPreviewData(pending, rowFor(1)).resultData?.skipped).toBeUndefined();
        expect(deriveScopedRow(pending, 1).skippedReason).toBe('Cited item does not exist.');
    });
});
