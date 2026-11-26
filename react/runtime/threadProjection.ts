import { serverThreadBlockedAtom, threadConflictAtom, viewedHistoryRevisionAtom } from "../../src/services/agentRuns/threadAdmission";
import { getSessionPort } from "../../src/services/agentRuns/runSession";
import { claimHolderOf } from "../../src/services/agentRuns/threadWriter";
import { atom } from "jotai";
import {
    currentThreadIdAtom,
    currentThreadNameAtom,
} from "@beaver/agent-core/run-state/atoms";
import type { WindowRuntime } from "../../src/runtime/instance";
import type { ThreadPresenceSnapshot } from "../../src/services/threads/threadPresence";
import { store } from "../store";
import { recentThreadsAtom } from "../atoms/threads";
import { runSessionStore } from './runSessionStore';
import {
    threadEntitiesAtom,
    threadViewsAtom,
    pinsPendingAtom,
    sortThreadsByUpdatedAt,
} from "../atoms/threadList";
export const threadPresenceAtom = atom<ThreadPresenceSnapshot>({
    revision: 0,
    claims: [],
    viewers: [],
    history: {},
    deleted: [],
});
export const threadDeletedAtom = atom((get) => {
    const id = get(currentThreadIdAtom);
    return !!id && get(threadPresenceAtom).deleted.includes(id);
});
/**
 * The open chat's history changed in this instance since the window loaded
 * it, by something other than the session it shows (a deletion, a write
 * this window's session did not make).
 */
export const threadHistoryStaleAtom = atom((get) => {
    const id = get(currentThreadIdAtom);
    const presence = get(threadPresenceAtom);
    // Writes of the session shown keep its history current.
    const ownsThread = presence.claims.some(
        (claim) => claim.threadId === id && claim.ownerId === shownSessionClaimHolder(),
    );
    return (
        !!id &&
        !ownsThread &&
        (presence.history[id] ?? 0) !==
            get(viewedHistoryRevisionAtom)
    );
});
/** Who the presence claims of the session this window shows are held by. */
function shownSessionClaimHolder(): string | null {
    try {
        return claimHolderOf(getSessionPort().sessionId);
    } catch {
        return null;
    }
}

export function attachThreadProjection(runtime: WindowRuntime): void {
    const instance = Zotero.Beaver;
    const removeCache = instance.threads.subscribe((snapshot) => {
        if (runtime.status === "closing") return;
        store.set(threadEntitiesAtom, snapshot.entities);
        store.set(threadViewsAtom, snapshot.views);
        store.set(pinsPendingAtom, snapshot.pins);
        store.set(
            recentThreadsAtom,
            sortThreadsByUpdatedAt([...snapshot.entities.values()]).slice(0, 6),
        );
        const id = store.get(currentThreadIdAtom);
        const entity = id ? snapshot.entities.get(id) : undefined;
        if (entity) runSessionStore().set(currentThreadNameAtom, entity.name);
    });
    const removePresence = instance.presence.subscribe((snapshot) => {
        if (runtime.status !== "closing")
            store.set(threadPresenceAtom, snapshot);
    });
    const view = () => {
        const id = store.get(currentThreadIdAtom);
        instance.presence.view(runtime.id, id);
        runSessionStore().set(
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
        get(serverThreadBlockedAtom) ||
        !!get(threadConflictAtom) ||
        get(threadDeletedAtom) ||
        get(threadHistoryStaleAtom),
);
