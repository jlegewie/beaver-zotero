/**
 * Worker-side URL configuration.
 *
 * The worker bundle has no access to the main-thread `getConfig()` from
 * `../config.ts` — it runs in a separate realm. Instead, the main-thread
 * `MuPDFWorkerClient` posts a `{ kind: "configure", urls: {...} }` message
 * as the first frame after spawning the worker. The dispatcher in
 * `./index.ts` forwards that to `setWorkerUrls()` here.
 *
 * Op messages received before configure throw via `getWorkerUrls()`, which
 * surface as a structured failure reply on the wire.
 *
 * The configure message may also carry WASM modules the host compiled once
 * (`compiledWasm`); the init code instantiates them instead of loading and
 * compiling the binaries from the URLs.
 */

export interface WorkerUrls {
    mupdfWasmFactoryUrl: string;
    mupdfWasmBinaryUrl: string;
    sentencexWasmFactoryUrl: string;
    sentencexWasmBinaryUrl: string;
}

/** Precompiled modules from the configure message; each is optional. */
export interface WorkerCompiledWasm {
    mupdf?: WebAssembly.Module;
    sentencex?: WebAssembly.Module;
}

let _urls: WorkerUrls | null = null;
let _compiledWasm: WorkerCompiledWasm = {};

export function setWorkerUrls(urls: WorkerUrls): void {
    _urls = urls;
}

export function getWorkerUrls(): WorkerUrls {
    if (!_urls) {
        throw new Error(
            "MuPDF worker not configured: expected a configure message before any op.",
        );
    }
    return _urls;
}

export function isWorkerConfigured(): boolean {
    return _urls !== null;
}

/** Keep only values that really are compiled modules. */
export function setWorkerCompiledWasm(compiled: unknown): void {
    const value = (compiled ?? {}) as Record<string, unknown>;
    const pick = (module: unknown) =>
        typeof WebAssembly !== "undefined" && module instanceof WebAssembly.Module
            ? module
            : undefined;
    _compiledWasm = { mupdf: pick(value.mupdf), sentencex: pick(value.sentencex) };
}

export function getWorkerCompiledWasm(): WorkerCompiledWasm {
    return _compiledWasm;
}
