/**
 * FIFO queue that serializes worker tasks so concurrent work cannot race on
 * shared WASM heap state (`_wasm_string`, `_wasm_matrix`, `createBuffer`
 * allocations, `_wasm_drop_document`, ...).
 *
 * Both the op dispatcher (`./index.ts`) and the doc cache's TTL-driven sweep
 * (`./docCache.ts`) enqueue through the same chain so destruction of cached
 * docs stays ordered with respect to in-flight ops.
 *
 * Limitation: a slow op (e.g. extractRawPages on a 1000-page doc) blocks
 * quick ops behind it. Worker pooling (PR #5) is the answer.
 */

let _queue: Promise<unknown> = Promise.resolve();

export function enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const next = _queue.then(work, work);
    _queue = next.catch(() => {
        // chain survives rejections
    });
    return next;
}
