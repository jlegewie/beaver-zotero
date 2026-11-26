/**
 * A run session in the test's own realm, shown by the window store.
 *
 * In Zotero a window views sessions of the instance's registry. A unit test
 * has none: importing this module installs one session, on the renderer's
 * transport, with the renderer as its viewer, projected onto the window
 * store when it is first used. Import it from test files whose code reaches
 * the window's session (`getSessionPort`, `runSessionStore`).
 */
import { createStore } from 'jotai';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { store } from '../../react/store';
import { RunSession, installRunSession } from '../../src/services/agentRuns/runSession';
import { createSessionPort } from '../../src/services/agentRuns/sessionPort';
import { createViewerRunHost } from '../../src/services/agentRuns/runViewer';
import { createWindowRunViewer } from '../../react/runtime/windowRunHost';
import { projectRunSession } from '../../react/runtime/windowRunSession';
import { tryGetWindowRuntime } from '../../react/runtime/windowRuntime';

export function installLocalRunSession(): RunSession {
    const viewer = createWindowRunViewer(store);
    const sessionStore = createStore();
    const session = new RunSession(
        sessionStore,
        agentService,
        createViewerRunHost({
            viewers: () => [viewer],
            origin: () => viewer,
            issuer: () => viewer,
            owner: () => tryGetWindowRuntime()?.id,
            threadId: () => sessionStore.get(currentThreadIdAtom),
            live: () => true,
            model: () => null,
        }),
    );
    installRunSession(session, {
        // Projected on first use rather than here: the atoms it applies are
        // defined by modules that import this one.
        beforeFirstUse: () => projectRunSession(createSessionPort(session)),
    });
    return session;
}

installLocalRunSession();
