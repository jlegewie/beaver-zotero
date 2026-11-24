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
 * Frames are the pacing signal, not the guarantee: they come from the runtime host
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
import type { createStore } from 'jotai';
import { store } from '../store';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';

/**
 * How long a queued event may wait when the main window is not painting. Slower
 * than a frame by design: this is the floor under a throttled window, not the
 * pace the reader normally sees.
 */
const FLUSH_BACKSTOP_MS = 100;

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

type Store = ReturnType<typeof createStore>;

/**
 * One run session's queue. The session applies the queued events to its own
 * store; frames come from whichever window `frameWindow` names when a flush is
 * armed.
 */
export class PartEventQueue {
    private pendingEvents: WSPartEvent[] = [];
    /** The window whose animation frame holds the pending flush, if one is armed. */
    private scheduledWindow: Window | null = null;
    private scheduledFrame: number | null = null;
    private backstopTimer: unknown = null;

    constructor(
        private readonly store: Store,
        private readonly frameWindow: () => Window | null | undefined,
    ) {}

    /**
     * Queue a part event to be applied on the next animation frame.
     */
    queue(event: WSPartEvent): void {
        this.pendingEvents.push(event);

        if (this.isFlushScheduled()) {
            // A frame armed by a window that has since closed will never run, so
            // the queue falls back to system timers once its runtime is gone.
            const frameIsLost = this.scheduledFrame !== null && (!this.scheduledWindow || this.scheduledWindow.closed);
            if (!frameIsLost) return;
            this.cancelScheduledFlush();
        }

        this.scheduleFlush();
    }

    /**
     * Apply every queued part event now. Also what an armed frame or backstop
     * runs.
     *
     * Call before any read or write of run state that must see the streamed text
     * that has arrived so far.
     */
    readonly flush = (): void => {
        this.cancelScheduledFlush();
        // Same guard as the scheduled path. Callers flush as the first step of
        // stopping a run or switching threads, and a malformed part event must not
        // abort the sequence that follows — that would leave the composer pinned on
        // a run nothing goes on to archive or cancel.
        try {
            this.applyPendingEvents();
        } catch (error) {
            logger(`streamingPartQueue: failed to apply part events: ${error}`, 1);
        }
    };

    private applyPendingEvents(): void {
        if (this.pendingEvents.length === 0) return;

        const events = this.pendingEvents;
        this.pendingEvents = [];

        this.store.set(activeRunAtom, (previous: AgentRun | null) => {
            // No active run: the same drop as applying a single event to null. A
            // part event for an archived run has nothing to update.
            if (!previous) return previous;
            return events.reduce((run, event) => updateRunWithPart(run, event), previous);
        });
    }

    private cancelScheduledFlush(): void {
        const win = this.scheduledWindow;
        if (this.scheduledFrame !== null && win && !win.closed
            && typeof win.cancelAnimationFrame === 'function') {
            win.cancelAnimationFrame(this.scheduledFrame);
        }
        this.scheduledFrame = null;
        this.scheduledWindow = null;

        if (this.backstopTimer !== null) {
            getRealmSafeTimers()?.clearTimeout(this.backstopTimer);
            this.backstopTimer = null;
        }
    }

    /** Whether anything is armed that will drain the queue on its own. */
    private isFlushScheduled(): boolean {
        return this.scheduledFrame !== null || this.backstopTimer !== null;
    }

    private scheduleFlush(): void {
        // The frame callback belongs to the window that scheduled it and dies with
        // it, so the window is recorded and re-checked before the queue is left in
        // its hands (see the cross-window notes in CLAUDE.md).
        const win = this.frameWindow();
        if (win && !win.closed && typeof win.requestAnimationFrame === 'function') {
            this.scheduledWindow = win;
            this.scheduledFrame = win.requestAnimationFrame(this.flush);
        }

        // The backstop covers a main window that is open but not painting, which
        // no longer delivers frames while the response is still arriving.
        const timers = getRealmSafeTimers();
        if (timers) {
            this.backstopTimer = timers.setTimeout(this.flush, FLUSH_BACKSTOP_MS);
        }

        // Nothing can wake the queue in this host, so it is applied now. Every
        // event still lands; it just is not coalesced.
        if (!this.isFlushScheduled()) this.applyPendingEvents();
    }
}

/** The queue of this renderer's run session, paced by the renderer's window. */
export const windowPartQueue = new PartEventQueue(store, () => tryGetWindowRuntime()?.hostWindow);

/**
 * Queue a part event on this renderer's queue.
 */
export function queuePartEvent(event: WSPartEvent): void {
    windowPartQueue.queue(event);
}

/**
 * Apply every part event queued on this renderer's queue now.
 */
export function flushPendingPartEvents(): void {
    windowPartQueue.flush();
}
