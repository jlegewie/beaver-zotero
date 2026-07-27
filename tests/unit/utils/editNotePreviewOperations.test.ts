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
});
