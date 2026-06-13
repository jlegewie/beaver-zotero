import { describe, expect, it } from 'vitest';

import {
    extractAnnotationAttachmentId,
    extractGetAnnotationsData,
    extractListCollectionsData,
    isGetAnnotationsResult,
    isExternalSearchResult,
    isLookupWorkResult,
    extractLookupWorkData,
    extractLookupWorkFoundCount,
} from '../../../react/agents/toolResultTypes';

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

    describe('future backend formats (per-collection / compound library scope)', () => {
        it('resolves library_id from a per-collection field when no container scope exists', () => {
            const content = {
                collections: [{ collection_key: 'AAAA1111', name: 'Methods', library_id: 9, item_count: 0, subcollection_count: 0 }],
                total_count: 1,
            };

            const result = extractListCollectionsData(content);

            expect(result?.collections).toEqual([
                { library_id: 9, zotero_key: 'AAAA1111', name: 'Methods', parent_key: null },
            ]);
        });

        it('prefers a per-collection library_id over the container library_id', () => {
            const metadata = {
                summary: {
                    tool_name: 'list_collections',
                    collection_count: 1,
                    total_count: 1,
                    has_more: false,
                    library_id: 5,
                    collections: [{ collection_key: 'AAAA1111', name: 'Methods', library_id: 9 }],
                },
            };

            const result = extractListCollectionsData(undefined, metadata);

            expect(result?.collections).toEqual([
                { library_id: 9, zotero_key: 'AAAA1111', name: 'Methods', parent_key: null },
            ]);
        });

        it('splits a compound collection_key into library scope and a bare zotero_key', () => {
            const content = {
                collections: [{ collection_key: '6-ABCD1234', name: 'Methods', item_count: 0, subcollection_count: 0 }],
                total_count: 1,
            };

            const result = extractListCollectionsData(content);

            expect(result?.collections).toEqual([
                { library_id: 6, zotero_key: 'ABCD1234', name: 'Methods', parent_key: null },
            ]);
        });

        it('prefers the compound library when it conflicts with the container library_id', () => {
            const content = {
                collections: [{ collection_key: '6-ABCD1234', name: 'Methods', item_count: 0, subcollection_count: 0 }],
                total_count: 1,
                library_id: 9,
            };

            const result = extractListCollectionsData(content);

            expect(result?.collections).toEqual([
                { library_id: 6, zotero_key: 'ABCD1234', name: 'Methods', parent_key: null },
            ]);
        });

        it('prefers the compound library when it conflicts with an explicit per-collection library_id', () => {
            const metadata = {
                summary: {
                    tool_name: 'list_collections',
                    collection_count: 1,
                    total_count: 1,
                    has_more: false,
                    collections: [{ collection_key: '6-ABCD1234', name: 'Methods', library_id: 9 }],
                },
            };

            const result = extractListCollectionsData(undefined, metadata);

            expect(result?.collections).toEqual([
                { library_id: 6, zotero_key: 'ABCD1234', name: 'Methods', parent_key: null },
            ]);
        });

    });

    describe('error responses', () => {
        it('returns null for an error payload with an empty collections array', () => {
            // list_collections failures return { collections: [], total_count: 0,
            // error, error_code } without library scope — must not render as a
            // successful "No collections found" result.
            const content = { collections: [], total_count: 0, error: 'list failed', error_code: 'list_failed' };

            expect(extractListCollectionsData(content)).toBeNull();
        });

        it('returns null for an error payload even when library scope is present', () => {
            const content = { collections: [], total_count: 0, library_id: 5, error_code: 'list_failed' };

            expect(extractListCollectionsData(content)).toBeNull();
        });

        it('returns null for a scopeless empty result', () => {
            expect(extractListCollectionsData({ collections: [], total_count: 0 })).toBeNull();
        });

        it('still renders a genuine successful empty result that carries library scope', () => {
            const result = extractListCollectionsData({ collections: [], total_count: 0, library_id: 5 });

            expect(result).not.toBeNull();
            expect(result?.collections).toEqual([]);
        });
    });
});

describe('find_annotations dehydrated summary', () => {
    const metadata = {
        summary: {
            tool_name: 'find_annotations',
            result_count: 1,
            total_count: 3,
            has_more: true,
            annotations: [{ library_id: 1, zotero_key: 'ANN12345' }],
        },
    };

    it('routes find_annotations through the annotation result guard', () => {
        expect(isGetAnnotationsResult('find_annotations', undefined, metadata)).toBe(true);
    });

    it('extracts annotation references without requiring attachment scope', () => {
        expect(extractGetAnnotationsData(undefined, metadata)).toEqual({
            annotations: [{ library_id: 1, zotero_key: 'ANN12345' }],
            totalCount: 3,
            toolName: 'find_annotations',
        });
    });
});

describe('extractAnnotationAttachmentId', () => {
    it('reads attachment_id from object args', () => {
        expect(extractAnnotationAttachmentId({ attachment_id: '1-ABCDEFGH' })).toBe('1-ABCDEFGH');
    });

    it('reads attachment_id from JSON string args', () => {
        expect(extractAnnotationAttachmentId('{"attachment_id":"1-ABCDEFGH"}')).toBe('1-ABCDEFGH');
    });

    it('returns null when args are unparseable or unscoped', () => {
        expect(extractAnnotationAttachmentId('{')).toBeNull();
        expect(extractAnnotationAttachmentId({ text_contains: 'foo' })).toBeNull();
        expect(extractAnnotationAttachmentId(null)).toBeNull();
    });
});

describe('lookup_work results', () => {
    const batchContent = {
        tool_name: 'lookup_work',
        found_count: 1,
        references: [{
            external_id: 'openlibrary:OL7453684M',
            title: 'Embracing Defeat: Japan in the Wake of World War II',
            authors: ['John W. Dower'],
            year: 2000,
            venue: 'W. W. Norton & Company',
        }],
        not_found_queries: ['Embracing Defeat'],
        temporarily_unchecked_queries: [],
    };

    const metadata = {
        supplemental_data: [{
            external_id: 'openlibrary:OL7453684M',
            source: 'openalex',
            publication_url: 'https://openlibrary.org/books/OL7453684M',
            authors: ['John W. Dower'],
            library_items: [],
        }],
    };

    it('recognizes batch lookup_work payloads', () => {
        expect(isLookupWorkResult('lookup_work', batchContent, metadata)).toBe(true);
    });

    it('does not route lookup_work through external search', () => {
        expect(isExternalSearchResult('lookup_work', batchContent, metadata)).toBe(false);
    });

    it('extracts found references and not-found queries', () => {
        expect(extractLookupWorkData(batchContent, metadata)).toEqual({
            foundCount: 1,
            references: [{
                source_id: 'openlibrary:OL7453684M',
                title: 'Embracing Defeat: Japan in the Wake of World War II',
                authors: ['John W. Dower'],
                year: 2000,
                venue: 'W. W. Norton & Company',
                source: 'openalex',
                id: 'openlibrary:OL7453684M',
                publication_url: 'https://openlibrary.org/books/OL7453684M',
                library_items: [],
            }],
            notFoundQueries: ['Embracing Defeat'],
            temporarilyUncheckedQueries: [],
            message: undefined,
        });
    });

    it('reads found_count for completed labels', () => {
        expect(extractLookupWorkFoundCount(batchContent)).toBe(1);
    });

    it('still supports legacy single-reference payloads', () => {
        const legacyContent = {
            found: true,
            reference: {
                external_id: 'openalex:W123',
                title: 'Legacy Work',
            },
        };

        expect(isLookupWorkResult('lookup_work', legacyContent)).toBe(true);
        expect(extractLookupWorkFoundCount(legacyContent)).toBe(1);
        expect(extractLookupWorkData(legacyContent)).toEqual({
            foundCount: 1,
            references: [{
                source_id: 'openalex:W123',
                title: 'Legacy Work',
                source: 'openalex',
                id: undefined,
                library_items: [],
            }],
            notFoundQueries: [],
            temporarilyUncheckedQueries: [],
            message: undefined,
        });
    });

    it('merges legacy single-object supplemental data for lookup_work', () => {
        const legacyContent = {
            found: true,
            reference: {
                external_id: 'openalex:W123',
                title: 'Legacy Work',
            },
        };
        const legacyMetadata = {
            supplemental_data: {
                external_id: 'openalex:W123',
                source: 'openalex' as const,
                publication_url: 'https://example.org/work',
                identifiers: {
                    doi: '10.1234/example',
                },
                library_items: [{
                    library_id: 1,
                    zotero_key: 'ABCDEFGH',
                    item_id: '1-ABCDEFGH',
                }],
            },
        };

        expect(extractLookupWorkData(legacyContent, legacyMetadata)).toMatchObject({
            foundCount: 1,
            references: [{
                source_id: 'openalex:W123',
                title: 'Legacy Work',
                source: 'openalex',
                id: 'openalex:W123',
                publication_url: 'https://example.org/work',
                identifiers: {
                    doi: '10.1234/example',
                },
                library_items: [{
                    library_id: 1,
                    zotero_key: 'ABCDEFGH',
                    item_id: '1-ABCDEFGH',
                }],
            }],
        });
    });
});
