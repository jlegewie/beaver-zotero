/**
 * Unit tests for executeOrganizeItemsAction's `unchanged_items` reporting: the
 * per-item record of what the action found already in the requested state and
 * therefore did not write. Consumers count a no-op apart from real work, so
 * "already in the collection" must never be indistinguishable from "filed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1]) },
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: vi.fn(() => null),
    excludedLibraryMessage: vi.fn((id: number) => `Library ${id} excluded`),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

import { executeOrganizeItemsAction } from '../../../src/services/agentDataProvider/actions/organizeItems';
import type { TimeoutContext } from '../../../src/services/agentDataProvider/timeout';
import type { WSAgentActionExecuteRequest } from '@beaver/agent-core/protocol/agentProtocol';

/** A deadline far enough out that no checkpoint in these tests trips it. */
function timeoutCtx(): TimeoutContext {
    return {
        signal: new AbortController().signal,
        timeoutSeconds: 60,
        startTime: Date.now(),
    };
}

const COLLECTION_KEY = 'ABCD2345';
const COLLECTION_ID = 77;

/** A top-level item whose starting tags and collection memberships are given. */
function makeItem(key: string, tags: string[], collectionIds: number[]) {
    const state = { tags: [...tags], collections: [...collectionIds] };
    return {
        key,
        libraryID: 1,
        state,
        isTopLevelItem: () => true,
        getTags: () => state.tags.map((tag) => ({ tag })),
        getCollections: () => [...state.collections],
        addTag: (tag: string) => state.tags.push(tag),
        removeTag: (tag: string) => {
            const at = state.tags.indexOf(tag);
            if (at === -1) return false;
            state.tags.splice(at, 1);
            return true;
        },
        addToCollection: (id: number) => state.collections.push(id),
        removeFromCollection: (id: number) => {
            state.collections = state.collections.filter((c) => c !== id);
        },
        save: vi.fn(async () => undefined),
        setTags: vi.fn(),
        setCollections: vi.fn(),
    };
}

function buildRequest(actionData: Record<string, any>): WSAgentActionExecuteRequest {
    return {
        type: 'agent_action_execute_request',
        request_id: 'req-1',
        action_type: 'organize_items',
        action_data: actionData,
    } as unknown as WSAgentActionExecuteRequest;
}

describe('executeOrganizeItemsAction unchanged_items', () => {
    let previousZotero: any;
    let items: Record<string, ReturnType<typeof makeItem>>;

    beforeEach(() => {
        vi.clearAllMocks();
        items = {};
        previousZotero = (globalThis as any).Zotero;
        (globalThis as any).Zotero = {
            Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1] },
            Libraries: {
                get: vi.fn(() => ({ libraryID: 1, name: 'My Library', editable: true })),
                userLibraryID: 1,
            },
            Groups: {
                getGroupIDFromLibraryID: vi.fn(() => false),
                getLibraryIDFromGroupID: vi.fn(() => false),
            },
            Collections: {
                getByLibrary: vi.fn(() => []),
                get: vi.fn((id: number) => (id === COLLECTION_ID ? { key: COLLECTION_KEY, id } : null)),
                getByLibraryAndKey: vi.fn((_lib: number, key: string) =>
                    key === COLLECTION_KEY ? { id: COLLECTION_ID, key, libraryID: 1, name: 'Collection' } : null
                ),
            },
            Items: {
                getByLibraryAndKeyAsync: vi.fn((_lib: number, key: string) => items[key] ?? null),
            },
            DB: {
                executeTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
            },
        };
    });

    it.each([1, 7])('applies tag-only edits in library %s without collection preflight or collection results', async libraryID => {
        const item = makeItem('AAAAAAAA', [], []);
        item.libraryID = libraryID;
        items.AAAAAAAA = item;
        Zotero.Beaver.searchableLibraryIds = [1, 7];
        vi.mocked(Zotero.Libraries.get).mockReturnValue({ libraryID, editable: true } as any);

        const response = await executeOrganizeItemsAction(buildRequest({
            item_ids: [`${libraryID}-AAAAAAAA`], tags: { add: ['reviewed'] },
        }), timeoutCtx());

        expect(response.success).toBe(true);
        expect(item.state.tags).toEqual(['reviewed']);
        expect(Zotero.Items.getByLibraryAndKeyAsync).toHaveBeenCalledTimes(1);
        expect(Zotero.Collections.getByLibraryAndKey).not.toHaveBeenCalled();
        expect(response.result_data).toMatchObject({ tags_added: ['reviewed'], items_modified: 1 });
        expect(response.result_data?.collection_ids_added).toBeUndefined();
        expect(response.result_data?.collection_ids_removed).toBeUndefined();
        expect(response.result_data?.collections_added).toBeUndefined();
        expect(response.result_data?.collections_removed).toBeUndefined();
    });

    it('omits portable result fields for collection operations that made no changes', async () => {
        items.AAAAAAAA = makeItem('AAAAAAAA', [], [COLLECTION_ID]);
        const response = await executeOrganizeItemsAction(buildRequest({
            item_ids: ['1-AAAAAAAA'], collections: { add: [COLLECTION_KEY] },
        }), timeoutCtx());
        expect(response.success).toBe(true);
        expect(response.result_data?.collection_ids_added).toBeUndefined();
        expect(response.result_data?.collection_ids_removed).toBeUndefined();
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('reports items already in the collection instead of counting them modified', async () => {
        // Two already filed, one not.
        items.AAAAAAAA = makeItem('AAAAAAAA', [], [COLLECTION_ID]);
        items.BBBBBBBB = makeItem('BBBBBBBB', [], [COLLECTION_ID]);
        items.CCCCCCCC = makeItem('CCCCCCCC', [], []);

        const response = await executeOrganizeItemsAction(
            buildRequest({
                item_ids: ['1-AAAAAAAA', '1-BBBBBBBB', '1-CCCCCCCC'],
                collections: { add: [COLLECTION_KEY] },
            }),
            timeoutCtx()
        );

        expect(response.success).toBe(true);
        expect(response.result_data?.items_modified).toBe(1);
        expect(response.result_data?.unchanged_items).toEqual(['1-AAAAAAAA', '1-BBBBBBBB']);
        expect(response.result_data?.skipped_items).toBeUndefined();
    });

    it('reports items that never had the tag being removed', async () => {
        items.AAAAAAAA = makeItem('AAAAAAAA', ['to-read'], []);
        items.BBBBBBBB = makeItem('BBBBBBBB', [], []);

        const response = await executeOrganizeItemsAction(
            buildRequest({
                item_ids: ['1-AAAAAAAA', '1-BBBBBBBB'],
                tags: { remove: ['to-read'] },
            }),
            timeoutCtx()
        );

        expect(response.result_data?.items_modified).toBe(1);
        expect(response.result_data?.unchanged_items).toEqual(['1-BBBBBBBB']);
    });

    it('omits the field when every item was actually changed', async () => {
        items.AAAAAAAA = makeItem('AAAAAAAA', [], []);

        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['1-AAAAAAAA'], tags: { add: ['reviewed'] } }),
            timeoutCtx()
        );

        expect(response.result_data?.items_modified).toBe(1);
        expect(response.result_data?.unchanged_items).toBeUndefined();
    });

    it('keeps unresolvable ids in skipped_items, not unchanged_items', async () => {
        // Never registered in `items`, so it does not resolve on this device.
        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['1-ZZZZZZZZ'], tags: { add: ['reviewed'] } }),
            timeoutCtx()
        );

        expect(response.result_data?.items_modified).toBe(0);
        expect(response.result_data?.skipped_items).toEqual(['1-ZZZZZZZZ']);
        expect(response.result_data?.unchanged_items).toBeUndefined();
    });

    it('counts a repeated id once instead of reporting it modified and unchanged', async () => {
        items.AAAAAAAA = makeItem('AAAAAAAA', [], []);

        const response = await executeOrganizeItemsAction(
            buildRequest({
                item_ids: ['1-AAAAAAAA', '1-AAAAAAAA'],
                tags: { add: ['reviewed'] },
            }),
            timeoutCtx()
        );

        expect(response.result_data?.items_modified).toBe(1);
        expect(response.result_data?.unchanged_items).toBeUndefined();
        expect(items.AAAAAAAA.save).toHaveBeenCalledTimes(1);
    });

    it('rejects a trashed add target before applying any item changes', async () => {
        items.AAAAAAAA = makeItem('AAAAAAAA', [], []);
        vi.mocked(Zotero.Collections.getByLibraryAndKey).mockImplementation((_lib: number, key: string) =>
            key === COLLECTION_KEY
                ? { id: COLLECTION_ID, key, libraryID: 1, name: 'Collection', deleted: true }
                : null);
        await expect(executeOrganizeItemsAction(buildRequest({
            item_ids: ['1-AAAAAAAA'], tags: { add: ['new'] }, collections: { add: [COLLECTION_KEY] },
        }), timeoutCtx())).rejects.toMatchObject({ code: 'collection_not_found' });
        expect(items.AAAAAAAA.save).not.toHaveBeenCalled();
        expect(items.AAAAAAAA.state.tags).toEqual([]);
    });

    it('fails the batch when an add-target collection was deleted since validation', async () => {
        // Filed in the surviving collection already; the second key resolves to
        // nothing, so the item is NOT in the requested state.
        items.AAAAAAAA = makeItem('AAAAAAAA', [], [COLLECTION_ID]);

        await expect(executeOrganizeItemsAction(
            buildRequest({
                item_ids: ['1-AAAAAAAA'],
                collections: { add: [COLLECTION_KEY, 'DELETED12'] },
            }),
            timeoutCtx()
        )).rejects.toMatchObject({ code: 'collection_not_found' });

        expect(items.AAAAAAAA.save).not.toHaveBeenCalled();
    });

    it('treats a deleted remove-target as already satisfied', async () => {
        // An item cannot be in a collection that no longer exists, so the
        // requested state holds and the item belongs in unchanged_items.
        items.AAAAAAAA = makeItem('AAAAAAAA', [], []);

        const response = await executeOrganizeItemsAction(
            buildRequest({
                item_ids: ['1-AAAAAAAA'],
                collections: { remove: ['DELETED12'] },
            }),
            timeoutCtx()
        );

        expect(response.success).toBe(true);
        expect(response.result_data).toMatchObject({ items_modified: 0, unchanged_items: ['1-AAAAAAAA'] });
        expect(items.AAAAAAAA.save).not.toHaveBeenCalled();
    });

    it('applies tag changes requested alongside a deleted remove-target', async () => {
        // Failing over a no-op removal would silently drop the tag edit.
        items.AAAAAAAA = makeItem('AAAAAAAA', [], []);

        const response = await executeOrganizeItemsAction(
            buildRequest({
                item_ids: ['1-AAAAAAAA'],
                tags: { add: ['marker'] },
                collections: { remove: ['DELETED12'] },
            }),
            timeoutCtx()
        );

        expect(response.success).toBe(true);
        expect(response.result_data).toMatchObject({ items_modified: 1, tags_added: ['marker'] });
        expect(items.AAAAAAAA.state.tags).toEqual(['marker']);
    });
});
