/**
 * Values a window hands to a run session, copied into the session's realm.
 *
 * A session outlives the windows that view it. An object a window created
 * keeps that window's realm alive for as long as the session holds it, so
 * what a window passes in is copied. Objects of this realm are kept as they
 * are, identity included, and not descended into: state the session already
 * holds keeps its identity when a window writes a value built on it, so its
 * memoized render survives.
 */

const OWN_PROTOTYPES = new Set<object | null>([
    null,
    Object.prototype,
    Array.prototype,
    Map.prototype,
    Set.prototype,
    Date.prototype,
]);

const tagOf = (value: object): string => Object.prototype.toString.call(value);

function copy(value: unknown, seen: Map<object, unknown>): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (OWN_PROTOTYPES.has(Object.getPrototypeOf(value))) return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        seen.set(value, out);
        for (const item of value) out.push(copy(item, seen));
        return out;
    }
    switch (tagOf(value)) {
        case '[object Map]': {
            const out = new Map();
            seen.set(value, out);
            (value as Map<unknown, unknown>).forEach((item, key) => out.set(copy(key, seen), copy(item, seen)));
            return out;
        }
        case '[object Set]': {
            const out = new Set();
            seen.set(value, out);
            (value as Set<unknown>).forEach((item) => out.add(copy(item, seen)));
            return out;
        }
        case '[object Date]':
            return new Date((value as Date).getTime());
        case '[object Object]': {
            const out: Record<string, unknown> = {};
            seen.set(value, out);
            for (const key of Object.keys(value)) out[key] = copy((value as Record<string, unknown>)[key], seen);
            return out;
        }
        default:
            // Zotero objects, errors and the like: not state a session keeps.
            return value;
    }
}

/** `value` with every object of another realm copied into this one. */
export function copyIn<T>(value: T): T {
    return copy(value, new Map()) as T;
}
