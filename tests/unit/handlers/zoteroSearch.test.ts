import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
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
    // These cases never request extra fields; the projection helpers are
    // stubbed pass-through so the module mock stays complete.
    isReadableItemField: vi.fn(() => true),
    readItemField: vi.fn((item: any, field: string) => item.getField?.(field, false, true)),
}));

// Keep the real serializeNote; stub serializeItemStub so parent serialization
// doesn't hit getCreators/getYear on mock items.
vi.mock('../../../src/utils/zoteroSerializers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/utils/zoteroSerializers')>();
    return {
        ...actual,
        serializeItemStub: vi.fn((item: any) => ({
            item_id: `${item.libraryID}-${item.key}`,
            item_type: item.itemType,
            title: item.getField?.('title', false, true) || item.getDisplayTitle?.() || null,
            creators: null,
            year: null,
        })),
    };
});

import type { WSZoteroSearchResponse } from '@beaver/agent-core/protocol/agentProtocol';
import { handleZoteroSearchRequest } from '../../../src/services/agentDataProvider/handleZoteroSearchRequest';
import { getAttachmentInfoForItem, isReadableItemField, validateLibraryAccess } from '../../../src/services/agentDataProvider/utils';

type MockItem = {
    id: number;
    key: string;
    libraryID: number;
    itemType: string;
    isNote: ReturnType<typeof vi.fn>;
    isAttachment: ReturnType<typeof vi.fn>;
    isRegularItem: ReturnType<typeof vi.fn>;
} & Record<string, any>;

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

type MockSearchInstance = {
    addCondition: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    setScope: ReturnType<typeof vi.fn>;
};

/** Stable fake itemTypeIDs so the DB mock can map params back to item types. */
const ITEM_TYPE_IDS: Record<string, number> = {
    journalArticle: 2,
    book: 3,
    note: 10,
    attachment: 11,
    annotation: 12,
};

describe('handleZoteroSearchRequest', () => {
    const itemsById = new Map<number, MockItem>();
    let searchResultIds: number[] = [1, 2, 3, 4];
    /** Every Zotero search the handler constructed, in construction order. */
    let searches: MockSearchInstance[] = [];

    /** The handler's primary search — always the first one it constructs. */
    const mainSearch = () => searches[0] ?? null;

    /** The collection-scope search, when the handler built one. */
    const scopeSearch = () => searches[1] ?? null;

    /** Conditions added to the Zotero search, as [field, operator, value] tuples. */
    const addedConditions = () =>
        (mainSearch()?.addCondition.mock.calls ?? []).map(call => call.slice(0, 3));

    /** Conditions added to the collection-scope search, same shape. */
    const scopeConditions = () =>
        (scopeSearch()?.addCondition.mock.calls ?? []).map(call => call.slice(0, 3));

    // Result rows are a discriminated union: attachments carry attachment_id,
    // every other shape carries item_id. Narrow on result_type rather than
    // casting, so a shape change surfaces here instead of silently reading
    // undefined.
    const itemIds = (response: WSZoteroSearchResponse) =>
        response.items.map(item => (item.result_type === 'attachment' ? undefined : item.item_id));
    const attachmentIds = (response: WSZoteroSearchResponse) =>
        response.items.map(item => (item.result_type === 'attachment' ? item.attachment_id : undefined));

    beforeEach(() => {
        vi.clearAllMocks();
        itemsById.clear();
        searchResultIds = [1, 2, 3, 4];

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

        searches = [];
        // Records every instance so tests can assert which conditions the handler
        // handed to Zotero (the crux of the join-mode fix) and which of them it
        // routed into a collection scope instead.
        (globalThis as any).Zotero.Search = class MockSearch {
            libraryID = 1;
            addCondition = vi.fn();
            search = vi.fn(async () => searchResultIds);
            setScope = vi.fn();
            constructor() {
                searches.push(this as unknown as MockSearchInstance);
            }
        };
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
            getID: vi.fn((itemType: string) => ITEM_TYPE_IDS[itemType]),
        };
        // Stands in for `SELECT itemID FROM items WHERE itemID IN (...) AND
        // itemTypeID [NOT] IN (...)`: the leading params are itemIDs, the
        // trailing ones itemTypeIDs, split by the placeholder counts in the SQL.
        (globalThis as any).Zotero.DB = {
            queryAsync: vi.fn(async (sql: string, params: any[], options: { onRow: (row: any) => void }) => {
                const idCount = (sql.match(/itemID IN \(([^)]*)\)/)![1].match(/\?/g) ?? []).length;
                const ids: number[] = params.slice(0, idCount);
                const typeIDs: number[] = params.slice(idCount);
                const exclude = /itemTypeID NOT IN/.test(sql);
                for (const id of ids) {
                    const item = itemsById.get(id);
                    if (!item) continue;
                    const inSet = typeIDs.includes(ITEM_TYPE_IDS[item.itemType]);
                    if (exclude ? !inSet : inSet) {
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
        expect(itemIds(response)).toEqual(['1-FIRST', '1-THIRD']);
    });

    it('filters annotations before pagination for any-mode regular searches', async () => {
        searchResultIds = [1, 2, 3];
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
        expect(itemIds(response)).toEqual(['1-FIRST', '1-THIRD']);
        expect((globalThis as any).Zotero.DB.queryAsync).toHaveBeenCalledOnce();
        expect((globalThis as any).Zotero.Items.getAsync).not.toHaveBeenCalledWith([1, 2, 3]);
    });

    // Regression guard: Zotero ORs non-special conditions together under
    // joinMode 'any', so itemType conditions there match the entire library.
    describe('item_category under join_mode="any"', () => {
        function seedMixedLibrary() {
            searchResultIds = [1, 2, 3, 4];
            itemsById.set(1, makeItem({
                id: 1,
                key: 'ARTICLE',
                getField: vi.fn((field: string) => field === 'title' ? 'Article' : ''),
                getDisplayTitle: vi.fn(() => 'Article'),
            }));
            itemsById.set(2, makeItem({
                id: 2,
                key: 'NOTE',
                itemType: 'note',
                getNote: vi.fn(() => '<p>Note body</p>'),
                getNoteTitle: vi.fn(() => 'Note'),
                getDisplayTitle: vi.fn(() => 'Note'),
            } as Partial<MockItem>));
            itemsById.set(3, makeItem({
                id: 3,
                key: 'ANNOT',
                itemType: 'annotation',
                isAnnotation: vi.fn(() => true),
            } as Partial<MockItem>));
            itemsById.set(4, makeItem({
                id: 4,
                key: 'BOOK',
                itemType: 'book',
                getField: vi.fn((field: string) => field === 'title' ? 'Book' : ''),
                getDisplayTitle: vi.fn(() => 'Book'),
            }));
        }

        const baseRequest = {
            event: 'zotero_search_request',
            request_id: 'req-any',
            conditions: [{ field: 'title', operator: 'contains', value: 'search term' }],
            join_mode: 'any',
            include_children: true,
            recursive: false,
            limit: 50,
            offset: 0,
        } as const;

        it('does not add itemType conditions to the search', async () => {
            seedMixedLibrary();

            await handleZoteroSearchRequest({ ...baseRequest, item_category: 'regular' } as any);

            expect(addedConditions()).not.toContainEqual(
                expect.arrayContaining(['itemType']),
            );
        });

        it('post-filters to regular items, so total_count excludes notes and annotations', async () => {
            seedMixedLibrary();

            const response = await handleZoteroSearchRequest({
                ...baseRequest,
                item_category: 'regular',
            } as any);

            expect(response.error).toBeUndefined();
            expect(response.total_count).toBe(2);
            expect(itemIds(response)).toEqual(['1-ARTICLE', '1-BOOK']);
        });

        it('post-filters to notes for item_category="note"', async () => {
            seedMixedLibrary();

            const response = await handleZoteroSearchRequest({
                ...baseRequest,
                item_category: 'note',
            } as any);

            expect(response.error).toBeUndefined();
            expect(response.total_count).toBe(1);
            expect(itemIds(response)).toEqual(['1-NOTE']);
        });

        it('post-filters to attachments for item_category="attachment"', async () => {
            seedMixedLibrary();
            itemsById.set(4, makeItem({
                id: 4,
                key: 'ATTACH',
                itemType: 'attachment',
                isFileAttachment: vi.fn(() => true),
                getAnnotations: vi.fn(() => []),
                getDisplayTitle: vi.fn(() => 'Attachment'),
            } as Partial<MockItem>));

            const response = await handleZoteroSearchRequest({
                ...baseRequest,
                item_category: 'attachment',
            } as any);

            expect(response.error).toBeUndefined();
            expect(response.total_count).toBe(1);
            expect(attachmentIds(response)).toEqual(['1-ATTACH']);
        });

        it('leaves item_category="all" unfiltered apart from annotations', async () => {
            seedMixedLibrary();

            const response = await handleZoteroSearchRequest({
                ...baseRequest,
                item_category: 'all',
            } as any);

            expect(response.error).toBeUndefined();
            expect(response.total_count).toBe(3);
            expect(itemIds(response)).toEqual(['1-ARTICLE', '1-NOTE', '1-BOOK']);
            expect(addedConditions()).not.toContainEqual(expect.arrayContaining(['itemType']));
        });

        it('applies the post-filter before pagination', async () => {
            seedMixedLibrary();

            const response = await handleZoteroSearchRequest({
                ...baseRequest,
                item_category: 'regular',
                limit: 1,
                offset: 0,
            } as any);

            // Without pre-pagination filtering the page would be the note/annotation.
            expect(response.total_count).toBe(2);
            expect(itemIds(response)).toEqual(['1-ARTICLE']);
        });

        it('skips the category filter when the request supplies its own itemType condition', async () => {
            seedMixedLibrary();

            const response = await handleZoteroSearchRequest({
                ...baseRequest,
                conditions: [{ field: 'itemType', operator: 'is', value: 'book' }],
                item_category: 'regular',
            } as any);

            // The caller's itemType condition wins; annotations are still dropped
            // because zotero_search has no annotation result shape.
            expect(addedConditions()).toContainEqual(['itemType', 'is', 'book']);
            expect(response.total_count).toBe(3);
            expect(itemIds(response)).toEqual(['1-ARTICLE', '1-NOTE', '1-BOOK']);
        });
    });

    it('keeps the condition-based category filter for join_mode="all"', async () => {
        searchResultIds = [1];
        itemsById.set(1, makeItem({ id: 1, key: 'ARTICLE' }));

        await handleZoteroSearchRequest({
            event: 'zotero_search_request',
            request_id: 'req-all',
            conditions: [{ field: 'title', operator: 'contains', value: 'search term' }],
            join_mode: 'all',
            item_category: 'regular',
            include_children: true,
            recursive: false,
            limit: 50,
            offset: 0,
        });

        expect(addedConditions()).toEqual(
            expect.arrayContaining([
                ['itemType', 'isNot', 'attachment'],
                ['itemType', 'isNot', 'note'],
                ['itemType', 'isNot', 'annotation'],
            ]),
        );
        // Zotero's SQL already applied the filter — no post-filter query needed.
        expect((globalThis as any).Zotero.DB.queryAsync).not.toHaveBeenCalled();
    });

    describe('item_category="annotation"', () => {
        it.each(['any', 'all'] as const)(
            'returns an explanatory warning without searching (join_mode="%s")',
            async (join_mode) => {
                itemsById.set(1, makeItem({ id: 1, key: 'ARTICLE' }));

                const response = await handleZoteroSearchRequest({
                    event: 'zotero_search_request',
                    request_id: `req-annot-${join_mode}`,
                    conditions: [{ field: 'title', operator: 'contains', value: 'search term' }],
                    join_mode,
                    item_category: 'annotation',
                    include_children: true,
                    recursive: false,
                    limit: 50,
                    offset: 0,
                } as any);

                expect(response.error).toBeUndefined();
                expect(response.total_count).toBe(0);
                expect(response.items).toEqual([]);
                // Point the agent at the tool that can actually answer this.
                expect(response.warnings?.join(' ')).toContain('find_annotations');
                // The result is knowable up front — no search, no itemType scans.
                expect(mainSearch()).toBeNull();
                expect((globalThis as any).Zotero.DB.queryAsync).not.toHaveBeenCalled();
            },
        );

        it('defers to an explicit itemType condition instead of short-circuiting', async () => {
            searchResultIds = [1];
            itemsById.set(1, makeItem({ id: 1, key: 'BOOK', itemType: 'book' }));

            const response = await handleZoteroSearchRequest({
                event: 'zotero_search_request',
                request_id: 'req-annot-override',
                conditions: [{ field: 'itemType', operator: 'is', value: 'book' }],
                join_mode: 'any',
                item_category: 'annotation',
                include_children: true,
                recursive: false,
                limit: 50,
                offset: 0,
            } as any);

            expect(response.warnings).toBeUndefined();
            expect(addedConditions()).toContainEqual(['itemType', 'is', 'book']);
            expect(itemIds(response)).toEqual(['1-BOOK']);
        });
    });

    // item_category arrives over the wire, so the category lookup must not
    // resolve inherited object keys ("constructor", "toString") to a bogus
    // filter. Unrecognized values degrade to "no category filter".
    describe.each(['constructor', 'toString', 'hasOwnProperty', 'unknown-category'])(
        'item_category="%s"',
        (item_category) => {
            it.each(['any', 'all'] as const)('degrades to no filter under join_mode="%s"', async (join_mode) => {
                searchResultIds = [1, 2];
                itemsById.set(1, makeItem({ id: 1, key: 'ARTICLE' }));
                itemsById.set(2, makeItem({
                    id: 2,
                    key: 'ANNOT',
                    itemType: 'annotation',
                    isAnnotation: vi.fn(() => true),
                }));

                const response = await handleZoteroSearchRequest({
                    event: 'zotero_search_request',
                    request_id: `req-${item_category}-${join_mode}`,
                    conditions: [{ field: 'title', operator: 'contains', value: 'search term' }],
                    join_mode,
                    item_category,
                    include_children: true,
                    recursive: false,
                    limit: 50,
                    offset: 0,
                } as any);

                expect(response.error).toBeUndefined();
                expect(addedConditions()).not.toContainEqual(expect.arrayContaining(['itemType']));
                // Annotations are still dropped — there is no result shape for them.
                expect(response.total_count).toBe(1);
                expect(itemIds(response)).toEqual(['1-ARTICLE']);
            });
        },
    );

    // Only top-level items belong to a Zotero collection, so a `collection`
    // condition cannot match the child notes and attachments the items tree shows
    // inside that collection. When child items are wanted, the condition becomes a
    // scope applied with includeChildren instead.
    describe('collection scope', () => {
        const collectionCondition = { field: 'collection', operator: 'is', value: 'ABCD2345' };

        function searchRequest(overrides: Record<string, any> = {}) {
            return {
                event: 'zotero_search_request',
                request_id: 'req-collection',
                conditions: [collectionCondition],
                join_mode: 'all',
                item_category: 'note',
                include_children: true,
                recursive: true,
                limit: 50,
                offset: 0,
                ...overrides,
            } as any;
        }

        it('moves the collection condition into an includeChildren scope', async () => {
            searchResultIds = [];

            const response = await handleZoteroSearchRequest(searchRequest());

            expect(response.error).toBeUndefined();
            // The condition must leave the main search: kept there it would
            // restrict results to direct members and hide every child note.
            expect(addedConditions()).not.toContainEqual(
                expect.arrayContaining(['collection'])
            );
            expect(addedConditions()).toContainEqual(['itemType', 'is', 'note']);
            expect(scopeConditions()).toContainEqual(['collection', 'is', 'ABCD2345']);
            expect(scopeConditions()).toContainEqual(['recursive', 'true', '']);
            expect(mainSearch()!.setScope).toHaveBeenCalledWith(scopeSearch(), true);
        });

        it('leaves subcollections out of the scope when recursive is false', async () => {
            searchResultIds = [];

            await handleZoteroSearchRequest(searchRequest({ recursive: false }));

            expect(scopeConditions()).toContainEqual(['collection', 'is', 'ABCD2345']);
            expect(scopeConditions()).not.toContainEqual(
                expect.arrayContaining(['recursive'])
            );
        });

        it('scopes an all-category listing so child items come back too', async () => {
            searchResultIds = [];

            await handleZoteroSearchRequest(searchRequest({ item_category: 'all' }));

            expect(addedConditions()).not.toContainEqual(
                expect.arrayContaining(['collection'])
            );
            expect(mainSearch()!.setScope).toHaveBeenCalledWith(scopeSearch(), true);
        });

        // A scope is an intersection; under 'any' the collection condition is one
        // disjunct of an OR, so scoping it would silently narrow the search.
        it('keeps the collection as a plain condition under join_mode="any"', async () => {
            searchResultIds = [];

            await handleZoteroSearchRequest(searchRequest({ join_mode: 'any' }));

            expect(addedConditions()).toContainEqual(['collection', 'is', 'ABCD2345']);
            expect(searches).toHaveLength(1);
            expect(mainSearch()!.setScope).not.toHaveBeenCalled();
        });

        it('keeps the collection as a plain condition when child items are excluded', async () => {
            searchResultIds = [];

            await handleZoteroSearchRequest(searchRequest({
                item_category: 'regular',
                include_children: false,
            }));

            expect(addedConditions()).toContainEqual(['collection', 'is', 'ABCD2345']);
            expect(searches).toHaveLength(1);
            expect(mainSearch()!.setScope).not.toHaveBeenCalled();
        });

        // 'isNot' excludes a collection; that is a filter on the item itself, and
        // expanding it into a scope would invert its meaning.
        it('does not scope a negated collection condition', async () => {
            searchResultIds = [];

            await handleZoteroSearchRequest(searchRequest({
                conditions: [{ field: 'collection', operator: 'isNot', value: 'ABCD2345' }],
            }));

            expect(addedConditions()).toContainEqual(['collection', 'isNot', 'ABCD2345']);
            expect(searches).toHaveLength(1);
            expect(mainSearch()!.setScope).not.toHaveBeenCalled();
        });

        // An empty scope search matches the whole library, so a collection
        // condition Zotero rejects must not leave one attached.
        it('does not attach a scope when the collection condition is rejected', async () => {
            searchResultIds = [];
            const originalSearch = (globalThis as any).Zotero.Search;
            (globalThis as any).Zotero.Search = class RejectingSearch extends originalSearch {
                constructor() {
                    super();
                    this.addCondition = vi.fn((field: string) => {
                        if (field === 'collection') throw new Error('Invalid search condition');
                    });
                }
            };

            const response = await handleZoteroSearchRequest(searchRequest());

            expect(response.warnings?.join(' ')).toContain('collection');
            expect(mainSearch()!.setScope).not.toHaveBeenCalled();
        });
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

    describe('requested extra fields', () => {
        const searchWithFields = (fields: string[]) => handleZoteroSearchRequest({
            event: 'zotero_search_request',
            request_id: 'req-fields',
            conditions: [],
            join_mode: 'all',
            item_category: 'all',
            include_children: true,
            recursive: false,
            limit: 10,
            offset: 0,
            fields,
        });

        // Readability does not depend on the item, so classification must not be
        // folded into the result loop: a search with no rows would skip it.
        it('classifies requested fields even when the search returns nothing', async () => {
            searchResultIds = [];

            const response = await searchWithFields(['bogusField']);

            expect(response.error).toBeUndefined();
            expect(response.total_count).toBe(0);
            expect(isReadableItemField).toHaveBeenCalledWith('bogusField');
        });

        it('classifies each requested field once, not once per item', async () => {
            itemsById.set(1, makeItem({ id: 1, key: 'FIRST' }));
            itemsById.set(2, makeItem({ id: 2, key: 'SECOND' }));
            itemsById.set(3, makeItem({ id: 3, key: 'THIRD' }));
            itemsById.set(4, makeItem({ id: 4, key: 'FOURTH' }));

            await searchWithFields(['title']);

            const titleChecks = vi.mocked(isReadableItemField).mock.calls
                .filter(([field]) => field === 'title');
            expect(titleChecks).toHaveLength(1);
        });
    });
    // A negated prose phrase that matches nothing narrows nothing, so the
    // results are the whole library rather than a filtered set. The read path
    // returns them and says so; `handleResolvePopulationRequest` refuses the
    // same condition outright.
    describe('negations that exclude nothing', () => {
        /** Makes the positive-form probe — and only the probe — find nothing. */
        function probeFindsNothing() {
            const RealSearch = (globalThis as any).Zotero.Search;
            (globalThis as any).Zotero.Search = class ProbingSearch extends RealSearch {
                private positiveProse = false;
                constructor() {
                    super();
                    this.addCondition = vi.fn((field: string, operator: string) => {
                        if (field === 'abstractNote' && operator === 'contains') {
                            this.positiveProse = true;
                        }
                        return 1;
                    });
                    this.search = vi.fn(async () => (this.positiveProse ? [] : searchResultIds));
                }
            };
        }

        function requestWith(conditions: any[]) {
            return {
                event: 'zotero_search_request' as const,
                request_id: 'req-vacuous',
                conditions,
                join_mode: 'all' as const,
                item_category: 'regular' as const,
                include_children: false,
                recursive: false,
                limit: 10,
                offset: 0,
            };
        }

        it('returns the results with a warning naming the condition and the correction', async () => {
            searchResultIds = [1];
            itemsById.set(1, makeItem({
                id: 1,
                key: 'FIRST',
                getField: vi.fn((field: string) => field === 'title' ? 'First' : ''),
                getDisplayTitle: vi.fn(() => 'First'),
            }));
            probeFindsNothing();

            const response = await handleZoteroSearchRequest(requestWith([
                { field: 'abstractNote', operator: 'doesNotContain', value: 'flow and team cohesion' },
            ]));

            // A read changes nothing, so it answers rather than refusing.
            expect(response.error).toBeUndefined();
            expect(itemIds(response)).toEqual(['1-FIRST']);
            expect(response.warnings).toHaveLength(1);
            expect(response.warnings![0]).toContain("field='abstractNote'");
            expect(response.warnings![0]).toContain('flow and team cohesion');
            expect(response.warnings![0]).toContain('excluded nothing');
            expect(response.warnings![0]).toContain('literal substring');
        });

        it('stays silent when the negated phrase does exclude something', async () => {
            searchResultIds = [1];
            itemsById.set(1, makeItem({
                id: 1,
                key: 'FIRST',
                getField: vi.fn((field: string) => field === 'title' ? 'First' : ''),
                getDisplayTitle: vi.fn(() => 'First'),
            }));

            const response = await handleZoteroSearchRequest(requestWith([
                { field: 'abstractNote', operator: 'doesNotContain', value: 'randomized controlled trial' },
            ]));

            expect(response.error).toBeUndefined();
            expect(response.warnings).toBeUndefined();
        });

        it('leaves a single-word negation alone', async () => {
            searchResultIds = [1];
            itemsById.set(1, makeItem({
                id: 1,
                key: 'FIRST',
                getField: vi.fn((field: string) => field === 'title' ? 'First' : ''),
                getDisplayTitle: vi.fn(() => 'First'),
            }));
            probeFindsNothing();

            const response = await handleZoteroSearchRequest(requestWith([
                { field: 'abstractNote', operator: 'doesNotContain', value: 'cohesion' },
            ]));

            expect(response.error).toBeUndefined();
            expect(response.warnings).toBeUndefined();
        });
    });
});
