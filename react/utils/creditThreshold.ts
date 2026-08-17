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

/**
 * Lowest limit worth setting. At 1 the user is asked about any request that
 * costs credits beyond its own base cost; below that the setting would only
 * ever mean the same thing, so it is refused rather than silently accepted.
 */
export const MIN_CREDIT_THRESHOLD = 1;

/** Fallback when the stored value cannot be used, matching the pref default. */
export const DEFAULT_CREDIT_THRESHOLD = 5;

/** Bound a candidate limit to what the preference and the server accept. */
export function clampCreditThreshold(value: number): number {
    if (!Number.isFinite(value) || value < MIN_CREDIT_THRESHOLD) {
        return DEFAULT_CREDIT_THRESHOLD;
    }
    return Math.min(Math.round(value), MAX_CREDIT_THRESHOLD);
}

/** The stored credit limit, bounded. */
export function readCreditThreshold(): number {
    return clampCreditThreshold(Number(getPref('creditConfirmThreshold')));
}

/**
 * What a typed credit-limit entry means.
 *
 * `never` is an empty field, which is a deliberate choice and not an invalid
 * entry. `invalid` is anything that is not a usable limit; the caller restores
 * what is stored rather than writing it.
 */
export type CreditLimitEntry =
    | { kind: 'never' }
    | { kind: 'limit'; value: number }
    | { kind: 'invalid' };

/** Interpret the credit-limit field's text. */
export function parseCreditLimitEntry(text: string): CreditLimitEntry {
    const entry = text.trim();
    if (entry === '') return { kind: 'never' };
    const parsed = Number(entry);
    if (!Number.isFinite(parsed) || parsed < MIN_CREDIT_THRESHOLD) {
        return { kind: 'invalid' };
    }
    return { kind: 'limit', value: clampCreditThreshold(parsed) };
}
