import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// =============================================================================
// Module mocks — only the transport is stubbed; the store itself is pure.
// =============================================================================

const getPaginatedThreadsMock = vi.fn();
const searchThreadsMock = vi.fn();
const getStarredThreadsMock = vi.fn();
const starThreadMock = vi.fn();
const unstarThreadMock = vi.fn();
const findThreadsByItemMock = vi.fn();

vi.mock('@beaver/agent-core/transport/threadService', () => ({
    threadService: {
        getPaginatedThreads: (...a: unknown[]) => getPaginatedThreadsMock(...a),
        searchThreads: (...a: unknown[]) => searchThreadsMock(...a),
        getStarredThreads: (...a: unknown[]) => getStarredThreadsMock(...a),
        starThread: (...a: unknown[]) => starThreadMock(...a),
        unstarThread: (...a: unknown[]) => unstarThreadMock(...a),
        findThreadsByItem: (...a: unknown[]) => findThreadsByItemMock(...a),
    },
    isThreadAgentMismatch: () => false,
}));

import {
    threadEntitiesAtom,
    threadViewsAtom,
    threadViewKey,
    resolveThreadView,
    selectPinnedThreads,
    loadThreadPageAtom,
    loadPinnedThreadsAtom,
    loadMoreThreadsAtom,
    loadThreadsByItemAtom,
    setThreadPinnedAtom,
    updateThreadAtom,
    upsertThreadsAtom,
    removeThreadAtom,
    resetThreadStoreAtom,
    pinsPendingAtom,
    isPinPending,
    PIN_LOCK_TTL_MS,
    threadStoreGenerationAtom,
    threadWriteStampAtom,
    currentThreadPinnedAtom,
    MAX_PINNED,
    EMPTY_THREAD_VIEW,
} from '../../../react/atoms/threadList';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import type { ThreadData } from '../../../react/atoms/threads';

/** A backend row (snake_case wire shape). */
const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: `Chat ${id}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    starred: false,
    ...overrides,
});

const page = (rows: unknown[], overrides: Record<string, unknown> = {}) => ({
    data: rows,
    next_cursor: null,
    has_more: false,
    total: rows.length,
    other_instance_count: null,
    ...overrides,
});

/** A UI-shape thread, for seeding the entity map directly. */
const entity = (id: string, overrides: Partial<ThreadData> = {}): ThreadData => ({
    id,
    name: `Chat ${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    isPinned: false,
    ...overrides,
});

let keySeq = 0;
/**
 * A fresh view key per test. `inFlight` is module-global, so sharing one key
 * across tests would let a request left pending by an earlier test silently
 * skip a later test's load instead of failing loudly.
 */
const nextKey = () => `user-1|test-${++keySeq}||scoped::`;

const gen = (store: ReturnType<typeof createStore>) => store.get(threadStoreGenerationAtom);

beforeEach(() => {
    vi.clearAllMocks();
});

describe('threadViewKey', () => {
    it('separates views that ask different questions or use a different scope', () => {
        const base = { userId: 'u1', showAll: false, scope: { zoteroUserId: '1', zoteroLocalId: 'A' } };
        const plain = threadViewKey(base);

        expect(threadViewKey({ ...base, query: 'draft' })).not.toBe(plain);
        expect(threadViewKey({ ...base, showAll: true })).not.toBe(plain);
        expect(threadViewKey({ ...base, scope: { zoteroUserId: '2', zoteroLocalId: 'B' } })).not.toBe(plain);
        expect(threadViewKey(base)).toBe(plain);
    });

    it('ignores the instance scope for an item-filtered view, which is fetched unscoped', () => {
        const filter = { libraryId: 1, keys: ['K1'], label: 'x', itemType: 'book' } as never;
        const scoped = threadViewKey({ userId: 'u1', showAll: false, scope: { zoteroUserId: '1', zoteroLocalId: 'A' }, filter });
        const all = threadViewKey({ userId: 'u1', showAll: true, filter });
        // Toggling "show all profiles" must not fork the key, or the list blanks
        // and refetches the rows it is already holding.
        expect(scoped).toBe(all);
    });
});

describe('entity writes', () => {
    it('updateThreadAtom no-ops on a thread that is not loaded', () => {
        const store = createStore();
        store.set(updateThreadAtom, { id: 'missing', update: t => ({ ...t, isPinned: true }) });
        expect(store.get(threadEntitiesAtom).size).toBe(0);
    });

    it('removeThreadAtom drops the entity, and views stop resolving its id', () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { stamp: { generation: 0, pinSeq: 0 }, threads: [
            entity('a', { updatedAt: '2026-01-02T00:00:00Z' }),
            entity('b', { updatedAt: '2026-01-01T00:00:00Z' }),
        ] });
        store.set(removeThreadAtom, 'a');

        const rows = resolveThreadView({ ...EMPTY_THREAD_VIEW, ids: ['a', 'b'] }, store.get(threadEntitiesAtom));
        expect(rows.map(r => r.id)).toEqual(['b']);
    });

    it('resetThreadStoreAtom forgets everything, so no account inherits another\'s chats', async () => {
        const store = createStore();
        const key = nextKey();
        getPaginatedThreadsMock.mockResolvedValue(page([row('a')]));
        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });

        store.set(resetThreadStoreAtom);

        expect(store.get(threadEntitiesAtom).size).toBe(0);
        expect(store.get(threadViewsAtom).size).toBe(0);
    });
});

describe('the pinned group is derived from entities, not from a view window', () => {
    it('includes a chat pinned from a search that the plain view never loaded', async () => {
        const store = createStore();
        const baseKey = nextKey();
        const searchKey = nextKey();

        // The plain view's window holds only recent chats.
        getPaginatedThreadsMock.mockResolvedValue(page([row('recent')]));
        getStarredThreadsMock.mockResolvedValue([]);
        await store.set(loadThreadPageAtom, { key: baseKey, query: '', includeOtherCount: false });
        await store.set(loadPinnedThreadsAtom, { key: baseKey });

        // A search reaches an old chat and the user pins it.
        searchThreadsMock.mockResolvedValue(page([row('old', { updated_at: '2025-01-01T00:00:00Z' })]));
        await store.set(loadThreadPageAtom, { key: searchKey, query: 'old', includeOtherCount: false });
        starThreadMock.mockResolvedValue({});
        await store.set(setThreadPinnedAtom, { threadId: 'old', pinned: true });

        // Back on the plain view — whose window still does not contain it — the
        // pinned group must show it anyway.
        const pinned = selectPinnedThreads(store.get(threadEntitiesAtom), undefined);
        expect(pinned.map(p => p.id)).toEqual(['old']);
        expect(store.get(threadViewsAtom).get(baseKey)!.ids).not.toContain('old');
    });

    it('excludes chats from another Zotero profile when the caller is scoped', () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { stamp: { generation: 0, pinSeq: 0 }, threads: [
            entity('mine', { isPinned: true, zoteroLocalId: 'ME' }),
            entity('theirs', { isPinned: true, zoteroLocalId: 'THEM' }),
        ] });

        const scope = { zoteroUserId: null, zoteroLocalId: 'ME' };
        expect(selectPinnedThreads(store.get(threadEntitiesAtom), scope).map(p => p.id)).toEqual(['mine']);
        // Undefined scope is "all profiles": nothing is foreign.
        expect(selectPinnedThreads(store.get(threadEntitiesAtom), undefined).map(p => p.id).sort()).toEqual(['mine', 'theirs']);
    });

    it('sorts newest first regardless of discovery order', () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { stamp: { generation: 0, pinSeq: 0 }, threads: [
            entity('old', { isPinned: true, updatedAt: '2025-01-01T00:00:00Z' }),
            entity('new', { isPinned: true, updatedAt: '2026-01-01T00:00:00Z' }),
        ] });
        expect(selectPinnedThreads(store.get(threadEntitiesAtom), undefined).map(p => p.id)).toEqual(['new', 'old']);
    });
});

describe('a view id set is a window, and a first page re-establishes it', () => {
    it('drops a row the query no longer returns', async () => {
        const store = createStore();
        const key = nextKey();
        getPaginatedThreadsMock
            .mockResolvedValueOnce(page([row('a'), row('gone')]))
            .mockResolvedValueOnce(page([row('a')]));

        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });
        expect(store.get(threadViewsAtom).get(key)!.ids).toEqual(['a', 'gone']);

        // A chat deleted on another device, or one that no longer matches a
        // re-run search, must not survive the refresh.
        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false, force: true });
        expect(store.get(threadViewsAtom).get(key)!.ids).toEqual(['a']);
    });

    it('resets the cursor with the window, so "show more" cannot go dead', async () => {
        const store = createStore();
        const key = nextKey();
        getPaginatedThreadsMock
            .mockResolvedValueOnce(page([row('a')], { next_cursor: 'c1', has_more: true }))
            .mockResolvedValueOnce(page([row('b')], { next_cursor: 'c2', has_more: true }))
            .mockResolvedValueOnce(page([row('a')], { next_cursor: 'c1', has_more: true }));

        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });
        await store.set(loadMoreThreadsAtom, { key, query: '' });
        expect(store.get(threadViewsAtom).get(key)!.ids).toEqual(['a', 'b']);
        expect(store.get(threadViewsAtom).get(key)!.cursor).toBe('c2');

        // Refreshing page one rewinds ids and cursor together — never one
        // describing page 3 while the other describes page 1.
        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false, force: true });
        const view = store.get(threadViewsAtom).get(key)!;
        expect(view.ids).toEqual(['a']);
        expect(view.cursor).toBe('c1');
    });

    it('appends without duplicating an id a later page repeats', async () => {
        const store = createStore();
        const key = nextKey();
        getPaginatedThreadsMock
            .mockResolvedValueOnce(page([row('a'), row('b')], { next_cursor: 'b', has_more: true }))
            .mockResolvedValueOnce(page([row('b'), row('c')]));

        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });
        await store.set(loadMoreThreadsAtom, { key, query: '' });

        expect(store.get(threadViewsAtom).get(key)!.ids).toEqual(['a', 'b', 'c']);
    });

    it('keeps an unpinned chat in the window it was not part of', async () => {
        const store = createStore();
        const key = nextKey();
        getPaginatedThreadsMock.mockResolvedValue(page([row('recent')]));
        getStarredThreadsMock.mockResolvedValue([
            row('old-pin', { starred: true, updated_at: '2025-06-01T00:00:00Z' }),
        ]);
        unstarThreadMock.mockResolvedValue({});

        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });
        await store.set(loadPinnedThreadsAtom, { key });
        // The pinned query feeds entities only — the window is untouched.
        expect(store.get(threadViewsAtom).get(key)!.ids).toEqual(['recent']);

        await store.set(setThreadPinnedAtom, { threadId: 'old-pin', pinned: false, viewKey: key });

        // Unpinning must not make the row vanish from under the cursor.
        const rows = resolveThreadView(store.get(threadViewsAtom).get(key)!, store.get(threadEntitiesAtom));
        expect(rows.map(r => r.id)).toContain('old-pin');
        expect(rows.find(r => r.id === 'old-pin')!.isPinned).toBe(false);
    });
});

describe('the by-item view replaces rather than merges', () => {
    it('drops a thread that no longer references the items', async () => {
        const store = createStore();
        const key = nextKey();
        const filter = { libraryId: 1, libraryRef: 'u', keys: ['K1'], label: 'x', itemType: 'book' } as never;
        findThreadsByItemMock
            .mockResolvedValueOnce([
                { ...row('t1'), run_id: 'r1', match_type: 'citation' },
                { ...row('t2'), run_id: 'r2', match_type: 'citation' },
            ])
            .mockResolvedValueOnce([{ ...row('t1'), run_id: 'r1', match_type: 'citation' }]);

        await store.set(loadThreadsByItemAtom, { key, filter });
        expect(new Set(store.get(threadViewsAtom).get(key)!.ids)).toEqual(new Set(['t1', 't2']));

        await store.set(loadThreadsByItemAtom, { key, filter, force: true });
        // "Chats about these items" is a closed question — t2 has to leave.
        expect(store.get(threadViewsAtom).get(key)!.ids).toEqual(['t1']);
        expect(store.get(threadViewsAtom).get(key)!.hasMore).toBe(false);
    });
});

describe('view isolation and freshness', () => {
    it('applies a late response to the view that asked for it, not the current one', async () => {
        const store = createStore();
        const scopedKey = nextKey();
        const allKey = nextKey();

        let resolveUnscoped: (v: unknown) => void = () => {};
        getPaginatedThreadsMock
            .mockImplementationOnce(() => new Promise(r => { resolveUnscoped = r; }))
            .mockResolvedValueOnce(page([row('mine')]));

        const unscopedLoad = store.set(loadThreadPageAtom, { key: allKey, query: '', includeOtherCount: false });
        await store.set(loadThreadPageAtom, { key: scopedKey, query: '', includeOtherCount: true });
        resolveUnscoped(page([row('foreign')]));
        await unscopedLoad;

        expect(store.get(threadViewsAtom).get(scopedKey)!.ids).toEqual(['mine']);
        expect(store.get(threadViewsAtom).get(allKey)!.ids).toEqual(['foreign']);
    });

    it('serves a fresh view without refetching, and refetches when forced', async () => {
        const store = createStore();
        const key = nextKey();
        getPaginatedThreadsMock.mockResolvedValue(page([row('a')]));

        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });
        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });
        expect(getPaginatedThreadsMock).toHaveBeenCalledTimes(1);

        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false, force: true });
        expect(getPaginatedThreadsMock).toHaveBeenCalledTimes(2);
    });

    it('does not let a page load refresh the pinned query\'s own freshness window', async () => {
        const store = createStore();
        const key = nextKey();
        getPaginatedThreadsMock.mockResolvedValue(page([row('a')]));
        getStarredThreadsMock.mockResolvedValue([]);

        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });
        await store.set(loadPinnedThreadsAtom, { key });
        expect(getStarredThreadsMock).toHaveBeenCalledTimes(1);

        // Age the pinned query past its TTL while leaving the page's `loadedAt`
        // current. Sharing one timestamp let the page loader keep the pinned
        // query from ever re-running; separate ones must not.
        const aged = store.get(threadViewsAtom).get(key)!;
        store.set(threadViewsAtom, new Map(store.get(threadViewsAtom)).set(key, {
            ...aged,
            pinnedLoadedAt: Date.now() - 120_000,
            loadedAt: Date.now(),
        }));

        await store.set(loadPinnedThreadsAtom, { key });
        expect(getStarredThreadsMock).toHaveBeenCalledTimes(2);
    });
});

describe('setThreadPinnedAtom', () => {
    it('applies the change before the request resolves', async () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { threads: [entity('a')], stamp: { generation: 0, pinSeq: 0 } });
        let resolveStar: (v: unknown) => void = () => {};
        starThreadMock.mockImplementationOnce(() => new Promise(r => { resolveStar = r; }));

        const pending = store.set(setThreadPinnedAtom, { threadId: 'a', pinned: true });
        // Optimistic: true while the request is still outstanding.
        expect(store.get(threadEntitiesAtom).get('a')!.isPinned).toBe(true);

        resolveStar({});
        expect(await pending).toBe(true);
        expect(store.get(threadEntitiesAtom).get('a')!.isPinned).toBe(true);
    });

    it('refuses a second toggle for the same chat while one is in flight', async () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { threads: [entity('a')], stamp: { generation: 0, pinSeq: 0 } });
        let resolveStar: (v: unknown) => void = () => {};
        starThreadMock.mockImplementationOnce(() => new Promise(r => { resolveStar = r; }));

        const first = store.set(setThreadPinnedAtom, { threadId: 'a', pinned: true });
        expect(isPinPending(store.get(pinsPendingAtom), 'a')).toBe(true);

        // The row's pin button and the header menu both target the same chat;
        // two PATCHes racing would have no ordering guarantee.
        const second = await store.set(setThreadPinnedAtom, { threadId: 'a', pinned: false });
        expect(second).toBe(false);
        expect(starThreadMock).toHaveBeenCalledTimes(1);
        expect(unstarThreadMock).not.toHaveBeenCalled();
        expect(store.get(threadEntitiesAtom).get('a')!.isPinned).toBe(true);

        resolveStar({});
        await first;
        // The slot drains, so the chat can be toggled again.
        expect(isPinPending(store.get(pinsPendingAtom), 'a')).toBe(false);
    });

    it('ignores a lock whose owning window is gone, instead of disabling the chat forever', async () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { threads: [entity('a')], stamp: { generation: 0, pinSeq: 0 } });
        // A claim left behind by a window that closed mid-request: its promise
        // continuation and its deadline both died with that realm, so nothing
        // will ever remove this entry.
        store.set(pinsPendingAtom, new Map([['a', { claimedAt: Date.now() - PIN_LOCK_TTL_MS - 1, token: -1 }]]));
        starThreadMock.mockResolvedValue({});

        expect(isPinPending(store.get(pinsPendingAtom), 'a')).toBe(false);
        expect(await store.set(setThreadPinnedAtom, { threadId: 'a', pinned: true })).toBe(true);
        expect(store.get(threadEntitiesAtom).get('a')!.isPinned).toBe(true);
    });

    it('sweeps expired locks when a new one is claimed, and keeps live ones', async () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { threads: [entity('a')], stamp: { generation: 0, pinSeq: 0 } });
        store.set(pinsPendingAtom, new Map([
            ['stale', { claimedAt: Date.now() - PIN_LOCK_TTL_MS - 1, token: -1 }],
            ['live', { claimedAt: Date.now(), token: -2 }],
        ]));
        starThreadMock.mockResolvedValue({});

        await store.set(setThreadPinnedAtom, { threadId: 'a', pinned: true });

        // Otherwise an abandoned entry sits in the app-lifetime store for the
        // rest of the session…
        expect(store.get(pinsPendingAtom).has('stale')).toBe(false);
        // …but a sweep that took live locks with it would free chats whose
        // requests are still outstanding.
        expect(store.get(pinsPendingAtom).has('live')).toBe(true);
    });

    it('does not roll back or release once its lock has been taken over', async () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { threads: [entity('x')], stamp: { generation: 0, pinSeq: 0 } });

        // A toggle whose window closed: it never settles on its own.
        let rejectAbandoned: (e: unknown) => void = () => {};
        starThreadMock.mockImplementationOnce(() => new Promise((_, rej) => { rejectAbandoned = rej; }));
        const abandoned = store.set(setThreadPinnedAtom, { threadId: 'x', pinned: true });

        // Its lock ages out…
        const pins = store.get(pinsPendingAtom);
        store.set(pinsPendingAtom, new Map([
            ['x', { ...pins.get('x')!, claimedAt: Date.now() - PIN_LOCK_TTL_MS - 1 }],
        ]));

        // …a second toggle runs to completion, releasing its own lock…
        unstarThreadMock.mockResolvedValue({});
        await store.set(setThreadPinnedAtom, { threadId: 'x', pinned: false });

        // …and a third takes the chat over and is left IN FLIGHT. Three toggles
        // are needed, not two: the abandoned call pinned, so its rollback would
        // write `false` — with only one intervening toggle the chat would
        // already be `false` and the assertion below could not tell a fired
        // rollback from a skipped one. This third one puts the chat back to
        // `true` *and* leaves a lock under a different token, so the entity
        // assertion covers the `catch` guard and the lock assertion covers the
        // `finally` guard.
        let resolveTakeover: (v: unknown) => void = () => {};
        starThreadMock.mockImplementationOnce(() => new Promise(r => { resolveTakeover = r; }));
        const takeover = store.set(setThreadPinnedAtom, { threadId: 'x', pinned: true });
        expect(store.get(threadEntitiesAtom).get('x')!.isPinned).toBe(true);

        // The abandoned request finally errors. It must neither invert what the
        // takeover optimistically wrote, nor release the takeover's lock.
        rejectAbandoned(new Error('window closed'));
        await abandoned;

        expect(store.get(threadEntitiesAtom).get('x')!.isPinned).toBe(true);
        expect(isPinPending(store.get(pinsPendingAtom), 'x')).toBe(true);

        // And the takeover still owns its lock well enough to release it.
        resolveTakeover({});
        await takeover;
        expect(isPinPending(store.get(pinsPendingAtom), 'x')).toBe(false);
    });

    it('rolls back when the backend rejects', async () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { threads: [entity('a')], stamp: { generation: 0, pinSeq: 0 } });
        starThreadMock.mockRejectedValue(new Error('boom'));

        expect(await store.set(setThreadPinnedAtom, { threadId: 'a', pinned: true })).toBe(false);
        expect(store.get(threadEntitiesAtom).get('a')!.isPinned).toBe(false);
    });

    it('does not resurrect a chat deleted while the request was in flight', async () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { threads: [entity('a', { isPinned: true })], stamp: { generation: 0, pinSeq: 0 } });
        let rejectUnstar: (e: unknown) => void = () => {};
        unstarThreadMock.mockImplementationOnce(() => new Promise((_, rej) => { rejectUnstar = rej; }));

        const pending = store.set(setThreadPinnedAtom, { threadId: 'a', pinned: false });
        store.set(removeThreadAtom, 'a');
        rejectUnstar(new Error('boom'));
        await pending;

        expect(store.get(threadEntitiesAtom).has('a')).toBe(false);
    });
});

describe('the store belongs to one account', () => {
    it('drops a response that was in flight when the store was reset', async () => {
        const store = createStore();
        const key = nextKey();
        let resolvePage: (v: unknown) => void = () => {};
        getPaginatedThreadsMock.mockImplementationOnce(() => new Promise(r => { resolvePage = r; }));

        const pending = store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });
        // Sign-out mid-request.
        store.set(resetThreadStoreAtom);
        resolvePage(page([row('a', { starred: true })]));
        await pending;

        // Nothing may come back: the pinned group scans every entity, so a
        // survivor here would render to whoever signs in next.
        expect(store.get(threadEntitiesAtom).size).toBe(0);
        expect(store.get(threadViewsAtom).size).toBe(0);
    });

    it('drops an upsert stamped with a superseded generation', () => {
        const store = createStore();
        const stale = gen(store);
        store.set(resetThreadStoreAtom);

        store.set(upsertThreadsAtom, { threads: [entity('a')], stamp: { generation: stale, pinSeq: 0 } });
        expect(store.get(threadEntitiesAtom).size).toBe(0);

        store.set(upsertThreadsAtom, { threads: [entity('a')], stamp: store.get(threadWriteStampAtom) });
        expect(store.get(threadEntitiesAtom).size).toBe(1);
    });
});

describe('the pinned query reconciles what it is authoritative about', () => {
    it('clears a flag for a chat unpinned on another device', async () => {
        const store = createStore();
        const key = nextKey();
        store.set(upsertThreadsAtom, {
            threads: [entity('gone', { isPinned: true }), entity('still', { isPinned: true })],
            stamp: { generation: 0, pinSeq: 0 },
        });
        // The server now reports only one of them as pinned.
        getStarredThreadsMock.mockResolvedValue([row('still', { starred: true })]);

        await store.set(loadPinnedThreadsAtom, { key });

        expect(store.get(threadEntitiesAtom).get('gone')!.isPinned).toBe(false);
        expect(store.get(threadEntitiesAtom).get('still')!.isPinned).toBe(true);
    });

    it('leaves another profile\'s pinned chats alone when the query was scoped', async () => {
        const store = createStore();
        const key = nextKey();
        store.set(upsertThreadsAtom, {
            threads: [entity('theirs', { isPinned: true, zoteroLocalId: 'THEM' })],
            stamp: { generation: 0, pinSeq: 0 },
        });
        getStarredThreadsMock.mockResolvedValue([]);

        // A scoped response says nothing about chats outside its scope.
        await store.set(loadPinnedThreadsAtom, {
            key,
            scope: { zoteroUserId: null, zoteroLocalId: 'ME' },
        });

        expect(store.get(threadEntitiesAtom).get('theirs')!.isPinned).toBe(true);
    });

    it('does not reconcile a truncated response', async () => {
        const store = createStore();
        const key = nextKey();
        store.set(upsertThreadsAtom, { threads: [entity('beyond-cap', { isPinned: true })], stamp: { generation: 0, pinSeq: 0 } });
        // A full page means the absentees may just be past the cap.
        getStarredThreadsMock.mockResolvedValue(
            Array.from({ length: MAX_PINNED }, (_, i) => row(`p${i}`, { starred: true }))
        );

        await store.set(loadPinnedThreadsAtom, { key });

        expect(store.get(threadEntitiesAtom).get('beyond-cap')!.isPinned).toBe(true);
    });

    it('does not undo an UNPIN the user made while the query was in flight', async () => {
        const store = createStore();
        const key = nextKey();
        store.set(upsertThreadsAtom, {
            threads: [entity('x', { isPinned: true })],
            stamp: { generation: 0, pinSeq: 0 },
        });
        let resolveStarred: (v: unknown) => void = () => {};
        getStarredThreadsMock.mockImplementationOnce(() => new Promise(r => { resolveStarred = r; }));
        unstarThreadMock.mockResolvedValue({});

        const pending = store.set(loadPinnedThreadsAtom, { key });
        // The user unpins X after the request went out, so the response still
        // reports X as pinned. The upsert must not write that flag back.
        await store.set(setThreadPinnedAtom, { threadId: 'x', pinned: false });
        resolveStarred([row('x', { starred: true })]);
        await pending;

        expect(store.get(threadEntitiesAtom).get('x')!.isPinned).toBe(false);
    });

    it('does not undo a pin the user made while the query was in flight', async () => {
        const store = createStore();
        const key = nextKey();
        store.set(upsertThreadsAtom, { threads: [entity('x')], stamp: { generation: 0, pinSeq: 0 } });
        let resolveStarred: (v: unknown) => void = () => {};
        getStarredThreadsMock.mockImplementationOnce(() => new Promise(r => { resolveStarred = r; }));
        starThreadMock.mockResolvedValue({});

        const pending = store.set(loadPinnedThreadsAtom, { key });
        // The user pins X after the request went out, so the response predates it.
        await store.set(setThreadPinnedAtom, { threadId: 'x', pinned: true });
        resolveStarred([]);
        await pending;

        expect(store.get(threadEntitiesAtom).get('x')!.isPinned).toBe(true);
    });
});

describe('page requests are serialized per view', () => {
    it('does not let a first page replace a window while "show more" is in flight', async () => {
        const store = createStore();
        const key = nextKey();
        getPaginatedThreadsMock.mockResolvedValueOnce(page([row('a')], { next_cursor: 'c1', has_more: true }));
        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });

        let resolveMore: (v: unknown) => void = () => {};
        getPaginatedThreadsMock.mockImplementationOnce(() => new Promise(r => { resolveMore = r; }));
        const morePending = store.set(loadMoreThreadsAtom, { key, query: '' });

        // A forced reload while page 2 is outstanding must be refused, not race it.
        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false, force: true });
        expect(getPaginatedThreadsMock).toHaveBeenCalledTimes(2);

        resolveMore(page([row('b')]));
        await morePending;
        expect(store.get(threadViewsAtom).get(key)!.ids).toEqual(['a', 'b']);
    });
});

describe('in-flight slots are owned by the request that claimed them', () => {
    it('does not let a pre-reset request release a slot claimed after the reset', async () => {
        const store = createStore();
        const key = nextKey();

        let resolveFirst: (v: unknown) => void = () => {};
        getPaginatedThreadsMock.mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }));
        const first = store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });

        // Sign-out clears the set; signing back in as the same user reissues the
        // identical key, so the two requests' slot strings collide.
        store.set(resetThreadStoreAtom);
        let resolveSecond: (v: unknown) => void = () => {};
        getPaginatedThreadsMock.mockImplementationOnce(() => new Promise(r => { resolveSecond = r; }));
        const second = store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false });

        resolveFirst(page([]));
        await first;

        // The second request still holds the slot, so a third load is refused
        // rather than racing it.
        await store.set(loadThreadPageAtom, { key, query: '', includeOtherCount: false, force: true });
        expect(getPaginatedThreadsMock).toHaveBeenCalledTimes(2);

        resolveSecond(page([row('a')]));
        await second;
        expect(store.get(threadViewsAtom).get(key)!.ids).toEqual(['a']);
    });
});

describe('currentThreadPinnedAtom', () => {
    it('is null with no open chat, and null when the open chat is not loaded', () => {
        const store = createStore();
        expect(store.get(currentThreadPinnedAtom)).toBeNull();

        store.set(currentThreadIdAtom, 'unknown');
        expect(store.get(currentThreadPinnedAtom)).toBeNull();
    });

    it('tracks the entity, so it cannot disagree with the lists', () => {
        const store = createStore();
        store.set(upsertThreadsAtom, { threads: [entity('t1', { isPinned: true })], stamp: { generation: 0, pinSeq: 0 } });
        store.set(currentThreadIdAtom, 't1');
        expect(store.get(currentThreadPinnedAtom)).toBe(true);

        store.set(updateThreadAtom, { id: 't1', update: t => ({ ...t, isPinned: false }) });
        expect(store.get(currentThreadPinnedAtom)).toBe(false);
    });
});
