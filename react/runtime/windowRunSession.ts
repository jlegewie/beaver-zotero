/**
 * The run session this renderer shows.
 *
 * Sessions run in the plugin realm (`Zotero.Beaver.agentRuns`), one per
 * chat. A window views the session of the chat it shows: it installs that
 * session's port for its code and projects the session's chat state onto
 * its store. Opening another chat views another session; the one left
 * behind goes on with whatever it was doing.
 *
 * A realm without the instance's registry (unit tests) has its session
 * installed by the test, and keeps it for every chat.
 */

import { store } from '../store';
import { getSessionPort, installSessionPort } from '../../src/services/agentRuns/runSession';
import type { SessionPort } from '../../src/services/agentRuns/sessionPort';
import { attachRunProjection, type RunProjection } from './runProjection';
import { sessionStateAtoms } from '../../src/services/agentRuns/sessionState';
import { createWindowRunViewer } from './windowRunHost';
import type { WindowRuntime } from '../../src/runtime/instance';
import { tryGetWindowRuntime } from './windowRuntime';

let projection: RunProjection | null = null;
let attached: WindowRuntime | null = null;
let openSeq = 0;

/**
 * Project `port`'s chat state onto this window, replacing any earlier
 * projection. A realm without a registry (unit tests) projects the session
 * it installs this way.
 */
export function projectRunSession(port: SessionPort): void {
    projection?.detach();
    const runtime = attached;
    projection = attachRunProjection(port, store, sessionStateAtoms(), () => (runtime ?? tryGetWindowRuntime())?.hostWindow);
}

/** Show `port`'s chat in this window: its state replaces the window's copies at once. */
function show(port: SessionPort): void {
    installSessionPort(port);
    projectRunSession(port);
}

/**
 * Attach this window to the instance's run sessions, showing a new chat.
 * Called once the window's runtime is ready, before any surface mounts.
 */
export function attachWindowRunSession(runtime: WindowRuntime): void {
    const registry = Zotero.Beaver?.agentRuns;
    if (!registry) throw new Error('Agent runs are not available');
    registry.attachWindow(runtime.id, createWindowRunViewer(store));
    attached = runtime;
    show(registry.open(runtime.id, null));
    // Stop applying session state as soon as the window starts closing; the
    // registry stops counting the window as a viewer itself.
    Zotero.Beaver.runtime.addWindowCleanup(runtime, () => {
        projection?.detach();
        projection = null;
        attached = null;
    });
}

/** Whether `port` is an empty new chat with nothing going, which a new chat can reuse. */
function isIdleNewChat(port: SessionPort): boolean {
    return !port.get('currentThreadId') && !port.isBusy() && (port.get('threadRuns') as unknown[]).length === 0;
}

/**
 * Show the session of `threadId` in this window (a new chat for null),
 * creating it when there is none. The chat shown before keeps its session,
 * and its run goes on. Returns the port of the session now shown.
 */
export function showChatSession(threadId: string | null): SessionPort {
    const current = getSessionPort();
    const registry = Zotero.Beaver?.agentRuns;
    if (!registry || !attached) return current;
    if (threadId === null ? isIdleNewChat(current) : current.get('currentThreadId') === threadId) return current;
    const port = registry.open(attached.id, threadId);
    show(port);
    return port;
}

/** A chat session held for a load that may still be abandoned. */
export interface PendingChatSession {
    readonly port: SessionPort;
    /** Show the session in this window. */
    show(): void;
    /** Abandon the load: release the session unless this window shows it. */
    cancel(): void;
}

/**
 * Hold the session of `threadId` without showing it yet, so a load can
 * prepare it and show it only if it succeeds.
 */
export function prepareChatSession(threadId: string): PendingChatSession {
    const current = getSessionPort();
    const registry = Zotero.Beaver?.agentRuns;
    const runtime = attached;
    if (!registry || !runtime || current.get('currentThreadId') === threadId) {
        return { port: current, show: () => {}, cancel: () => {} };
    }
    const token = `${runtime.id}:load:${++openSeq}`;
    const port = registry.acquire(token, threadId);
    let settled = false;
    const release = () => {
        if (settled) return;
        settled = true;
        registry.release(token, port.sessionId);
    };
    return {
        port,
        show: () => {
            if (settled || attached !== runtime) return release();
            show(registry.view(runtime.id, port.sessionId));
            release();
        },
        cancel: release,
    };
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
