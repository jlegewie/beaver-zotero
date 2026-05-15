/**
 * sentencex-wasm bootstrap inside the worker bundle.
 *
 * Mirrors `wasmInit.ts`:
 *   1. URLs come from the configure message (see `./config.ts` and
 *      `./index.ts`). The local `const` indirection at the call site keeps
 *      esbuild from rewriting the dynamic import. `external: ["chrome://*"]`
 *      in the worker entry of `zotero-plugin.config.ts` is the
 *      belt-and-braces backup that catches any static
 *      `import "chrome://..."` a future refactor might introduce.
 *   2. Workers don't have ChromeUtils/NetUtil and `fetch('chrome://...')`
 *      is unreliable in worker scope, so XHR is the only reliable path
 *      for the WASM binary (shared via `./wasmHelpers`).
 *   3. We call the wasm-bindgen module's `initSync({ module: bytes })`
 *      directly instead of the default `__wbg_init` export, which
 *      avoids the shim's `import.meta.url` / `fetch(.wasm)` path.
 *
 * Cache state lives in `./apiCache.ts` so the Node CLI bootstrap can
 * pre-populate it via fs-based loading; subsequent `ensureSentencex()`
 * calls then short-circuit on the cached value.
 *
 * No dispose op: the module's WASM memory is owned by this worker scope
 * and dies with `worker.terminate()` (driven by `MuPDFWorkerClient.dispose`).
 */

import { loadWasmBinaryXHR } from "./wasmHelpers";
import { getWorkerUrls } from "./config";
import { getCachedSentencex, setCachedSentencex } from "./apiCache";
import type { SentencexBoundary } from "../SentencexSplitter";

/** The minimal wasm-bindgen module surface the splitter resolver uses. */
export interface SentencexModule {
    segment: (language: string, text: string) => string[];
    get_sentence_boundaries: (
        language: string,
        text: string,
    ) => SentencexBoundary[];
}

/**
 * Shape of the wasm-bindgen module exports we depend on. `initSync`
 * accepts `{ module }` in current wasm-bindgen, with a deprecated raw
 * `WebAssembly.Module` form behind a one-time warning. We pass the
 * object form.
 */
interface SentencexFactory extends SentencexModule {
    initSync: (config: { module: ArrayBuffer | WebAssembly.Module }) => unknown;
}

let _initPromise: Promise<SentencexModule> | null = null;

export async function ensureSentencex(): Promise<SentencexModule> {
    const cached = getCachedSentencex();
    if (cached) return cached;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        const urls = getWorkerUrls();
        // Local consts — keeps the dynamic-import specifier non-literal at
        // the call site (see file header).
        const factoryUrl = urls.sentencexWasmFactoryUrl;
        const binaryUrl = urls.sentencexWasmBinaryUrl;

        const wasmBinary = await loadWasmBinaryXHR(binaryUrl);

        // Dynamic import of the wasm-bindgen factory at runtime — the
        // const-indirected specifier defeats esbuild's static analysis,
        // so the bundler leaves it alone (see file header).
        const mod: SentencexFactory = (await import(
            factoryUrl
        )) as SentencexFactory;

        // initSync, NOT default — avoids the shim's import.meta.url / fetch path
        mod.initSync({ module: wasmBinary });

        setCachedSentencex(mod);
        return mod;
    })();

    try {
        return await _initPromise;
    } catch (e) {
        _initPromise = null;
        throw e;
    }
}
