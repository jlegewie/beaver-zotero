import { atom } from 'jotai';
import type { Getter, Setter } from 'jotai';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { threadService, isThreadAgentMismatch } from '@beaver/agent-core/transport/threadService';
import type { ZoteroInstanceRef } from '@beaver/agent-core/transport/threadService';
import { logger } from '@beaver/agent-core/platform/logger';
import { deduplicateByThread, threadModelToThreadData } from '../utils/threadMatches';
import { isTransientNetworkError } from '../utils/isTransientNetworkError';
// Type-only: `threads.ts` imports this module's writers, so a value import here
// would close a runtime cycle between them.
import type { ThreadData } from './threads';
import type { ThreadItemFilter } from './ui';

/**
 * Thread-list state, as one normalized store rather than one array per surface.
 *
 * `pinned` is an attribute of a thread, not a collection of threads. Modelling
 * it as a second list meant two fetches, two caches and two React copies of the
 * same fact kept in step by hand — the source of every de-dup, cross-window
 * notification and rollback-ordering problem this area had.
 *
 * Instead:
 *
 * - {@link threadEntitiesAtom} holds one copy of each thread. `isPinned` lives
 *   there and nowhere else.
 * - {@link threadViewsAtom} holds, per view, only an ordered set of ids plus its
 *   paging cursor. A view never holds thread data. A view id set is a *window*
 *   over the list — what the paginated query has reached — and a first page
 *   replaces it rather than unioning into it, so rows the query no longer
 *   matches cannot accumulate with nothing able to remove them.
 * - The pinned group is **not** a view: it is
 *   {@link selectPinnedThreads}, a filter over every known entity. Membership
 *   of a window is a collection, and making the group depend on one would put
 *   back exactly the split this module exists to remove — a chat pinned from a
 *   search would not appear in the group until the window happened to reach it.
 * - Every mutation is a functional update on a single entity that **no-ops when
 *   the entity is absent**, which is what stops an optimistic rollback from
 *   resurrecting a deleted chat or dropping a live one without either case
 *   being special-cased.
 *
 * Views resolve ids through the entity map at render and drop unknown ones, so
 * deleting a chat is one entity removal; ids left behind in id sets are inert.
 */

/** One copy of each known thread, keyed by id. The only home for `isPinned`. */
export const threadEntitiesAtom = atom<Map<string, ThreadData>>(new Map());

/**
 * Bumped by {@link resetThreadStoreAtom}. Every write captures it first and is
 * dropped if it has moved on.
 *
 * Without this the reset is defeatable: a request issued for one account that
 * resolves after the sign-out repopulates the store, and because
 * {@link selectPinnedThreads} scans every entity rather than one account-keyed
 * view, those chats would then render to whoever signs in next.
 */
export const threadStoreGenerationAtom = atom(0);

/**
 * Bumped on every local pin/unpin. A request captures it when it is issued;
 * if it has moved by the time the response lands, the response's `isPinned`
 * predates the user's own click and must not be written back.
 */
export const pinMutationSeqAtom = atom(0);

/**
 * What a write has to be stamped with to be accepted: the store generation it
 * was issued under, and the pin-mutation counter at that moment.
 *
 * Read this **before** issuing a request and pass it to the write. Server rows
 * carry a whole entity including `isPinned`, so a response is stale in two
 * independent ways — the store may have been reset (wrong account), or the
 * user may have toggled a pin the response cannot know about.
 */
export interface ThreadWriteStamp {
    generation: number;
    pinSeq: number;
}

export const threadWriteStampAtom = atom<ThreadWriteStamp>((get) => ({
    generation: get(threadStoreGenerationAtom),
    pinSeq: get(pinMutationSeqAtom),
}));

export type ThreadViewStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ThreadListViewState {
    /** Ids discovered for this view, in first-seen order — render sorts. */
    ids: string[];
    /** Paging cursor from the last paginated response, if any. */
    cursor: string | null;
    hasMore: boolean;
    /**
     * Threads the instance scoping hides, as reported by the backend. Only a
     * scoped first page carries one; retained across later pages and searches.
     */
    otherInstanceCount: number | null;
    /**
     * When the pinned query last ran for this view, or 0. Separate from
     * `loadedAt`: the two queries have different lifetimes, and sharing one
     * timestamp let a page reload keep the pinned query from ever re-running.
     */
    pinnedLoadedAt: number;
    status: ThreadViewStatus;
    /** Set only for transient network failures, which offer a retry. */
    error: { offline: boolean } | null;
    /** When the view last completed a load, for the staleness check. */
    loadedAt: number;
}

/** Stable identity for a view that has never been loaded. */
export const EMPTY_THREAD_VIEW: ThreadListViewState = {
    ids: [],
    cursor: null,
    hasMore: false,
    otherInstanceCount: null,
    pinnedLoadedAt: 0,
    status: 'idle',
    error: null,
    loadedAt: 0,
};

/** Per-view id sets and paging state, keyed by {@link threadViewKey}. */
export const threadViewsAtom = atom<Map<string, ThreadListViewState>>(new Map());

export const THREAD_PAGE_SIZE = 15;
/**
 * Bounds the pinned query. The pinned group renders from each entity's own
 * flag rather than from this result, so a chat past the cap is still kept out
 * of the date groups — it is simply not discovered until a page reaches it.
 */
export const MAX_PINNED = 50;
/** How long a loaded view is served without refetching. */
export const THREAD_VIEW_TTL = 60_000;

/**
 * Identifies a view: the question it answers plus the scope it answers it in.
 *
 * Responses are applied to the key they were issued for, so one that arrives
 * after the user has moved on lands in a view nobody is showing rather than on
 * top of the current one. That is what removes the need for request-sequence
 * guards.
 *
 * The instance identity is part of the key so logging into (or out of) Zotero
 * cannot reuse a previous identity's results under the same "scoped" bucket.
 */
export function threadViewKey(params: {
    userId: string;
    query?: string;
    showAll: boolean;
    scope?: ZoteroInstanceRef | null;
    filter?: ThreadItemFilter | null;
}): string {
    const { userId, query = '', showAll, scope, filter } = params;
    if (filter) {
        // The by-item route takes no scope — that view is fetched whole and
        // partitioned client-side — so the scope must not fork its key, or
        // toggling "show all profiles" would blank the list and refetch the
        // same rows under a second key.
        return `${userId}|item:${filter.libraryId}:${filter.keys.join('+')}|${query}|unscoped`;
    }
    const scopePart = showAll
        ? 'all'
        : `scoped:${scope?.zoteroUserId ?? ''}:${scope?.zoteroLocalId ?? ''}`;
    return `${userId}||${query}|${scopePart}`;
}

// ---------------------------------------------------------------------------
// Entity writes
// ---------------------------------------------------------------------------

/**
 * Merges rows into the entity map, overwriting the stored copy of each.
 *
 * `generation` is the value of {@link threadStoreGenerationAtom} read *before*
 * the request that produced these rows. Rows from a superseded generation
 * (the store was reset meanwhile — a sign-out, an account switch) are dropped.
 */
export const upsertThreadsAtom = atom(
    null,
    (get, set, { threads, stamp }: { threads: ThreadData[]; stamp: ThreadWriteStamp }) => {
        if (threads.length === 0) return;
        if (stamp.generation !== get(threadStoreGenerationAtom)) return;

        // A pin toggled after this request went out means the rows carry an
        // older answer than the user's own click. Keep the server's data but
        // the local flag — writing the row wholesale would bounce the chat back
        // into the group it was just dragged out of, with nothing to correct it
        // (the reconciliation below this is skipped for the same reason).
        const pinsMovedSince = stamp.pinSeq !== get(pinMutationSeqAtom);
        const entities = get(threadEntitiesAtom);
        const next = new Map(entities);
        for (const thread of threads) {
            const existing = pinsMovedSince ? entities.get(thread.id) : undefined;
            next.set(thread.id, existing ? { ...thread, isPinned: existing.isPinned } : thread);
        }
        set(threadEntitiesAtom, next);
    }
);

/**
 * Applies `update` to one thread. A no-op when the thread is unknown, so a
 * caller does not have to know whether it was deleted or never loaded — which
 * is what lets an optimistic rollback be unconditional.
 */
export const updateThreadAtom = atom(
    null,
    (get, set, { id, update }: { id: string; update: (thread: ThreadData) => ThreadData }) => {
        const entities = get(threadEntitiesAtom);
        const existing = entities.get(id);
        if (!existing) return;
        const next = new Map(entities);
        next.set(id, update(existing));
        set(threadEntitiesAtom, next);
    }
);

/**
 * Forgets a thread. Ids left behind in view id sets are inert: views resolve
 * through the entity map and drop what they cannot find.
 */
export const removeThreadAtom = atom(null, (get, set, id: string) => {
    const entities = get(threadEntitiesAtom);
    if (!entities.has(id)) return;
    const next = new Map(entities);
    next.delete(id);
    set(threadEntitiesAtom, next);
});

// ---------------------------------------------------------------------------
// View writes
// ---------------------------------------------------------------------------

/**
 * Views hold only ids and a cursor, and one is created per distinct query a
 * session actually runs — so the map is small and deliberately not evicted.
 * Eviction was tried and removed: keyed on last *fetch*, it made the
 * most-used view (served from cache, so never re-stamped) the first candidate,
 * and evicting the view a mounted list is showing leaves it empty with nothing
 * to trigger a reload. The whole map is dropped on sign-out instead.
 */
function patchView(
    get: Getter,
    set: Setter,
    key: string,
    generation: number,
    patch: (view: ThreadListViewState) => ThreadListViewState
): void {
    if (generation !== get(threadStoreGenerationAtom)) return;
    const views = get(threadViewsAtom);
    const next = new Map(views);
    next.set(key, patch(views.get(key) ?? EMPTY_THREAD_VIEW));
    set(threadViewsAtom, next);
}

/** Unions ids into a view, preserving first-seen order. */
function mergeIds(existing: string[], incoming: string[]): string[] {
    if (incoming.length === 0) return existing;
    const seen = new Set(existing);
    const added = incoming.filter((id) => !seen.has(id));
    return added.length === 0 ? existing : [...existing, ...added];
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * In-flight loads, so a second mount (the separate Beaver window renders its
 * own list against this store) or a repeated retry does not duplicate a
 * request. Keyed by view plus role: a "show more" is a different request from
 * the first page of the same view.
 */
const inFlight = new Set<string>();

/**
 * Whether any page request is outstanding for a view. A first page replaces the
 * window, so running one while a "show more" is in flight would let whichever
 * lands last win — dropping the page the user just asked for.
 */
function hasPageRequestInFlight(key: string): boolean {
    for (const requestKey of inFlight) {
        if (requestKey === `${key}|page` || requestKey.startsWith(`${key}|page|`)) return true;
    }
    return false;
}

function errorFor(error: unknown): { offline: boolean } | null {
    if (!isTransientNetworkError(error)) return null;
    return { offline: typeof navigator !== 'undefined' && navigator.onLine === false };
}

interface LoadPageParams {
    key: string;
    query: string;
    scope?: ZoteroInstanceRef;
    /** Ask the backend how many threads the scoping hides (first page only). */
    includeOtherCount: boolean;
    /** Reload even when the view is still fresh. */
    force?: boolean;
}

/**
 * Loads a view's first page, or keeps the loaded one when it is still fresh.
 * Merges, so a reload never drops ids the pinned query or an earlier page found.
 */
export const loadThreadPageAtom = atom(
    null,
    async (get, set, { key, query, scope, includeOtherCount, force = false }: LoadPageParams) => {
        const stamp = get(threadWriteStampAtom);
        const generation = stamp.generation;
        const view = get(threadViewsAtom).get(key) ?? EMPTY_THREAD_VIEW;
        if (!force && view.status === 'ready' && Date.now() - view.loadedAt < THREAD_VIEW_TTL) return;

        const requestKey = `${key}|page`;
        if (hasPageRequestInFlight(key)) return;
        inFlight.add(requestKey);
        try {
            // Inside the try: a throw between claiming the slot and the `finally`
            // would strand the key, and `hasPageRequestInFlight` matches every
            // page request for the view — wedging both loaders for the session.
            patchView(get, set, key, generation, (v) => ({ ...v, status: 'loading' }));
            const response = query
                ? await threadService.searchThreads(query, THREAD_PAGE_SIZE, null, scope)
                : await threadService.getPaginatedThreads(THREAD_PAGE_SIZE, null, scope, includeOtherCount);
            const rows = response.data.map(threadModelToThreadData);
            set(upsertThreadsAtom, { threads: rows, stamp });
            patchView(get, set, key, generation, (v) => ({
                ...v,
                // Replaced, not merged: a first page *is* the window. Unioning
                // would keep rows the query no longer matches (a renamed chat
                // under its old search, a chat deleted on another device) with
                // nothing able to remove them, and would leave the cursor
                // describing page 1 while the ids described page 3.
                ids: rows.map((t) => t.id),
                cursor: response.next_cursor,
                hasMore: response.has_more,
                // Search responses carry no count — keep the last known one.
                otherInstanceCount: response.other_instance_count ?? v.otherInstanceCount,
                status: 'ready',
                error: null,
                loadedAt: Date.now(),
            }));
        } catch (error) {
            logger(`loadThreadPageAtom: ${error}`, 1);
            patchView(get, set, key, generation, (v) => ({ ...v, status: 'error', error: errorFor(error) }));
        } finally {
            // Only if this request still owns the slot: `resetThreadStoreAtom`
            // clears the set, and a list remounting for the same user reissues
            // the identical key — deleting it then would void the serialization
            // guard for a request that is still outstanding.
            if (generation === get(threadStoreGenerationAtom)) inFlight.delete(requestKey);
        }
    }
);

/** Appends a view's next page. */
export const loadMoreThreadsAtom = atom(
    null,
    async (get, set, { key, query, scope }: { key: string; query: string; scope?: ZoteroInstanceRef }) => {
        const stamp = get(threadWriteStampAtom);
        const generation = stamp.generation;
        const view = get(threadViewsAtom).get(key) ?? EMPTY_THREAD_VIEW;
        if (!view.hasMore || !view.cursor) return;

        const cursor = view.cursor;
        const requestKey = `${key}|page|${cursor}`;
        // Same rule from the other side: appending onto a window that a
        // concurrent first page is about to replace would drop this page.
        if (hasPageRequestInFlight(key)) return;
        inFlight.add(requestKey);
        patchView(get, set, key, generation, (v) => ({ ...v, status: 'loading' }));

        try {
            const response = query
                ? await threadService.searchThreads(query, THREAD_PAGE_SIZE, cursor, scope)
                : await threadService.getPaginatedThreads(THREAD_PAGE_SIZE, cursor, scope);
            const rows = response.data.map(threadModelToThreadData);
            set(upsertThreadsAtom, { threads: rows, stamp });
            patchView(get, set, key, generation, (v) => ({
                ...v,
                ids: mergeIds(v.ids, rows.map((t) => t.id)),
                cursor: response.next_cursor,
                hasMore: response.has_more,
                status: 'ready',
                error: null,
                loadedAt: Date.now(),
            }));
        } catch (error) {
            logger(`loadMoreThreadsAtom: ${error}`, 1);
            patchView(get, set, key, generation, (v) => ({ ...v, status: 'error', error: errorFor(error) }));
        } finally {
            // Only if this request still owns the slot: `resetThreadStoreAtom`
            // clears the set, and a list remounting for the same user reissues
            // the identical key — deleting it then would void the serialization
            // guard for a request that is still outstanding.
            if (generation === get(threadStoreGenerationAtom)) inFlight.delete(requestKey);
        }
    }
);

/**
 * Discovers a view's pinned chats, which reach further back than the paginated
 * window. Merged into the same view, so unpinning one leaves it in place among
 * the date groups instead of dropping it out of the list.
 *
 * Failure is quiet: the list below still renders, and a second error banner for
 * the group would be noise.
 */
export const loadPinnedThreadsAtom = atom(
    null,
    async (
        get,
        set,
        {
            key,
            scope,
            isForeign,
            force = false,
        }: {
            key: string;
            scope?: ZoteroInstanceRef;
            /**
             * Whether an entity lies outside the scope this query asked for.
             * Reconciliation only clears `isPinned` on entities the response was
             * authoritative about; without this a scoped query would unpin
             * another profile's chats, which it never saw.
             */
            isForeign: (thread: ThreadData) => boolean;
            force?: boolean;
        }
    ) => {
        const stamp = get(threadWriteStampAtom);
        const generation = stamp.generation;
        const view = get(threadViewsAtom).get(key) ?? EMPTY_THREAD_VIEW;
        if (!force && view.pinnedLoadedAt && Date.now() - view.pinnedLoadedAt < THREAD_VIEW_TTL) return;

        const requestKey = `${key}|pinned`;
        if (inFlight.has(requestKey)) return;
        inFlight.add(requestKey);

        try {
            const rows = (await threadService.getStarredThreads(MAX_PINNED, scope)).map(threadModelToThreadData);
            // Entities only. The group renders from each entity's own flag, so
            // discovery is all this query owes it — and a chat pinned from a
            // search or from the header menu shows up without this having to
            // run again.
            set(upsertThreadsAtom, { threads: rows, stamp });

            // Reconcile: this response is the authoritative pinned set for its
            // scope, so a chat still flagged pinned here but absent from it was
            // unpinned somewhere else. Nothing else can clear that flag — a
            // paginated refresh only reports the chats inside its window — so
            // without this an unpin on another device would never arrive, and
            // the chat would sit under "Pinned" for the rest of the session.
            //
            // Skipped on a truncated response: at the cap the absentees are
            // just the ones past it, and unpinning them would be wrong.
            if (
                rows.length < MAX_PINNED
                && generation === get(threadStoreGenerationAtom)
                // A toggle since this request was issued means the response
                // predates it, and reconciling would silently undo the user's
                // own click. Skipping is safe: the next run reconciles.
                && stamp.pinSeq === get(pinMutationSeqAtom)
            ) {
                const stillPinned = new Set(rows.map((t) => t.id));
                const entities = get(threadEntitiesAtom);
                let changed = false;
                const next = new Map(entities);
                for (const [id, thread] of entities) {
                    // Not authoritative about another instance's threads, nor
                    // another agent's — /starred carries both scopes.
                    if (!thread.isPinned || stillPinned.has(id)) continue;
                    if (isForeign(thread) || isThreadAgentMismatch({ agent_name: thread.agentName })) continue;
                    next.set(id, { ...thread, isPinned: false });
                    changed = true;
                }
                if (changed) set(threadEntitiesAtom, next);
            }
            patchView(get, set, key, generation, (v) => ({ ...v, pinnedLoadedAt: Date.now() }));
        } catch (error) {
            logger(`loadPinnedThreadsAtom: ${error}`, 1);
        } finally {
            // Only if this request still owns the slot: `resetThreadStoreAtom`
            // clears the set, and a list remounting for the same user reissues
            // the identical key — deleting it then would void the serialization
            // guard for a request that is still outstanding.
            if (generation === get(threadStoreGenerationAtom)) inFlight.delete(requestKey);
        }
    }
);

/**
 * Loads the threads referencing given Zotero items. The by-item route takes no
 * agent scope, so another client's threads are dropped here; instance scoping
 * stays client-side because the match set is bounded.
 */
export const loadThreadsByItemAtom = atom(
    null,
    async (
        get,
        set,
        { key, filter, force = false }: { key: string; filter: ThreadItemFilter; force?: boolean }
    ) => {
        const stamp = get(threadWriteStampAtom);
        const generation = stamp.generation;
        const view = get(threadViewsAtom).get(key) ?? EMPTY_THREAD_VIEW;
        if (!force && view.status === 'ready' && Date.now() - view.loadedAt < THREAD_VIEW_TTL) return;

        const requestKey = `${key}|by-item`;
        if (inFlight.has(requestKey)) return;
        inFlight.add(requestKey);
        patchView(get, set, key, generation, (v) => ({ ...v, status: 'loading' }));

        try {
            const matches = await threadService.findThreadsByItem(
                { libraryId: filter.libraryId, libraryRef: filter.libraryRef },
                filter.keys,
                'both'
            );
            const rows = deduplicateByThread(matches.filter((m) => !isThreadAgentMismatch(m)));
            set(upsertThreadsAtom, { threads: rows, stamp });
            patchView(get, set, key, generation, (v) => ({
                ...v,
                // Replaced, not merged: this view answers "threads about these
                // items", so one that no longer matches has to leave it.
                ids: rows.map((t) => t.id),
                cursor: null,
                hasMore: false,
                status: 'ready',
                error: null,
                loadedAt: Date.now(),
            }));
        } catch (error) {
            logger(`loadThreadsByItemAtom: ${error}`, 1);
            patchView(get, set, key, generation, (v) => ({ ...v, status: 'error', error: errorFor(error) }));
        } finally {
            // Only if this request still owns the slot: `resetThreadStoreAtom`
            // clears the set, and a list remounting for the same user reissues
            // the identical key — deleting it then would void the serialization
            // guard for a request that is still outstanding.
            if (generation === get(threadStoreGenerationAtom)) inFlight.delete(requestKey);
        }
    }
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Pins or unpins a chat everywhere at once: every surface renders from the
 * entity, so one write reaches the sidebar list, the separate window's list and
 * the header menu together.
 *
 * Applied optimistically — the row it moves sits under the cursor, so waiting a
 * round trip before anything moves reads as a dropped click — and rolled back
 * on failure. The rollback needs no guard because {@link updateThreadAtom}
 * no-ops on an absent entity: a chat deleted while the request was in flight is
 * not resurrected, and one still present is not lost.
 *
 * @returns whether the backend accepted the change
 */
export const setThreadPinnedAtom = atom(
    null,
    async (
        get,
        set,
        { threadId, pinned, viewKey }: { threadId: string; pinned: boolean; viewKey?: string }
    ): Promise<boolean> => {
        const generation = get(threadStoreGenerationAtom);
        set(pinMutationSeqAtom, get(pinMutationSeqAtom) + 1);
        set(updateThreadAtom, { id: threadId, update: (t) => ({ ...t, isPinned: pinned }) });
        // Unpinning a chat the pinned group reached but the paginated window
        // never did would otherwise drop it off screen mid-click. Keep it in
        // the window until the next reload, which then honestly re-establishes
        // what the window contains.
        if (!pinned && viewKey) {
            patchView(get, set, viewKey, generation, (v) => ({ ...v, ids: mergeIds(v.ids, [threadId]) }));
        }
        try {
            if (pinned) {
                await threadService.starThread(threadId);
            } else {
                await threadService.unstarThread(threadId);
            }
            return true;
        } catch (error) {
            logger(`setThreadPinnedAtom: ${error}`, 1);
            set(pinMutationSeqAtom, get(pinMutationSeqAtom) + 1);
            set(updateThreadAtom, { id: threadId, update: (t) => ({ ...t, isPinned: !pinned }) });
            return false;
        }
    }
);

/**
 * Drops every entity and view. Called when the signed-in user changes: the
 * store lives on the app-lifetime Jotai store, so without this the previous
 * account's chat titles stay resident and could be rendered to the next one.
 */
export const resetThreadStoreAtom = atom(null, (get, set) => {
    set(threadStoreGenerationAtom, get(threadStoreGenerationAtom) + 1);
    set(threadEntitiesAtom, new Map());
    set(threadViewsAtom, new Map());
    // Forget outstanding request keys as well. Their responses are already
    // neutralised by the generation bump, so nothing is lost — but leaving the
    // keys behind makes `hasPageRequestInFlight` refuse the next load for the
    // same view, and signing back in as the same user reuses the same key. The
    // list would then sit on "No chats yet" with no spinner and no retry.
    inFlight.clear();
});

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Newest first — the order every thread endpoint returns. */
export function sortThreadsByUpdatedAt(threads: ThreadData[]): ThreadData[] {
    return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Resolves a view's ids to threads, dropping ids whose entity is gone (deleted
 * meanwhile) and sorting newest-first.
 */
export function resolveThreadView(
    view: ThreadListViewState,
    entities: Map<string, ThreadData>
): ThreadData[] {
    const rows: ThreadData[] = [];
    for (const id of view.ids) {
        const entity = entities.get(id);
        if (entity) rows.push(entity);
    }
    return sortThreadsByUpdatedAt(rows);
}

/**
 * The pinned chats a surface should show, taken over every known entity rather
 * than over one view's window — so a chat pinned from a search, from an
 * item-filtered list or from the header menu appears immediately, whether or
 * not the paginated query has reached it.
 *
 * `isForeign` applies the caller's instance scoping. The entity map can hold
 * chats from another Zotero profile once "show all profiles" has been used, and
 * they must not leak back into a scoped group.
 */
export function selectPinnedThreads(
    entities: Map<string, ThreadData>,
    isForeign: (thread: ThreadData) => boolean
): ThreadData[] {
    const pinned: ThreadData[] = [];
    for (const thread of entities.values()) {
        if (thread.isPinned && !isForeign(thread)) pinned.push(thread);
    }
    return sortThreadsByUpdatedAt(pinned);
}

/**
 * Pin state of the open chat, derived from the entity store so it cannot
 * disagree with what the lists show. `null` means the chat is not loaded here
 * yet (a deep link, or one created in this session); callers resolve it on
 * demand rather than assuming "not pinned".
 */
export const currentThreadPinnedAtom = atom<boolean | null>((get) => {
    const threadId = get(currentThreadIdAtom);
    if (!threadId) return null;
    const entity = get(threadEntitiesAtom).get(threadId);
    return entity ? entity.isPinned : null;
});
