import { describe, expect, it } from 'vitest';
import { flattenRefTokens, splitContentByRefTokens } from '../../../react/utils/refTokens';
import type { MessageAttachment } from '../../../react/types/attachments/apiTypes';

const itemRef: MessageAttachment = {
    type: 'item',
    library_id: 1,
    zotero_key: 'ITEMKEY',
    item: {
        item_id: '1-ITEMKEY',
        item_type: 'journalArticle',
        title: 'Item Title',
        creators: 'Smith',
        year: 2026,
    },
};

const collectionRef: MessageAttachment = {
    type: 'collection',
    library_id: 1,
    zotero_key: 'COLLKEY',
    name: 'Collection Name',
    parent_key: null,
};

describe('refTokens', () => {
    it('splits text and resolved ref tokens', () => {
        const segments = splitContentByRefTokens('Use <ref id="r0"/> now', { r0: itemRef });

        expect(segments).toEqual([
            { type: 'text', text: 'Use ' },
            { type: 'ref', refId: 'r0', attachment: itemRef },
            { type: 'text', text: ' now' },
        ]);
    });

    it('flattens item and collection refs to display names', () => {
        expect(
            flattenRefTokens('<ref id="r0"/> in <ref id="r1"/>', {
                r0: itemRef,
                r1: collectionRef,
            }),
        ).toBe('Item Title in Collection Name');
    });

    it('degrades missing refs to raw text', () => {
        expect(flattenRefTokens('Use <ref id="missing"/>', {})).toBe('Use <ref id="missing"/>');
    });

    it('passes through text without tokens', () => {
        expect(splitContentByRefTokens('No refs here', {})).toEqual([
            { type: 'text', text: 'No refs here' },
        ]);
    });
});
