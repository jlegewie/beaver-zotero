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
            Libraries: {
                get: vi.fn(() => ({ libraryID: 1, name: 'My Library', editable: true })),
                userLibraryID: 1,
            },
            Groups: {
                getGroupIDFromLibraryID: vi.fn(() => false),
                getLibraryIDFromGroupID: vi.fn(() => false),
            },
            Collections: {
                get: vi.fn((id: number) => (id === COLLECTION_ID ? { key: COLLECTION_KEY, id } : null)),
                getByLibraryAndKeyAsync: vi.fn(async (_lib: number, key: string) =>
                    key === COLLECTION_KEY ? { id: COLLECTION_ID, key } : null
                ),
            },
            Items: {
                getByLibraryAndKeyAsync: vi.fn(async (_lib: number, key: string) => items[key] ?? null),
            },
            DB: {
                executeTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
            },
        };
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
});
