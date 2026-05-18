import { describe, expect, it } from 'vitest';

import {
    collectionReferenceKey,
    collectionToReference,
    type CollectionReference,
} from '../../../react/types/zotero';

describe('collectionReferenceKey', () => {
    it('combines library_id and zotero_key into a composite key', () => {
        const ref: CollectionReference = { library_id: 1, zotero_key: 'ABCD1234', name: 'Methods', parent_key: null };
        expect(collectionReferenceKey(ref)).toBe('1-ABCD1234');
    });

    it('produces distinct keys for the same collection key in different libraries', () => {
        // Zotero collection keys are only unique within a library, so two
        // libraries can legitimately share a key.
        const a: CollectionReference = { library_id: 1, zotero_key: 'ABCD1234', name: 'Inbox', parent_key: null };
        const b: CollectionReference = { library_id: 5, zotero_key: 'ABCD1234', name: 'Inbox', parent_key: null };
        expect(collectionReferenceKey(a)).not.toBe(collectionReferenceKey(b));
    });
});

describe('collectionToReference', () => {
    it('builds a canonical CollectionReference from a live Zotero collection', () => {
        const collection = { libraryID: 3, key: 'EFGH5678', name: 'Theory', parentKey: 'ROOT0000' };
        expect(collectionToReference(collection as any)).toEqual({
            library_id: 3,
            zotero_key: 'EFGH5678',
            name: 'Theory',
            parent_key: 'ROOT0000',
        });
    });

    it('normalizes a missing parent key to null', () => {
        const collection = { libraryID: 3, key: 'EFGH5678', name: 'Theory', parentKey: false };
        expect(collectionToReference(collection as any).parent_key).toBeNull();
    });
});
