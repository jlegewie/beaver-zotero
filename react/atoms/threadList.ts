import { atom } from 'jotai';
import type { Getter, Setter } from 'jotai';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import {
    threadService,
    isThreadAgentMismatch,
    PIN_RECONCILE_TIMEOUT_MS,
} from '@beaver/agent-core/transport/threadService';
import type { ZoteroInstanceRef } from '@beaver/agent-core/transport/threadService';
import { logger } from '@beaver/agent-core/platform/logger';
import { deduplicateByThread, threadModelToThreadData, isThreadInstanceMismatch } from '../utils/threadMatches';
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
 *   the entity is absent**, which stops a late response from resurrecting a
 *   deleted chat or dropping a live one without either case being special-cased.
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

/**
 * Chats with a pin/unpin request outstanding, as id → the lock held on it.
 *
 * One shared map rather than per-surface state, because the row's pin button
 * and the header's chat-actions menu can both target the same chat — the menu
 * stays reachable while the list overlay is open — and two toggles racing gives
 * the two PATCHes no ordering guarantee. It is also what disables the controls
 * while a request is in flight.
 *
 * The claim time is what makes the lock self-healing, and it is load-bearing:
 * this map lives on the app-lifetime Jotai store, while everything that
 * releases an entry belongs to the window that made the claim — the promise
 * continuation, and the request deadline, which is a window `setTimeout`. Close
 * that window with a request in flight and neither runs again (see CLAUDE.md,
 * "the slot outlives the realm"), so an entry whose owner is gone has to age
 * out rather than disable that chat's pin controls until the app restarts.
 * Expiry is checked at render, so the control comes back on the next render of
 * that surface (reopening the list, or reopening the header menu) rather than
 * the instant the lock lapses.
 *
 * Deliberately not cleared by {@link resetThreadStoreAtom}: every toggle
 * removes its own id in a `finally`, and clearing would let a pre-reset toggle
 * release an id a later one had claimed.
 */
export interface PinLock {
    /** When the lock was taken, for {@link PIN_LOCK_TTL_MS}. */
    claimedAt: number;
    /**
     * Identifies the call that took it. Expiring a lock only stops others
     * waiting on it — it cannot stop the abandoned owner from coming back, so
     * that owner has to be able to tell that the lock is no longer its own
     * before it writes anything. A counter rather than the timestamp, because
     * two claims can land in the same millisecond.
     */
    token: number;
}

export const pinsPendingAtom = atom<Map<string, PinLock>>(new Map<string, PinLock>());

let pinLockSeq = 0;

/**
 * How long a pin lock is honoured. Must stay comfortably longer than
 * `PIN_TIMEOUT_MS`, the deadline on the pin request itself
 * (`agent-core/transport/threadService`), so a live request is never treated as
 * abandoned; anything older than this had its owner torn down.
 *
 * Restated rather than imported: pulling a transport constant in here would
 * make every test that mocks `threadService` responsible for providing it.
 */
export const PIN_LOCK_TTL_MS = 30_000;

/** Whether a pin/unpin for this chat is in flight and its lock still valid. */
export function isPinPending(pins: Map<string, PinLock>, threadId: string): boolean {
    const lock = pins.get(threadId);
    return lock !== undefined && Date.now() - lock.claimedAt < PIN_LOCK_TTL_MS;
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
 * Applies a patch to one view, if the write still belongs to the current store
 * generation. Views hold only ids and a cursor and are not evicted; the whole
 * map is dropped on sign-out.
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
 * request. Keyed by view plus role.
 *
 * A first page and a "show more" share one key: a first page replaces the
 * window, so the two must never run together — whichever landed last would win
 * and drop the other's rows.
 */
const inFlight = new Set<string>();

const pageRequestKey = (key: string) => `${key}|page`;

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
 * The shape every view load shares: freshness check, exclusive in-flight slot,
 * fetch, then one patch describing what the response did to the view. Each
 * loader below supplies only its own query and its ids policy — replace for a
 * first page or a by-item set, append for a "show more" — which is the part
 * that actually differs.
 *
 * Everything after the slot is claimed runs inside the block the `finally`
 * releases, so a throw cannot strand the key and wedge the view.
 */
async function runViewLoad(
    get: Getter,
    set: Setter,
    options: {
        /** Names the loader in error logs. */
        label: string;
        key: string;
        requestKey: string;
        /** True when there is nothing to do — already fresh, or nothing to page. */
        skip: (view: ThreadListViewState) => boolean;
        /**
         * Whether this load owns the view's `status`/`error`. The pinned query
         * does not: it renders no spinner and swallows its failure, because the
         * list below it stays usable and a second error banner would be noise.
         */
        tracksStatus?: boolean;
        run: (stamp: ThreadWriteStamp, view: ThreadListViewState)
            => Promise<(view: ThreadListViewState) => ThreadListViewState>;
    }
): Promise<void> {
    const { label, key, requestKey, skip, tracksStatus = true, run } = options;
    const stamp = get(threadWriteStampAtom);
    const view = get(threadViewsAtom).get(key) ?? EMPTY_THREAD_VIEW;
    if (skip(view)) return;
    if (inFlight.has(requestKey)) return;
    inFlight.add(requestKey);

    try {
        if (tracksStatus) {
            patchView(get, set, key, stamp.generation, (v) => ({ ...v, status: 'loading' }));
        }
        patchView(get, set, key, stamp.generation, await run(stamp, view));
    } catch (error) {
        logger(`${label}: ${error}`, 1);
        if (tracksStatus) {
            patchView(get, set, key, stamp.generation, (v) => ({
                ...v, status: 'error', error: errorFor(error),
            }));
        }
    } finally {
        // Only if this request still owns the slot: `resetThreadStoreAtom`
        // clears the set, and a list remounting for the same user reissues the
        // identical key — deleting it then would void the serialization guard
        // for a request that is still outstanding.
        if (stamp.generation === get(threadStoreGenerationAtom)) inFlight.delete(requestKey);
    }
}

const isViewFresh = (view: ThreadListViewState) =>
    view.status === 'ready' && Date.now() - view.loadedAt < THREAD_VIEW_TTL;

/** Loads a view's first page, or keeps the loaded one when it is still fresh. */
export const loadThreadPageAtom = atom(
    null,
    async (get, set, { key, query, scope, includeOtherCount, force = false }: LoadPageParams) =>
        runViewLoad(get, set, {
            label: 'loadThreadPageAtom',
            key,
            requestKey: pageRequestKey(key),
            skip: (view) => !force && isViewFresh(view),
            run: async (stamp) => {
                const response = query
                    ? await threadService.searchThreads(query, THREAD_PAGE_SIZE, null, scope)
                    : await threadService.getPaginatedThreads(THREAD_PAGE_SIZE, null, scope, includeOtherCount);
                const rows = response.data.map(threadModelToThreadData);
                set(upsertThreadsAtom, { threads: rows, stamp });
                return (v) => ({
                    ...v,
                    // A first page *is* the window, so it replaces: rows the
                    // query no longer matches have to leave, and the ids must
                    // not outrun the cursor beside them.
                    ids: rows.map((t) => t.id),
                    cursor: response.next_cursor,
                    hasMore: response.has_more,
                    // Search responses carry no count — keep the last known one.
                    otherInstanceCount: response.other_instance_count ?? v.otherInstanceCount,
                    status: 'ready',
                    error: null,
                    loadedAt: Date.now(),
                });
            },
        })
);

/** Appends a view's next page. */
export const loadMoreThreadsAtom = atom(
    null,
    async (get, set, { key, query, scope }: { key: string; query: string; scope?: ZoteroInstanceRef }) =>
        runViewLoad(get, set, {
            label: 'loadMoreThreadsAtom',
            key,
            requestKey: pageRequestKey(key),
            skip: (view) => !view.hasMore || !view.cursor,
            run: async (stamp, view) => {
                const response = query
                    ? await threadService.searchThreads(query, THREAD_PAGE_SIZE, view.cursor, scope)
                    : await threadService.getPaginatedThreads(THREAD_PAGE_SIZE, view.cursor, scope);
                const rows = response.data.map(threadModelToThreadData);
                set(upsertThreadsAtom, { threads: rows, stamp });
                return (v) => ({
                    ...v,
                    ids: mergeIds(v.ids, rows.map((t) => t.id)),
                    cursor: response.next_cursor,
                    hasMore: response.has_more,
                    status: 'ready',
                    error: null,
                    loadedAt: Date.now(),
                });
            },
        })
);

/**
 * Discovers a view's pinned chats, which reach further back than the paginated
 * window, and reconciles the flags it is authoritative about.
 */
export const loadPinnedThreadsAtom = atom(
    null,
    async (
        get,
        set,
        { key, scope, force = false }: { key: string; scope?: ZoteroInstanceRef; force?: boolean }
    ) =>
        runViewLoad(get, set, {
            label: 'loadPinnedThreadsAtom',
            key,
            requestKey: `${key}|pinned`,
            tracksStatus: false,
            skip: (view) =>
                !force && !!view.pinnedLoadedAt && Date.now() - view.pinnedLoadedAt < THREAD_VIEW_TTL,
            run: async (stamp) => {
                const rows = (await threadService.getStarredThreads(MAX_PINNED, scope))
                    .map(threadModelToThreadData);
                // Entities only. The group renders from each entity's own flag,
                // so discovery is all this query owes it — a chat pinned from a
                // search or the header menu shows up without this running again.
                set(upsertThreadsAtom, { threads: rows, stamp });
                reconcilePinnedFlags(get, set, { rows, stamp, scope });
                return (v) => ({ ...v, pinnedLoadedAt: Date.now() });
            },
        })
);

/**
 * Clears `isPinned` on the chats this response was authoritative about but did
 * not list — the only way an unpin performed on another device arrives, since a
 * paginated refresh only reports the chats inside its window.
 */
function reconcilePinnedFlags(
    get: Getter,
    set: Setter,
    { rows, stamp, scope }: { rows: ThreadData[]; stamp: ThreadWriteStamp; scope?: ZoteroInstanceRef }
): void {
    // A truncated response says nothing about the chats past its cap, and a
    // toggle since the request was issued means the response predates the
    // user's own click — reconciling either would be wrong. Both are safe to
    // skip: the next run reconciles.
    if (rows.length >= MAX_PINNED) return;
    if (stamp.generation !== get(threadStoreGenerationAtom)) return;
    if (stamp.pinSeq !== get(pinMutationSeqAtom)) return;

    const stillPinned = new Set(rows.map((t) => t.id));
    const entities = get(threadEntitiesAtom);
    const next = new Map(entities);
    let changed = false;
    for (const [id, thread] of entities) {
        if (!thread.isPinned || stillPinned.has(id)) continue;
        // Not authoritative about another instance's threads, nor another
        // agent's — /starred carries both scopes. Using the same `scope` the
        // request was issued with keeps the check from drifting from the ask.
        if (isThreadInstanceMismatch(scope ?? null, thread)) continue;
        if (isThreadAgentMismatch({ agent_name: thread.agentName })) continue;
        next.set(id, { ...thread, isPinned: false });
        changed = true;
    }
    if (changed) set(threadEntitiesAtom, next);
}

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
    ) =>
        runViewLoad(get, set, {
            label: 'loadThreadsByItemAtom',
            key,
            requestKey: `${key}|by-item`,
            skip: (view) => !force && isViewFresh(view),
            run: async (stamp) => {
                const matches = await threadService.findThreadsByItem(
                    { libraryId: filter.libraryId, libraryRef: filter.libraryRef },
                    filter.keys,
                    'both'
                );
                const rows = deduplicateByThread(matches.filter((m) => !isThreadAgentMismatch(m)));
                set(upsertThreadsAtom, { threads: rows, stamp });
                return (v) => ({
                    ...v,
                    // This view answers "threads about these items", so a thread
                    // that no longer matches has to leave it.
                    ids: rows.map((t) => t.id),
                    cursor: null,
                    hasMore: false,
                    status: 'ready',
                    error: null,
                    loadedAt: Date.now(),
                });
            },
        })
);

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Pins or unpins a chat everywhere at once: every surface renders from the
 * entity, so one write reaches the sidebar list, the separate window's list and
 * the header menu together.
 *
 * The entity is updated only after the backend confirms the mutation. While it
 * is in flight, every pin control for the chat renders its shared pending lock
 * as a spinner. A transient failure is ambiguous — the PATCH may have committed
 * before its response stalled — so it is read back before the lock is released.
 *
 * @returns true when the confirmed backend state matches the requested state;
 *   false when it does not, cannot be confirmed, or no request was sent
 */
export const setThreadPinnedAtom = atom(
    null,
    async (
        get,
        set,
        { threadId, pinned, viewKey }: { threadId: string; pinned: boolean; viewKey?: string }
    ): Promise<boolean> => {
        // One toggle per chat at a time, across every surface.
        const pins = get(pinsPendingAtom);
        if (isPinPending(pins, threadId)) return false;
        // Claiming is also the sweep point: entries whose owning window is gone
        // are dropped here rather than accumulating for the app's lifetime.
        const claimed = new Map(
            [...pins].filter(([id]) => id !== threadId && isPinPending(pins, id))
        );
        const lock: PinLock = { claimedAt: Date.now(), token: ++pinLockSeq };
        claimed.set(threadId, lock);
        set(pinsPendingAtom, claimed);
        /** Whether this call still holds the lock it took. */
        const stillOwnsLock = () => get(pinsPendingAtom).get(threadId)?.token === lock.token;

        const generation = get(threadStoreGenerationAtom);
        set(pinMutationSeqAtom, get(pinMutationSeqAtom) + 1);
        const canApply = () => stillOwnsLock() && get(threadStoreGenerationAtom) === generation;
        const applyConfirmedState = (confirmedPinned: boolean) => {
            if (!canApply()) return;
            set(updateThreadAtom, {
                id: threadId,
                update: (t) => ({ ...t, isPinned: confirmedPinned }),
            });
            // An unpinned chat that only the pinned query reached would
            // otherwise disappear from under the cursor when confirmation
            // moves it out of that group.
            if (!confirmedPinned && viewKey) {
                patchView(get, set, viewKey, generation, (v) => ({
                    ...v,
                    ids: mergeIds(v.ids, [threadId]),
                }));
            }
        };
        try {
            const thread = pinned
                ? await threadService.starThread(threadId)
                : await threadService.unstarThread(threadId);
            if (!canApply()) return false;
            // Older backends may omit `starred`; a successful absolute-set
            // route still confirms the requested state in that case.
            const confirmedPinned = thread.starred ?? pinned;
            applyConfirmedState(confirmedPinned);
            return confirmedPinned === pinned;
        } catch (error) {
            logger(`setThreadPinnedAtom: ${error}`, 1);
            if (isTransientNetworkError(error) && canApply()) {
                try {
                    const thread = await threadService.getThread(threadId, {
                        timeoutMs: PIN_RECONCILE_TIMEOUT_MS,
                    });
                    // A legacy response that omits `starred` cannot tell us
                    // whether the timed-out mutation committed. Preserve the
                    // last confirmed UI state until a later authoritative
                    // response includes the flag.
                    if (typeof thread.starred !== 'boolean') return false;
                    const confirmedPinned = thread.starred;
                    if (!canApply()) return false;
                    applyConfirmedState(confirmedPinned);
                    return confirmedPinned === pinned;
                } catch (reconcileError) {
                    logger(`setThreadPinnedAtom reconciliation: ${reconcileError}`, 1);
                }
            }
            return false;
        } finally {
            // Likewise: release only our own claim, never whoever holds it now.
            if (stillOwnsLock()) {
                const next = new Map(get(pinsPendingAtom));
                next.delete(threadId);
                set(pinsPendingAtom, next);
            }
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
    // neutralised by the generation bump, so nothing is lost — but a leftover
    // key makes the next load for the same view refuse to start, and signing
    // back in as the same user reuses the same key. The list would then sit on
    // "No chats yet" with no spinner and no retry.
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
 * `scope` is the instance the caller is showing, or undefined for "all
 * profiles". The entity map can hold chats from another Zotero profile once
 * "show all" has been used, and they must not leak back into a scoped group.
 */
export function selectPinnedThreads(
    entities: Map<string, ThreadData>,
    scope: ZoteroInstanceRef | null | undefined
): ThreadData[] {
    const pinned: ThreadData[] = [];
    for (const thread of entities.values()) {
        if (thread.isPinned && !isThreadInstanceMismatch(scope ?? null, thread)) pinned.push(thread);
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
