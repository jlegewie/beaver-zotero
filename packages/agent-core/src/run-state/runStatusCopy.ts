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

/** A reattach shorter than this is never shown: a blip stays invisible. */
export const RECONNECT_SHOW_AFTER_MS = 1000;

/** After this long, the reconnect copy says how long the server holds the run. */
export const RECONNECT_ESCALATE_AFTER_MS = 30_000;

/**
 * How far along a reconnect is, for what to show: nothing yet (`hidden`), a
 * quiet "Reconnecting…", or the escalated `still` copy. A connect retry
 * carries no start time and is shown as soon as it is reported.
 */
export type ReconnectPhase = "hidden" | "reconnecting" | "still";

export function reconnectPhase(state: ReconnectState, now: number): ReconnectPhase {
    if (state.since === undefined) return "reconnecting";
    const elapsed = now - state.since;
    if (elapsed < RECONNECT_SHOW_AFTER_MS) return "hidden";
    return elapsed < RECONNECT_ESCALATE_AFTER_MS ? "reconnecting" : "still";
}

/** Milliseconds until `reconnectPhase` changes, or null when it no longer will. */
export function msUntilReconnectPhaseChange(state: ReconnectState, now: number): number | null {
    if (state.since === undefined) return null;
    const elapsed = now - state.since;
    if (elapsed < RECONNECT_SHOW_AFTER_MS) return RECONNECT_SHOW_AFTER_MS - elapsed;
    if (elapsed < RECONNECT_ESCALATE_AFTER_MS) return RECONNECT_ESCALATE_AFTER_MS - elapsed;
    return null;
}

/**
 * The grace period as the user reads it. Rounded down, so "up to" never
 * promises more time than the server gives.
 */
function graceText(graceMs: number | undefined): string | null {
    if (!graceMs || graceMs <= 0) return null;
    if (graceMs >= 60_000) {
        const minutes = Math.floor(graceMs / 60_000);
        return minutes === 1 ? "1 minute" : `${minutes} minutes`;
    }
    return `${Math.floor(graceMs / 1000)} seconds`;
}

/** The copy for a reconnect that has gone on for a while. */
export function stillReconnectingText(graceMs: number | undefined): string {
    const grace = graceText(graceMs);
    return grace
        ? `Still reconnecting… Beaver keeps your response running for up to ${grace}.`
        : "Still reconnecting…";
}

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
    /**
     * The time to judge a reattach's phase by (default: now). A reattach that
     * is still `hidden` reads as no reconnect at all; a caller showing this
     * text re-renders when the phase changes (see `msUntilReconnectPhaseChange`).
     */
    now?: number;
    /** Leave the grace period out of the escalated copy, for a line that clips. */
    compact?: boolean;
}): string {
    const phase = state.reconnect
        ? reconnectPhase(state.reconnect, state.now ?? Date.now())
        : null;
    if (state.reconnect && phase === "still") {
        return state.compact
            ? stillReconnectingText(undefined)
            : stillReconnectingText(state.reconnect.graceMs);
    }
    if (state.reconnect && phase === "reconnecting") {
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
