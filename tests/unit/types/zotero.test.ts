import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectionReferenceKey,
    type CollectionReference,
} from '@beaver/agent-core/types/zotero';
import { collectionToReference } from '../../../react/utils/zoteroReferences';

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
    beforeEach(() => {
        vi.stubGlobal('Zotero', { Libraries: { userLibraryID: 1 }, Groups: { getGroupIDFromLibraryID: () => 12345 } });
    });
    it('builds a canonical CollectionReference from a live Zotero collection', () => {
        const collection = { libraryID: 3, key: 'EFGH5678', name: 'Theory', parentKey: 'ROOT0000' };
        expect(collectionToReference(collection as any)).toEqual({
            library_id: 3,
            library_ref: 'g12345',
            collection_id: 'g12345-EFGH5678',
            parent_collection_id: 'g12345-ROOT0000',
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
