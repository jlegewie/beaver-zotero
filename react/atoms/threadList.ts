import { atom } from "jotai";
import { currentThreadIdAtom } from "@beaver/agent-core/run-state/atoms";
import type {
    ThreadData,
    ThreadWriteStamp,
    ThreadListViewState,
    PinLock,
} from "../../src/services/threads/types";
import type { ThreadRepository } from "../../src/services/threads/threadRepository";
export {
    EMPTY_THREAD_VIEW,
    THREAD_PAGE_SIZE,
    MAX_PINNED,
    THREAD_VIEW_TTL,
    PIN_LOCK_TTL_MS,
    isPinPending,
    threadViewKey,
    sortThreadsByUpdatedAt,
    resolveThreadView,
    selectPinnedThreads,
} from "../../src/services/threads/threadRepository";
export type {
    ThreadWriteStamp,
    ThreadListViewState,
    PinLock,
} from "../../src/services/threads/types";

/** Window-local projections; only the instance repository performs network/cache writes. */
export const threadEntitiesAtom = atom<Map<string, ThreadData>>(new Map());
export const threadViewsAtom = atom<Map<string, ThreadListViewState>>(
    new Map(),
);
export const threadStoreGenerationAtom = atom(0);
export const pinMutationSeqAtom = atom(0);
export const pinsPendingAtom = atom<Map<string, PinLock>>(new Map());
export const threadRepositoryRevisionAtom = atom(0);
export const threadWriteStampAtom = atom<ThreadWriteStamp>((get) => {
    return {
        generation: get(threadStoreGenerationAtom),
        pinSeq: get(pinMutationSeqAtom),
        revision: get(threadRepositoryRevisionAtom),
    };
});
export const upsertThreadsAtom = atom(
    null,
    (_get, _set, request: { threads: ThreadData[]; stamp: ThreadWriteStamp }) =>
        Zotero.Beaver.threads.upsertThreads(request),
);
export const updateThreadAtom = atom(
    null,
    (
        get,
        _set,
        request: { id: string; update: (thread: ThreadData) => ThreadData },
    ) => {
        const existing = get(threadEntitiesAtom).get(request.id);
        if (existing)
            Zotero.Beaver.threads.patchThread(
                request.id,
                request.update(existing),
            );
    },
);
export const removeThreadAtom = atom(null, (_get, _set, id: string) =>
    Zotero.Beaver.threads.removeThread(id),
);
export const loadThreadPageAtom = atom(
    null,
    (_get, _set, request: Parameters<ThreadRepository["loadThreadPage"]>[0]) =>
        Zotero.Beaver.threads.loadThreadPage(request),
);
export const loadMoreThreadsAtom = atom(
    null,
    (_get, _set, request: Parameters<ThreadRepository["loadMoreThreads"]>[0]) =>
        Zotero.Beaver.threads.loadMoreThreads(request),
);
export const loadPinnedThreadsAtom = atom(
    null,
    (
        _get,
        _set,
        request: Parameters<ThreadRepository["loadPinnedThreads"]>[0],
    ) => Zotero.Beaver.threads.loadPinnedThreads(request),
);
export const loadThreadsByItemAtom = atom(
    null,
    (
        _get,
        _set,
        request: Parameters<ThreadRepository["loadThreadsByItem"]>[0],
    ) => Zotero.Beaver.threads.loadThreadsByItem(request),
);
export const setThreadPinnedAtom = atom(
    null,
    (_get, _set, request: Parameters<ThreadRepository["setThreadPinned"]>[0]) =>
        Zotero.Beaver.threads.setThreadPinned(request),
);
/** Account hydration resets this renderer, never another viewer's instance cache. */
export const resetThreadStoreAtom = atom(null, (get, set) => {
    set(threadStoreGenerationAtom, get(threadStoreGenerationAtom) + 1);
    set(threadEntitiesAtom, new Map());
    set(threadViewsAtom, new Map());
    set(pinsPendingAtom, new Map());
});
export const currentThreadPinnedAtom = atom<boolean | null>((get) => {
    const id = get(currentThreadIdAtom);
    return id ? (get(threadEntitiesAtom).get(id)?.isPinned ?? null) : null;
});
