import { atom } from "jotai";
import {
    currentThreadIdAtom,
    currentThreadNameAtom,
} from "@beaver/agent-core/run-state/atoms";
import type { WindowRuntime } from "../../src/runtime/instance";
import type { ThreadPresenceSnapshot } from "../../src/services/threads/threadPresence";
import { store } from "../store";
import { recentThreadsAtom } from "../atoms/threads";
import {
    threadEntitiesAtom,
    threadViewsAtom,
    threadStoreGenerationAtom,
    pinMutationSeqAtom,
    pinsPendingAtom,
    threadRepositoryRevisionAtom,
    sortThreadsByUpdatedAt,
} from "../atoms/threadList";
export const threadPresenceAtom = atom<ThreadPresenceSnapshot>({
    revision: 0,
    claims: [],
    viewers: [],
    history: {},
    deleted: [],
});
export const viewedHistoryRevisionAtom = atom(0);
export const otherThreadWriterAtom = atom((get) => {
    const id = get(currentThreadIdAtom);
    const owner = get(threadPresenceAtom).claims.find(
        (claim) => claim.threadId === id,
    );
    return owner && owner.windowId !== tryGetWindowRuntime()?.id ? owner : null;
});
// Resolve the immutable renderer owner, never the currently focused main window.
import { tryGetWindowRuntime } from "./windowRuntime";
export const threadDeletedAtom = atom((get) => {
    const id = get(currentThreadIdAtom);
    return !!id && get(threadPresenceAtom).deleted.includes(id);
});
export const threadHistoryStaleAtom = atom((get) => {
    const id = get(currentThreadIdAtom);
    return (
        !!id &&
        (get(threadPresenceAtom).history[id] ?? 0) !==
            get(viewedHistoryRevisionAtom)
    );
});
export function attachThreadProjection(runtime: WindowRuntime): void {
    const instance = Zotero.Beaver;
    const removeCache = instance.threads.subscribe((snapshot) => {
        if (runtime.status === "closing") return;
        store.set(threadEntitiesAtom, snapshot.entities);
        store.set(threadViewsAtom, snapshot.views);
        store.set(threadStoreGenerationAtom, snapshot.generation);
        store.set(pinMutationSeqAtom, snapshot.pinSeq);
        store.set(pinsPendingAtom, snapshot.pins);
        store.set(threadRepositoryRevisionAtom, snapshot.revision);
        store.set(
            recentThreadsAtom,
            sortThreadsByUpdatedAt([...snapshot.entities.values()]).slice(0, 6),
        );
        const id = store.get(currentThreadIdAtom);
        const entity = id ? snapshot.entities.get(id) : undefined;
        if (entity) store.set(currentThreadNameAtom, entity.name);
    });
    const removePresence = instance.presence.subscribe((snapshot) => {
        if (runtime.status !== "closing")
            store.set(threadPresenceAtom, snapshot);
    });
    const view = () => {
        const id = store.get(currentThreadIdAtom);
        instance.presence.view(runtime.id, id);
        store.set(
            viewedHistoryRevisionAtom,
            id ? (instance.presence.getSnapshot().history[id] ?? 0) : 0,
        );
    };
    const removeView = store.sub(currentThreadIdAtom, view);
    view();
    instance.runtime.addWindowCleanup(runtime, () => {
        removeCache();
        removePresence();
        removeView();
    });
}

export const threadReadOnlyAtom = atom(
    (get) =>
        !!get(otherThreadWriterAtom) ||
        get(threadDeletedAtom) ||
        get(threadHistoryStaleAtom),
);
