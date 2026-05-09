/**
 * Worker-scope typing for the bundled MuPDF worker.
 *
 * tsconfig.json's `lib: ["DOM", "ES2016"]` types `self` as Window. A bare
 * `declare const self: DedicatedWorkerGlobalScope` would conflict with
 * lib.dom.d.ts. Instead, we declare a structural interface and use a
 * lazy getter cast so importing this module from Node doesn't trip
 * `ReferenceError: self is not defined` at module load.
 */

export interface DedicatedWorkerGlobalScopeLike {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    onmessage: ((ev: MessageEvent) => void) | null;
    onerror: ((ev: ErrorEvent) => void) | null;
}

let _cached: DedicatedWorkerGlobalScopeLike | null | undefined;

/**
 * Returns the worker-scope `self` cast to the worker-correct shape, or
 * `null` when called outside a Worker context (e.g. Node CLI). Cached
 * after the first lookup since `self` doesn't change at runtime.
 */
export function getWorkerSelf(): DedicatedWorkerGlobalScopeLike | null {
    if (_cached !== undefined) return _cached;
    _cached = typeof self !== "undefined"
        ? (self as unknown as DedicatedWorkerGlobalScopeLike)
        : null;
    return _cached;
}

/**
 * Worker-only variant: throws if `self` is unavailable. Use from worker
 * entry/dispatcher code where the Worker context is guaranteed.
 */
export function requireWorkerSelf(): DedicatedWorkerGlobalScopeLike {
    const w = getWorkerSelf();
    if (!w) {
        throw new Error(
            "Worker scope unavailable (`self` is undefined). This module must run in a Web Worker.",
        );
    }
    return w;
}
