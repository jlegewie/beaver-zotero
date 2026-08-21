/**
 * When a live run's stream has gone quiet for long enough to say so.
 *
 * A provider can spend tens of seconds reasoning before it emits anything, and
 * when it finally does it may flush a whole turn's worth of tool calls at once.
 * Nothing on the wire distinguishes that from a connection that died — both are
 * silence — so silence itself is the only signal a client has, and this module
 * is what measures it.
 *
 * The measurement is deliberately coarse. Inside normal streaming, text deltas
 * arrive tens of milliseconds apart and reasoning deltas a few hundred; the
 * waits worth reporting are thousands. `DEFAULT_QUIET_AFTER_MS` sits an order of
 * magnitude above the deltas it must not trip on and an order below the gaps it
 * is looking for, so it needs no tuning against a particular provider.
 *
 * Presentation-neutral: whether a quiet run is worth drawing anything for is
 * `runStatusVisibility`'s question, and what that looks like is the client's.
 */

import { atom } from "jotai/vanilla";

/** How long the stream must be quiet before the wait is worth reporting. */
export const DEFAULT_QUIET_AFTER_MS = 1000;

/**
 * How long a reported wait stays reported once it starts.
 *
 * Without it, an event arriving just after the threshold trips produces a
 * one-frame flash of an indicator — worse than never having shown it, because a
 * blink reads as a glitch rather than as progress.
 */
export const DEFAULT_MIN_REPORTED_MS = 500;

/**
 * A wait worth reporting, for the run named in `runId`.
 *
 * Run-scoped for the same reason `RetryState` is: the state outlives the run it
 * describes, and a client renders per-run. A renderer must match `runId` against
 * the run it is drawing before believing this, or the tail of one run's wait
 * becomes the opening of the next run's.
 */
export interface StreamQuietState {
    /** The run whose stream has gone quiet. */
    runId: string;
    /**
     * When the quiet stretch began, in epoch milliseconds: the arrival of the
     * last event, not the start of the run. A client counting the wait up on
     * screen counts from here, so the number it shows is the whole wait rather
     * than only the part after the threshold tripped.
     */
    quietSince: number;
}

/**
 * The wait currently worth reporting, or null when there is none.
 *
 * Written by a tracker (below) rather than from the event handlers directly, and
 * only on a transition: null → quiet → null. Every component reading this atom
 * would otherwise re-render on every token of every run in the thread.
 */
export const streamQuietAtom = atom<StreamQuietState | null>(null);

export interface StreamActivityTrackerOptions {
    /** Publishes a transition; a client wires this to its store. */
    publish: (state: StreamQuietState | null) => void;
    /** Overrides `DEFAULT_QUIET_AFTER_MS`. */
    quietAfterMs?: number;
    /** Overrides `DEFAULT_MIN_REPORTED_MS`. */
    minReportedMs?: number;
    /** Clock seam, for tests. */
    now?: () => number;
}

export interface StreamActivityTracker {
    /**
     * Records that something arrived for `runId`, restarting its quiet clock.
     * Call from every handler that advances a run's stream — a handler left out
     * makes its event look like more silence.
     */
    noteActivity(runId: string): void;
    /**
     * Starts a wait for `runId` immediately, dated from now.
     *
     * `noteActivity` waits out the quiet threshold, and if a wait was already
     * on screen it drops it for a second before putting it back. A backend
     * retry is already a wait the reader should see — the Retrying line lives
     * on this same indicator — and the seconds beside it should count from the
     * retry, not from the last token that prompted it.
     */
    startWait(runId: string): void;
    /**
     * Forgets the run being tracked and disarms the clock, reporting nothing.
     * Call when a run ends or is abandoned, however that happens.
     */
    reset(): void;
}

/**
 * Tracks the gap since the last stream event and reports when it gets long.
 *
 * One tracker per client, created once and shared: it owns a single timer, and
 * two trackers publishing to the same atom would fight over it.
 */
export function createStreamActivityTracker(
    options: StreamActivityTrackerOptions,
): StreamActivityTracker {
    const {
        publish,
        quietAfterMs = DEFAULT_QUIET_AFTER_MS,
        minReportedMs = DEFAULT_MIN_REPORTED_MS,
        now = () => Date.now(),
    } = options;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let runId: string | null = null;
    /** When the current quiet stretch began. */
    let quietSince = 0;
    /** The last state handed to `publish`, so a transition publishes once. */
    let reported: StreamQuietState | null = null;
    /**
     * When `reported` last became non-null. The minimum hold dates from here
     * so a wait reported immediately (`startWait`) is not held as if it had
     * already waited out `quietAfterMs`.
     */
    let reportedAt = 0;

    const disarm = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const report = (state: StreamQuietState | null) => {
        if (state === null && reported === null) return;
        if (
            state !== null &&
            reported !== null &&
            state.runId === reported.runId &&
            state.quietSince === reported.quietSince
        ) {
            return;
        }
        reported = state;
        if (state !== null) reportedAt = now();
        publish(state);
    };

    /** Publishes the current verdict and arms the next transition, if any. */
    const settle = () => {
        disarm();
        if (runId === null) return;

        const elapsed = now() - quietSince;

        if (elapsed >= quietAfterMs) {
            report({ runId, quietSince });
            // Only an event can end this wait, and an event calls noteActivity.
            return;
        }

        // The clock restarted while a wait was on screen. Hold the report for
        // the rest of its minimum and re-settle: by then the stream is either
        // flowing again or already into a fresh quiet stretch.
        if (reported !== null) {
            const held = now() - reportedAt;
            if (held < minReportedMs) {
                timer = setTimeout(settle, minReportedMs - held);
                return;
            }
        }

        report(null);
        timer = setTimeout(settle, quietAfterMs - elapsed);
    };

    return {
        noteActivity(eventRunId: string) {
            // A new run inherits nothing: its first gap is its own, and a wait
            // still reported for the previous run is over the moment this one
            // produces something.
            if (eventRunId !== runId) {
                runId = eventRunId;
                report(null);
            }
            quietSince = now();
            settle();
        },
        startWait(eventRunId: string) {
            disarm();
            runId = eventRunId;
            quietSince = now();
            report({ runId, quietSince });
        },
        reset() {
            disarm();
            runId = null;
            quietSince = 0;
            report(null);
        },
    };
}
