/**
 * The credit limit preference, sanitized on the way out.
 *
 * The preference holds a 32-bit integer, so a value large enough to wrap is
 * stored negative. The server rejects a negative limit, which would fail every
 * run until the user re-edits the field — so the value is bounded wherever it
 * is read, not only where it is written.
 */

import { getPref } from '../../src/utils/prefs';

/** Upper bound for the stored limit; above this the preference wraps negative. */
export const MAX_CREDIT_THRESHOLD = 1_000_000;

/** Fallback when the stored value cannot be used, matching the pref default. */
export const DEFAULT_CREDIT_THRESHOLD = 5;

/** Bound a candidate limit to what the preference and the server accept. */
export function clampCreditThreshold(value: number): number {
    if (!Number.isFinite(value) || value < 0) return DEFAULT_CREDIT_THRESHOLD;
    return Math.min(Math.round(value), MAX_CREDIT_THRESHOLD);
}

/** The stored credit limit, bounded. */
export function readCreditThreshold(): number {
    return clampCreditThreshold(Number(getPref('creditConfirmThreshold')));
}
