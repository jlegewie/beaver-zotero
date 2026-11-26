/**
 * The chat state of the run session this window shows, as a store.
 *
 * Window code that changes the chat's state (loading a chat, leaving it,
 * answering a card) writes here, never to its own copies, which the run
 * projection keeps equal to the session's. The session lives in the plugin
 * realm: each read and write goes through its port, naming the atom, so only
 * session state and the engine's named actions can be reached.
 */

import type { createStore } from 'jotai';
import { getSessionPort } from '../../src/services/agentRuns/runSession';
import type { SessionPort } from '../../src/services/agentRuns/sessionPort';
import { sessionAtomName } from '../../src/services/agentRuns/sessionState';

type Store = ReturnType<typeof createStore>;

let cached: { port: SessionPort; store: Store } | null = null;

/** The chat state of `port`'s session, as a store. */
export function sessionStoreOf(port: SessionPort): Store {
    return {
        get: (atom: object) => port.get(sessionAtomName(atom)),
        set: (atom: object, ...args: unknown[]) => port.set(sessionAtomName(atom), ...args),
        sub: (atom: object, listener: () => void) => port.sub(sessionAtomName(atom), listener),
    } as unknown as Store;
}

/** The chat state of the session this window shows, as a store. */
export function runSessionStore(): Store {
    const port = getSessionPort();
    if (cached?.port === port) return cached.store;
    cached = { port, store: sessionStoreOf(port) };
    return cached.store;
}
