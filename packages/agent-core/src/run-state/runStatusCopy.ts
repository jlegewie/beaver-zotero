/**
 * User-facing copy for a run that is in trouble but has not ended.
 *
 * Shared across clients so the same wait reads the same everywhere.
 * Presentation-neutral: no markup, styling, or host APIs.
 *
 * Two different things can be keeping a run waiting, and they are deliberately
 * not described in the same amount of detail:
 *
 * - A **backend** retry reads as `Retrying…` and nothing else. Its `reason` and
 *   its attempt numbers are left out because the reader can act on neither: the
 *   reason names a server-side failure they have no part in, and the count is
 *   the server's own budget rather than a wait they get to decide about.
 * - A **client** reconnect does show its attempt numbers. A reconnect that is
 *   counting up is the difference between "wait a moment" and "something is
 *   wrong", and that is a judgement only the reader can make.
 *
 * The idle label can carry a count of the seconds waited, for the same reason.
 * A still spinner says only "something may be happening"; a number climbing past
 * it says "and it has been happening for a while, and this pane is alive enough
 * to keep telling you so", which is what a thirty-second wait needs.
 */

import type { ReconnectState, RetryState } from "./atoms";

/**
 * What to show on a status line for a run that is waiting.
 *
 * Reconnecting wins over a backend retry, which wins over `idleLabel`: a
 * reconnect is about the connection carrying the run and so outranks anything
 * happening over it, and both are more specific than whatever the caller says
 * when nothing is wrong.
 */
export function runStatusText(state: {
    /** This client is reconnecting a failed connect attempt, or null. */
    reconnect: ReconnectState | null;
    /**
     * The backend retrying the model request for *the run this text describes*,
     * or null. Filtering by run is the caller's job: the state names the run it
     * belongs to, and a caller that renders per-run must check it.
     */
    backendRetry: RetryState | null;
    /** What to say when neither is happening. */
    idleLabel: string;
    /**
     * How long the run has been waiting, appended to `idleLabel` alone: the two
     * branches above carry their own progress, and a second number beside an
     * attempt count reads as part of it. Omit it, or pass null, to say nothing —
     * a caller is expected to withhold it until the wait is long enough that a
     * bare spinner starts to look stuck.
     */
    elapsedSeconds?: number | null;
}): string {
    if (state.reconnect) {
        // The shared connect-retry loop reports the attempt it is *about* to
        // make, so its first report is already attempt 2 and the numberless
        // branch below is never taken from it. That branch is for a caller that
        // reports the attempt currently in flight, where a bare "(1/4)" would
        // be counting a first try as a retry.
        return state.reconnect.attempt > 1
            ? `Reconnecting… (${state.reconnect.attempt}/${state.reconnect.maxAttempts})`
            : "Reconnecting…";
    }
    if (state.backendRetry) return "Retrying…";
    const seconds = state.elapsedSeconds;
    if (seconds === null || seconds === undefined || seconds < 1) {
        return state.idleLabel;
    }
    // A middot keeps the number from reading as a duration of generation
    // ("Generating 8s") or as time remaining.
    return `${state.idleLabel} · ${Math.floor(seconds)}s`;
}
