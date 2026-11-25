/**
 * This renderer's run session: its private store, the window as its host, and
 * the projection that keeps the window's copies of the chat state current.
 */

import { createStore } from 'jotai';
import { agentService } from '@beaver/agent-core/transport/agentService';
import { store } from '../store';
import { RunSession, getRunSession, installRunSession } from '../../src/services/agentRuns/runSession';
import { attachRunProjection, type RunProjection } from './runProjection';
import { sessionStateAtoms } from '../../src/services/agentRuns/sessionState';
import { createWindowRunHost } from './windowRunHost';
import { tryGetWindowRuntime } from './windowRuntime';

let projection: RunProjection | null = null;

const session = new RunSession(createStore(), agentService, createWindowRunHost(store));
installRunSession(session, {
    // Attached on first use rather than here: the atoms it applies are
    // defined by modules that import this one.
    beforeFirstUse: () => {
        projection = attachRunProjection(
            session.store,
            store,
            sessionStateAtoms(),
            () => tryGetWindowRuntime()?.hostWindow,
        );
    },
});

/**
 * Apply the session's state to the window now, streamed text included. For
 * reads that must see everything that has arrived, not only what has been
 * rendered.
 */
export function flushRunProjection(): void {
    getRunSession();
    projection?.flush();
}
