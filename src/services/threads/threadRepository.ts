import {
    threadService,
    setThreadAgentName,
    isThreadAgentMismatch,
    PIN_RECONCILE_TIMEOUT_MS,
} from "@beaver/agent-core/transport/threadService";
import type { ZoteroInstanceRef } from "@beaver/agent-core/transport/threadService";
import { logger } from "@beaver/agent-core/platform/logger";
import {
    deduplicateByThread,
    threadModelToThreadData,
    isThreadInstanceMismatch,
} from "./threadMatches";
import { isTransientNetworkError } from "./isTransientNetworkError";
import { classifyChatLoadError } from "./chatLoadError";
import type {
    ThreadData,
    ThreadItemFilter,
    ThreadWriteStamp,
    PinLock,
    ThreadListViewState,
} from "./types";
export type {
    ThreadData,
    ThreadWriteStamp,
    PinLock,
    ThreadListViewState,
} from "./types";
interface LoadPageParams {
    key: string;
    query: string;
    scope?: ZoteroInstanceRef;
    includeOtherCount: boolean;
    force?: boolean;
}
export interface ThreadRepositorySnapshot {
    revision: number;
    entities: Map<string, ThreadData>;
    views: Map<string, ThreadListViewState>;
    generation: number;
    pinSeq: number;
    pins: Map<string, PinLock>;
}
export const PIN_LOCK_TTL_MS = 30000;
export function isPinPending(
    pins: Map<string, PinLock>,
    threadId: string,
): boolean {
    const lock = pins.get(threadId);
    return lock !== undefined && Date.now() - lock.claimedAt < PIN_LOCK_TTL_MS;
}
export const EMPTY_THREAD_VIEW: ThreadListViewState = {
    ids: [],
    cursor: null,
    hasMore: false,
    otherInstanceCount: null,
    pinnedLoadedAt: 0,
    status: "idle",
    error: null,
    loadedAt: 0,
};
export const THREAD_PAGE_SIZE = 15;
export const MAX_PINNED = 50;
export const THREAD_VIEW_TTL = 60000;
export function threadViewKey(params: {
    userId: string;
    query?: string;
    showAll: boolean;
    scope?: ZoteroInstanceRef | null;
    filter?: ThreadItemFilter | null;
}): string {
    const { userId, query = "", showAll, scope, filter } = params;
    if (filter) {
        return `${userId}|item:${filter.libraryId}:${filter.keys.join("+")}|${query}|unscoped`;
    }
    const scopePart = showAll
        ? "all"
        : `scoped:${scope?.zoteroUserId ?? ""}:${scope?.zoteroLocalId ?? ""}`;
    return `${userId}||${query}|${scopePart}`;
}
function mergeIds(existing: string[], incoming: string[]): string[] {
    if (incoming.length === 0) return existing;
    const seen = new Set(existing);
    const added = incoming.filter((id) => !seen.has(id));
    return added.length === 0 ? existing : [...existing, ...added];
}
const RETRY_BACKOFF_MS = 30000;
const pageRequestKey = (key: string) => `${key}|page`;
const isViewFresh = (view: ThreadListViewState) =>
    view.status === "ready" && Date.now() - view.loadedAt < THREAD_VIEW_TTL;
export function sortThreadsByUpdatedAt(threads: ThreadData[]): ThreadData[] {
    return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function resolveThreadView(
    view: ThreadListViewState,
    entities: Map<string, ThreadData>,
): ThreadData[] {
    const rows: ThreadData[] = [];
    for (const id of view.ids) {
        const entity = entities.get(id);
        if (entity) rows.push(entity);
    }
    return sortThreadsByUpdatedAt(rows);
}
export function selectPinnedThreads(
    entities: Map<string, ThreadData>,
    scope: ZoteroInstanceRef | null | undefined,
): ThreadData[] {
    const pinned: ThreadData[] = [];
    for (const thread of entities.values()) {
        if (thread.isPinned && !isThreadInstanceMismatch(scope ?? null, thread))
            pinned.push(thread);
    }
    return sortThreadsByUpdatedAt(pinned);
}
/** Plugin-owned cache. Network continuations and locks outlive their requesting renderer. */
export class ThreadRepository {
    private metadataLoads = new Map<
        string,
        Promise<
            import("@beaver/agent-core/transport/threadService").ThreadModel
        >
    >();
    private revision = 0;
    private invalidationSeq = 0;
    private accountGeneration: number | undefined;
    private tombstones = new Set<string>();
    private changedAt = new Map<string, number>();
    private mutationTails = new Map<string, Promise<unknown>>();
    private disposeSubscription?: () => void;
    private disposeRealtime?: () => void;
    private realtimeUser: string | undefined;
    private entities = new Map<string, ThreadData>();
    private views = new Map<string, ThreadListViewState>();
    private generation = 0;
    private pinSeq = 0;
    private pins = new Map<string, PinLock>();
    private inFlight = new Set<string>();
    private retryAfter = new Map<string, number>();
    private pinLockSeq = 0;
    private listeners = new Set<(snapshot: ThreadRepositorySnapshot) => void>();
    stamp(): ThreadWriteStamp {
        return {
            generation: this.generation,
            pinSeq: this.pinSeq,
            revision: this.revision,
        };
    }
    getSnapshot(): ThreadRepositorySnapshot {
        return {
            revision: this.revision,
            entities: new Map(
                [...this.entities].map(([id, value]) => [id, { ...value }]),
            ),
            views: new Map(
                [...this.views].map(([id, value]) => [
                    id,
                    {
                        ...value,
                        ids: [...value.ids],
                        error: value.error ? { ...value.error } : null,
                    },
                ]),
            ),
            generation: this.generation,
            pinSeq: this.pinSeq,
            pins: new Map(
                [...this.pins].map(([id, value]) => [id, { ...value }]),
            ),
        };
    }
    subscribe(
        listener: (snapshot: ThreadRepositorySnapshot) => void,
    ): () => void {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => {
            this.listeners.delete(listener);
        };
    }
    private change(patch: Partial<ThreadRepositorySnapshot>): void {
        Object.assign(this, patch);
        for (const listener of [...this.listeners]) {
            try {
                listener(this.getSnapshot());
            } catch (error) {
                logger(`Thread projection: ${error}`, 1);
            }
        }
    }
    upsertThreads({
        threads,
        stamp,
    }: {
        threads: ThreadData[];
        stamp: ThreadWriteStamp;
    }) {
        if (threads.length === 0) return;
        if (stamp.generation !== this.generation) return;
        const pinsMovedSince = stamp.pinSeq !== this.pinSeq;
        const entities = this.entities;
        const next = new Map(entities);
        for (const thread of threads) {
            if (this.tombstones.has(thread.id)) continue;
            if (
                stamp.revision !== undefined &&
                (this.changedAt.get(thread.id) ?? 0) > stamp.revision
            )
                continue;
            const existing = pinsMovedSince
                ? entities.get(thread.id)
                : undefined;
            next.set(
                thread.id,
                existing
                    ? { ...thread, isPinned: existing.isPinned }
                    : { ...thread },
            );
        }
        this.change({ entities: next });
    }
    private updateThread({
        id,
        update,
    }: {
        id: string;
        update: (thread: ThreadData) => ThreadData;
    }) {
        const entities = this.entities;
        const existing = entities.get(id);
        if (!existing) return;
        const next = new Map(entities);
        next.set(id, update(existing));
        this.changedAt.set(id, ++this.revision);
        this.change({ entities: next });
    }
    removeThread(id: string) {
        this.tombstones.add(id);
        this.changedAt.set(id, ++this.revision);
        const entities = this.entities;
        if (!entities.has(id)) return;
        const next = new Map(entities);
        next.delete(id);
        this.change({ entities: next });
    }
    private patchView(
        key: string,
        generation: number,
        patch: (view: ThreadListViewState) => ThreadListViewState,
    ): void {
        if (generation !== this.generation) return;
        const views = this.views;
        const next = new Map(views);
        next.set(key, patch(views.get(key) ?? EMPTY_THREAD_VIEW));
        this.change({ views: next });
    }
    private async runViewLoad(options: {
        label: string;
        key: string;
        requestKey: string;
        skip: (view: ThreadListViewState) => boolean;
        force?: boolean;
        tracksStatus?: boolean;
        run: (
            stamp: ThreadWriteStamp,
            view: ThreadListViewState,
        ) => Promise<(view: ThreadListViewState) => ThreadListViewState>;
    }): Promise<void> {
        const {
            label,
            key,
            requestKey,
            skip,
            force = false,
            tracksStatus = true,
            run,
        } = options;
        const stamp = this.stamp();
        const view = this.views.get(key) ?? EMPTY_THREAD_VIEW;
        if (skip(view)) return;
        if (!force) {
            const until = this.retryAfter.get(requestKey);
            if (until !== undefined && Date.now() < until) return;
        }
        if (this.inFlight.has(requestKey)) return;
        this.inFlight.add(requestKey);
        const ownsStore = () => stamp.generation === this.generation;
        try {
            if (tracksStatus) {
                this.patchView(key, stamp.generation, (v) => ({
                    ...v,
                    status: "loading",
                }));
            }
            const patch = await run(stamp, view);
            this.patchView(key, stamp.generation, (v) => {
                const result = patch(v);
                return stamp.revision === this.revision
                    ? result
                    : {
                          ...result,
                          loadedAt: -++this.invalidationSeq,
                          pinnedLoadedAt: -this.invalidationSeq,
                      };
            });
            if (ownsStore()) this.retryAfter.delete(requestKey);
        } catch (error) {
            logger(`${label}: ${error}`, 1);
            if (ownsStore())
                this.retryAfter.set(requestKey, Date.now() + RETRY_BACKOFF_MS);
            if (tracksStatus) {
                this.patchView(key, stamp.generation, (v) => ({
                    ...v,
                    status: "error",
                    error: classifyChatLoadError(error),
                }));
            }
        } finally {
            if (ownsStore()) this.inFlight.delete(requestKey);
        }
    }
    async loadThreadPage({
        key,
        query,
        scope,
        includeOtherCount,
        force = false,
    }: LoadPageParams) {
        scope = scope ? { ...scope } : undefined;
        return this.runViewLoad({
            label: "loadThreadPageAtom",
            key,
            requestKey: pageRequestKey(key),
            skip: (view) => !force && isViewFresh(view),
            force,
            run: async (stamp) => {
                const response = query
                    ? await threadService.searchThreads(
                          query,
                          THREAD_PAGE_SIZE,
                          null,
                          scope,
                      )
                    : await threadService.getPaginatedThreads(
                          THREAD_PAGE_SIZE,
                          null,
                          scope,
                          includeOtherCount,
                      );
                const rows = response.data.map(threadModelToThreadData);
                this.upsertThreads({ threads: rows, stamp });
                return (v) => ({
                    ...v,
                    ids: rows.map((t) => t.id),
                    cursor: response.next_cursor,
                    hasMore: response.has_more,
                    otherInstanceCount:
                        response.other_instance_count ?? v.otherInstanceCount,
                    status: "ready",
                    error: null,
                    loadedAt: Date.now(),
                });
            },
        });
    }
    async loadMoreThreads({
        key,
        query,
        scope,
    }: {
        key: string;
        query: string;
        scope?: ZoteroInstanceRef;
    }) {
        scope = scope ? { ...scope } : undefined;
        return this.runViewLoad({
            label: "loadMoreThreadsAtom",
            key,
            requestKey: pageRequestKey(key),
            skip: (view) => !view.hasMore || !view.cursor,
            force: true,
            run: async (stamp, view) => {
                const response = query
                    ? await threadService.searchThreads(
                          query,
                          THREAD_PAGE_SIZE,
                          view.cursor,
                          scope,
                      )
                    : await threadService.getPaginatedThreads(
                          THREAD_PAGE_SIZE,
                          view.cursor,
                          scope,
                      );
                const rows = response.data.map(threadModelToThreadData);
                this.upsertThreads({ threads: rows, stamp });
                return (v) => ({
                    ...v,
                    ids: mergeIds(
                        v.ids,
                        rows.map((t) => t.id),
                    ),
                    cursor: response.next_cursor,
                    hasMore: response.has_more,
                    status: "ready",
                    error: null,
                    loadedAt: Date.now(),
                });
            },
        });
    }
    async loadPinnedThreads({
        key,
        scope,
        force = false,
    }: {
        key: string;
        scope?: ZoteroInstanceRef;
        force?: boolean;
    }) {
        scope = scope ? { ...scope } : undefined;
        return this.runViewLoad({
            label: "loadPinnedThreadsAtom",
            key,
            requestKey: `${key}|pinned`,
            tracksStatus: false,
            skip: (view) =>
                !force &&
                !!view.pinnedLoadedAt &&
                Date.now() - view.pinnedLoadedAt < THREAD_VIEW_TTL,
            force,
            run: async (stamp) => {
                const rows = (
                    await threadService.getStarredThreads(MAX_PINNED, scope)
                ).map(threadModelToThreadData);
                this.upsertThreads({ threads: rows, stamp });
                this.reconcilePinnedFlags({ rows, stamp, scope });
                return (v) => ({ ...v, pinnedLoadedAt: Date.now() });
            },
        });
    }
    private reconcilePinnedFlags({
        rows,
        stamp,
        scope,
    }: {
        rows: ThreadData[];
        stamp: ThreadWriteStamp;
        scope?: ZoteroInstanceRef;
    }): void {
        if (rows.length >= MAX_PINNED) return;
        if (stamp.generation !== this.generation) return;
        if (stamp.revision !== this.revision || stamp.pinSeq !== this.pinSeq)
            return;
        const stillPinned = new Set(rows.map((t) => t.id));
        const entities = this.entities;
        const next = new Map(entities);
        let changed = false;
        for (const [id, thread] of entities) {
            if (!thread.isPinned || stillPinned.has(id)) continue;
            if (isThreadInstanceMismatch(scope ?? null, thread)) continue;
            if (isThreadAgentMismatch({ agent_name: thread.agentName }))
                continue;
            next.set(id, { ...thread, isPinned: false });
            changed = true;
        }
        if (changed) this.change({ entities: next });
    }
    async loadThreadsByItem({
        key,
        filter,
        force = false,
    }: {
        key: string;
        filter: ThreadItemFilter;
        force?: boolean;
    }) {
        filter = { ...filter, keys: [...filter.keys] };
        return this.runViewLoad({
            label: "loadThreadsByItemAtom",
            key,
            requestKey: `${key}|by-item`,
            skip: (view) => !force && isViewFresh(view),
            force,
            run: async (stamp) => {
                const matches = await threadService.findThreadsByItem(
                    {
                        libraryId: filter.libraryId,
                        libraryRef: filter.libraryRef,
                    },
                    filter.keys,
                    "both",
                );
                const rows = deduplicateByThread(
                    matches.filter((m) => !isThreadAgentMismatch(m)),
                );
                this.upsertThreads({ threads: rows, stamp });
                return (v) => ({
                    ...v,
                    ids: rows.map((t) => t.id),
                    cursor: null,
                    hasMore: false,
                    status: "ready",
                    error: null,
                    loadedAt: Date.now(),
                });
            },
        });
    }
    async setThreadPinned({
        threadId,
        pinned,
        viewKey,
    }: {
        threadId: string;
        pinned: boolean;
        viewKey?: string;
    }): Promise<boolean> {
        const pins = this.pins;
        if (isPinPending(pins, threadId)) return false;
        const claimed = new Map(
            [...pins].filter(
                ([id]) => id !== threadId && isPinPending(pins, id),
            ),
        );
        const lock: PinLock = {
            claimedAt: Date.now(),
            token: ++this.pinLockSeq,
        };
        claimed.set(threadId, lock);
        this.change({ pins: claimed });
        const stillOwnsLock = () =>
            this.pins.get(threadId)?.token === lock.token;
        const generation = this.generation;
        this.change({ pinSeq: this.pinSeq + 1 });
        const canApply = () =>
            stillOwnsLock() && this.generation === generation;
        const applyConfirmedState = (confirmedPinned: boolean) => {
            if (!canApply()) return;
            this.updateThread({
                id: threadId,
                update: (t) => ({ ...t, isPinned: confirmedPinned }),
            });
            if (!confirmedPinned && viewKey) {
                this.patchView(viewKey, generation, (v) => ({
                    ...v,
                    ids: mergeIds(v.ids, [threadId]),
                }));
            }
        };
        try {
            const thread = pinned
                ? await this.mutate(threadId, () =>
                      threadService.starThread(threadId),
                  )
                : await this.mutate(threadId, () =>
                      threadService.unstarThread(threadId),
                  );
            if (!canApply()) return false;
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
                    if (typeof thread.starred !== "boolean") return false;
                    const confirmedPinned = thread.starred;
                    if (!canApply()) return false;
                    applyConfirmedState(confirmedPinned);
                    return confirmedPinned === pinned;
                } catch (reconcileError) {
                    logger(
                        `setThreadPinnedAtom reconciliation: ${reconcileError}`,
                        1,
                    );
                }
            }
            return false;
        } finally {
            if (stillOwnsLock()) {
                const next = new Map(this.pins);
                next.delete(threadId);
                this.change({ pins: next });
            }
        }
    }
    resetThreadStore() {
        this.metadataLoads.clear();
        this.revision++;
        this.tombstones.clear();
        this.changedAt.clear();
        this.mutationTails.clear();
        this.change({ generation: this.generation + 1 });
        this.change({ entities: new Map() });
        this.change({ views: new Map() });
        this.inFlight.clear();
        this.retryAfter.clear();
    }
    start(account: import("../instanceAccount").InstanceAccount): void {
        if (this.disposeSubscription) return;
        setThreadAgentName("beaver");
        this.disposeSubscription = account.subscribe((snapshot) => {
            if (snapshot.generation !== this.accountGeneration) {
                this.accountGeneration = snapshot.generation;
                this.disposeRealtime?.();
                this.realtimeUser = undefined;
                this.resetThreadStore();
                Zotero.Beaver.presence.reset(snapshot.generation);
            }
            const userId = snapshot.session?.user.id;
            if (userId === this.realtimeUser) return;
            this.realtimeUser = userId;
            this.disposeRealtime?.();
            if (userId)
                this.disposeRealtime = account.realtime.subscribe(
                    "threads",
                    userId,
                    (payload) => {
                        if (
                            snapshot.generation !== this.accountGeneration ||
                            userId !== this.realtimeUser
                        )
                            return;
                        if (payload.eventType === "DELETE") {
                            const id = String(payload.old.id);
                            this.removeThread(id);
                            Zotero.Beaver.presence.invalidate(id, true);
                        } else if (
                            payload.eventType === "INSERT" ||
                            payload.eventType === "UPDATE"
                        ) {
                            if (isThreadAgentMismatch(payload.new as any)) return;
                            const row = threadModelToThreadData(
                                payload.new as any,
                            );
                            const previous = this.entities.get(row.id);
                            if (
                                previous &&
                                previous.updatedAt !== row.updatedAt
                            )
                                Zotero.Beaver.presence.invalidate(row.id);
                            this.upsertThreads({
                                threads: [row],
                                stamp: this.stamp(),
                            });
                            this.changedAt.set(row.id, ++this.revision);
                            this.invalidateViews();
                        }
                    },
                );
        });
    }
    invalidateViews(): void {
        this.revision++;
        const invalidatedAt = -++this.invalidationSeq;
        this.change({
            views: new Map(
                [...this.views].map(([key, view]) => [
                    key,
                    {
                        ...view,
                        loadedAt: invalidatedAt,
                        pinnedLoadedAt: invalidatedAt,
                    },
                ]),
            ),
        });
    }
    patchThread(id: string, patch: Partial<ThreadData>): void {
        this.updateThread({
            id,
            update: (value) => ({ ...value, ...patch, id }),
        });
    }
    /** Serialize metadata writes in this realm, including network settlement. */
    private mutate<T>(id: string, operation: () => Promise<T>): Promise<T> {
        const generation = this.generation;
        const previous = this.mutationTails.get(id);
        const invoke = async () => {
            if (generation !== this.generation || this.tombstones.has(id))
                throw new Error("Chat is no longer available");
            this.changedAt.set(id, ++this.revision);
            return operation();
        };
        const result = previous
            ? previous.catch(() => {}).then(invoke)
            : invoke();
        this.mutationTails.set(id, result);
        void result
            .finally(() => {
                if (this.mutationTails.get(id) === result)
                    this.mutationTails.delete(id);
            })
            .catch(() => {});
        return result;
    }
    getThread(
        id: string,
    ): Promise<
        import("@beaver/agent-core/transport/threadService").ThreadModel
    > {
        const pending = this.metadataLoads.get(id);
        if (pending) return pending;
        const stamp = this.stamp();
        const request = threadService
            .getThread(id)
            .then((row) => {
                if (
                    stamp.generation !== this.generation ||
                    this.tombstones.has(id)
                )
                    throw new Error("Chat is no longer available");
                this.upsertThreads({
                    threads: [threadModelToThreadData(row)],
                    stamp,
                });
                const current = this.entities.get(id);
                return {
                    ...row,
                    name: current?.name ?? row.name,
                    starred: current?.isPinned ?? row.starred,
                };
            })
            .finally(() => {
                if (this.metadataLoads.get(id) === request)
                    this.metadataLoads.delete(id);
            });
        this.metadataLoads.set(id, request);
        return request;
    }
    renameThread(id: string, name: string): Promise<void> {
        return this.mutate(id, async () => {
            const stamp = this.stamp();
            const row = await threadService.renameThread(id, name);
            if (stamp.generation !== this.generation) return;
            this.upsertThreads({
                threads: [threadModelToThreadData(row)],
                stamp,
            });
            this.patchThread(id, { name });
            this.invalidateViews();
        });
    }
    deleteThread(
        id: string,
        windowId: string,
        generation: number,
    ): Promise<void> {
        const presence = Zotero.Beaver.presence;
        const claim = presence.claim(windowId, id, generation);
        if (!claim)
            return Promise.reject(
                Object.assign(new Error("Responding in another window"), {
                    code: "thread_busy",
                }),
            );
        return this.mutate(id, async () => {
            if (!presence.owns(claim))
                throw new Error("Chat operation was canceled");
            const stamp = this.stamp();
            await threadService.deleteThread(id);
            // A confirmed instance mutation survives the requesting window.
            if (stamp.generation !== this.generation) return;
            this.removeThread(id);
            presence.invalidate(id, true);
            this.invalidateViews();
        }).finally(() => presence.release(claim));
    }
    dispose(): void {
        this.disposeSubscription?.();
        this.disposeRealtime?.();
        this.listeners.clear();
        this.resetThreadStore();
    }
}
