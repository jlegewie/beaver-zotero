/**
 * Unit tests for `handleExternalReferenceCheckRequest`.
 *
 * Mocks `batchFindExistingReferences` to verify:
 *   - timing fields propagate into the response
 *   - library_ids default to the searchable (non-excluded) libraries when empty
 *   - an explicit library_ids is handed to the shared filter resolver verbatim
 *     (portable tokens included) and only its result is searched
 *   - a thrown error produces an all-null response (no reject)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

const mockBatchFindExistingReferences = vi.fn();
vi.mock('../../../react/utils/batchFindExistingReferences', () => ({
    batchFindExistingReferences: (...args: any[]) => mockBatchFindExistingReferences(...args),
}));

const { mockGetSearchableLibraryIds, mockResolveLibrariesFilterToSearchableIds } = vi.hoisted(() => ({
    mockGetSearchableLibraryIds: vi.fn(() => [1, 42] as number[]),
    mockResolveLibrariesFilterToSearchableIds: vi.fn(),
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: mockGetSearchableLibraryIds,
    resolveLibrariesFilterToSearchableIds: mockResolveLibrariesFilterToSearchableIds,
}));

import { handleExternalReferenceCheckRequest } from '../../../src/services/agentDataProvider/handleExternalReferenceCheckRequest';

const baseRequest = {
    type: 'external_reference_check_request' as const,
    request_id: 'req-1',
    library_ids: [1],
    items: [
        {
            id: 'W1',
            title: 'Paper One',
            doi: '10.1/one',
            isbn: null,
            date: '2020',
            creators: ['Smith'],
        },
        {
            id: 'W2',
            title: 'Paper Two',
            doi: null,
            isbn: null,
            date: '2021',
            creators: ['Jones'],
        },
    ],
};

beforeEach(() => {
    mockBatchFindExistingReferences.mockReset();
    mockGetSearchableLibraryIds.mockReturnValue([1, 42]);
    // Matches `baseRequest.library_ids`; cases that care set their own.
    mockResolveLibrariesFilterToSearchableIds.mockReturnValue([1]);
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('handleExternalReferenceCheckRequest', () => {
    it('propagates timing fields from batchFindExistingReferences into the response', async () => {
        mockBatchFindExistingReferences.mockResolvedValue({
            results: [
                { id: 'W1', item: { library_id: 1, zotero_key: 'KEY1' } },
                { id: 'W2', item: null },
            ],
            timing: {
                total_ms: 123,
                phase1_identifier_lookup_ms: 45,
                phase2_title_candidates_ms: 77,
                phase3_fuzzy_matching_ms: 1,
                candidates_fetched: 3,
                matches_by_identifier: 1,
                matches_by_fuzzy: 0,
            },
        });

        const response = await handleExternalReferenceCheckRequest(baseRequest as any);

        expect(mockBatchFindExistingReferences).toHaveBeenCalledWith(
            expect.any(Array),
            [1]
        );

        expect(response.type).toBe('external_reference_check');
        expect(response.request_id).toBe('req-1');
        expect(response.results).toEqual([
            { id: 'W1', exists: true, item: { library_id: 1, zotero_key: 'KEY1' } },
            { id: 'W2', exists: false },
        ]);
        expect(response.timing).toMatchObject({
            total_ms: 123,
            item_count: 2,
            phase1_identifier_lookup_ms: 45,
            phase2_title_candidates_ms: 77,
            phase3_fuzzy_matching_ms: 1,
            candidates_fetched: 3,
            matches_by_identifier: 1,
            matches_by_fuzzy: 0,
        });
    });

    it('falls back to the searchable libraries when library_ids is undefined', async () => {
        mockGetSearchableLibraryIds.mockReturnValue([1, 42]);
        mockBatchFindExistingReferences.mockResolvedValue({
            results: baseRequest.items.map(i => ({ id: i.id, item: null })),
            timing: {
                total_ms: 10, phase1_identifier_lookup_ms: 5, phase2_title_candidates_ms: 5,
                phase3_fuzzy_matching_ms: 0, candidates_fetched: 0, matches_by_identifier: 0,
                matches_by_fuzzy: 0,
            },
        });

        const req = { ...baseRequest, library_ids: undefined };
        await handleExternalReferenceCheckRequest(req as any);

        expect(mockBatchFindExistingReferences).toHaveBeenCalledWith(
            expect.any(Array),
            [1, 42]
        );
    });

    it('falls back to the searchable libraries when library_ids is an empty array', async () => {
        mockGetSearchableLibraryIds.mockReturnValue([1]);
        mockBatchFindExistingReferences.mockResolvedValue({
            results: baseRequest.items.map(i => ({ id: i.id, item: null })),
            timing: {
                total_ms: 1, phase1_identifier_lookup_ms: 0, phase2_title_candidates_ms: 0,
                phase3_fuzzy_matching_ms: 0, candidates_fetched: 0, matches_by_identifier: 0,
                matches_by_fuzzy: 0,
            },
        });

        const req = { ...baseRequest, library_ids: [] };
        await handleExternalReferenceCheckRequest(req as any);

        expect(mockBatchFindExistingReferences).toHaveBeenCalledWith(
            expect.any(Array),
            [1]
        );
    });

    // The handler's own job for an explicit `library_ids` is to hand the entries
    // to the shared resolver untouched and search exactly what comes back — it
    // must not pre-filter, re-map, or widen. The resolver's own contract (portable
    // tokens, numeric ids, names, and the intersection with the searchable set
    // that keeps excluded libraries out) is pinned in getLibraryByIdOrName.test.ts.
    it('forwards an explicit library_ids to the shared resolver verbatim and searches only its result', async () => {
        mockGetSearchableLibraryIds.mockReturnValue([1, 42]);
        mockResolveLibrariesFilterToSearchableIds.mockReturnValue([42]);
        mockBatchFindExistingReferences.mockResolvedValue({
            results: baseRequest.items.map(i => ({ id: i.id, item: null })),
            timing: {
                total_ms: 1, phase1_identifier_lookup_ms: 0, phase2_title_candidates_ms: 0,
                phase3_fuzzy_matching_ms: 0, candidates_fetched: 0, matches_by_identifier: 0,
                matches_by_fuzzy: 0,
            },
        });

        // Portable token, legacy numeric id and a name in one request: none of
        // them is the handler's to interpret.
        const req = { ...baseRequest, library_ids: ['g555', 99, 'Group Alpha'] };
        await handleExternalReferenceCheckRequest(req as any);

        expect(mockResolveLibrariesFilterToSearchableIds).toHaveBeenCalledWith(['g555', 99, 'Group Alpha']);
        expect(mockGetSearchableLibraryIds).not.toHaveBeenCalled();
        expect(mockBatchFindExistingReferences).toHaveBeenCalledWith(expect.any(Array), [42]);
    });

    it('searches nothing when an explicit library_ids resolves to nothing', async () => {
        mockGetSearchableLibraryIds.mockReturnValue([1, 42]);
        mockResolveLibrariesFilterToSearchableIds.mockReturnValue([]);
        mockBatchFindExistingReferences.mockResolvedValue({
            results: baseRequest.items.map(i => ({ id: i.id, item: null })),
            timing: {
                total_ms: 1, phase1_identifier_lookup_ms: 0, phase2_title_candidates_ms: 0,
                phase3_fuzzy_matching_ms: 0, candidates_fetched: 0, matches_by_identifier: 0,
                matches_by_fuzzy: 0,
            },
        });

        // An unresolvable or fully excluded filter must narrow the search to
        // nothing, never fall back to every searchable library.
        const req = { ...baseRequest, library_ids: ['g999999'] };
        await handleExternalReferenceCheckRequest(req as any);

        expect(mockBatchFindExistingReferences).toHaveBeenCalledWith(expect.any(Array), []);
    });

    it('returns all items as not found and zero timing on batch failure', async () => {
        mockBatchFindExistingReferences.mockRejectedValue(new Error('boom'));

        const response = await handleExternalReferenceCheckRequest(baseRequest as any);

        expect(response.results).toHaveLength(baseRequest.items.length);
        expect(response.results.every(r => r.exists === false)).toBe(true);
        expect(response.timing.phase1_identifier_lookup_ms).toBe(0);
        expect(response.timing.phase2_title_candidates_ms).toBe(0);
        expect(response.timing.phase3_fuzzy_matching_ms).toBe(0);
        expect(response.timing.item_count).toBe(baseRequest.items.length);
    });
});
