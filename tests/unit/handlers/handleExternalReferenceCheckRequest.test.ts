/**
 * Unit tests for `handleExternalReferenceCheckRequest`.
 *
 * Mocks `batchFindExistingReferences` to verify:
 *   - timing fields propagate into the response
 *   - library_ids defaults fall back to Zotero.Libraries.getAll() when empty
 *   - a thrown error produces an all-null response (no reject)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

const mockBatchFindExistingReferences = vi.fn();
vi.mock('../../../react/utils/batchFindExistingReferences', () => ({
    batchFindExistingReferences: (...args: any[]) => mockBatchFindExistingReferences(...args),
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

    it('falls back to all libraries when library_ids is undefined', async () => {
        (globalThis as any).Zotero.Libraries.getAll.mockReturnValue([
            { libraryID: 1 },
            { libraryID: 42 },
        ]);
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

    it('falls back to all libraries when library_ids is an empty array', async () => {
        (globalThis as any).Zotero.Libraries.getAll.mockReturnValue([
            { libraryID: 1 },
        ]);
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
