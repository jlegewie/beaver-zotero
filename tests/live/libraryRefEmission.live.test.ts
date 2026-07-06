/**
 * Live tests asserting that `library_ref` is emitted through every production
 * data-provider handler and serializer the identity change touched, for both
 * personal ("u") and group ("g<groupID>") items. This is the regression net for
 * Phase 1: `libraryRefForLibraryID()` is now injected into ~40 serializer/funnel
 * sites, and these tests confirm the funnels still produce correct output and
 * stamp the portable ref.
 *
 * Handlers covered: /beaver/library/libraries, /library/list, /library/search,
 * /library/metadata, /library/collections, /library/find-annotations, and
 * /beaver/zotero-data (serializeItem / serializeAttachment).
 *
 * Prerequisites: dev build running + authenticated. Group-library assertions
 * skip automatically when no group library is present.
 * Run: npm run test:live -- libraryRefEmission
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import {
    getLibraryTopology,
    firstItemKey,
    firstItemId,
    type LibraryTopology,
} from '../helpers/libraryTopology';

interface ItemRow { item_id: string; library_ref?: string; result_type?: string }
interface ListResponse { items: ItemRow[]; error?: string | null; library_name?: string }
interface SearchResponse { items: ItemRow[]; total_count: number; error?: string | null }
interface MetadataResponse { items: Array<{ item_id: string; library_ref?: string }>; error?: string | null }
interface CollectionsResponse {
    collections: Array<{ collection_key: string; library_ref?: string | null; library_id?: number }>;
    error?: string | null;
}
interface AnnotationsResponse {
    annotations: Array<{ annotation_id: string; library_ref?: string }>;
    total_count: number;
    error?: string | null;
}
interface ZoteroDataResponse {
    items: Array<{ item: { library_ref?: string; library_id?: number } }>;
    attachments: Array<{ attachment: { library_ref?: string; library_id?: number } }>;
    errors?: unknown[];
}

let available: boolean;
let topo: LibraryTopology;
let personalKey: string | null = null;
let groupItemId: string | null = null;

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) {
        console.warn('\n⚠  Zotero not available — libraryRefEmission live tests will be skipped.\n');
        return;
    }
    topo = await getLibraryTopology();
    personalKey = await firstItemKey(topo.personal.library_id);
    if (topo.group) groupItemId = await firstItemId(topo.group.library_id);
});

describe('/beaver/library/libraries', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('emits "u" for the personal library and a "g<id>" ref for every group', async () => {
        const res = await post<{ libraries: LibraryTopology['personal'][] }>('/beaver/library/libraries', {});
        for (const lib of res.libraries) {
            if (lib.is_group) {
                expect(lib.library_ref).toMatch(/^g[1-9][0-9]*$/);
            } else {
                expect(lib.library_ref).toBe('u');
            }
        }
    });
});

describe('/beaver/library/list', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('stamps "u" on personal-library items', async () => {
        const res = await post<ListResponse>('/beaver/library/list', { library_id: topo.personal.library_id, limit: 5 });
        expect(res.error ?? null).toBeNull();
        expect(res.items.length).toBeGreaterThan(0);
        for (const item of res.items) expect(item.library_ref).toBe('u');
    });

    it('stamps the group ref on group-library items', async (ctx) => {
        if (!topo.group) return ctx.skip();
        const res = await post<ListResponse>('/beaver/library/list', { library_id: topo.group.library_id, limit: 5 });
        expect(res.error ?? null).toBeNull();
        expect(res.items.length).toBeGreaterThan(0);
        for (const item of res.items) expect(item.library_ref).toBe(topo.group.library_ref);
    });
});

describe('/beaver/library/search', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('stamps the group ref on search-result rows', async (ctx) => {
        if (!topo.group) return ctx.skip();
        const res = await post<SearchResponse>('/beaver/library/search', {
            library_id: topo.group.library_id,
            conditions: [{ field: 'title', operator: 'contains', value: 'e' }],
            limit: 5,
        });
        expect(res.error ?? null).toBeNull();
        if (res.items.length === 0) return ctx.skip();
        for (const item of res.items) expect(item.library_ref).toBe(topo.group.library_ref);
    });
});

describe('/beaver/library/metadata', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('stamps the right ref on each item across libraries', async (ctx) => {
        if (!personalKey) return ctx.skip();
        const ids = [`${topo.personal.library_id}-${personalKey}`];
        if (groupItemId) ids.push(groupItemId);
        const res = await post<MetadataResponse>('/beaver/library/metadata', { item_ids: ids });
        expect(res.error ?? null).toBeNull();
        const byId = new Map(res.items.map((it) => [it.item_id, it.library_ref]));
        expect(byId.get(`${topo.personal.library_id}-${personalKey}`)).toBe('u');
        if (groupItemId) expect(byId.get(groupItemId)).toBe(topo.group!.library_ref);
    });
});

describe('/beaver/library/collections', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('stamps the group ref on each collection row', async (ctx) => {
        if (!topo.group) return ctx.skip();
        const res = await post<CollectionsResponse>('/beaver/library/collections', { library_id: topo.group.library_id, limit: 10 });
        expect(res.error ?? null).toBeNull();
        if (res.collections.length === 0) return ctx.skip();
        for (const coll of res.collections) expect(coll.library_ref).toBe(topo.group.library_ref);
    });
});

describe('/beaver/library/find-annotations', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('stamps the group ref on annotation rows', async (ctx) => {
        if (!topo.group) return ctx.skip();
        const res = await post<AnnotationsResponse>('/beaver/library/find-annotations', { library_id: topo.group.library_id, limit: 5 });
        expect(res.error ?? null).toBeNull();
        if (res.annotations.length === 0) return ctx.skip();
        for (const ann of res.annotations) expect(ann.library_ref).toBe(topo.group.library_ref);
    });
});

describe('/beaver/zotero-data (serializeItem / serializeAttachment)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('stamps "u" on a serialized personal item', async (ctx) => {
        if (!personalKey) return ctx.skip();
        const res = await post<ZoteroDataResponse>('/beaver/zotero-data', {
            items: [{ library_id: topo.personal.library_id, zotero_key: personalKey }],
            include_attachments: true,
            include_parents: false,
        });
        // The handler omits `errors` entirely when there are none.
        expect(res.errors ?? []).toEqual([]);
        for (const w of res.items) expect(w.item.library_ref).toBe('u');
        for (const w of res.attachments) expect(w.attachment.library_ref).toBe('u');
    });

    it('stamps the group ref on a serialized group item and its attachments', async (ctx) => {
        if (!groupItemId) return ctx.skip();
        const dash = groupItemId.indexOf('-');
        const library_id = parseInt(groupItemId.slice(0, dash), 10);
        const zotero_key = groupItemId.slice(dash + 1);
        const res = await post<ZoteroDataResponse>('/beaver/zotero-data', {
            items: [{ library_id, zotero_key }],
            include_attachments: true,
            include_parents: false,
        });
        // The handler omits `errors` entirely when there are none.
        expect(res.errors ?? []).toEqual([]);
        for (const w of res.items) expect(w.item.library_ref).toBe(topo.group!.library_ref);
        for (const w of res.attachments) expect(w.attachment.library_ref).toBe(topo.group!.library_ref);
    });
});
