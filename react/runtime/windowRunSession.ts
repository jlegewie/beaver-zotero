/**
 * This renderer's run session.
 *
 * The session runs in the plugin realm (`Zotero.Beaver.agentRuns`). When the
 * window attaches (`attachWindowRunSession`), it registers itself as the
 * session's viewer, installs the session's port for its code, and projects
 * the session's chat state onto its store.
 *
 * A realm without the instance's registry (unit tests) runs a session of its
 * own, created here when this module loads.
 */

import { createStore } from 'jotai';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { store } from '../store';
import { RunSession, getSessionPort, installRunSession, installSessionPort } from '../../src/services/agentRuns/runSession';
import { createSessionPort, type SessionPort } from '../../src/services/agentRuns/sessionPort';
import { createViewerRunHost } from '../../src/services/agentRuns/runViewer';
import { attachRunProjection, type RunProjection } from './runProjection';
import { sessionStateAtoms } from '../../src/services/agentRuns/sessionState';
import { createWindowRunViewer } from './windowRunHost';
import { tryGetWindowRuntime } from './windowRuntime';
import type { WindowRuntime } from '../../src/runtime/instance';

let projection: RunProjection | null = null;

/** Project `port`'s state onto this window's store, replacing any earlier projection. */
function project(port: SessionPort, frameWindow: () => Window | null | undefined): RunProjection {
    projection?.detach();
    projection = attachRunProjection(port, store, sessionStateAtoms(), frameWindow);
    return projection;
}

if (!Zotero.Beaver?.agentRuns) {
    const viewer = createWindowRunViewer(store);
    const sessionStore = createStore();
    const session = new RunSession(
        sessionStore,
        agentService,
        createViewerRunHost(() => tryGetWindowRuntime()?.id, () => viewer, {
            owner: () => tryGetWindowRuntime()?.id,
            threadId: () => sessionStore.get(currentThreadIdAtom),
        }),
    );
    installRunSession(session, {
        // Attached on first use rather than here: the atoms it applies are
        // defined by modules that import this one.
        beforeFirstUse: () => {
            project(createSessionPort(session), () => tryGetWindowRuntime()?.hostWindow);
        },
    });
}

/**
 * Attach this window to its run session in the plugin realm. Called once the
 * window's runtime is ready, before any surface mounts.
 */
export function attachWindowRunSession(runtime: WindowRuntime): void {
    const registry = Zotero.Beaver?.agentRuns;
    if (!registry) return;
    const port = registry.attachWindow(runtime.id, createWindowRunViewer(store));
    installSessionPort(port);
    const attached = project(port, () => runtime.hostWindow);
    // Stop applying the session's state as soon as the window starts closing;
    // the registry ends the session itself.
    Zotero.Beaver.runtime.addWindowCleanup(runtime, () => attached.detach());
}

/**
 * Apply the session's state to the window now, streamed text included. For
 * reads that must see everything that has arrived, not only what has been
 * rendered.
 */
export function flushRunProjection(): void {
    getSessionPort();
    projection?.flush();
}
