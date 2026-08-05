/**
 * Unit tests for create_item validation, focused on how the collection
 * arguments are resolved and normalized.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fixture state the faked collection resolver reads.
const harness = vi.hoisted(() => ({
    collections: [] as any[],
    libraryRefs: { 1: 'u', 100: 'g12345' } as Record<number, string>,
    libraryNames: { 1: 'My Library', 100: 'Group Library' } as Record<number, string>,
    searchableLibraryIds: [1, 100] as number[],
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => harness.searchableLibraryIds) },
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../react/utils/batchFindExistingReferences', () => ({
    batchFindExistingReferences: vi.fn(async () => ({ results: [], timing: { total_ms: 0 } })),
}));

vi.mock('../../../react/utils/addItemActions', () => ({
    applyCreateItemData: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/utils', async () => {
    const { createCollectionResolverFake } = await import('../../helpers/collectionResolverFake');
    const fake = createCollectionResolverFake(harness);
    return {
        checkLibraryExcluded: vi.fn(() => null),
        excludedLibraryMessage: vi.fn((id: number) => `Library ${id} excluded`),
        getDeferredToolPreference: vi.fn(() => 'always_ask'),
        resolveCollectionForWrite: vi.fn(fake.resolveCollectionForWrite),
    };
});

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { validateCreateItemAction } from '../../../src/services/agentDataProvider/actions/createItems';

function buildRequest(actionData: Record<string, any>): any {
    return {
        event: 'agent_action_validate',
        request_id: 'req-1',
        action_type: 'create_item',
        action_data: { items: [{ source_id: 's1', title: 'A paper' }], ...actionData },
    };
}

let previousZotero: any;

beforeEach(() => {
    vi.clearAllMocks();
    harness.collections = [
        { id: 1, key: 'RLKEY234', libraryID: 1, name: 'Reading List' },
        { id: 2, key: 'GRPKEY23', libraryID: 100, name: 'Group Reading' },
    ];
    harness.searchableLibraryIds = [1, 100];
    previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
        Libraries: {
            get: vi.fn((id: number) => ({ libraryID: id, name: harness.libraryNames[id], editable: true })),
            userLibraryID: 1,
        },
        Groups: {
            getGroupIDFromLibraryID: vi.fn((id: number) => (id === 100 ? 12345 : false)),
            getLibraryIDFromGroupID: vi.fn((groupId: number) => (groupId === 12345 ? 100 : false)),
        },
    };
});

afterEach(() => {
    (globalThis as any).Zotero = previousZotero;
});

describe('validateCreateItemAction collections', () => {
    it('accepts a scoped collection identifier and normalizes it to a bare key', async () => {
        const res = await validateCreateItemAction(buildRequest({ collections: ['u-RLKEY234'] }));

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data).toMatchObject({
            library_id: 1,
            library_ref: 'u',
            collections: ['RLKEY234'],
        });
        expect(res.current_value.resolved_collections).toEqual([{ key: 'RLKEY234', name: 'Reading List' }]);
    });

    it('rejects a collection name, naming the identifier to use instead', async () => {
        const res = await validateCreateItemAction(buildRequest({ collections: ['Reading List'] }));

        expect(res.valid).toBe(false);
        expect(res.error).toContain('u-RLKEY234');
        expect(res.error).toContain('list_collections');
    });

    it('rejects a collection from a library other than the target', async () => {
        const res = await validateCreateItemAction(buildRequest({ collections: ['g12345-GRPKEY23'] }));

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('invalid_request');
    });

    it('reports an unknown collection key as not found', async () => {
        const res = await validateCreateItemAction(buildRequest({ collections: ['ZZZZ2345'] }));

        expect(res.valid).toBe(false);
        expect(res.error_code).toBe('collection_not_found');
    });

    it('normalizes the library even when no collections were requested', async () => {
        const res = await validateCreateItemAction(buildRequest({ library_ref: 'g12345' }));

        expect(res.valid).toBe(true);
        expect(res.normalized_action_data).toEqual({ library_id: 100, library_ref: 'g12345' });
    });
});
