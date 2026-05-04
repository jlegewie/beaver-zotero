import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-user' })),
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1]) },
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getCollectionByIdOrName: vi.fn(),
    validateLibraryAccess: vi.fn(),
    isLibrarySearchable: vi.fn(() => true),
    getSearchableLibraries: vi.fn(() => []),
    extractYear: vi.fn(() => null),
    formatCreatorsString: vi.fn(() => ''),
}));

import { handleListItemsRequest } from '../../../src/services/agentDataProvider/handleListItemsRequest';
import { getCollectionByIdOrName, validateLibraryAccess } from '../../../src/services/agentDataProvider/utils';

type MockItem = Partial<Zotero.Item> & {
    id: number;
    key: string;
    libraryID: number;
    itemType: string;
    isNote: ReturnType<typeof vi.fn>;
    isAttachment: ReturnType<typeof vi.fn>;
    isRegularItem: ReturnType<typeof vi.fn>;
};

function makeItem(overrides: Partial<MockItem> = {}): MockItem {
    const itemType = overrides.itemType ?? 'journalArticle';
    const isNote = itemType === 'note';
    const isAttachment = itemType === 'attachment';
    return {
        id: 1,
        key: 'ITEM1',
        libraryID: 1,
        itemType,
        parentItemID: null,
        dateAdded: '2024-01-01',
        dateModified: '2024-01-02',
        getField: vi.fn(() => ''),
        getCreators: vi.fn(() => []),
        getDisplayTitle: vi.fn(() => ''),
        getNotes: vi.fn(() => []),
        getAttachments: vi.fn(() => []),
        getTags: vi.fn(() => []),
        numAttachments: vi.fn(() => 0),
        isNote: vi.fn(() => isNote),
        isAttachment: vi.fn(() => isAttachment),
        isRegularItem: vi.fn(() => !isNote && !isAttachment && itemType !== 'annotation'),
        ...overrides,
    };
}

describe('handleListItemsRequest', () => {
    const searchResults: number[][] = [];
    const itemsById = new Map<number, MockItem>();

    beforeEach(() => {
        vi.clearAllMocks();
        searchResults.length = 0;
        itemsById.clear();

        (validateLibraryAccess as any).mockReturnValue({
            valid: true,
            library: { libraryID: 1, name: 'My Library' },
        });
        (getCollectionByIdOrName as any).mockReturnValue({
            libraryID: 1,
            collection: { id: 10, name: 'Collection' },
        });

        class MockSearch {
            libraryID = 1;
            addCondition = vi.fn();
            search = vi.fn(async () => searchResults.shift() ?? []);
        }

        (globalThis as any).Zotero.Search = MockSearch;
        (globalThis as any).Zotero.Libraries.get = vi.fn(() => ({ libraryID: 1, name: 'My Library' }));
        (globalThis as any).Zotero.Items = {
            getAsync: vi.fn(async (ids: number | number[]) => {
                if (Array.isArray(ids)) {
                    return ids.map(id => itemsById.get(id) ?? null);
                }
                return itemsById.get(ids) ?? null;
            }),
            loadDataTypes: vi.fn(async () => undefined),
        };
    });

    it('returns an empty result for annotation-only listings instead of malformed regular items', async () => {
        const annotation = makeItem({
            id: 1,
            key: 'ANN1',
            itemType: 'annotation',
            isAnnotation: vi.fn(() => true),
        } as Partial<MockItem>);
        itemsById.set(annotation.id, annotation);
        searchResults.push([annotation.id]);

        const response = await handleListItemsRequest({
            event: 'list_items_request',
            request_id: 'req-1',
            item_category: 'annotation',
            recursive: true,
            sort_by: 'dateModified',
            sort_order: 'desc',
            limit: 20,
            offset: 0,
        });

        expect(response.error).toBeUndefined();
        expect(response.total_count).toBe(0);
        expect(response.items).toEqual([]);
    });

    it('does not add child annotations to collection all listings', async () => {
        const parent = makeItem({
            id: 1,
            key: 'PARENT',
            itemType: 'journalArticle',
            getField: vi.fn((field: string) => field === 'title' ? 'Parent' : ''),
            getNotes: vi.fn(() => [2]),
            getAttachments: vi.fn(() => [3]),
        });
        const note = makeItem({
            id: 2,
            key: 'NOTE',
            itemType: 'note',
            parentItemID: parent.id,
            isNote: vi.fn(() => true),
            isRegularItem: vi.fn(() => false),
            getDisplayTitle: vi.fn(() => 'Note'),
        });
        const attachment = makeItem({
            id: 3,
            key: 'ATTACH',
            itemType: 'attachment',
            parentItemID: parent.id,
            isAttachment: vi.fn(() => true),
            isRegularItem: vi.fn(() => false),
            getDisplayTitle: vi.fn(() => 'Attachment'),
            attachmentFilename: 'paper.pdf',
            attachmentContentType: 'application/pdf',
            getAnnotations: vi.fn(() => [{ id: 4 }]),
        } as Partial<MockItem>);
        const annotation = makeItem({
            id: 4,
            key: 'ANN1',
            itemType: 'annotation',
            isAnnotation: vi.fn(() => true),
        } as Partial<MockItem>);

        for (const item of [parent, note, attachment, annotation]) {
            itemsById.set(item.id, item);
        }
        searchResults.push([parent.id], [parent.id]);

        const response = await handleListItemsRequest({
            event: 'list_items_request',
            request_id: 'req-2',
            library_id: 1,
            collection_key: 'COLLECTION',
            item_category: 'all',
            recursive: true,
            sort_by: 'dateModified',
            sort_order: 'desc',
            limit: 20,
            offset: 0,
        });

        expect(response.total_count).toBe(3);
        expect(response.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ item_id: '1-PARENT', result_type: 'regular' }),
            expect.objectContaining({ item_id: '1-NOTE', result_type: 'note' }),
            expect.objectContaining({ item_id: '1-ATTACH', result_type: 'attachment' }),
        ]));
        expect(response.items).not.toContainEqual(expect.objectContaining({ item_id: '1-ANN1' }));
        expect(attachment.getAnnotations).not.toHaveBeenCalled();
    });
});
