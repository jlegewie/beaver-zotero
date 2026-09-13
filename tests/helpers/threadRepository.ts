import { createStore as createJotaiStore } from "jotai";
import { ThreadRepository } from "../../src/services/threads/threadRepository";
import { ThreadPresence } from "../../src/services/threads/threadPresence";
import {
    threadEntitiesAtom,
    threadViewsAtom,
    pinsPendingAtom,
} from "../../react/atoms/threadList";

/**
 * A renderer projection backed by a real instance repository and a fresh
 * presence service, with transport mocked by the test.
 */
export function createThreadStore(repository = new ThreadRepository(), presence = new ThreadPresence()) {
    const store = createJotaiStore();
    (Zotero as any).Beaver = { ...(Zotero as any).Beaver, threads: repository, presence };
    repository.subscribe((snapshot) => {
        store.set(threadEntitiesAtom, snapshot.entities);
        store.set(threadViewsAtom, snapshot.views);
        store.set(pinsPendingAtom, snapshot.pins);
    });
    return store;
}
