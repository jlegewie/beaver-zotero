/**
 * Render-layer derivation for `edit_note_blocks` rows.
 *
 * Everything asserted here is built from the SELF-CONTAINED persisted metadata
 * validation writes onto each block edit — no note, no prefs, no editor. That
 * is the decoupling boundary these tests are really pinning.
 */
import { describe, expect, it } from 'vitest';
import {
    deriveEditNoteRows,
    describeBlockEdit,
    getEditNoteCallVariant,
} from '../../../react/components/agentRuns/editNoteShared';

describe('describeBlockEdit', () => {
    it('labels each op by the address it edits', () => {
        expect(describeBlockEdit({ op: 'replace', block: 5 })).toBe('replace · block 5');
        expect(describeBlockEdit({ op: 'rewrite' })).toBe('rewrite · whole note');
        expect(describeBlockEdit({ op: 'insert', after: 12 })).toBe('insert · after 12');
        expect(describeBlockEdit({ op: 'delete', block: 4, to: 7 })).toBe('delete · blocks 4-7');
        expect(describeBlockEdit({ op: 'delete', block: 4 })).toBe('delete · block 4');
        // to === block is a single-line delete, not a range.
        expect(describeBlockEdit({ op: 'delete', block: 4, to: 4 })).toBe('delete · block 4');
    });

    it('names the two insert seams that are not block numbers', () => {
        expect(describeBlockEdit({ op: 'insert', after: 0 })).toBe('insert · at start');
        expect(describeBlockEdit({ op: 'insert', after: 'end' })).toBe('insert · at end');
    });

    it('degrades to the bare op rather than inventing an address', () => {
        expect(describeBlockEdit({ op: 'replace' })).toBe('replace');
        expect(describeBlockEdit({ op: 'insert' })).toBe('insert');
        expect(describeBlockEdit({ op: 'delete' })).toBe('delete');
        expect(describeBlockEdit({})).toBe('edit');
        expect(describeBlockEdit(undefined)).toBe('edit');
    });
});

describe('deriveEditNoteRows — edit_note_blocks', () => {
    const blocksActionData = {
        library_id: 1,
        zotero_key: 'AAAAA',
        snapshot: 'snap-token',
        edits: [
            {
                index: 0,
                op: 'replace',
                block: 5,
                operation: 'str_replace',
                old_string: '<p>Five</p>',
                new_string: '<p>Five, revised</p>',
                target_before_context: '<p>four</p>',
                target_after_context: '<p>six</p>',
            },
            {
                index: 1,
                op: 'insert',
                after: 12,
                operation: 'insert_after',
                old_string: '<p>Twelve</p>',
                new_string: '<p>Twelve</p>\n<p>Inserted</p>',
                target_before_context: '<p>eleven</p>',
                target_after_context: '<p>thirteen</p>',
            },
            {
                index: 2,
                op: 'delete',
                block: 4,
                to: 7,
                operation: 'str_replace',
                old_string: '<p>Four</p>\n<p>Five</p>\n<p>Six</p>\n<p>Seven</p>',
                new_string: '',
            },
            {
                index: 3,
                op: 'replace',
                block: 9,
                skip_reason_code: 'expect_mismatch',
                skip_reason: 'The text at block 9 did not match `expect`.',
            },
        ],
    };

    it('yields one row per edit, in request order, with block labels', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_blocks',
            actionData: blocksActionData,
        });

        expect(rows.map((row) => row.label)).toEqual([
            'replace · block 5',
            'insert · after 12',
            'delete · blocks 4-7',
            'replace · block 9',
        ]);
        expect(rows.map((row) => row.editIndex)).toEqual([0, 1, 2, 3]);
    });

    it('carries the diff strings and per-row jump anchors from the persisted edit', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_blocks',
            actionData: blocksActionData,
        });

        expect(rows[0]).toMatchObject({
            operation: 'str_replace',
            oldString: '<p>Five</p>',
            newString: '<p>Five, revised</p>',
            targetBeforeContext: '<p>four</p>',
            targetAfterContext: '<p>six</p>',
        });
        // An insert is anchor-merged for display: old_string is the anchor
        // alone, new_string the anchor plus the insertion.
        expect(rows[1]).toMatchObject({
            operation: 'insert_after',
            oldString: '<p>Twelve</p>',
            newString: '<p>Twelve</p>\n<p>Inserted</p>',
            targetBeforeContext: '<p>eleven</p>',
            targetAfterContext: '<p>thirteen</p>',
        });
        expect(rows[2]).toMatchObject({
            operation: 'str_replace',
            newString: '',
        });
    });

    it('marks a skipped edit with its reason and gives it no diff strings', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_blocks',
            actionData: blocksActionData,
        });

        expect(rows[3].skippedReason).toBe('The text at block 9 did not match `expect`.');
        expect(rows[3].oldString).toBe('');
        expect(rows[3].newString).toBe('');
        // Only the skipped row is marked.
        expect(rows.slice(0, 3).every((row) => row.skippedReason === undefined)).toBe(true);
    });

    it('falls back to the reason code when validation supplied no wording', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_blocks',
            actionData: {
                library_id: 1,
                zotero_key: 'AAAAA',
                edits: [{ index: 0, op: 'delete', block: 2, skip_reason_code: 'unbalanced_range' }],
            },
        });

        expect(rows[0].skippedReason).toBe('unbalanced_range');
    });

    it('labels a whole-note rewrite and reports it as a rewrite operation', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_blocks',
            actionData: {
                library_id: 1,
                zotero_key: 'AAAAA',
                destructive_rewrite: true,
                edits: [{
                    index: 0,
                    op: 'rewrite',
                    operation: 'rewrite',
                    new_string: '<p>Whole new body</p>',
                }],
            },
        });

        expect(rows).toHaveLength(1);
        expect(rows[0].label).toBe('rewrite · whole note');
        // The group header keys off this to read "Rewrite Note".
        expect(rows[0].operation).toBe('rewrite');
        expect(rows[0].newString).toBe('<p>Whole new body</p>');
    });

    // Batch validation ROUTINELY writes target_*_context onto its edits, so a
    // fixture without them would not prove the rows stay unchanged. Use one
    // that has them.
    it('adds no label, skip or anchor fields to batch rows that carry anchors', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_batch',
            actionData: {
                library_id: 1,
                zotero_key: 'AAAAA',
                edits: [{
                    index: 0,
                    operation: 'str_replace',
                    old_string: 'a',
                    new_string: 'A',
                    target_before_context: '<p>before</p>',
                    target_after_context: '<p>after</p>',
                }],
            },
        });

        expect(rows).toEqual([{
            editIndex: 0,
            operation: 'str_replace',
            oldString: 'a',
            newString: 'A',
            occurrencesReplaced: undefined,
        }]);
        expect('targetBeforeContext' in rows[0]).toBe(false);
        expect('targetAfterContext' in rows[0]).toBe(false);
    });

    it('adds no label or skip fields to batch rows', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_batch',
            actionData: {
                library_id: 1,
                zotero_key: 'AAAAA',
                edits: [{ index: 0, operation: 'str_replace', old_string: 'a', new_string: 'A' }],
            },
        });

        expect(rows).toEqual([{
            editIndex: 0,
            operation: 'str_replace',
            oldString: 'a',
            newString: 'A',
            occurrencesReplaced: undefined,
        }]);
        expect('label' in rows[0]).toBe(false);
        expect('skippedReason' in rows[0]).toBe(false);
        expect('targetBeforeContext' in rows[0]).toBe(false);
    });

    it('labels a streaming blocks call classified only by its per-edit `op`', () => {
        const toolArgs = {
            note_id: '1-AAAAA',
            snapshot: 'snap-token',
            edits: [{ index: 0, op: 'delete', block: 3, to: 5 }],
        };

        expect(getEditNoteCallVariant({ toolArgs })).toBe('blocks');
        expect(deriveEditNoteRows({ toolArgs })[0].label).toBe('delete · blocks 3-5');
    });

    // The preview triple is written by validation, so a card whose validation
    // FAILED (snapshot_mismatch / no_applicable_edits — no action is created at
    // all) has only the raw tool args. Without a fallback every row renders an
    // empty diff box, which reads as "nothing changes here" — and the group
    // auto-expands on error, so the user is looking straight at it.
    it('falls back to expect/content when validation never wrote the preview triple', () => {
        const rows = deriveEditNoteRows({
            toolArgs: {
                edits: [
                    { index: 0, op: 'replace', block: 12, expect: '<p>Old twelve</p>', content: '<p>New twelve</p>' },
                    { index: 1, op: 'insert', after: 3, content: '<p>Inserted</p>' },
                ],
            },
        });

        expect(rows).toHaveLength(2);
        expect(rows[0].oldString).toBe('<p>Old twelve</p>');
        expect(rows[0].newString).toBe('<p>New twelve</p>');
        expect(rows[0].label).toBe('replace · block 12');
        // An insert overwrites nothing, so it legitimately has no old side.
        expect(rows[1].oldString).toBe('');
        expect(rows[1].newString).toBe('<p>Inserted</p>');
    });

    it('prefers the validated triple over the raw args when both are present', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_blocks',
            actionData: {
                edits: [{
                    index: 0, op: 'replace', block: 12,
                    expect: '<p>Raw expect</p>', content: '<p>Raw content</p>',
                    operation: 'str_replace',
                    old_string: '<p>Resolved old</p>', new_string: '<p>Resolved new</p>',
                }],
            },
        });

        expect(rows[0].oldString).toBe('<p>Resolved old</p>');
        expect(rows[0].newString).toBe('<p>Resolved new</p>');
    });

    // The fallback must be blocks-only: a legacy/batch edit has no `expect` or
    // `content`, and reading them would be a shape change on the rollback path.
    it('does not apply the fallback to batch rows', () => {
        const rows = deriveEditNoteRows({
            actionType: 'edit_note_batch',
            actionData: { edits: [{ index: 0, operation: 'str_replace', expect: 'x', content: 'y' } as any] },
        });

        expect(rows[0].oldString).toBe('');
        expect(rows[0].newString).toBe('');
    });
});
