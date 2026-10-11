/**
 * Feature rows from feature objects. The item models compute a row's
 * features as one object literal keyed by name, written in column order, so
 * the row is the object's values; reading them by name per item would cost
 * more than computing some of the features.
 */

/** Name lists whose feature objects were checked to be in column order. */
const ordered = new WeakSet<readonly string[]>();

/**
 * The values of a feature object in `names` order, as a new array. Throws
 * unless the object's keys are `names` in order (checked once per list).
 */
export function featureRow<K extends string>(f: Record<K, number>, names: readonly K[]): number[] {
    if (!ordered.has(names)) {
        const keys = Object.keys(f);
        if (keys.length !== names.length || keys.some((key, k) => key !== names[k])) {
            throw new Error(`Feature object is not in column order: expected ${names.join(", ")}; got ${keys.join(", ")}`);
        }
        ordered.add(names);
    }
    return Object.values<number>(f);
}
