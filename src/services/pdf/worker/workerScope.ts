/**
 * Worker-scope typing for the bundled MuPDF worker.
 *
 * tsconfig.json's `lib: ["DOM", "ES2016"]` types `self` as Window. A bare
 * `declare const self: DedicatedWorkerGlobalScope` would conflict with
 * lib.dom.d.ts. Instead, we declare a structural interface and use a
 * per-file cast to inform TS about the worker-correct shape of `self`.
 */

export interface DedicatedWorkerGlobalScopeLike {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    onmessage: ((ev: MessageEvent) => void) | null;
    onerror: ((ev: ErrorEvent) => void) | null;
}

/** Cast `self` to the worker-correct typing. */
export const workerSelf = self as unknown as DedicatedWorkerGlobalScopeLike;
