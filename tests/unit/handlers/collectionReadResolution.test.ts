/**
 * Focused unit tests for getCollectionByIdOrName (src/services/agentDataProvider/utils.ts).
 *
 * The module has a wide transitive dependency surface (document extraction,
 * sync, popups, etc.) that getCollectionByIdOrName itself never touches, so
 * every unrelated dependency is stubbed out just to make the module
 * importable in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(),
    safeFileExists: vi.fn(),
    isLinkedUrlAttachment: vi.fn(),
}));
vi.mock('../../../src/utils/sync', () => ({
    syncingItemFilterAsync: vi.fn(),
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(),
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({
    addPopupMessageAtom: {},
}));
vi.mock('../../../react/utils/sourceUtils', () => ({
    wasItemAddedBeforeLastSync: vi.fn(),
}));
vi.mock('../../../react/atoms/deferredToolPreferences', () => ({
    deferredToolPreferencesAtom: {},
}));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    isAgentSupportedItem: vi.fn(),
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1, 100]) },
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    activeRunAtom: Symbol('activeRunAtom'),
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfo', () => ({
    getAttachmentInfo: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    getBestAttachmentBatch: vi.fn(),
    prepareAttachmentInfoBatchData: vi.fn(),
    processAttachmentInfoBatch: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction', () => ({
    loadPdfData: vi.fn(),
    isRemoteAccessAvailable: vi.fn(),
    validateZoteroItemReference: vi.fn(),
    checkRemotePdfSize: vi.fn(),
    preflightCachedPdfMeta: vi.fn(),
    resolveToPdfAttachment: vi.fn(),
    resolveToImageAttachment: vi.fn(),
}));

vi.mock('../../../src/utils/searchTools', () => ({
    resolveItemsByFilters: vi.fn(async () => ({ itemIDs: [], matchedTags: [], matchedAuthors: [] })),
}));
import { resolveItemsByFilters } from '../../../src/utils/searchTools';
import { handleResolveSearchFiltersRequest } from '../../../src/services/agentDataProvider/handleResolveSearchFiltersRequest';
import { handleZoteroSearchRequest } from '../../../src/services/agentDataProvider/handleZoteroSearchRequest';
import { handleResolvePopulationRequest } from '../../../src/services/agentDataProvider/handleResolvePopulationRequest';
import { handleListCollectionsRequest } from '../../../src/services/agentDataProvider/handleListCollectionsRequest';
import { handleListItemsRequest } from '../../../src/services/agentDataProvider/handleListItemsRequest';
import { handleListTagsRequest } from '../../../src/services/agentDataProvider/handleListTagsRequest';
import { handleFindAnnotationsRequest } from '../../../src/services/agentDataProvider/handleFindAnnotationsRequest';

const collections = [
    { id: 10, libraryID: 1, key: 'ABCD2345', name: 'Research' },
    { id: 20, libraryID: 7, key: 'ABCD2345', name: 'Research' },
    { id: 21, libraryID: 7, key: 'CHILD234', name: 'Methods', parentID: 20, parentKey: 'ABCD2345' },
];
let previous: any;
let searches: any[];
beforeEach(() => {
    previous = (globalThis as any).Zotero;
    searches = [];
    const libraries = [{ libraryID: 1, name: 'My Library' }, { libraryID: 7, name: 'Group' }];
    (globalThis as any).Zotero = {
        Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1, 7] },
        Libraries: { userLibraryID: 1, userLibrary: libraries[0], get: (id: number) => libraries.find(l => l.libraryID === id), getAll: () => libraries },
        Groups: { getLibraryIDFromGroupID: (id: number) => id === 12345 ? 7 : false, getGroupIDFromLibraryID: (id: number) => id === 7 ? 12345 : false },
        Collections: {
            get: (id: number) => collections.find(c => c.id === id),
            getByLibraryAndKey: (id: number, key: string) => collections.find(c => c.libraryID === id && c.key === key),
            getByLibrary: (id: number) => collections.filter(c => c.libraryID === id),
            getByParent: (id: number) => collections.filter(c => c.parentID === id),
        },
        Search: class {
            libraryID = 0;
            addCondition = vi.fn();
            setScope = vi.fn();
            search = vi.fn(async () => []);
            constructor() { searches.push(this); }
        },
        ItemTypes: { getID: () => 4 },
        Items: { getAsync: async () => [], loadDataTypes: async () => {} },
        Utilities: { isValidObjectKey: (value: string) => /^[A-Z0-9]{8}$/.test(value) },
    };
});
afterEach(() => { (globalThis as any).Zotero = previous; });

const request = (extra: Record<string, unknown> = {}) => ({ event: 'list_collections_request', request_id: 'r', ...extra } as any);

describe('collection read wire compatibility', () => {
    it.each(['ABCD2345', 'g12345-ABCD2345', '7-ABCD2345', 'Research'])('accepts scoped parent %s and preserves native output fields', async parent => {
        const result = await handleListCollectionsRequest(request({ library_id: 7, parent_collection_key: parent }));
        expect(result.error).toBeUndefined();
        expect(result.library_id).toBe(7);
        expect(result.collections).toEqual([expect.objectContaining({
            collection_key: 'CHILD234', parent_key: 'ABCD2345', name: 'Methods',
            collection_id: 'g12345-CHILD234', parent_collection_id: 'g12345-ABCD2345', library_ref: 'g12345',
        })]);
    });
    it('uses the qualified parent library when the omitted default library is excluded', async () => {
        (globalThis as any).Zotero.Beaver.searchableLibraryIds = [7];
        const result = await handleListCollectionsRequest(request({ parent_collection_key: 'g12345-ABCD2345' }));
        expect(result.error).toBeUndefined();
        expect(result.collections[0].collection_id).toBe('g12345-CHILD234');
    });
    it('does not reinterpret a missing qualified parent as a collection name', async () => {
        const result = await handleListCollectionsRequest(request({ parent_collection_key: 'g99999-ABCD2345' }));
        expect(result.error_code).toBe('library_unavailable');
        expect(result.collections).toEqual([]);
    });
    it('keeps full-text filters scoped and reports partially unresolved collections', async () => {
        const result = await handleResolveSearchFiltersRequest(request({ collections: ['g12345-ABCD2345', 'Missing'] }));
        expect(result.error).toBeUndefined();
        expect(result.unresolved?.collections).toEqual(['Missing']);
        expect(resolveItemsByFilters).toHaveBeenCalledWith(7, expect.objectContaining({ collectionKeys: ['ABCD2345'] }));
    });
    it('fails ambiguous and all-invalid full-text filters before resolving members', async () => {
        vi.mocked(resolveItemsByFilters).mockClear();
        const ambiguous = await handleResolveSearchFiltersRequest(request({ collections: ['ABCD2345'] }));
        expect(ambiguous.error_code).toBe('ambiguous_collection');
        expect(ambiguous.error).not.toContain('CollectionResolutionError:');
        const missing = await handleResolveSearchFiltersRequest(request({ collections: ['Missing'] }));
        expect(missing.error_code).toBe('collection_not_found');
        expect(resolveItemsByFilters).not.toHaveBeenCalled();
    });

    it('infers the advanced-search library from a qualified negative condition when library is omitted', async () => {
        const result = await handleZoteroSearchRequest(request({
            conditions: [{ field: 'collection', operator: 'isNot', value: 'g12345-ABCD2345' }],
            join_mode: 'any',
        }));
        expect(result.error).toBeUndefined();
        expect(searches[0].libraryID).toBe(7);
        expect(searches[0].addCondition).toHaveBeenCalledWith('collection', 'isNot', 'ABCD2345');
    });
    it('keeps populations in one library and returns portable IDs alongside labels', async () => {
        const result = await handleResolvePopulationRequest(request({ collection_keys: ['g12345-ABCD2345'], max_items: 0 }));
        expect(result.error).toBeUndefined();
        expect(result.collection_names).toEqual(['Research']);
        expect(result.collection_ids).toEqual(['g12345-ABCD2345']);
        expect(searches.every(search => search.libraryID === 7)).toBe(true);
        searches = [];
        const mismatch = await handleResolvePopulationRequest(request({ collection_keys: ['u-ABCD2345', 'g12345-ABCD2345'] }));
        expect(mismatch.error_code).toBe('library_collection_mismatch');
        expect(searches).toEqual([]);
    });

    it.each([
        ['list_collections', handleListCollectionsRequest, 'parent_collection_key'],
        ['list_items', handleListItemsRequest, 'collection_key'],
        ['list_tags', handleListTagsRequest, 'collection_key'],
        ['find_annotations', handleFindAnnotationsRequest, 'collection'],
    ] as const)('%s rejects ambiguity and explicit library conflicts before reading members', async (_name, handler, field) => {
        const ambiguous = await handler(request({ [field]: 'ABCD2345' }));
        expect(ambiguous.error_code).toBe('ambiguous_collection');
        expect(ambiguous.error).not.toContain('CollectionResolutionError:');
        const missing = await handler(request({ library_id: 1, [field]: 'u-MISS2345' }));
        expect(missing.error_code).toBe('collection_not_found');
        expect(missing.error).toContain('u-MISS2345');
        expect(missing.error).toContain('list_collections');
        const conflict = await handler(request({ library_id: 1, [field]: 'g12345-ABCD2345' }));
        expect(conflict.error_code).toBe('library_collection_mismatch');
    });
});
