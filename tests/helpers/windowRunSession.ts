/**
 * A renderer's run session on a test's own store.
 *
 * For tests that drive the engine on a store they create: the session uses
 * that store itself (no projection), the renderer's transport and the
 * renderer as its viewer, bound to the store, so the test reads what the
 * engine wrote where it wrote it.
 */
import type { createStore } from 'jotai';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { RunSession, installRunSession } from '../../src/services/agentRuns/runSession';
import '../../src/services/agentRuns/sessionPort';
import { createViewerRunHost } from '../../src/services/agentRuns/runViewer';
import { createWindowRunViewer } from '../../react/runtime/windowRunHost';
import { tryGetWindowRuntime } from '../../react/runtime/windowRuntime';

export function installWindowStoreRunSession(store: ReturnType<typeof createStore>): RunSession {
    const viewer = createWindowRunViewer(store);
    const session = new RunSession(store, agentService, createViewerRunHost({
        viewers: () => [viewer],
        origin: () => viewer,
        issuer: () => viewer,
        owner: () => tryGetWindowRuntime()?.id,
        threadId: () => store.get(currentThreadIdAtom),
        live: () => true,
        model: () => null,
    }));
    installRunSession(session);
    return session;
}
