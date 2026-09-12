import { createStore as createJotaiStore } from "jotai";
import { ThreadRepository } from "../../src/services/threads/threadRepository";
import {
    threadEntitiesAtom,
    threadViewsAtom,
    pinsPendingAtom,
} from "../../react/atoms/threadList";

/** A renderer projection backed by a real instance repository, with transport mocked by the test. */
export function createThreadStore(repository = new ThreadRepository()) {
    const store = createJotaiStore();
    (Zotero as any).Beaver = { ...(Zotero as any).Beaver, threads: repository };
    repository.subscribe((snapshot) => {
        store.set(threadEntitiesAtom, snapshot.entities);
        store.set(threadViewsAtom, snapshot.views);
        store.set(pinsPendingAtom, snapshot.pins);
    });
    return store;
}
