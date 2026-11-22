/** The two first-run pages new accounts are split between. */
export type FirstRunVariant = 'feature_credits' | 'where_to_start';

/**
 * Salt for the split. Changing it reassigns every account, so a new
 * experiment gets a new salt.
 */
const SPLIT_SALT = 'first_run_v2';

/** 32-bit FNV-1a over the UTF-16 code units of `text`. */
function fnv1a32(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

/**
 * The first-run page for an account: half see the feature-credit tasks, half
 * "Where should we start?".
 *
 * The split is a pure function of the user id, the same on every device and
 * recomputable in analysis: FNV-1a (32 bit) of `first_run_v2:<user id>` with
 * the id as a lowercase UUID string, modulo 100, below 50 for the credit
 * tasks. It is independent of the server's feature-credit holdout.
 */
export function getFirstRunVariant(userId: string): FirstRunVariant {
    return fnv1a32(`${SPLIT_SALT}:${userId.toLowerCase()}`) % 100 < 50
        ? 'feature_credits'
        : 'where_to_start';
}
