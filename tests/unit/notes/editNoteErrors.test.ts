import { describe, expect, it } from 'vitest';
import { isStaleNoteEdit } from '../../../react/host/zotero/components/editNoteErrors';

const failed = (overrides: Record<string, unknown>): any => ({
    id: 'n',
    action_type: 'edit_note_batch',
    status: 'error',
    ...overrides,
});

describe('isStaleNoteEdit', () => {
    it.each(['old_string_not_found', 'ambiguous_match', 'overlapping_edits', 'note_changed'])(
        'offers no retry for an apply refused with %s',
        (code) => {
            expect(isStaleNoteEdit(failed({ error_details: { error_code: code } }))).toBe(true);
        },
    );

    it('recognizes a saved resolve failure without an error code', () => {
        expect(isStaleNoteEdit(failed({
            error_message: 'Batch cannot be applied: 1 edit(s) no longer resolve against the current note '
                + '(edit 5: The string to replace was not found in the note.)',
            error_details: { error_name: 'Error' },
        }))).toBe(true);
        expect(isStaleNoteEdit(failed({
            action_type: 'edit_note',
            error_message: 'The string to replace was not found in the note.',
        }))).toBe(true);
    });

    it('keeps retry for other failures, a failed undo, and other action types', () => {
        expect(isStaleNoteEdit(failed({ error_message: 'Failed to save note: DB write failed' }))).toBe(false);
        expect(isStaleNoteEdit(failed({
            result_data: {},
            error_details: { error_code: 'old_string_not_found' },
        }))).toBe(false);
        expect(isStaleNoteEdit(failed({
            action_type: 'edit_metadata',
            error_details: { error_code: 'old_string_not_found' },
        }))).toBe(false);
        expect(isStaleNoteEdit({ ...failed({ error_details: { error_code: 'old_string_not_found' } }), status: 'pending' })).toBe(false);
    });
});
