/**
 * The bounds a credit limit has to satisfy and how a typed one is read.
 *
 * Shared so every client offers exactly the range the server accepts — a second
 * copy of these numbers is a copy that drifts. Reading and writing the stored
 * limit stays with the client, since that is the one part that is host-specific.
 */

/** Upper bound for the stored limit; see `clampCreditThreshold` for why it exists. */
export const MAX_CREDIT_THRESHOLD = 1_000_000;

/**
 * Lowest limit worth setting. At 1 the user is asked about any request that
 * costs credits beyond its own base cost; below that the setting would only
 * ever mean the same thing, so it is refused rather than silently accepted.
 */
export const MIN_CREDIT_THRESHOLD = 1;

/**
 * Fallback when a stored value cannot be used. Clients are expected to default
 * their own stored limit to this same number, so an untouched setting and an
 * unusable one behave alike.
 */
export const DEFAULT_CREDIT_THRESHOLD = 5;

/**
 * Bound a candidate limit to what a client can store and the server accepts.
 *
 * The upper bound is not cosmetic: a preference store that holds this in a
 * 32-bit integer records a large enough value as a negative one, and the server
 * rejects a negative limit — which fails every run until the user re-edits the
 * field. Clamping on the way out as well as the way in is what keeps a value
 * already stored by an older build from doing that.
 */
export function clampCreditThreshold(value: number): number {
    if (!Number.isFinite(value) || value < MIN_CREDIT_THRESHOLD) {
        return DEFAULT_CREDIT_THRESHOLD;
    }
    return Math.min(Math.round(value), MAX_CREDIT_THRESHOLD);
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
