import { describe, expect, it } from 'vitest';
import { deriveEditNoteRows } from '../../../react/components/agentRuns/editNoteShared';

describe('deriveEditNoteRows', () => {
    it('returns a single row (editIndex null) for a v1 flat edit_note part', () => {
        const rows = deriveEditNoteRows({
            toolArgs: { note_id: '1-AAAAA', operation: 'str_replace', old_string: 'foo', new_string: 'bar' },
            actionType: 'edit_note',
            actionData: { library_id: 1, zotero_key: 'AAAAA', operation: 'str_replace', old_string: 'foo', new_string: 'bar' },
            resultData: { occurrences_replaced: 1 },
        });

        expect(rows).toEqual([{
            editIndex: null,
            operation: 'str_replace',
            oldString: 'foo',
            newString: 'bar',
            occurrencesReplaced: 1,
        }]);
    });

    it('returns a single row from flat toolArgs when no action/actionData exists yet', () => {
        const rows = deriveEditNoteRows({
            toolArgs: { note_id: '1-AAAAA', old_string: 'foo', new_string: 'bar' },
        });

        expect(rows).toEqual([{
            editIndex: null,
            operation: 'str_replace',
            oldString: 'foo',
            newString: 'bar',
            occurrencesReplaced: undefined,
        }]);
    });

    it('returns one row per edit for an edit_note_batch action, in request order', () => {
        const rows = deriveEditNoteRows({
            toolArgs: undefined,
            actionType: 'edit_note_batch',
            actionData: {
                library_id: 1,
                zotero_key: 'AAAAA',
                edits: [
                    { index: 0, operation: 'str_replace', old_string: 'a', new_string: 'A' },
                    { index: 1, operation: 'insert_after', old_string: 'b', new_string: 'B' },
                    { index: 2, operation: 'append', new_string: 'C' },
                ],
            },
            resultData: undefined,
        });

        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.editIndex)).toEqual([0, 1, 2]);
        expect(rows[0]).toEqual({
            editIndex: 0, operation: 'str_replace', oldString: 'a', newString: 'A', occurrencesReplaced: undefined,
        });
        expect(rows[1]).toEqual({
            editIndex: 1, operation: 'insert_after', oldString: 'b', newString: 'B', occurrencesReplaced: undefined,
        });
        expect(rows[2]).toEqual({
            editIndex: 2, operation: 'append', oldString: '', newString: 'C', occurrencesReplaced: undefined,
        });
    });

    it('joins occurrencesReplaced from resultData.applied[] by index, even when applied[] is out of order', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_batch',
            actionData: {
                edits: [
                    { index: 0, operation: 'str_replace', old_string: 'a', new_string: 'A' },
                    { index: 1, operation: 'str_replace_all', old_string: 'b', new_string: 'B' },
                    { index: 2, operation: 'str_replace', old_string: 'c', new_string: 'C' },
                ],
            },
            resultData: {
                // Deliberately out of index order.
                applied: [
                    { index: 2, occurrences_replaced: 1 },
                    { index: 0, occurrences_replaced: 1 },
                    { index: 1, occurrences_replaced: 3 },
                ],
            },
        });

        expect(rows).toHaveLength(3);
        expect(rows[0].occurrencesReplaced).toBe(1);
        expect(rows[1].occurrencesReplaced).toBe(3);
        expect(rows[2].occurrencesReplaced).toBe(1);
    });

    it('treats a streaming tool call with an edits[] array as a batch even without an action', () => {
        const rows = deriveEditNoteRows({
            toolArgs: {
                note_id: '1-AAAAA',
                edits: [
                    { operation: 'str_replace', old_string: 'a', new_string: 'A' },
                    { operation: 'str_replace' },
                ],
            },
        });

        expect(rows).toHaveLength(2);
        // Missing `index` on a streaming edit falls back to its array position.
        expect(rows[0]).toEqual({
            editIndex: 0, operation: 'str_replace', oldString: 'a', newString: 'A', occurrencesReplaced: undefined,
        });
        // Streaming partial args (missing new_string entirely) tolerate to ''.
        expect(rows[1]).toEqual({
            editIndex: 1, operation: 'str_replace', oldString: '', newString: '', occurrencesReplaced: undefined,
        });
    });

    it('tolerates a batch edit missing every optional field while still streaming', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_batch',
            actionData: { edits: [{}] },
        });

        expect(rows).toEqual([{
            editIndex: 0, operation: 'str_replace', oldString: '', newString: '', occurrencesReplaced: undefined,
        }]);
    });

    it('prefers actionData over toolArgs for both the batch flag and the edits payload', () => {
        const rows = deriveEditNoteRows({
            // toolArgs still looks like a v1 flat call (no edits[]) and would
            // resolve to a single row on its own...
            toolArgs: { note_id: '1-AAAAA', old_string: 'stale', new_string: 'stale-new' },
            // ...but the stored action is authoritative and is a batch.
            actionType: 'edit_note_batch',
            actionData: {
                edits: [
                    { index: 0, operation: 'str_replace', old_string: 'a', new_string: 'A' },
                    { index: 1, operation: 'str_replace', old_string: 'b', new_string: 'B' },
                ],
            },
        });

        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.oldString)).toEqual(['a', 'b']);
    });

    it('prefers actionData flat fields over toolArgs for a v1 edit', () => {
        const rows = deriveEditNoteRows({
            toolArgs: { note_id: '1-AAAAA', old_string: 'stale', new_string: 'stale-new', operation: 'str_replace' },
            actionType: 'edit_note',
            actionData: { library_id: 1, zotero_key: 'AAAAA', old_string: 'fresh', new_string: 'fresh-new', operation: 'str_replace_all' },
        });

        expect(rows).toEqual([{
            editIndex: null,
            operation: 'str_replace_all',
            oldString: 'fresh',
            newString: 'fresh-new',
            occurrencesReplaced: undefined,
        }]);
    });

    it('returns an empty array when a batch has no edits at all', () => {
        expect(deriveEditNoteRows({ actionType: 'edit_note_batch', actionData: {} })).toEqual([]);
        expect(deriveEditNoteRows({ actionType: 'edit_note_batch' })).toEqual([]);
    });
});
