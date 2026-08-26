/**
 * Frame-coalescing queue for streamed part events.
 *
 * The backend sends a part event carrying the whole accumulated part, several
 * times per second per run. Applying each one to `activeRunAtom` immediately
 * re-renders the thread once per event, and the work each render does grows
 * with the answer — the markdown for a long response is re-parsed from the top
 * every time. Buffering the events and applying them once per animation frame
 * caps that at the display's refresh rate without changing what is rendered:
 * parts are accumulated rather than incremental, so applying five events in one
 * store write produces exactly the state the fifth event describes.
 *
 * Frames are the pacing signal, not the guarantee: they come from the main
 * window, which stops painting while it is minimized or occluded — and the
 * reader may be watching the separate Beaver window meanwhile. A realm-safe
 * timer backstops every frame so a queue can never wait on a window that has
 * stopped painting.
 *
 * Ordering with the rest of the stream is the caller's to preserve. Anything
 * that reads or writes run state outside the part path must call
 * `flushPendingPartEvents()` first — `createWSCallbacks` wraps every other
 * WebSocket callback with that flush. The tool-call events (progress, streamed
 * args) are wrapped too, so while one of those streams the queue is flushed at
 * its rate rather than the frame rate.
 */

import { AgentRun } from '@beaver/agent-core/agents/types';
import { WSPartEvent } from '@beaver/agent-core/protocol/agentProtocol';
import { activeRunAtom, updateRunWithPart } from '@beaver/agent-core/run-state/atoms';
import { logger } from '@beaver/agent-core/platform/logger';
import { store } from '../store';

/**
 * How long a queued event may wait when the main window is not painting. Slower
 * than a frame by design: this is the floor under a throttled window, not the
 * pace the reader normally sees.
 */
const FLUSH_BACKSTOP_MS = 100;

let pendingEvents: WSPartEvent[] = [];
/** The window whose animation frame holds the pending flush, if one is armed. */
let scheduledWindow: Window | null = null;
let scheduledFrame: number | null = null;
let backstopTimer: unknown = null;

interface RealmSafeTimers {
    setTimeout: (callback: () => void, delayMs: number) => unknown;
    clearTimeout: (id: unknown) => void;
}

let resolvedFrom: unknown = null;
let resolvedTimers: RealmSafeTimers | undefined;

/**
 * Timers from the system module rather than a window, so a queue armed by a
 * window that then closes still drains (see the cross-window notes in
 * CLAUDE.md). Undefined outside Gecko, where the frame path is used alone.
 *
 * Resolved once per host object: this sits in the path a streaming response
 * runs through many times a second, and the module lookup does not need
 * repeating while the host is the same one it was resolved from.
 */
function getRealmSafeTimers(): RealmSafeTimers | undefined {
    const chromeUtils = (globalThis as any).ChromeUtils;
    if (chromeUtils === resolvedFrom) return resolvedTimers;

    resolvedFrom = chromeUtils;
    try {
        const { setTimeout: systemSetTimeout, clearTimeout: systemClearTimeout } =
            chromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
        resolvedTimers = {
            setTimeout: (callback: () => void, delayMs: number) => systemSetTimeout(callback, delayMs),
            clearTimeout: (id: unknown) => systemClearTimeout(id),
        };
    } catch {
        resolvedTimers = undefined;
    }
    return resolvedTimers;
}

function applyPendingEvents(): void {
    if (pendingEvents.length === 0) return;

    const events = pendingEvents;
    pendingEvents = [];

    store.set(activeRunAtom, (previous: AgentRun | null) => {
        // No active run: the same drop as applying a single event to null. A
        // part event for an archived run has nothing to update.
        if (!previous) return previous;
        return events.reduce((run, event) => updateRunWithPart(run, event), previous);
    });
}

function cancelScheduledFlush(): void {
    if (scheduledFrame !== null && scheduledWindow && !scheduledWindow.closed
        && typeof scheduledWindow.cancelAnimationFrame === 'function') {
        scheduledWindow.cancelAnimationFrame(scheduledFrame);
    }
    scheduledFrame = null;
    scheduledWindow = null;

    if (backstopTimer !== null) {
        getRealmSafeTimers()?.clearTimeout(backstopTimer);
        backstopTimer = null;
    }
}

/** Whether anything is armed that will drain the queue on its own. */
function isFlushScheduled(): boolean {
    return scheduledFrame !== null || backstopTimer !== null;
}

function runScheduledFlush(): void {
    cancelScheduledFlush();
    try {
        applyPendingEvents();
    } catch (error) {
        logger(`streamingPartQueue: failed to apply part events: ${error}`, 1);
    }
}

function scheduleFlush(): void {
    // The frame callback belongs to the window that scheduled it and dies with
    // it, so the window is recorded and re-checked before the queue is left in
    // its hands (see the cross-window notes in CLAUDE.md).
    const win = Zotero.getMainWindow();
    if (win && !win.closed && typeof win.requestAnimationFrame === 'function') {
        scheduledWindow = win;
        scheduledFrame = win.requestAnimationFrame(runScheduledFlush);
    }

    // The backstop covers a main window that is open but not painting, which
    // no longer delivers frames while the response is still arriving.
    const timers = getRealmSafeTimers();
    if (timers) {
        backstopTimer = timers.setTimeout(runScheduledFlush, FLUSH_BACKSTOP_MS);
    }

    // Nothing can wake the queue in this host, so it is applied now. Every
    // event still lands; it just is not coalesced.
    if (!isFlushScheduled()) applyPendingEvents();
}

/**
 * Queue a part event to be applied on the next animation frame.
 */
export function queuePartEvent(event: WSPartEvent): void {
    pendingEvents.push(event);

    if (isFlushScheduled()) {
        // A frame armed by a window that has since closed will never run, so
        // the queue is re-armed on whichever window is current.
        const frameIsLost = scheduledFrame !== null && (!scheduledWindow || scheduledWindow.closed);
        if (!frameIsLost) return;
        cancelScheduledFlush();
    }

    scheduleFlush();
}

/**
 * Apply every queued part event now.
 *
 * Call before any read or write of run state that must see the streamed text
 * that has arrived so far.
 */
export function flushPendingPartEvents(): void {
    cancelScheduledFlush();
    // Same guard as the scheduled path. Callers flush as the first step of
    // stopping a run or switching threads, and a malformed part event must not
    // abort the sequence that follows — that would leave the composer pinned on
    // a run nothing goes on to archive or cancel.
    try {
        applyPendingEvents();
    } catch (error) {
        logger(`streamingPartQueue: failed to apply part events: ${error}`, 1);
    }
}
