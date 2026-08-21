/**
 * Unit tests for `@beaver/agent-core/run-state/streamActivity`.
 *
 * The tracker is the only thing standing between a provider that buffers a whole
 * turn's worth of tool calls and a pane that looks frozen for forty seconds, and
 * every way it can be wrong is a timing bug: reporting a wait that never
 * happened, flashing one for a frame, or reporting the previous run's. Fake
 * timers are the only way to pin any of that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createStreamActivityTracker,
    DEFAULT_MIN_REPORTED_MS,
    DEFAULT_QUIET_AFTER_MS,
    type StreamQuietState,
} from '@beaver/agent-core/run-state/streamActivity';

/** Records every transition, so a redundant publish is a visible failure. */
function tracked() {
    const published: (StreamQuietState | null)[] = [];
    const tracker = createStreamActivityTracker({
        publish: (state) => published.push(state),
        now: () => Date.now(),
    });
    return { tracker, published, latest: () => published[published.length - 1] };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
    vi.useRealTimers();
});

describe('createStreamActivityTracker', () => {
    it('reports nothing while deltas keep arriving', () => {
        const { tracker, published } = tracked();

        // 40 deltas, 50 ms apart: two seconds of streaming, no gap in it.
        for (let i = 0; i < 40; i++) {
            tracker.noteActivity('run-1');
            vi.advanceTimersByTime(50);
        }

        expect(published).toEqual([]);
    });

    it('reports the wait once the stream goes quiet, dated from the last event', () => {
        const { tracker, published } = tracked();
        tracker.noteActivity('run-1');
        const lastEventAt = Date.now();

        vi.advanceTimersByTime(DEFAULT_QUIET_AFTER_MS - 1);
        expect(published).toEqual([]);

        vi.advanceTimersByTime(1);
        expect(published).toEqual([{ runId: 'run-1', quietSince: lastEventAt }]);
    });

    it('keeps reporting one wait rather than republishing it as it drags on', () => {
        const { tracker, published } = tracked();
        tracker.noteActivity('run-1');

        vi.advanceTimersByTime(40_000);

        expect(published).toHaveLength(1);
    });

    it('holds a reported wait on screen for its minimum when an event lands right after', () => {
        const { tracker, published, latest } = tracked();
        tracker.noteActivity('run-1');

        // The wait goes up, then the flush the run was waiting on arrives 50 ms
        // later. Dropping it immediately would be a one-frame flash.
        vi.advanceTimersByTime(DEFAULT_QUIET_AFTER_MS);
        expect(latest()).not.toBeNull();
        tracker.noteActivity('run-1');

        vi.advanceTimersByTime(DEFAULT_MIN_REPORTED_MS - 1);
        expect(latest()).not.toBeNull();

        vi.advanceTimersByTime(1);
        expect(latest()).toBeNull();
        expect(published).toHaveLength(2);
    });

    it('restarts the clock from the event that ended the previous wait', () => {
        const { tracker, published } = tracked();
        tracker.noteActivity('run-1');
        vi.advanceTimersByTime(DEFAULT_QUIET_AFTER_MS);

        tracker.noteActivity('run-1');
        const secondEventAt = Date.now();
        // Past the minimum-reported hold, so the first wait has been retired.
        vi.advanceTimersByTime(DEFAULT_QUIET_AFTER_MS);

        expect(published).toEqual([
            { runId: 'run-1', quietSince: secondEventAt - DEFAULT_QUIET_AFTER_MS },
            null,
            { runId: 'run-1', quietSince: secondEventAt },
        ]);
    });

    it('drops the previous run\'s wait the moment a new run produces something', () => {
        const { tracker, published, latest } = tracked();
        tracker.noteActivity('run-1');
        vi.advanceTimersByTime(DEFAULT_QUIET_AFTER_MS);
        expect(latest()).toEqual({ runId: 'run-1', quietSince: expect.any(Number) });

        // No minimum-reported hold across a run boundary: the old run's wait is
        // over, and holding it would date the new run's opening from the old one.
        tracker.noteActivity('run-2');
        expect(latest()).toBeNull();

        vi.advanceTimersByTime(DEFAULT_QUIET_AFTER_MS);
        expect(latest()).toEqual({ runId: 'run-2', quietSince: expect.any(Number) });
        expect(published).toHaveLength(3);
    });

    it('reports nothing more after a reset, however long the silence lasts', () => {
        const { tracker, published, latest } = tracked();
        tracker.noteActivity('run-1');
        vi.advanceTimersByTime(DEFAULT_QUIET_AFTER_MS);
        expect(latest()).not.toBeNull();

        tracker.reset();
        expect(latest()).toBeNull();

        vi.advanceTimersByTime(60_000);
        expect(published).toHaveLength(2);
    });

    it('does not publish a redundant null when reset finds nothing reported', () => {
        const { tracker, published } = tracked();
        tracker.noteActivity('run-1');
        tracker.reset();
        tracker.reset();

        expect(published).toEqual([]);
    });

    it('starts clean after a reset rather than resuming the old clock', () => {
        const { tracker, latest } = tracked();
        tracker.noteActivity('run-1');
        vi.advanceTimersByTime(500);
        tracker.reset();

        // A stale clock would trip 500 ms in; this one owes a full threshold.
        tracker.noteActivity('run-1');
        vi.advanceTimersByTime(DEFAULT_QUIET_AFTER_MS - 1);
        expect(latest()).toBeUndefined();

        vi.advanceTimersByTime(1);
        expect(latest()).toEqual({ runId: 'run-1', quietSince: expect.any(Number) });
    });
});
