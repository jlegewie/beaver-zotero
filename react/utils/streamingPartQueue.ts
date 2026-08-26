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
 * Ordering with the rest of the stream is the caller's to preserve. Anything
 * that reads or writes run state outside the part path must call
 * `flushPendingPartEvents()` first — `createWSCallbacks` wraps every other
 * WebSocket callback with that flush.
 */

import { AgentRun } from '@beaver/agent-core/agents/types';
import { WSPartEvent } from '@beaver/agent-core/protocol/agentProtocol';
import { activeRunAtom, updateRunWithPart } from '@beaver/agent-core/run-state/atoms';
import { logger } from '@beaver/agent-core/platform/logger';
import { store } from '../store';

let pendingEvents: WSPartEvent[] = [];
/** The window whose animation frame holds the pending flush, if one is armed. */
let scheduledWindow: Window | null = null;
let scheduledFrame: number | null = null;

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
}

function scheduleFlush(): void {
    // The frame callback belongs to the window that scheduled it and dies with
    // it, so the window is recorded and re-checked before the queue is left in
    // its hands (see the cross-window notes in CLAUDE.md).
    const win = Zotero.getMainWindow();
    if (!win || win.closed || typeof win.requestAnimationFrame !== 'function') {
        applyPendingEvents();
        return;
    }

    scheduledWindow = win;
    scheduledFrame = win.requestAnimationFrame(() => {
        scheduledFrame = null;
        scheduledWindow = null;
        try {
            applyPendingEvents();
        } catch (error) {
            logger(`streamingPartQueue: failed to apply part events: ${error}`, 1);
        }
    });
}

/**
 * Queue a part event to be applied on the next animation frame.
 */
export function queuePartEvent(event: WSPartEvent): void {
    pendingEvents.push(event);

    if (scheduledFrame !== null) {
        // A flush armed by a window that has since closed will never run.
        if (scheduledWindow && !scheduledWindow.closed) return;
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
    applyPendingEvents();
}
