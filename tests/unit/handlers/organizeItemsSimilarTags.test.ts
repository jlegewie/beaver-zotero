/**
 * Unit tests for organize_items' `similar_existing_tags`: tags a write created
 * that differ from a tag already in the library only in form (case, spacing,
 * hyphens, plural ending). Advisory, so it must never block or alter the write.
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
import { similarTagKey } from '../../../src/services/agentDataProvider/actions/similarTags';
import type { TimeoutContext } from '../../../src/services/agentDataProvider/timeout';
import type { WSAgentActionExecuteRequest } from '@beaver/agent-core/protocol/agentProtocol';

function timeoutCtx(): TimeoutContext {
    return { signal: new AbortController().signal, timeoutSeconds: 60, startTime: Date.now() };
}

function makeItem(key: string, tags: string[], libraryID = 1) {
    const state = { tags: [...tags] };
    return {
        key,
        libraryID,
        state,
        isTopLevelItem: () => true,
        getTags: () => state.tags.map((tag) => ({ tag })),
        getCollections: () => [],
        addTag: (tag: string) => state.tags.push(tag),
        removeTag: (tag: string) => {
            const at = state.tags.indexOf(tag);
            if (at === -1) return false;
            state.tags.splice(at, 1);
            return true;
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

/**
 * Answers the two queries the check makes: names on items of one library, and
 * every name in the global tags table.
 */
function fakeTagQueries(libraryTags: Record<number, string[]>, otherNames: string[] = []) {
    return vi.fn(async (sql: string, params: any[], opts: { onRow: (row: any) => void }) => {
        const row = (name: string) => ({ getResultByIndex: () => name });
        if (sql.trim() === 'SELECT name FROM tags') {
            const all = new Set([...Object.values(libraryTags).flat(), ...otherNames]);
            for (const name of all) opts.onRow(row(name));
            return;
        }
        const [libraryID, ...names] = params;
        for (const name of new Set(names)) {
            if ((libraryTags[libraryID] ?? []).includes(name)) opts.onRow(row(name));
        }
    });
}

describe('similarTagKey', () => {
    it.each([
        ['Machine Learning', 'machine-learning'],
        ['sandwich panel', 'Sandwich  panels'],
        ['therapy', 'therapies'],
        ['gut_microbiome', 'Gut microbiome'],
    ])('treats %s and %s as one name', (a, b) => {
        expect(similarTagKey(a)).toBe(similarTagKey(b));
    });

    it.each([
        ['analysis', 'analysi'],
        ['virus', 'viru'],
        ['p53', 'p63'],
        ['in vitro', 'in vivo'],
    ])('keeps %s apart from %s', (a, b) => {
        expect(similarTagKey(a)).not.toBe(similarTagKey(b));
    });
});

describe('executeOrganizeItemsAction similar_existing_tags', () => {
    let previousZotero: any;
    let items: Record<string, ReturnType<typeof makeItem>>;

    function installZotero(queryAsync: any) {
        (globalThis as any).Zotero = {
            Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1, 7] },
            Libraries: {
                get: vi.fn((id: number) => ({ libraryID: id, name: 'Library', editable: true })),
                userLibraryID: 1,
            },
            Groups: {
                getGroupIDFromLibraryID: vi.fn((id: number) => (id === 7 ? 42 : false)),
                getLibraryIDFromGroupID: vi.fn((id: number) => (id === 42 ? 7 : false)),
            },
            Collections: { get: vi.fn(() => null), getByLibraryAndKey: vi.fn(() => null) },
            Items: {
                getByLibraryAndKeyAsync: vi.fn((_lib: number, key: string) => items[key] ?? null),
            },
            DB: {
                executeTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
                queryAsync,
            },
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        items = {};
        previousZotero = (globalThis as any).Zotero;
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('reports a new tag that differs from an existing one only in case', async () => {
        installZotero(fakeTagQueries({ 1: ['Machine Learning', 'Ethics'] }));
        items.AAAAAAAA = makeItem('AAAAAAAA', []);

        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['u-AAAAAAAA'], tags: { add: ['machine learning', 'ethics'] } }),
            timeoutCtx(),
        );

        expect(response.success).toBe(true);
        expect(items.AAAAAAAA.state.tags).toEqual(['machine learning', 'ethics']);
        expect(response.result_data?.similar_existing_tags).toEqual([
            { tag: 'machine learning', library_ref: 'u', existing: ['Machine Learning'] },
            { tag: 'ethics', library_ref: 'u', existing: ['Ethics'] },
        ]);
    });

    it('stays silent when the added tag already exists in the library', async () => {
        // Both spellings already exist: reusing one of them creates nothing.
        const queryAsync = fakeTagQueries({ 1: ['Machine Learning', 'machine learning'] });
        installZotero(queryAsync);
        items.AAAAAAAA = makeItem('AAAAAAAA', []);

        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['u-AAAAAAAA'], tags: { add: ['machine learning'] } }),
            timeoutCtx(),
        );

        expect(response.result_data?.similar_existing_tags).toBeUndefined();
        // The indexed lookup settles it; no scan of every tag name.
        expect(queryAsync.mock.calls.some(([sql]) => sql === 'SELECT name FROM tags')).toBe(false);
    });

    it('ignores a spelling that exists only in another library', async () => {
        installZotero(fakeTagQueries({ 1: [], 7: ['Machine Learning'] }));
        items.AAAAAAAA = makeItem('AAAAAAAA', []);

        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['u-AAAAAAAA'], tags: { add: ['machine learning'] } }),
            timeoutCtx(),
        );

        expect(response.result_data?.similar_existing_tags).toBeUndefined();
    });

    it('names the group library the similar tag lives in', async () => {
        installZotero(fakeTagQueries({ 7: ['Sandwich panels'] }));
        items.AAAAAAAA = makeItem('AAAAAAAA', [], 7);

        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['g42-AAAAAAAA'], tags: { add: ['sandwich panel'] } }),
            timeoutCtx(),
        );

        expect(response.result_data?.similar_existing_tags).toEqual([
            { tag: 'sandwich panel', library_ref: 'g42', existing: ['Sandwich panels'] },
        ]);
    });

    it('does not flag a replacement that removes the old spelling in the same call', async () => {
        installZotero(fakeTagQueries({ 1: ['Machine Learning'] }));
        items.AAAAAAAA = makeItem('AAAAAAAA', ['Machine Learning']);

        const response = await executeOrganizeItemsAction(
            buildRequest({
                item_ids: ['u-AAAAAAAA'],
                tags: { add: ['machine learning'], remove: ['Machine Learning'] },
            }),
            timeoutCtx(),
        );

        expect(items.AAAAAAAA.state.tags).toEqual(['machine learning']);
        expect(response.result_data?.similar_existing_tags).toBeUndefined();
    });

    it('applies the write unchanged when the lookup fails', async () => {
        installZotero(vi.fn(async () => { throw new Error('database is locked'); }));
        items.AAAAAAAA = makeItem('AAAAAAAA', []);

        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['u-AAAAAAAA'], tags: { add: ['machine learning'] } }),
            timeoutCtx(),
        );

        expect(response.success).toBe(true);
        expect(items.AAAAAAAA.state.tags).toEqual(['machine learning']);
        expect(response.result_data?.similar_existing_tags).toBeUndefined();
        // Which tags are new is unknown, so the field is left out.
        expect(response.result_data?.tags_created).toBeUndefined();
    });
});

describe('executeOrganizeItemsAction tags_created', () => {
    let previousZotero: any;
    let items: Record<string, ReturnType<typeof makeItem>>;

    function installZotero(queryAsync: any) {
        (globalThis as any).Zotero = {
            Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1, 7] },
            Libraries: {
                get: vi.fn((id: number) => ({ libraryID: id, name: 'Library', editable: true })),
                userLibraryID: 1,
            },
            Groups: {
                getGroupIDFromLibraryID: vi.fn((id: number) => (id === 7 ? 42 : false)),
                getLibraryIDFromGroupID: vi.fn((id: number) => (id === 42 ? 7 : false)),
            },
            Collections: { get: vi.fn(() => null), getByLibraryAndKey: vi.fn(() => null) },
            Items: {
                getByLibraryAndKeyAsync: vi.fn((_lib: number, key: string) => items[key] ?? null),
            },
            DB: {
                executeTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
                queryAsync,
            },
        };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        items = {};
        previousZotero = (globalThis as any).Zotero;
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('lists the added tags that are new to their library', async () => {
        installZotero(fakeTagQueries({ 1: ['ethics'] }));
        items.AAAAAAAA = makeItem('AAAAAAAA', []);

        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['u-AAAAAAAA'], tags: { add: ['ethics', 'deep learning'] } }),
            timeoutCtx(),
        );

        expect(response.result_data?.tags_created).toEqual([
            { tag: 'deep learning', library_ref: 'u' },
        ]);
    });

    it('reports an empty list when every added tag already existed', async () => {
        installZotero(fakeTagQueries({ 7: ['ethics'] }));
        items.AAAAAAAA = makeItem('AAAAAAAA', [], 7);

        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['g42-AAAAAAAA'], tags: { add: ['ethics'] } }),
            timeoutCtx(),
        );

        expect(response.result_data?.tags_created).toEqual([]);
    });

    it('omits the field when the write added no tag', async () => {
        installZotero(fakeTagQueries({ 1: ['ethics'] }));
        items.AAAAAAAA = makeItem('AAAAAAAA', ['ethics']);

        const response = await executeOrganizeItemsAction(
            buildRequest({ item_ids: ['u-AAAAAAAA'], tags: { add: ['ethics'] } }),
            timeoutCtx(),
        );

        expect(response.result_data?.tags_created).toBeUndefined();
    });
});
