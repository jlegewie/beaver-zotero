/**
 * Runs a callback at most once per animation frame.
 *
 * Frames are the pacing signal, not the guarantee: they come from the window
 * named when a run is armed, which stops painting while it is minimized or
 * occluded, and the reader may be watching another window meanwhile. A
 * realm-safe timer backstops every frame so a scheduled callback never waits
 * on a window that has stopped painting. In a host with neither (unit tests),
 * a scheduled callback runs at once.
 */

import { logger } from '@beaver/agent-core/platform/logger';

/**
 * How long a scheduled callback may wait when the window is not painting.
 * Slower than a frame by design: this is the floor under a throttled window,
 * not the pace the reader normally sees.
 */
const FLUSH_BACKSTOP_MS = 100;

interface RealmSafeTimers {
    setTimeout: (callback: () => void, delayMs: number) => unknown;
    clearTimeout: (id: unknown) => void;
}

let resolvedFrom: unknown = null;
let resolvedTimers: RealmSafeTimers | undefined;

/**
 * Timers from the system module rather than a window, so a callback armed by a
 * window that then closes still runs (see the cross-window notes in
 * CLAUDE.md). Undefined outside Gecko, where the frame path is used alone.
 *
 * Resolved once per host object: this sits in the path a streaming response
 * runs through many times a second.
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

export class FrameScheduler {
    /** The window whose animation frame holds the pending run, if one is armed. */
    private scheduledWindow: Window | null = null;
    private scheduledFrame: number | null = null;
    private backstopTimer: unknown = null;

    constructor(
        private readonly frameWindow: () => Window | null | undefined,
        private readonly callback: () => void,
    ) {}

    /** Run the callback on the next frame, unless a run is already armed. */
    schedule(): void {
        if (this.isScheduled()) {
            // A frame armed by a window that has since closed will never run, so
            // the scheduler falls back to system timers once its window is gone.
            const frameIsLost = this.scheduledFrame !== null && (!this.scheduledWindow || this.scheduledWindow.closed);
            if (!frameIsLost) return;
            this.cancel();
        }

        // The frame callback belongs to the window that scheduled it and dies with
        // it, so the window is recorded and re-checked before the run is left in
        // its hands (see the cross-window notes in CLAUDE.md).
        const win = this.frameWindow();
        if (win && !win.closed && typeof win.requestAnimationFrame === 'function') {
            this.scheduledWindow = win;
            this.scheduledFrame = win.requestAnimationFrame(this.run);
        }

        // The backstop covers a window that is open but not painting, which no
        // longer delivers frames.
        const timers = getRealmSafeTimers();
        if (timers) this.backstopTimer = timers.setTimeout(this.run, FLUSH_BACKSTOP_MS);

        // Nothing can wake the scheduler in this host, so the callback runs now.
        if (!this.isScheduled()) this.run();
    }

    /** Disarm a pending run without running the callback. */
    cancel(): void {
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

    /** Whether a frame or backstop is armed. */
    isScheduled(): boolean {
        return this.scheduledFrame !== null || this.backstopTimer !== null;
    }

    /** What an armed frame or backstop runs: disarm, then run the callback. */
    private readonly run = (): void => {
        this.cancel();
        try {
            this.callback();
        } catch (error) {
            logger(`frameScheduler: scheduled callback failed: ${error}`, 1);
        }
    };
}
