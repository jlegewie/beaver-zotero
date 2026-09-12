import { atom } from "jotai";
import { currentThreadIdAtom } from "@beaver/agent-core/run-state/atoms";
import type {
    ThreadData,
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
export const pinsPendingAtom = atom<Map<string, PinLock>>(new Map());
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
export const currentThreadPinnedAtom = atom<boolean | null>((get) => {
    const id = get(currentThreadIdAtom);
    return id ? (get(threadEntitiesAtom).get(id)?.isPinned ?? null) : null;
});
