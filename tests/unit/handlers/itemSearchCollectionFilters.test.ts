/**
 * Collection filters on the two item-search handlers
 * (`handleItemSearchByMetadataRequest`, `handleItemSearchByTopicRequest`) and on
 * the shared `resolveCollectionFilters` helper they use.
 *
 * The handlers run against the real resolver, so every unrelated dependency of
 * `agentDataProvider/utils` (document extraction, sync, popups, …) is stubbed
 * just to make the module importable in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    searchableLibraryIds: [] as number[],
    /** Per-library results the mocked metadata search returns. */
    metadataResults: {} as Record<number, any[]>,
    /** Candidate window the mocked semantic search draws from, best match first. */
    topicResults: [] as { itemId: number; similarity: number }[],
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(),
    safeFileExists: vi.fn(),
    isLinkedUrlAttachment: vi.fn(),
    // Mirrors the real algorithm (first occurrence wins its slot, an item from
    // the preferred library replaces it), with the title standing in for the
    // real duplicate test.
    deduplicateItems: vi.fn((items: any[], preferredLibraryId = 1) => {
        const result: any[] = [];
        const processed = new Set<number>();
        for (let i = 0; i < items.length; i++) {
            if (processed.has(i)) continue;
            let best = items[i];
            for (let j = i + 1; j < items.length; j++) {
                if (processed.has(j)) continue;
                if (items[j].getField('title') !== items[i].getField('title')) continue;
                processed.add(j);
                if (items[j].libraryID === preferredLibraryId && best.libraryID !== preferredLibraryId) {
                    best = items[j];
                }
            }
            result.push(best);
        }
        return result;
    }),
}));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    isAgentSupportedItem: vi.fn(() => true),
    agentItemFilter: vi.fn((item: any) => item.isRegularItem() && !item.deleted),
}));
vi.mock('../../../src/utils/zoteroSerializers', () => ({
    safeStub: vi.fn(),
    serializeItem: vi.fn(async (item: any) => ({ library_id: item.libraryID, zotero_key: item.key })),
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
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => harness.searchableLibraryIds) },
}));
vi.mock('../../../react/agents/atoms', () => ({
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
    prepareAttachmentInfoBatchData: vi.fn(async () => ({})),
    processAttachmentInfoBatch: vi.fn(async () => []),
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
vi.mock('../../../src/services/database', () => ({
    BeaverDB: class {},
}));
vi.mock('../../../src/services/semanticSearchService', () => ({
    semanticSearchService: class {
        async search(query: string, options: { topK: number }) {
            return semanticSearch(query, options);
        }
    },
}));
// Stands in for Zotero's own search: a `collection_key` condition selects direct
// members of that collection in the searched library, and `limit` truncates.
vi.mock('../../../react/utils/searchTools', () => ({
    searchItemsByMetadata: vi.fn(async (libraryId: number, options: any) => {
        const items = harness.metadataResults[libraryId] ?? [];
        const scoped = options.collection_key
            ? items.filter((item: any) =>
                item.getCollections().some((collectionId: number) => {
                    const collection = COLLECTIONS.find(c => c.id === collectionId);
                    return collection?.libraryID === libraryId && collection.key === options.collection_key;
                })
            )
            : items;
        return options.limit > 0 ? scoped.slice(0, options.limit) : scoped;
    }),
}));

import { logger } from '@beaver/agent-core/platform/logger';
import { resolveCollectionFilters } from '../../../src/services/agentDataProvider/utils';
import { handleItemSearchByMetadataRequest } from '../../../src/services/agentDataProvider/handleItemSearchByMetadataRequest';
import { handleItemSearchByTopicRequest } from '../../../src/services/agentDataProvider/handleItemSearchByTopicRequest';
import { searchItemsByMetadata } from '../../../react/utils/searchTools';

const semanticSearch = vi.fn(async (_query: string, options: { topK: number }) =>
    harness.topicResults.slice(0, options.topK)
);

const PERSONAL_LIBRARY = 1;
const GROUP_LIBRARY = 100;
const EXCLUDED_LIBRARY = 200;

const LIBRARIES = [
    { libraryID: PERSONAL_LIBRARY, name: 'My Library' },
    { libraryID: GROUP_LIBRARY, name: 'Group A' },
    { libraryID: EXCLUDED_LIBRARY, name: 'Group B' },
];

const GROUP_ID_BY_LIBRARY: Record<number, number> = {
    [GROUP_LIBRARY]: 12345,
    [EXCLUDED_LIBRARY]: 67890,
};

type MockCollection = { id: number; key: string; libraryID: number; name: string };

const personalA: MockCollection = { id: 10, key: 'PERSAAA2', libraryID: PERSONAL_LIBRARY, name: 'Method' };
const personalB: MockCollection = { id: 11, key: 'PERSBBB2', libraryID: PERSONAL_LIBRARY, name: 'Theory' };
const groupA: MockCollection = { id: 20, key: 'GRPCAAA2', libraryID: GROUP_LIBRARY, name: 'Group Reading' };
// Same key as `groupA`, in the personal library: keys are unique per library only.
const personalSameKeyAsGroup: MockCollection = { id: 12, key: 'GRPCAAA2', libraryID: PERSONAL_LIBRARY, name: 'Shadow' };
// One name, two libraries: a name filter is OR-expanded over both.
const personalShared: MockCollection = { id: 13, key: 'SHRDAAA2', libraryID: PERSONAL_LIBRARY, name: 'Inbox' };
const groupShared: MockCollection = { id: 21, key: 'SHRDBBB2', libraryID: GROUP_LIBRARY, name: 'Inbox' };
// One key, two libraries: a bare key filter is ambiguous.
const dupePersonal: MockCollection = { id: 14, key: 'DUPEKEYZ', libraryID: PERSONAL_LIBRARY, name: 'Dup Personal' };
const dupeGroup: MockCollection = { id: 22, key: 'DUPEKEYZ', libraryID: GROUP_LIBRARY, name: 'Dup Group' };
const excluded: MockCollection = { id: 90, key: 'EXCLZZZ2', libraryID: EXCLUDED_LIBRARY, name: 'Excluded Coll' };

const COLLECTIONS: MockCollection[] = [
    personalA,
    personalB,
    groupA,
    personalSameKeyAsGroup,
    personalShared,
    groupShared,
    dupePersonal,
    dupeGroup,
    excluded,
];

interface MockItemOptions {
    id: number;
    key: string;
    libraryID: number;
    title?: string;
    collections?: number[];
    dateAdded?: string;
    deleted?: boolean;
}

const ITEMS_BY_ID = new Map<number, any>();

/** Zotero's own key alphabet (no 0, 1 or O). */
const KEY_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';

/** Distinct 8-character key for generated fixtures. */
function itemKey(index: number): string {
    let remaining = index;
    let key = '';
    for (let position = 0; position < 8; position++) {
        key = KEY_ALPHABET[remaining % KEY_ALPHABET.length] + key;
        remaining = Math.floor(remaining / KEY_ALPHABET.length);
    }
    return key;
}

const timestamp = (minutesFromMidnight: number) =>
    `2026-01-01 ${String(Math.floor(minutesFromMidnight / 60)).padStart(2, '0')}` +
    `:${String(minutesFromMidnight % 60).padStart(2, '0')}:00`;

function makeItem(options: MockItemOptions) {
    const item = {
        id: options.id,
        key: options.key,
        libraryID: options.libraryID,
        deleted: options.deleted ?? false,
        dateAdded: options.dateAdded ?? '2026-01-01 00:00:00',
        isRegularItem: () => true,
        getField: (field: string) => (field === 'title' ? options.title ?? `Item ${options.id}` : ''),
        getCollections: () => options.collections ?? [],
        getTags: () => [],
        getCreators: () => [],
    };
    ITEMS_BY_ID.set(options.id, item);
    return item;
}

let previousZotero: any;

beforeEach(() => {
    vi.clearAllMocks();
    harness.searchableLibraryIds = [PERSONAL_LIBRARY, GROUP_LIBRARY];
    harness.metadataResults = {};
    harness.topicResults = [];
    ITEMS_BY_ID.clear();
    previousZotero = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
        Beaver: { db: {} },
        Libraries: {
            get: vi.fn((libraryID: number) => LIBRARIES.find(l => l.libraryID === libraryID) ?? false),
            getAll: vi.fn(() => LIBRARIES),
            userLibraryID: PERSONAL_LIBRARY,
        },
        Groups: {
            getGroupIDFromLibraryID: vi.fn((libraryID: number) => GROUP_ID_BY_LIBRARY[libraryID] ?? false),
            getLibraryIDFromGroupID: vi.fn((groupID: number) => {
                const entry = Object.entries(GROUP_ID_BY_LIBRARY).find(([, id]) => id === groupID);
                return entry ? Number(entry[0]) : false;
            }),
        },
        Collections: {
            get: vi.fn((id: number) => COLLECTIONS.find(c => c.id === id) ?? false),
            getByLibraryAndKey: vi.fn(
                (libraryID: number, key: string) =>
                    COLLECTIONS.find(c => c.libraryID === libraryID && c.key === key) ?? false
            ),
            getByLibrary: vi.fn((libraryID: number) => COLLECTIONS.filter(c => c.libraryID === libraryID)),
        },
        Items: {
            getAsync: vi.fn(async (ids: number[]) => ids.map(id => ITEMS_BY_ID.get(id) ?? null)),
            loadDataTypes: vi.fn(async () => undefined),
        },
        Utilities: {
            // Mirrors Zotero's own key alphabet (no 0, 1 or O).
            isValidObjectKey: vi.fn((key: string) => /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(key)),
        },
    };
});

afterEach(() => {
    (globalThis as any).Zotero = previousZotero;
});

const eligible = () => [PERSONAL_LIBRARY, GROUP_LIBRARY];

function metadataRequest(overrides: Record<string, any> = {}) {
    return {
        event: 'item_search_by_metadata_request',
        request_id: 'req-1',
        title_query: 'anything',
        limit: 10,
        ...overrides,
    } as any;
}

function topicRequest(overrides: Record<string, any> = {}) {
    return {
        event: 'item_search_by_topic_request',
        request_id: 'req-1',
        topic_query: 'anything',
        limit: 10,
        ...overrides,
    } as any;
}

const returnedKeys = (response: any) => response.items.map((entry: any) => entry.item.zotero_key);
const capWarnings = () =>
    (logger as any).mock.calls.filter((call: any[]) => String(call[0]).includes('cap'));

/**
 * `count` members of `personalA` in search order, with `dateAdded` ascending
 * along it, so an ordering by recency would visibly reverse the page.
 */
function seedPersonalCollection(count: number) {
    const members = Array.from({ length: count }, (_, index) =>
        makeItem({
            id: index + 1,
            key: itemKey(index + 1),
            libraryID: PERSONAL_LIBRARY,
            title: `Item ${index + 1}`,
            collections: [personalA.id],
            dateAdded: timestamp(index),
        })
    );
    harness.metadataResults = { [PERSONAL_LIBRARY]: members };
    return members;
}

const metadataCallsFor = (libraryId: number) =>
    (searchItemsByMetadata as any).mock.calls
        .filter((call: any[]) => call[0] === libraryId)
        .map((call: any[]) => call[1]);
const metadataCallFor = (libraryId: number) => metadataCallsFor(libraryId)[0];

describe('resolveCollectionFilters', () => {
    it('returns no filters when none were requested', () => {
        expect(resolveCollectionFilters(undefined, { eligibleLibraryIds: eligible() })).toEqual({
            ok: true,
            filters: [],
        });
    });

    it('keeps the library of each scoped identifier', () => {
        const resolved = resolveCollectionFilters([`u-${personalA.key}`, `g12345-${groupA.key}`], {
            eligibleLibraryIds: eligible(),
        });
        expect(resolved).toEqual({
            ok: true,
            filters: [
                { libraryID: PERSONAL_LIBRARY, key: personalA.key },
                { libraryID: GROUP_LIBRARY, key: groupA.key },
            ],
        });
    });

    it('OR-expands a name that matches in several libraries', () => {
        const resolved = resolveCollectionFilters(['Inbox'], { eligibleLibraryIds: eligible() });
        expect(resolved).toEqual({
            ok: true,
            filters: [
                { libraryID: PERSONAL_LIBRARY, key: personalShared.key },
                { libraryID: GROUP_LIBRARY, key: groupShared.key },
            ],
        });
    });

    it('resolves a numeric row id only inside the eligible libraries', () => {
        expect(resolveCollectionFilters([personalA.id], { eligibleLibraryIds: eligible() })).toEqual({
            ok: true,
            filters: [{ libraryID: PERSONAL_LIBRARY, key: personalA.key }],
        });
        expect(resolveCollectionFilters([excluded.id], { eligibleLibraryIds: eligible() })).toMatchObject({
            ok: false,
            code: 'collection_not_found',
        });
    });

    it('deduplicates filters that resolve to the same collection', () => {
        const resolved = resolveCollectionFilters([personalA.id, `u-${personalA.key}`, personalA.key], {
            eligibleLibraryIds: eligible(),
        });
        expect(resolved).toEqual({ ok: true, filters: [{ libraryID: PERSONAL_LIBRARY, key: personalA.key }] });
    });

    it('fails the whole request when one of several filters is unresolvable', () => {
        const resolved = resolveCollectionFilters([`u-${personalA.key}`, 'No Such Collection'], {
            eligibleLibraryIds: eligible(),
        });
        expect(resolved).toMatchObject({ ok: false, code: 'collection_not_found' });
        expect((resolved as any).message).toContain('No Such Collection');
        expect((resolved as any).message).toContain('1 of 2');
    });

    it('treats a malformed entry as an unresolvable filter', () => {
        expect(
            resolveCollectionFilters([`u-${personalA.key}`, {} as any, null as any], {
                eligibleLibraryIds: eligible(),
            })
        ).toMatchObject({ ok: false, code: 'invalid_request' });
    });

    it('rejects a filter that is not a list', () => {
        for (const malformed of [personalA.key as any, { key: personalA.key } as any, 7 as any]) {
            expect(resolveCollectionFilters(malformed, { eligibleLibraryIds: eligible() })).toMatchObject({
                ok: false,
                code: 'invalid_request',
            });
        }
    });

    it('reports a scoped identifier outside an explicitly requested library as a scope conflict', () => {
        const resolved = resolveCollectionFilters([`g12345-${groupA.key}`], {
            eligibleLibraryIds: [PERSONAL_LIBRARY],
            explicitLibrary: true,
        });
        expect(resolved).toMatchObject({ ok: false, code: 'invalid_request' });
    });
});

describe('handleItemSearchByMetadataRequest collection filters', () => {
    it('applies each scoped filter only within its own library', async () => {
        // Both libraries hold a collection with key GRPCAAA2, but only the group
        // one was requested.
        harness.metadataResults = {
            [PERSONAL_LIBRARY]: [
                makeItem({ id: 1, key: 'PITEM222', libraryID: PERSONAL_LIBRARY, collections: [personalA.id] }),
                makeItem({ id: 2, key: 'PITEM333', libraryID: PERSONAL_LIBRARY, collections: [personalSameKeyAsGroup.id] }),
            ],
            [GROUP_LIBRARY]: [
                makeItem({ id: 3, key: 'GITEM222', libraryID: GROUP_LIBRARY, collections: [groupA.id] }),
            ],
        };

        const response = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: [`u-${personalA.key}`, `g12345-${groupA.key}`] })
        );

        expect(returnedKeys(response).sort()).toEqual(['GITEM222', 'PITEM222']);
        expect(metadataCallFor(PERSONAL_LIBRARY)).toMatchObject({ collection_key: personalA.key });
        expect(metadataCallFor(GROUP_LIBRARY)).toMatchObject({ collection_key: groupA.key });
    });

    it('runs one bounded search per collection and returns their union', async () => {
        harness.metadataResults = {
            [PERSONAL_LIBRARY]: [
                makeItem({ id: 1, key: 'INAAA222', libraryID: PERSONAL_LIBRARY, collections: [personalA.id] }),
                makeItem({ id: 2, key: 'INBBB222', libraryID: PERSONAL_LIBRARY, collections: [personalB.id] }),
                makeItem({ id: 3, key: 'OUTCC222', libraryID: PERSONAL_LIBRARY, collections: [personalShared.id] }),
            ],
        };

        const response = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: [`u-${personalA.key}`, `u-${personalB.key}`] })
        );

        expect(returnedKeys(response).sort()).toEqual(['INAAA222', 'INBBB222']);
        // Two OR'd collections cannot be expressed by one search, so each gets
        // its own bounded, collection-scoped search.
        const calls = metadataCallsFor(PERSONAL_LIBRARY);
        expect(calls.map((options: any) => options.collection_key)).toEqual([personalA.key, personalB.key]);
        for (const options of calls) {
            expect(options.limit).toBeGreaterThan(0);
        }
    });

    it('skips a library that holds none of the requested collections', async () => {
        harness.metadataResults = {
            [PERSONAL_LIBRARY]: [makeItem({ id: 1, key: 'PITEM222', libraryID: PERSONAL_LIBRARY, collections: [personalA.id] })],
            [GROUP_LIBRARY]: [makeItem({ id: 2, key: 'GITEM222', libraryID: GROUP_LIBRARY, collections: [groupA.id] })],
        };

        const response = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: [`u-${personalA.key}`] })
        );

        expect(returnedKeys(response)).toEqual(['PITEM222']);
        expect(metadataCallFor(GROUP_LIBRARY)).toBeUndefined();
    });

    it('never runs an unfiltered search when a filter cannot be resolved', async () => {
        harness.metadataResults = {
            [PERSONAL_LIBRARY]: [makeItem({ id: 1, key: 'PITEM222', libraryID: PERSONAL_LIBRARY })],
        };

        const response = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: [`u-${personalA.key}`, 'No Such Collection'] })
        );

        expect(searchItemsByMetadata).not.toHaveBeenCalled();
        expect(response.items).toEqual([]);
        expect(response.error_code).toBe('collection_not_found');
        expect(response.error).toContain('No Such Collection');
    });

    it('reports a bare key present in two libraries as ambiguous', async () => {
        const response = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: [dupePersonal.key] })
        );

        expect(searchItemsByMetadata).not.toHaveBeenCalled();
        expect(response.error_code).toBe('ambiguous_collection');
        expect(response.error).toContain('u-DUPEKEYZ');
        expect(response.error).toContain('g12345-DUPEKEYZ');
    });

    it('reports a scoped identifier from a library this computer does not have', async () => {
        const response = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: ['g99999-ABCD2345'] })
        );

        expect(searchItemsByMetadata).not.toHaveBeenCalled();
        expect(response.error_code).toBe('library_unavailable');
    });

    it('reports an explicitly named excluded library, and hides it from a bare key', async () => {
        const named = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: [`g67890-${excluded.key}`] })
        );
        expect(named.error_code).toBe('library_not_searchable');

        // A bare key must not disclose that the collection exists in a library
        // the user excluded from Beaver.
        const bareKey = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: [excluded.key] })
        );
        expect(bareKey.error_code).toBe('collection_not_found');
        expect(bareKey.error).not.toContain('Group B');
        expect(searchItemsByMetadata).not.toHaveBeenCalled();
    });

    it('paginates the union in search order, with no per-library truncation', async () => {
        harness.metadataResults = {
            [PERSONAL_LIBRARY]: [
                makeItem({ id: 1, key: 'PAAAA222', libraryID: PERSONAL_LIBRARY, title: 'P1', collections: [personalA.id], dateAdded: '2026-01-05 00:00:00' }),
                makeItem({ id: 2, key: 'PBBBB222', libraryID: PERSONAL_LIBRARY, title: 'P2', collections: [personalA.id], dateAdded: '2026-01-03 00:00:00' }),
            ],
            [GROUP_LIBRARY]: [
                makeItem({ id: 3, key: 'GAAAA222', libraryID: GROUP_LIBRARY, title: 'G1', collections: [groupA.id], dateAdded: '2026-01-04 00:00:00' }),
                makeItem({ id: 4, key: 'GBBBB222', libraryID: GROUP_LIBRARY, title: 'G2', collections: [groupA.id], dateAdded: '2026-01-02 00:00:00' }),
            ],
        };
        const filters = [`u-${personalA.key}`, `g12345-${groupA.key}`];

        const firstPage = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: filters, limit: 2 })
        );
        const secondPage = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: filters, limit: 2, offset: 2 })
        );
        const firstPageAgain = await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: filters, limit: 2 })
        );

        // Union order: each search contributes its results in turn, and the page
        // is a slice of that. `dateAdded` interleaves the libraries and plays no
        // part in the ordering.
        expect(returnedKeys(firstPage)).toEqual(['PAAAA222', 'PBBBB222']);
        expect(returnedKeys(secondPage)).toEqual(['GAAAA222', 'GBBBB222']);
        expect(returnedKeys(firstPageAgain)).toEqual(returnedKeys(firstPage));
        // Each search is bounded, but well above the page size so the union can
        // still be paginated.
        expect(metadataCallFor(PERSONAL_LIBRARY).limit).toBe(100);
        expect(metadataCallFor(GROUP_LIBRARY).limit).toBe(100);
    });

    it('pages through a collection larger than the per-search cap without overlap', async () => {
        const members = seedPersonalCollection(150);
        const request = { collections_filter: [`u-${personalA.key}`], limit: 5 };
        const memberKeys = (from: number, to: number) => members.slice(from, to).map(item => item.key);

        const firstPage = await handleItemSearchByMetadataRequest(metadataRequest(request));
        const secondPage = await handleItemSearchByMetadataRequest(metadataRequest({ ...request, offset: 5 }));
        // Past the 100-result cap a shallow page's search takes: a deeper offset
        // widens the cap and continues the same union.
        const deepPage = await handleItemSearchByMetadataRequest(metadataRequest({ ...request, offset: 120 }));
        const firstPageAgain = await handleItemSearchByMetadataRequest(metadataRequest(request));

        expect(returnedKeys(firstPage)).toEqual(memberKeys(0, 5));
        expect(returnedKeys(secondPage)).toEqual(memberKeys(5, 10));
        expect(returnedKeys(deepPage)).toEqual(memberKeys(120, 125));
        expect(returnedKeys(firstPageAgain)).toEqual(returnedKeys(firstPage));
        // Consecutive pages are disjoint.
        expect(returnedKeys(firstPage).filter((key: string) => returnedKeys(secondPage).includes(key))).toEqual([]);
    });

    it('keeps the per-library limit when no collection filter is requested', async () => {
        harness.metadataResults = {
            [PERSONAL_LIBRARY]: [makeItem({ id: 1, key: 'PITEM222', libraryID: PERSONAL_LIBRARY })],
        };

        await handleItemSearchByMetadataRequest(metadataRequest({ limit: 7 }));

        expect(metadataCallFor(PERSONAL_LIBRARY)).toMatchObject({ limit: 7, collection_key: undefined });
    });

    it('keeps limit 0 unlimited, with and without a collection filter', async () => {
        harness.metadataResults = {
            [PERSONAL_LIBRARY]: [makeItem({ id: 1, key: 'PITEM222', libraryID: PERSONAL_LIBRARY, collections: [personalA.id] })],
        };

        await handleItemSearchByMetadataRequest(metadataRequest({ limit: 0 }));
        await handleItemSearchByMetadataRequest(
            metadataRequest({ limit: 0, collections_filter: [`u-${personalA.key}`] })
        );

        expect(metadataCallsFor(PERSONAL_LIBRARY).map((options: any) => options.limit)).toEqual([0, 0]);
    });

    it('warns about the search cap only when a collection filter is applied', async () => {
        // A page-sized search that fills its page is not a truncated one.
        harness.metadataResults = {
            [PERSONAL_LIBRARY]: [
                makeItem({ id: 1, key: 'PITEM222', libraryID: PERSONAL_LIBRARY, title: 'A' }),
                makeItem({ id: 2, key: 'PITEM333', libraryID: PERSONAL_LIBRARY, title: 'B' }),
            ],
        };
        await handleItemSearchByMetadataRequest(metadataRequest({ limit: 2 }));
        expect(capWarnings()).toEqual([]);

        seedPersonalCollection(150);
        await handleItemSearchByMetadataRequest(
            metadataRequest({ collections_filter: [`u-${personalA.key}`], limit: 5 })
        );
        expect(capWarnings()).toHaveLength(1);
    });

    it('applies a collection filter inside libraries_filter and rejects one outside it', async () => {
        harness.metadataResults = {
            [PERSONAL_LIBRARY]: [makeItem({ id: 1, key: 'PITEM222', libraryID: PERSONAL_LIBRARY, collections: [personalA.id] })],
            [GROUP_LIBRARY]: [makeItem({ id: 2, key: 'GITEM222', libraryID: GROUP_LIBRARY, collections: [groupA.id] })],
        };

        const conflict = await handleItemSearchByMetadataRequest(
            metadataRequest({ libraries_filter: ['u'], collections_filter: [`g12345-${groupA.key}`] })
        );

        expect(searchItemsByMetadata).not.toHaveBeenCalled();
        expect(conflict.error_code).toBe('invalid_request');
        expect(conflict.error).toContain(`g12345-${groupA.key}`);
        expect(conflict.error).toContain('My Library');
        // The conflicting library may be one the user excluded; it is never named.
        expect(conflict.error).not.toContain('Group A');

        const scoped = await handleItemSearchByMetadataRequest(
            metadataRequest({ libraries_filter: ['u'], collections_filter: [`u-${personalA.key}`] })
        );

        expect(returnedKeys(scoped)).toEqual(['PITEM222']);
        expect(metadataCallFor(PERSONAL_LIBRARY)).toMatchObject({ collection_key: personalA.key });
        expect(metadataCallFor(GROUP_LIBRARY)).toBeUndefined();
    });
});

describe('handleItemSearchByTopicRequest collection filters', () => {
    it('matches collection membership by library and key', async () => {
        makeItem({ id: 1, key: 'GITEM222', libraryID: GROUP_LIBRARY, title: 'In group', collections: [groupA.id] });
        makeItem({ id: 2, key: 'PITEM222', libraryID: PERSONAL_LIBRARY, title: 'Same key elsewhere', collections: [personalSameKeyAsGroup.id] });
        harness.topicResults = [
            { itemId: 1, similarity: 0.9 },
            { itemId: 2, similarity: 0.8 },
        ];

        const response = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: [`g12345-${groupA.key}`] })
        );

        expect(returnedKeys(response)).toEqual(['GITEM222']);
    });

    it('never runs an unfiltered search when a filter cannot be resolved', async () => {
        makeItem({ id: 1, key: 'PITEM222', libraryID: PERSONAL_LIBRARY });
        harness.topicResults = [{ itemId: 1, similarity: 0.9 }];

        const response = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: ['No Such Collection'] })
        );

        expect(semanticSearch).not.toHaveBeenCalled();
        expect(response.items).toEqual([]);
        expect(response.error_code).toBe('collection_not_found');
    });

    it('reports ambiguous, unavailable and excluded collection filters', async () => {
        const ambiguous = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: [dupePersonal.key] })
        );
        expect(ambiguous.error_code).toBe('ambiguous_collection');

        const unavailable = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: ['g99999-ABCD2345'] })
        );
        expect(unavailable.error_code).toBe('library_unavailable');

        const notSearchable = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: [`g67890-${excluded.key}`] })
        );
        expect(notSearchable.error_code).toBe('library_not_searchable');

        const hidden = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: [excluded.key] })
        );
        expect(hidden.error_code).toBe('collection_not_found');
        expect(hidden.error).not.toContain('Group B');

        expect(semanticSearch).not.toHaveBeenCalled();
    });

    it('keeps the item inside the requested collection over its personal-library duplicate', async () => {
        // Deduplication prefers the personal library, so the filter has to run first.
        makeItem({ id: 1, key: 'GITEM222', libraryID: GROUP_LIBRARY, title: 'Shared Title', collections: [groupA.id] });
        makeItem({ id: 2, key: 'PITEM222', libraryID: PERSONAL_LIBRARY, title: 'Shared Title', collections: [] });
        harness.topicResults = [
            { itemId: 1, similarity: 0.9 },
            { itemId: 2, similarity: 0.7 },
        ];

        const response = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: [`g12345-${groupA.key}`] })
        );

        expect(returnedKeys(response)).toEqual(['GITEM222']);
        expect(response.items[0].similarity).toBe(0.9);
    });

    it('still deduplicates to the personal-library copy when both survive the filter', async () => {
        makeItem({ id: 1, key: 'GITEM222', libraryID: GROUP_LIBRARY, title: 'Shared Title', collections: [groupA.id] });
        makeItem({ id: 2, key: 'PITEM222', libraryID: PERSONAL_LIBRARY, title: 'Shared Title', collections: [personalA.id] });
        harness.topicResults = [
            { itemId: 1, similarity: 0.9 },
            { itemId: 2, similarity: 0.7 },
        ];

        const response = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: [`g12345-${groupA.key}`, `u-${personalA.key}`] })
        );

        expect(returnedKeys(response)).toEqual(['PITEM222']);
    });

    it('returns similarities in non-increasing order when dedup drops a higher-scoring duplicate', async () => {
        // Deduplication keeps the personal-library copy but at the group copy's
        // position, so its lower similarity would otherwise be ranked first.
        makeItem({ id: 1, key: 'GITEM222', libraryID: GROUP_LIBRARY, title: 'Shared Title', collections: [groupA.id] });
        makeItem({ id: 2, key: 'POTHER22', libraryID: PERSONAL_LIBRARY, title: 'Other Title', collections: [personalA.id] });
        makeItem({ id: 3, key: 'PITEM222', libraryID: PERSONAL_LIBRARY, title: 'Shared Title', collections: [personalA.id] });
        harness.topicResults = [
            { itemId: 1, similarity: 0.9 },
            { itemId: 2, similarity: 0.8 },
            { itemId: 3, similarity: 0.7 },
        ];

        const response = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: [`g12345-${groupA.key}`, `u-${personalA.key}`] })
        );

        expect(returnedKeys(response)).toEqual(['POTHER22', 'PITEM222']);
        const similarities = response.items.map(entry => entry.similarity);
        expect(similarities).toEqual([0.8, 0.7]);
        for (let i = 1; i < similarities.length; i++) {
            expect(similarities[i - 1]).toBeGreaterThanOrEqual(similarities[i] as number);
        }
    });

    it('runs one search and walks the ranking in windows when matches lie deep', async () => {
        // Only items 301-320 are in the requested collection, past the first
        // 200-candidate window.
        harness.topicResults = Array.from({ length: 500 }, (_, index) => {
            const id = index + 1;
            makeItem({
                id,
                key: itemKey(id),
                libraryID: PERSONAL_LIBRARY,
                title: `Topic item ${id}`,
                collections: id > 300 && id <= 320 ? [personalA.id] : [],
            });
            return { itemId: id, similarity: 1 - index / 10000 };
        });

        const response = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: [`u-${personalA.key}`], limit: 5 })
        );

        expect(response.items).toHaveLength(5);
        // One search, asked for a ranking deep enough to reach the matches.
        expect(semanticSearch.mock.calls.map(call => call[1].topK)).toEqual([500]);
        // Items are loaded a window at a time, stopping once the page is full.
        expect((Zotero as any).Items.getAsync).toHaveBeenCalledTimes(2);
    });

    it('runs one search even when the filter matches nothing', async () => {
        harness.topicResults = Array.from({ length: 500 }, (_, index) => {
            const id = index + 1;
            makeItem({ id, key: itemKey(id), libraryID: PERSONAL_LIBRARY, title: `Topic item ${id}` });
            return { itemId: id, similarity: 1 - index / 10000 };
        });

        const response = await handleItemSearchByTopicRequest(
            topicRequest({ collections_filter: [`u-${personalA.key}`], limit: 5 })
        );

        expect(response.items).toEqual([]);
        expect(semanticSearch).toHaveBeenCalledTimes(1);
    });

    it('asks only for a page-sized ranking without a collection filter', async () => {
        harness.topicResults = Array.from({ length: 200 }, (_, index) => {
            const id = index + 1;
            makeItem({ id, key: itemKey(id), libraryID: PERSONAL_LIBRARY, title: `Topic item ${id}`, deleted: true });
            return { itemId: id, similarity: 1 - index / 1000 };
        });

        const response = await handleItemSearchByTopicRequest(topicRequest({ limit: 5 }));

        expect(response.items).toEqual([]);
        expect(semanticSearch.mock.calls.map(call => call[1].topK)).toEqual([20]);
        // A page-sized ranking is one page-sized window.
        expect((Zotero as any).Items.getAsync).toHaveBeenCalledTimes(1);
    });

    it('reports a failed semantic search instead of an empty result', async () => {
        semanticSearch.mockRejectedValueOnce(new Error('embeddings unavailable'));

        const response = await handleItemSearchByTopicRequest(topicRequest({ limit: 5 }));

        expect(response.items).toEqual([]);
        expect(response.error_code).toBe('internal_error');
        expect(response.error).toContain('embeddings unavailable');
    });
});
