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
    validateLibraryAccess: vi.fn(),
    extractYear: vi.fn(() => null),
    formatCreatorsString: vi.fn(() => ''),
}));

import { handleZoteroSearchRequest } from '../../../src/services/agentDataProvider/handleZoteroSearchRequest';
import { validateLibraryAccess } from '../../../src/services/agentDataProvider/utils';

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
        dateAdded: '2024-01-01',
        dateModified: '2024-01-02',
        getField: vi.fn((field: string) => field === 'title' ? 'Title' : ''),
        getCreators: vi.fn(() => []),
        getDisplayTitle: vi.fn(() => 'Title'),
        numAttachments: vi.fn(() => 0),
        isNote: vi.fn(() => isNote),
        isAttachment: vi.fn(() => isAttachment),
        isRegularItem: vi.fn(() => !isNote && !isAttachment && itemType !== 'annotation'),
        ...overrides,
    };
}

describe('handleZoteroSearchRequest', () => {
    const itemsById = new Map<number, MockItem>();

    beforeEach(() => {
        vi.clearAllMocks();
        itemsById.clear();

        vi.mocked(validateLibraryAccess).mockReturnValue({
            valid: true,
            library: { libraryID: 1, name: 'My Library' },
        } as any);

        class MockSearch {
            libraryID = 1;
            addCondition = vi.fn();
            search = vi.fn(async () => [1, 2, 3, 4]);
        }

        (globalThis as any).Zotero.Search = MockSearch;
        (globalThis as any).Zotero.Items = {
            getAsync: vi.fn(async (ids: number | number[]) => {
                if (!Array.isArray(ids)) {
                    return itemsById.get(ids) ?? null;
                }
                return [...ids]
                    .reverse()
                    .map(id => itemsById.get(id) ?? null);
            }),
            loadDataTypes: vi.fn(async () => undefined),
        };
        (globalThis as any).Zotero.ItemTypes = {
            getID: vi.fn((itemType: string) => itemType === 'annotation' ? 1 : 0),
        };
        (globalThis as any).Zotero.DB = {
            queryAsync: vi.fn(async (_sql: string, params: any[], options: { onRow: (row: any) => void }) => {
                const annotationItemTypeID = params[params.length - 1];
                for (const id of params.slice(0, -1)) {
                    const item = itemsById.get(id);
                    if (item && item.itemType !== 'annotation' && annotationItemTypeID === 1) {
                        options.onRow({ getResultByIndex: () => id });
                    }
                }
            }),
        };
    });

    it('preserves native search order when filtering annotations before pagination', async () => {
        itemsById.set(1, makeItem({
            id: 1,
            key: 'FIRST',
            getField: vi.fn((field: string) => field === 'title' ? 'First' : ''),
            getDisplayTitle: vi.fn(() => 'First'),
        }));
        itemsById.set(2, makeItem({
            id: 2,
            key: 'ANNOT',
            itemType: 'annotation',
            isAnnotation: vi.fn(() => true),
        } as Partial<MockItem>));
        itemsById.set(3, makeItem({
            id: 3,
            key: 'THIRD',
            getField: vi.fn((field: string) => field === 'title' ? 'Third' : ''),
            getDisplayTitle: vi.fn(() => 'Third'),
        }));
        itemsById.set(4, makeItem({
            id: 4,
            key: 'FOURTH',
            getField: vi.fn((field: string) => field === 'title' ? 'Fourth' : ''),
            getDisplayTitle: vi.fn(() => 'Fourth'),
        }));

        const response = await handleZoteroSearchRequest({
            event: 'zotero_search_request',
            request_id: 'req-1',
            conditions: [],
            join_mode: 'all',
            item_category: 'all',
            include_children: true,
            recursive: false,
            limit: 2,
            offset: 0,
        });

        expect(response.error).toBeUndefined();
        expect(response.total_count).toBe(3);
        expect(response.items.map(item => item.item_id)).toEqual(['1-FIRST', '1-THIRD']);
    });

    it('filters annotations before pagination for any-mode regular searches', async () => {
        itemsById.set(1, makeItem({
            id: 1,
            key: 'FIRST',
            getField: vi.fn((field: string) => field === 'title' ? 'First' : ''),
            getDisplayTitle: vi.fn(() => 'First'),
        }));
        itemsById.set(2, makeItem({
            id: 2,
            key: 'ANNOT',
            itemType: 'annotation',
            isAnnotation: vi.fn(() => true),
        } as Partial<MockItem>));
        itemsById.set(3, makeItem({
            id: 3,
            key: 'THIRD',
            getField: vi.fn((field: string) => field === 'title' ? 'Third' : ''),
            getDisplayTitle: vi.fn(() => 'Third'),
        }));

        const response = await handleZoteroSearchRequest({
            event: 'zotero_search_request',
            request_id: 'req-2',
            conditions: [{ field: 'title', operator: 'contains', value: 'search term' }],
            join_mode: 'any',
            item_category: 'regular',
            include_children: true,
            recursive: false,
            limit: 2,
            offset: 0,
        });

        expect(response.error).toBeUndefined();
        expect(response.total_count).toBe(2);
        expect(response.items.map(item => item.item_id)).toEqual(['1-FIRST', '1-THIRD']);
        expect((globalThis as any).Zotero.DB.queryAsync).toHaveBeenCalledOnce();
        expect((globalThis as any).Zotero.Items.getAsync).not.toHaveBeenCalledWith([1, 2, 3]);
    });
});
