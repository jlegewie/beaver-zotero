/**
 * The arithmetic behind find-in-chat navigation, kept away from the DOM.
 *
 * `useFindInChat` measures the hits and moves the container; everything it has
 * to *decide* — which hit a fresh query lands on, and which one a step away
 * from the current one reaches — lives here, where it can be reasoned about and
 * tested without a document.
 */

/**
 * Index of the first hit that starts at or below `scrollTop`, falling back to
 * the first hit when every one of them is above it.
 *
 * `offsets` are the hits' top edges within the scroll container's content, in
 * document order, and `scrollTop` is the top of what the reader can see. A new
 * query therefore lands on the nearest match going down from where the reader
 * already is, rather than throwing them to the top of a long thread.
 *
 * @returns The index, or -1 when there are no hits.
 */
export function findFirstHitAtOrBelow(offsets: number[], scrollTop: number): number {
    if (offsets.length === 0) return -1;
    const index = offsets.findIndex((top) => top >= scrollTop);
    return index === -1 ? 0 : index;
}

/**
 * The index `delta` steps away from `current`, wrapping around both ends.
 *
 * `current` is -1 when nothing is selected yet — a forward step then lands on
 * the first hit and a backward step on the last, which is what "next" and
 * "previous" mean before either has been used.
 *
 * @returns The index, or -1 when there are no hits.
 */
export function stepMatchIndex(current: number, count: number, delta: number): number {
    if (count <= 0) return -1;
    if (current < 0) return delta >= 0 ? 0 : count - 1;
    return ((current + delta) % count + count) % count;
}
