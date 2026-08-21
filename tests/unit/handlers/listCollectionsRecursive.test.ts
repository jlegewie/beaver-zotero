/**
 * `handleListCollectionsRequest` — the `recursive` scope and the page size.
 *
 * A client that mirrors a library's collections wants one call, not one call
 * per level, so what these tests pin is that `recursive` widens the scope to
 * every descendant while leaving each row's tree position intact, and that the
 * default stays direct children.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    validateLibraryAccess: vi.fn(),
    getCollectionByIdOrName: vi.fn(),
    isLibrarySearchable: vi.fn(() => true),
    getSearchableLibraries: vi.fn(() => []),
    excludedLibraryMessage: vi.fn(() => 'excluded'),
    getCollectionItemCounts: vi.fn(async () => new Map()),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    validateLibraryAccess: mocks.validateLibraryAccess,
    getCollectionByIdOrName: mocks.getCollectionByIdOrName,
    isLibrarySearchable: mocks.isLibrarySearchable,
    getSearchableLibraries: mocks.getSearchableLibraries,
    excludedLibraryMessage: mocks.excludedLibraryMessage,
}));

vi.mock('../../../src/services/agentDataProvider/collectionCounts', () => ({
    getCollectionItemCounts: mocks.getCollectionItemCounts,
}));

vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: vi.fn(() => 'u'),
}));

import { handleListCollectionsRequest } from '../../../src/services/agentDataProvider/handleListCollectionsRequest';

/**
 * A three-level library: two roots, one of which has a child that has a child
 * of its own.
 */
function collection(id: number, name: string, parentID: number | null) {
    return {
        id,
        key: `KEY${id}`,
        name,
        parentID: parentID ?? undefined,
        parentKey: parentID ? `KEY${parentID}` : null,
    };
}

const ALL = [
    collection(1, 'Papers', null),
    collection(2, 'Methods', 1),
    collection(3, 'Surveys', 2),
    collection(4, 'Teaching', null),
];

const getByLibrary = vi.fn(() => ALL);
const getByParent = vi.fn((parentId: number) => (
    parentId === 1 ? [ALL[1], ALL[2]] : []
));

function request(overrides: Record<string, any> = {}) {
    return {
        event: 'list_collections_request',
        request_id: 'r1',
        library_id: 1,
        include_item_counts: false,
        limit: 50,
        offset: 0,
        ...overrides,
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateLibraryAccess.mockReturnValue({
        valid: true,
        library: { libraryID: 1, name: 'My Library' },
    });
    mocks.getCollectionItemCounts.mockResolvedValue(new Map());
    getByLibrary.mockReturnValue(ALL);
    getByParent.mockImplementation((parentId: number) => (parentId === 1 ? [ALL[1], ALL[2]] : []));

    (globalThis as any).Zotero.Collections = { getByLibrary, getByParent };
});

describe('handleListCollectionsRequest recursive', () => {
    it('returns top-level collections only by default', async () => {
        const res = await handleListCollectionsRequest(request());

        expect(res.collections.map((c) => c.name)).toEqual(['Papers', 'Teaching']);
        expect(res.total_count).toBe(2);
    });

    it('returns the whole library in one call when recursive', async () => {
        const res = await handleListCollectionsRequest(request({ recursive: true }));

        expect(res.collections.map((c) => c.name).sort()).toEqual([
            'Methods', 'Papers', 'Surveys', 'Teaching',
        ]);
        expect(res.total_count).toBe(4);
        // The flat list still carries each row's place in the tree.
        const surveys = res.collections.find((c) => c.name === 'Surveys');
        expect(surveys?.parent_key).toBe('KEY2');
        expect(surveys?.parent_name).toBe('Methods');
    });

    it('returns every descendant of a parent collection, not just its children', async () => {
        mocks.getCollectionByIdOrName.mockReturnValue({
            libraryID: 1,
            collection: { id: 1, key: 'KEY1' },
        });

        const res = await handleListCollectionsRequest(
            request({ parent_collection_key: 'KEY1', recursive: true })
        );

        expect(getByParent).toHaveBeenCalledWith(1, true);
        expect(res.collections.map((c) => c.name)).toEqual(['Methods', 'Surveys']);
    });

    it('reports subcollection counts from the whole library, not the listed page', async () => {
        const res = await handleListCollectionsRequest(request({ recursive: true }));

        const byName = new Map(res.collections.map((c) => [c.name, c]));
        expect(byName.get('Papers')?.subcollection_count).toBe(1);
        expect(byName.get('Methods')?.subcollection_count).toBe(1);
        expect(byName.get('Teaching')?.subcollection_count).toBe(0);
    });

    it('serves a page large enough to hold a whole library', async () => {
        const many = Array.from({ length: 900 }, (_, i) => collection(i + 10, `C${i}`, null));
        getByLibrary.mockReturnValue(many);

        const res = await handleListCollectionsRequest(request({ recursive: true, limit: 1000 }));

        expect(res.collections).toHaveLength(900);
    });

    it('caps an unbounded limit rather than serializing whatever was asked for', async () => {
        const many = Array.from({ length: 1200 }, (_, i) => collection(i + 10, `C${i}`, null));
        getByLibrary.mockReturnValue(many);

        const res = await handleListCollectionsRequest(request({ recursive: true, limit: 100000 }));

        expect(res.collections).toHaveLength(1000);
        // The client can still tell it did not get everything.
        expect(res.total_count).toBe(1200);
    });

    it('treats limit 0 as an empty page rather than one row', async () => {
        const res = await handleListCollectionsRequest(request({ limit: 0 }));

        expect(res.collections).toEqual([]);
        expect(res.total_count).toBe(2);
    });
});
