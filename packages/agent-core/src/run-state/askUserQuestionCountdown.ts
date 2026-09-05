/**
 * The question card's idle countdown.
 *
 * The backend tells the card how long it will wait (`timeout_seconds` on the
 * request) and, for a client that declares `ask_user_question_client_timeout`,
 * makes that window long and leaves pacing to the card. The card counts down
 * from IDLE_MS; any interaction — picking an option, typing a note, moving
 * between questions — refills it, so a user who is engaged never runs out.
 * The refill stops at the backend's window: once a touch can no longer push
 * the deadline out, the card is capped and says so, then expires just before
 * the backend would, so the answer (partial or not) always arrives first.
 *
 * Pure deadline arithmetic lives here so it can be tested without a clock or a
 * component; the hook in the card drives it from `Date.now()`.
 */

/** Idle time before an untouched card expires. */
export const QUESTION_IDLE_MS = 90_000;
/**
 * How far ahead of the backend's own expiry the card answers, so the response
 * is on the wire before the backend stops listening.
 */
export const QUESTION_SAFETY_MS = 5_000;
/** The backend's wait when the request does not say (its fixed legacy window). */
export const DEFAULT_BACKEND_TIMEOUT_MS = 120_000;

/** When the backend stops waiting, from the request's window and arrival time. */
export function backendExpiresAt(receivedAt: number, timeoutSeconds: number | null | undefined): number {
    const windowMs = timeoutSeconds != null && timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : DEFAULT_BACKEND_TIMEOUT_MS;
    return receivedAt + windowMs;
}

/** The last moment the card may still answer. */
export function hardDeadline(expiresAt: number): number {
    return expiresAt - QUESTION_SAFETY_MS;
}

/** Deadline for a card the backend drops at `expiresAt`, last touched at `now`. */
export function nextDeadline(expiresAt: number, now: number): number {
    return Math.min(now + QUESTION_IDLE_MS, hardDeadline(expiresAt));
}

/**
 * Whether a touch at `now` would no longer move the deadline: the backend's
 * window is closer than one idle window away. The card shows this so the user
 * knows engaging no longer buys time.
 */
export function isCapped(expiresAt: number, now: number): boolean {
    return now + QUESTION_IDLE_MS >= hardDeadline(expiresAt);
}

/**
 * Share of the current idle window still left, 0..1. The bar reads this: it
 * refills to 1 on a touch and drains to 0 at the deadline.
 */
export function remainingFraction(deadline: number, now: number): number {
    const remaining = deadline - now;
    if (remaining <= 0) return 0;
    return Math.min(1, remaining / QUESTION_IDLE_MS);
}
