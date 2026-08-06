import { describe, expect, it } from 'vitest';
import { annotationTagDelta } from '../../../react/host/zotero/components/EditAnnotationsPreview';

describe('EditAnnotationsPreview', () => {
    it('treats missing legacy snapshot tags as an empty tag set', () => {
        const snapshot = {
            annotation_id: 'u-AAAAAAA1',
            library_id: 1,
            library_ref: 'u',
            zotero_key: 'AAAAAAA1',
            color: '',
            comment: '',
        } as any;

        expect(
            annotationTagDelta(snapshot, {
                add_tags: ['new'],
                remove_tags: ['old'],
            }),
        ).toEqual({ added: ['new'], removed: [] });
    });
});
