import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

let searchableLibs: number[] = [1];
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => searchableLibs) },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../react/utils/searchTools', () => ({
    resolveItemsByFilters: vi.fn(),
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getCollectionByIdOrName: vi.fn(),
}));
// agentItemFilter: supported unless the item is deleted.
vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: vi.fn((item: any) => !!item && !item.deleted),
}));

import { handleResolveSearchFiltersRequest } from '../../../src/services/agentDataProvider/handleResolveSearchFiltersRequest';
import { resolveItemsByFilters } from '../../../react/utils/searchTools';
import { getCollectionByIdOrName } from '../../../src/services/agentDataProvider/utils';

interface MockItem {
    id: number;
    key: string;
    libraryID: number;
    deleted?: boolean;
    isRegularItem: () => boolean;
    isAttachment: () => boolean;
    getAttachments: () => number[];
}

const itemsById = new Map<number, MockItem>();

function regular(id: number, key: string, attachmentIds: number[], libraryID = 1): MockItem {
    return {
        id, key, libraryID, deleted: false,
        isRegularItem: () => true,
        isAttachment: () => false,
        getAttachments: () => attachmentIds,
    };
}
function attachment(id: number, key: string, opts: { deleted?: boolean; libraryID?: number } = {}): MockItem {
    return {
        id, key, libraryID: opts.libraryID ?? 1, deleted: opts.deleted ?? false,
        isRegularItem: () => false,
        isAttachment: () => true,
        getAttachments: () => [],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    searchableLibs = [1];
    itemsById.clear();

    (globalThis as any).Zotero.Libraries.getAll = vi.fn(() => [{ libraryID: 1, name: 'My Library' }]);
    (globalThis as any).Zotero.Items = {
        getAsync: vi.fn(async (ids: number | number[]) =>
            Array.isArray(ids) ? ids.map((id) => itemsById.get(id) ?? null) : (itemsById.get(ids) ?? null)
        ),
        loadDataTypes: vi.fn(async () => undefined),
    };

    (getCollectionByIdOrName as any).mockReturnValue({ libraryID: 1, collection: { key: 'COLLKEY' } });
});

describe('handleResolveSearchFiltersRequest', () => {
    it('expands matched regular items to their supported attachments (excluding deleted)', async () => {
        itemsById.set(10, regular(10, 'PARENT', [11, 12]));
        itemsById.set(11, attachment(11, 'ATT1'));
        itemsById.set(12, attachment(12, 'ATT2', { deleted: true }));
        (resolveItemsByFilters as any).mockResolvedValue({ itemIDs: [10], matchedTags: ['ml'], matchedAuthors: [] });

        const res = await handleResolveSearchFiltersRequest({
            event: 'resolve_search_filters_request',
            request_id: 'r1',
            collections: ['Research'],
            tags: ['ml'],
        });

        expect(res.type).toBe('resolve_search_filters');
        expect(res.attachments).toEqual([{ library_id: 1, zotero_key: 'ATT1' }]);
        expect(res.unresolved).toBeUndefined();
        expect(res.timing?.item_count).toBe(1);
        expect(res.timing?.attachment_count).toBe(1);
    });

    it('reports tags that match no library in unresolved', async () => {
        itemsById.set(10, regular(10, 'PARENT', [11]));
        itemsById.set(11, attachment(11, 'ATT1'));
        (resolveItemsByFilters as any).mockResolvedValue({ itemIDs: [10], matchedTags: ['ml'], matchedAuthors: [] });

        const res = await handleResolveSearchFiltersRequest({
            event: 'resolve_search_filters_request',
            request_id: 'r2',
            tags: ['ml', 'ghost'],
        });

        expect(res.attachments).toEqual([{ library_id: 1, zotero_key: 'ATT1' }]);
        expect(res.unresolved?.tags).toEqual(['ghost']);
    });

    it('includes a matched standalone attachment directly', async () => {
        itemsById.set(20, attachment(20, 'STANDALONE'));
        (resolveItemsByFilters as any).mockResolvedValue({ itemIDs: [20], matchedTags: ['scan'], matchedAuthors: [] });

        const res = await handleResolveSearchFiltersRequest({
            event: 'resolve_search_filters_request',
            request_id: 'r3',
            tags: ['scan'],
        });

        expect(res.attachments).toEqual([{ library_id: 1, zotero_key: 'STANDALONE' }]);
    });

    it('returns empty with unresolved.libraries when the library filter matches nothing', async () => {
        (resolveItemsByFilters as any).mockResolvedValue({ itemIDs: [], matchedTags: [], matchedAuthors: [] });

        const res = await handleResolveSearchFiltersRequest({
            event: 'resolve_search_filters_request',
            request_id: 'r4',
            libraries: ['Nonexistent'],
            tags: ['ml'],
        });

        expect(res.attachments).toEqual([]);
        expect(res.unresolved?.libraries).toEqual(['Nonexistent']);
        // No searchable libraries: no resolver call.
        expect(resolveItemsByFilters as any).not.toHaveBeenCalled();
    });

    it('skips a library where requested collections resolve to no keys', async () => {
        searchableLibs = [1];
        (getCollectionByIdOrName as any).mockReturnValue(null);
        (resolveItemsByFilters as any).mockResolvedValue({ itemIDs: [10], matchedTags: [], matchedAuthors: [] });

        const res = await handleResolveSearchFiltersRequest({
            event: 'resolve_search_filters_request',
            request_id: 'r5',
            collections: ['Missing'],
        });

        expect(res.attachments).toEqual([]);
        expect(resolveItemsByFilters as any).not.toHaveBeenCalled();
        expect(res.unresolved?.collections).toEqual(['Missing']);
    });

    it('dedupes attachments shared across matched items', async () => {
        itemsById.set(10, regular(10, 'PARENT', [11, 11]));
        itemsById.set(11, attachment(11, 'ATT1'));
        (resolveItemsByFilters as any).mockResolvedValue({ itemIDs: [10], matchedTags: [], matchedAuthors: ['Smith'] });

        const res = await handleResolveSearchFiltersRequest({
            event: 'resolve_search_filters_request',
            request_id: 'r6',
            authors: ['Smith'],
        });

        expect(res.attachments).toEqual([{ library_id: 1, zotero_key: 'ATT1' }]);
    });
});
