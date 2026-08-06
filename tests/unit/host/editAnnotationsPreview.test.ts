import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    annotationTagDelta,
    commentPillPreview,
    netSummary,
    noteTooltipComment,
    type EditGroupView,
} from '../../../react/host/zotero/components/EditAnnotationsPreview';
import {
    DeleteAnnotationsPreview,
    deleteAnnotationRow,
    deleteAnnotationSnapshots,
} from '../../../react/host/zotero/components/DeleteAnnotationsPreview';

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
    describe('note tooltip comment', () => {
        it('prefers and truncates the proposed comment', () => {
            const oldComment = 'Old comment';
            const newComment = 'N'.repeat(200);

            expect(
                noteTooltipComment(
                    { ...snapshot('AAAAAAA1'), comment: oldComment },
                    { comment: newComment },
                ),
            ).toBe(`${'N'.repeat(180)}...`);
        });

        it('falls back to the existing comment when none is proposed', () => {
            expect(
                noteTooltipComment(
                    { ...snapshot('AAAAAAA1'), comment: 'Existing comment' },
                    { color: 'blue' },
                ),
            ).toBe('Existing comment');
        });

        it('uses an explicitly cleared comment instead of the old one', () => {
            expect(
                noteTooltipComment(
                    { ...snapshot('AAAAAAA1'), comment: 'Existing comment' },
                    { comment: '' },
                ),
            ).toBe('');
        });
    });

    it('uses a shorter preview for the comment change pill', () => {
        expect(commentPillPreview('N'.repeat(200))).toBe(
            `${'N'.repeat(60)}...`,
        );
    });

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

            expect(netSummary(groups)).toBe(
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

            expect(netSummary(groups)).toBe(
                '2 annotations: comment updated',
            );
        });

        it('returns nothing when no annotation could be resolved', () => {
            expect(netSummary([{ key: 'edit-0', rows: [] }])).toBe(null);
        });
    });

    describe('delete preview rows', () => {
        it('keeps the action target order and drops missing previews', () => {
            const first = snapshot('AAAAAAA1');
            const second = snapshot('AAAAAAA2');

            expect(
                deleteAnnotationSnapshots(
                    [
                        {
                            library_id: 1,
                            library_ref: 'u',
                            zotero_key: 'AAAAAAA2',
                        },
                        {
                            library_id: 1,
                            library_ref: 'u',
                            zotero_key: 'MISSING1',
                        },
                        {
                            library_id: 1,
                            library_ref: 'u',
                            zotero_key: 'AAAAAAA1',
                        },
                    ],
                    [first, second],
                ),
            ).toEqual([second, first]);
        });

        it('adapts a persisted snapshot to the shared annotation row', () => {
            const preview = {
                ...snapshot('AAAAAAA1', ['read']),
                annotation_type: 'highlight',
                text: 'Highlighted passage',
                comment: 'A comment',
                page_label: '4',
            };

            expect(deleteAnnotationRow(preview)).toEqual({
                kind: 'annotation',
                library_id: 1,
                zotero_key: 'AAAAAAA1',
                library_ref: 'u',
                annotation_type: 'highlight',
                text: 'Highlighted passage',
                comment: 'A comment',
                color: '#ffd400',
                page_label: '4',
                tags: ['read'],
            });
        });

        it('renders only the shared compact annotation list', () => {
            const preview = {
                ...snapshot('AAAAAAA1'),
                annotation_type: 'highlight',
                text: 'Highlighted passage',
                page_label: '4',
            };
            const markup = renderToStaticMarkup(
                React.createElement(DeleteAnnotationsPreview, {
                    actionData: {
                        operation: 'delete',
                        annotation_refs: [preview],
                        annotation_previews: [preview],
                    },
                    status: 'pending',
                }),
            );

            expect(markup).toContain('Highlighted passage');
            expect(markup).toContain('Page 4');
            expect(markup).not.toContain('Move to trash');
            expect(markup).not.toContain('edit-annotations-preview-list');
            expect(markup).not.toContain('text-decoration');
        });
    });
});
