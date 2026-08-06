import { describe, expect, it } from 'vitest';
import {
    annotationTagDelta,
    netSummary,
    type EditGroupView,
} from '../../../react/host/zotero/components/EditAnnotationsPreview';

const snapshot = (key: string, tags: string[] = []) =>
    ({
        annotation_id: `u-${key}`,
        library_id: 1,
        library_ref: 'u',
        zotero_key: key,
        color: '#ffd400',
        comment: '',
        tags,
    }) as any;

describe('EditAnnotationsPreview', () => {
    it('treats missing legacy snapshot tags as an empty tag set', () => {
        expect(
            annotationTagDelta(
                {
                    annotation_id: 'u-AAAAAAA1',
                    library_id: 1,
                    library_ref: 'u',
                    zotero_key: 'AAAAAAA1',
                    color: '',
                    comment: '',
                } as any,
                { add_tags: ['new'], remove_tags: ['old'] },
            ),
        ).toEqual({ added: ['new'], removed: [] });
    });

    describe('netSummary', () => {
        it('counts an annotation once across the groups that touch it', () => {
            const groups: EditGroupView[] = [
                {
                    key: 'edit-0',
                    changes: { color: 'blue' },
                    rows: [snapshot('AAAAAAA1'), snapshot('AAAAAAA2')],
                },
                {
                    key: 'edit-1',
                    changes: { add_tags: ['read'] },
                    rows: [snapshot('AAAAAAA2')],
                },
            ];

            expect(netSummary(groups, false)).toBe(
                '2 annotations: recolored, tags updated',
            );
        });

        it('omits a tag verb that changes nothing on any target', () => {
            const groups: EditGroupView[] = [
                {
                    key: 'edit-0',
                    changes: { comment: 'note' },
                    rows: [snapshot('AAAAAAA1')],
                },
                {
                    key: 'edit-1',
                    changes: { add_tags: ['read'] },
                    rows: [snapshot('AAAAAAA2', ['read'])],
                },
            ];

            expect(netSummary(groups, false)).toBe(
                '2 annotations: comment updated',
            );
        });

        it('describes a deletion as a move to the trash', () => {
            const groups: EditGroupView[] = [
                { key: 'delete', rows: [snapshot('AAAAAAA1')] },
            ];

            expect(netSummary(groups, true)).toBe('1 annotation moved to trash');
        });

        it('returns nothing when no annotation could be resolved', () => {
            expect(netSummary([{ key: 'edit-0', rows: [] }], false)).toBe(null);
        });
    });
});
