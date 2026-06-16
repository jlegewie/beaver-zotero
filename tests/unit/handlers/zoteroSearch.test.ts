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
    getAttachmentInfoForItem: vi.fn(),
}));

// Keep the real serializeNote; stub serializeItemStub so parent serialization
// doesn't hit getCreators/getYear on mock items.
vi.mock('../../../src/utils/zoteroSerializers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/utils/zoteroSerializers')>();
    return {
        ...actual,
        serializeItemStub: vi.fn((item: any) => ({
            library_id: item.libraryID,
            zotero_key: item.key,
            item_type: item.itemType,
            title: item.getField?.('title', false, true) || item.getDisplayTitle?.() || null,
            creators: null,
            year: null,
        })),
    };
});

import { handleZoteroSearchRequest } from '../../../src/services/agentDataProvider/handleZoteroSearchRequest';
import { getAttachmentInfoForItem, validateLibraryAccess } from '../../../src/services/agentDataProvider/utils';

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
        vi.mocked(getAttachmentInfoForItem).mockImplementation(async (item: any, options: any = {}) => ({
            attachment_id: `${item.libraryID}-${item.key}`,
            parent_item_id: options.parentItemId ?? null,
            title: item.getDisplayTitle?.() || item.key,
            filename: item.attachmentFilename ?? null,
            content_kind: 'pdf',
            status: 'readable',
            page_count: 9,
            line_count: null,
            is_primary: Boolean(options.isPrimary),
            annotations_count: item.isFileAttachment?.() ? item.getAnnotations?.().length ?? 0 : 0,
        } as any));

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

    it('returns attachment rows with attachment_id and resolver metadata', async () => {
        const parent = makeItem({
            id: 10,
            key: 'PARENT',
            getField: vi.fn((field: string) => field === 'title' ? 'Parent Article' : ''),
            getDisplayTitle: vi.fn(() => 'Parent Article'),
        });
        const attachment = makeItem({
            id: 1,
            key: 'ATTACH',
            itemType: 'attachment',
            parentItemID: parent.id,
            isAttachment: vi.fn(() => true),
            isRegularItem: vi.fn(() => false),
            getDisplayTitle: vi.fn(() => 'Attachment PDF'),
            attachmentFilename: 'paper.pdf',
            attachmentContentType: 'application/pdf',
            isFileAttachment: vi.fn(() => true),
            getAnnotations: vi.fn(() => [{ id: 2 }, { id: 3 }]),
        } as Partial<MockItem>);
        itemsById.set(parent.id, parent);
        itemsById.set(attachment.id, attachment);

        const response = await handleZoteroSearchRequest({
            event: 'zotero_search_request',
            request_id: 'req-3',
            conditions: [],
            join_mode: 'all',
            item_category: 'attachment',
            include_children: true,
            recursive: false,
            limit: 1,
            offset: 0,
        });

        expect(response.error).toBeUndefined();
        expect(response.items).toEqual([
            expect.objectContaining({
                result_type: 'attachment',
                attachment_id: '1-ATTACH',
                parent_item_id: '1-PARENT',
                parent_title: 'Parent Article',
                annotations_count: 2,
            }),
        ]);
        expect(response.items[0]).not.toHaveProperty('item_id');
        expect(getAttachmentInfoForItem).toHaveBeenCalledWith(
            attachment,
            expect.objectContaining({
                parentItemId: '1-PARENT',
                includeAnnotationsCount: true,
                skipWorkerFallback: true,
            }),
        );
    });
});
