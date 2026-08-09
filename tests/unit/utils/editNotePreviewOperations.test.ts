import { describe, expect, it } from 'vitest';
import { buildPreviewableEditOperations } from '../../../react/utils/editNotePreviewOperations';

describe('buildPreviewableEditOperations', () => {
    it('supports legacy and batch note edits while preserving batch target anchors', () => {
        const operations = buildPreviewableEditOperations([
            {
                operation: 'str_replace',
                old_string: 'Legacy old',
                new_string: 'Legacy new',
            },
            {
                edits: [{
                    index: 0,
                    operation: 'str_replace',
                    old_string: 'Repeated text',
                    new_string: 'Targeted replacement',
                    target_before_context: '<p>first occurrence</p><p>',
                    target_after_context: '</p></div>',
                }],
            },
        ]);

        expect(operations).toEqual([
            {
                oldString: 'Legacy old',
                newString: 'Legacy new',
                operation: 'str_replace',
            },
            {
                oldString: 'Repeated text',
                newString: 'Targeted replacement',
                operation: 'str_replace',
                targetBeforeContext: '<p>first occurrence</p><p>',
                targetAfterContext: '</p></div>',
            },
        ]);
    });

    /**
     * The `skip_reason_code` guard must be inert for the two variants that
     * never carry the field. This fixture deliberately exercises every shape
     * that reaches the two drop gates — a rewrite and an append (which clear
     * gate 1 on their operation alone), a plain replace, a deletion (empty
     * new_string), and an entry with NO old_string that must still be dropped —
     * and pins the exact output.
     */
    it('is unchanged for legacy and batch payloads, which never carry skip_reason_code', () => {
        const operations = buildPreviewableEditOperations([
            { operation: 'rewrite', old_string: '', new_string: '<p>Whole new body</p>' },
            { operation: 'append', old_string: '', new_string: '<p>Appended</p>' },
            {
                edits: [
                    { index: 0, operation: 'str_replace', old_string: 'a', new_string: 'A' },
                    { index: 1, operation: 'str_replace', old_string: 'gone', new_string: '' },
                    // No old_string and a non-widened operation: dropped by the
                    // pre-existing gate, not by the new guard.
                    { index: 2, operation: 'str_replace', old_string: '', new_string: 'orphan' },
                ],
            },
        ]);

        expect(operations).toEqual([
            { oldString: '', newString: '<p>Whole new body</p>', operation: 'rewrite' },
            { oldString: '', newString: '<p>Appended</p>', operation: 'append' },
            { oldString: 'a', newString: 'A', operation: 'str_replace' },
            { oldString: 'gone', newString: '', operation: 'str_replace' },
        ]);
    });

    /**
     * The reader-side guard, tested on its own terms: the entry below is one
     * validation would never emit (a skipped edit keeps no preview triple), fed
     * in deliberately so the assertion covers the guard rather than the
     * validator's discipline. Without it this edit clears gate 1 on its
     * non-empty old_string and the user is shown an approval diff for an edit
     * execute will never apply.
     */
    it('drops a skipped block edit even when it carries a full preview triple', () => {
        const operations = buildPreviewableEditOperations([{
            edits: [
                {
                    index: 0,
                    op: 'replace',
                    block: 4,
                    skip_reason_code: 'expect_mismatch',
                    skip_reason: 'The text at block 4 did not match `expect`.',
                    operation: 'str_replace',
                    old_string: 'Block four as the model believed it read',
                    new_string: 'Rewritten block four',
                    target_before_context: '<p>three</p>',
                    target_after_context: '<p>five</p>',
                },
                {
                    index: 1,
                    op: 'replace',
                    block: 6,
                    operation: 'str_replace',
                    old_string: 'Block six',
                    new_string: 'Block six, revised',
                },
            ],
        }]);

        expect(operations).toEqual([
            { oldString: 'Block six', newString: 'Block six, revised', operation: 'str_replace' },
        ]);
    });

    it('drops a skipped block edit whose only widening signal is its operation', () => {
        // `rewrite` and `append` clear gate 1 without any old_string, so the
        // guard has to run BEFORE that gate, not alongside it.
        const operations = buildPreviewableEditOperations([{
            edits: [{
                index: 0,
                op: 'replace',
                block: 'all',
                skip_reason_code: 'unbalanced_range',
                operation: 'rewrite',
                new_string: '<p>Replacement body</p>',
            }],
        }]);

        expect(operations).toEqual([]);
    });

    // The guard is scoped to `op`, which only a block edit carries, so its
    // inertness for legacy/batch holds structurally rather than by contract.
    // Batch entries reach this function verbatim from backend action_data
    // whenever validation emits no normalized_action_data, legacy normalization
    // is a full spread that preserves unknown keys, and nothing strips unknown
    // keys at runtime — so a stray key must not be able to drop a batch diff
    // the user is approving while execute still applies it.
    it('does NOT drop a batch edit that somehow carries skip_reason_code', () => {
        const operations = buildPreviewableEditOperations([{
            edits: [{
                index: 0,
                operation: 'str_replace',
                old_string: 'Original batch text',
                new_string: 'Revised batch text',
                skip_reason_code: 'expect_mismatch',
            }],
        }]);

        expect(operations).toEqual([
            { oldString: 'Original batch text', newString: 'Revised batch text', operation: 'str_replace' },
        ]);
    });

    it('previews applicable block edits of every op through the shared flattener', () => {
        const operations = buildPreviewableEditOperations([{
            edits: [
                // An insert is anchor-merged by validation: old_string is the
                // anchor line alone, new_string the anchor plus the insertion,
                // so it survives BOTH drop gates as an ordinary replace-shaped
                // diff rather than needing a relaxed gate of its own.
                {
                    index: 0,
                    op: 'insert',
                    after: 12,
                    operation: 'insert_after',
                    old_string: '<p>Anchor line</p>',
                    new_string: '<p>Anchor line</p>\n<p>Inserted</p>',
                    target_before_context: '<p>eleven</p>',
                    target_after_context: '<p>thirteen</p>',
                },
                {
                    index: 1,
                    op: 'replace',
                    block: 5,
                    operation: 'str_replace',
                    old_string: '<p>Five</p>',
                    new_string: '<p>Five, revised</p>',
                },
                {
                    index: 2,
                    op: 'delete',
                    from_block: 7,
                    to_block: 9,
                    operation: 'str_replace',
                    old_string: '<p>Seven</p>\n<p>Eight</p>\n<p>Nine</p>',
                    new_string: '',
                },
                {
                    index: 3,
                    op: 'replace',
                    block: 'all',
                    operation: 'rewrite',
                    new_string: '<p>Whole new body</p>',
                },
            ],
        }]);

        expect(operations).toEqual([
            {
                oldString: '<p>Anchor line</p>',
                newString: '<p>Anchor line</p>\n<p>Inserted</p>',
                operation: 'insert_after',
                targetBeforeContext: '<p>eleven</p>',
                targetAfterContext: '<p>thirteen</p>',
            },
            {
                oldString: '<p>Five</p>',
                newString: '<p>Five, revised</p>',
                operation: 'str_replace',
            },
            {
                oldString: '<p>Seven</p>\n<p>Eight</p>\n<p>Nine</p>',
                newString: '',
                operation: 'str_replace',
            },
            {
                oldString: '',
                newString: '<p>Whole new body</p>',
                operation: 'rewrite',
            },
        ]);
    });
});
