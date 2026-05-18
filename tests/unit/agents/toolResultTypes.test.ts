import { describe, expect, it } from 'vitest';

import { extractListCollectionsData } from '../../../react/agents/toolResultTypes';

/**
 * extractListCollectionsData is the boundary that normalizes backend
 * list_collections wire data into the canonical CollectionReference. It must
 * fill library_id from the result container, preserve empty results, and bail
 * out when the library scope is absent.
 */
describe('extractListCollectionsData', () => {
    describe('content path', () => {
        it('normalizes CollectionInfo into canonical CollectionReference with container library_id', () => {
            const content = {
                collections: [
                    { collection_key: 'AAAA1111', name: 'Methods', parent_key: 'ROOT0000', item_count: 3, subcollection_count: 0 },
                    { collection_key: 'BBBB2222', name: 'Theory', item_count: 1, subcollection_count: 2 },
                ],
                total_count: 2,
                library_id: 5,
                library_name: 'My Library',
            };

            const result = extractListCollectionsData(content);

            expect(result).toEqual({
                collections: [
                    { library_id: 5, zotero_key: 'AAAA1111', name: 'Methods', parent_key: 'ROOT0000' },
                    { library_id: 5, zotero_key: 'BBBB2222', name: 'Theory', parent_key: null },
                ],
                totalCount: 2,
                libraryId: 5,
                libraryName: 'My Library',
            });
        });

        it('preserves an empty collections array so the view can render "No collections found"', () => {
            const content = { collections: [], total_count: 0, library_id: 5 };

            const result = extractListCollectionsData(content);

            expect(result).not.toBeNull();
            expect(result?.collections).toEqual([]);
        });

        it('returns null when the container library_id is missing', () => {
            const content = {
                collections: [{ collection_key: 'AAAA1111', name: 'Methods', item_count: 0, subcollection_count: 0 }],
                total_count: 1,
            };

            expect(extractListCollectionsData(content)).toBeNull();
        });
    });

    describe('summary path (dehydrated)', () => {
        it('normalizes BackendCollectionRef into canonical CollectionReference with null parent_key', () => {
            const metadata = {
                summary: {
                    tool_name: 'list_collections',
                    collection_count: 1,
                    total_count: 1,
                    has_more: false,
                    library_id: 7,
                    library_name: 'Group Library',
                    collections: [{ collection_key: 'CCCC3333', name: 'Drafts' }],
                },
            };

            const result = extractListCollectionsData(undefined, metadata);

            expect(result).toEqual({
                collections: [
                    { library_id: 7, zotero_key: 'CCCC3333', name: 'Drafts', parent_key: null },
                ],
                totalCount: 1,
                libraryId: 7,
                libraryName: 'Group Library',
            });
        });

        it('preserves an empty collections array', () => {
            const metadata = {
                summary: { tool_name: 'list_collections', collection_count: 0, total_count: 0, has_more: false, library_id: 7, collections: [] },
            };

            const result = extractListCollectionsData(undefined, metadata);

            expect(result).not.toBeNull();
            expect(result?.collections).toEqual([]);
        });

        it('returns null when the summary library_id is missing', () => {
            const metadata = {
                summary: { tool_name: 'list_collections', collection_count: 1, total_count: 1, has_more: false, collections: [{ collection_key: 'CCCC3333', name: 'Drafts' }] },
            };

            expect(extractListCollectionsData(undefined, metadata)).toBeNull();
        });
    });

    it('returns null when neither content nor summary carry collections', () => {
        expect(extractListCollectionsData(undefined)).toBeNull();
        expect(extractListCollectionsData({ total_count: 0 })).toBeNull();
        expect(extractListCollectionsData(undefined, { summary: {} })).toBeNull();
    });
});
