/**
 * Collection-scoped search live suite (`/beaver/search/metadata`,
 * `/beaver/search/topic`).
 *
 * Both search paths scope `collections_filter` recursively and rank/paginate
 * inside that scope. This suite seeds hierarchies it fully controls — parent
 * collections that hold no items directly, each with a child that does — and
 * checks:
 *   - a parent-scoped search finds an item only its child holds
 *     (metadata and topic)
 *   - a full page is returned when the scope holds enough items
 *   - a page past the first offset is non-empty and does not repeat page 1
 *   - a collection filter that resolves to nothing returns nothing rather than
 *     widening to the whole library
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - The user library is searchable and holds indexed (embedded) items.
 *
 * Run with: `npm run test:live -- collectionScopeSearch`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';

const USER_LIBRARY_ID = 1;

/** Page size the pagination guards use; the scope needs more items than this. */
const PAGE_SIZE = 25;

/** Items requested for the paging hierarchy. */
const SEED_TARGET = 45;

/** Broad topic query used to find an item that has an embedding. */
const TOPIC_QUERY = 'police stops race gender';

interface SearchResultItem {
    item: { zotero_key: string; library_id: number; item_type?: string; title?: string };
    attachments: unknown[];
    similarity?: number;
}

interface SearchResponse {
    items?: SearchResultItem[];
}

interface CollectionCreateResponse {
    ok?: boolean;
    error?: string;
    collection_key: string;
    added_item_keys: string[];
}

let available = false;
/** Parent of a child holding exactly one embedded item. */
let singleParentKey: string | null = null;
/** Parent of a child holding many items, for the pagination guards. */
let pagingParentKey: string | null = null;
const createdCollectionKeys: string[] = [];
/** Items the paging scope yields, after deduplication. */
let scopedItemCount = 0;
/** An embedded item, held only by the single-item child collection. */
let embeddedKey: string | null = null;

const suffix = Math.random().toString(36).slice(2, 10);

function userLibraryItems(res: SearchResponse): SearchResultItem[] {
    return (res.items ?? []).filter((r) => r.item?.library_id === USER_LIBRARY_ID);
}

async function createCollection(
    name: string,
    options: { parentKey?: string; itemKeys?: string[]; fillRegularItems?: number } = {},
): Promise<CollectionCreateResponse> {
    const res = await post<CollectionCreateResponse>(
        '/beaver/test/collection-create',
        {
            library_id: USER_LIBRARY_ID,
            name,
            parent_key: options.parentKey,
            item_keys: options.itemKeys,
            fill_regular_items: options.fillRegularItems,
        },
        { timeout: 60_000 },
    );
    // Record the key before checking for failure: the collection exists even
    // when seeding it partially failed, and teardown has to remove it.
    if (res.collection_key) createdCollectionKeys.push(res.collection_key);
    if (!res.ok) throw new Error(`collection-create failed for "${name}": ${res.error ?? 'unknown error'}`);
    return res;
}

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) return;

    // An embedded item: only items with embeddings come back from a topic
    // search, so this guarantees the topic assertion has something to find.
    const topicRes = await post<SearchResponse>('/beaver/search/topic', {
        topic_query: TOPIC_QUERY,
        limit: 5,
    });
    // Metadata search returns regular items only, so the shared target has to
    // be one — the topic path is the looser of the two.
    embeddedKey = userLibraryItems(topicRes)
        .find((r) => r.item.item_type !== 'attachment' && r.item.item_type !== 'note')
        ?.item.zotero_key ?? null;

    if (embeddedKey) {
        const parent = await createCollection(`beaver-live-single-parent-${suffix}`);
        singleParentKey = parent.collection_key;
        await createCollection(`beaver-live-single-child-${suffix}`, {
            parentKey: singleParentKey,
            itemKeys: [embeddedKey],
        });
    }

    // Bulk regular items for the pagination guards.
    const pagingParent = await createCollection(`beaver-live-paging-parent-${suffix}`);
    pagingParentKey = pagingParent.collection_key;
    await createCollection(`beaver-live-paging-child-${suffix}`, {
        parentKey: pagingParentKey,
        fillRegularItems: SEED_TARGET,
    });

    // How many items the scope actually yields — seeded items can collapse in
    // deduplication, and the page guards below need a count they can trust.
    const scoped = await post<SearchResponse>(
        '/beaver/search/metadata',
        { collections_filter: [pagingParentKey], limit: SEED_TARGET * 2 },
        { timeout: 60_000 },
    );
    scopedItemCount = (scoped.items ?? []).length;
}, 120_000);

afterAll(async () => {
    if (createdCollectionKeys.length === 0) return;
    // Children are listed too so a partially failed setup still cleans up,
    // even though erasing a parent also erases its descendants.
    await post(
        '/beaver/test/collection-delete',
        { library_id: USER_LIBRARY_ID, collection_keys: createdCollectionKeys },
        { timeout: 60_000 },
    );
}, 60_000);

describe('collection scope includes subcollections', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('metadata search scoped to a parent returns the item only its child holds', async () => {
        expect(embeddedKey, 'an embedded item in the user library').toBeTruthy();

        const res = await post<SearchResponse>('/beaver/search/metadata', {
            collections_filter: [singleParentKey],
            limit: 5,
        });
        expect(userLibraryItems(res).map((r) => r.item.zotero_key)).toEqual([embeddedKey]);
    }, 30_000);

    it('topic search scoped to a parent returns the item only its child holds', async () => {
        expect(embeddedKey, 'an embedded item in the user library').toBeTruthy();

        const res = await post<SearchResponse>('/beaver/search/topic', {
            topic_query: TOPIC_QUERY,
            collections_filter: [singleParentKey],
            limit: 5,
        });
        expect(userLibraryItems(res).map((r) => r.item.zotero_key)).toContain(embeddedKey);
    }, 30_000);
});

describe('collection-scoped metadata pagination', () => {
    // Serializing a page of items with their attachments is the expensive part
    // of these assertions, so page 1 is fetched once and shared by both.
    let firstPage: Promise<SearchResponse> | null = null;
    const fetchPage = (offset: number) =>
        post<SearchResponse>(
            '/beaver/search/metadata',
            { collections_filter: [pagingParentKey], limit: PAGE_SIZE, offset },
            { timeout: 60_000 },
        );

    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
        if (scopedItemCount <= PAGE_SIZE) {
            ctx.skip(`user library has too few regular items (${scopedItemCount}) to fill a page`);
        }
    });

    it('returns a full page when the scope holds more items than the page size', async () => {
        firstPage ??= fetchPage(0);
        expect((await firstPage).items ?? []).toHaveLength(PAGE_SIZE);
    }, 60_000);

    it('returns a non-empty second page that does not repeat the first', async () => {
        firstPage ??= fetchPage(0);
        const [first, second] = [await firstPage, await fetchPage(PAGE_SIZE)];

        const firstKeys = new Set((first.items ?? []).map((r) => r.item.zotero_key));
        const secondKeys = (second.items ?? []).map((r) => r.item.zotero_key);
        expect(secondKeys.length).toBeGreaterThan(0);
        expect(secondKeys.filter((key) => firstKeys.has(key))).toEqual([]);
    }, 60_000);
});

describe('a collection filter that resolves to nothing narrows instead of widening', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns no items for metadata search', async () => {
        const res = await post<SearchResponse>('/beaver/search/metadata', {
            title_query: 'the',
            collections_filter: [`no-such-collection-${suffix}`],
            limit: 5,
        });
        expect(res.items ?? []).toHaveLength(0);
    }, 30_000);

    it('returns no items for topic search', async () => {
        const res = await post<SearchResponse>('/beaver/search/topic', {
            topic_query: TOPIC_QUERY,
            collections_filter: [`no-such-collection-${suffix}`],
            limit: 5,
        });
        expect(res.items ?? []).toHaveLength(0);
    }, 30_000);
});
