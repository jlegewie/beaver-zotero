/**
 * A renderer's run session on a test's own store.
 *
 * For tests that drive the engine on a store they create: the session uses
 * that store itself (no projection), the renderer's transport and the
 * renderer's window host bound to the store, so the test reads what the
 * engine wrote where it wrote it.
 */
import type { createStore } from 'jotai';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { RunSession, installRunSession } from '../../react/agentRuns/runSession';
import { createWindowRunHost } from '../../react/runtime/windowRunHost';

export function installWindowStoreRunSession(store: ReturnType<typeof createStore>): RunSession {
    const session = new RunSession(store, agentService, createWindowRunHost(store));
    installRunSession(session);
    return session;
}
