/**
 * MuPDF WASM bootstrap inside the worker bundle.
 *
 * Keeping the WASM factory URL dynamic at bundle time:
 *
 *   1. The actual mechanism is the indirection through a local `const`
 *      variable — `await import(factoryUrl)` is a dynamic import whose
 *      specifier isn't a string literal at the call site, so esbuild
 *      leaves it alone.
 *   2. `external: ["chrome://*"]` in zotero-plugin.config.ts is the
 *      belt-and-braces backup that catches any static `import "chrome://..."`
 *      a future refactor might introduce. (Esbuild requires `external` to be
 *      `string[]`; a regex like /^chrome:/ is rejected.)
 *
 * URLs come from the configure message (see `./config.ts` and `./index.ts`)
 * — the package no longer hardcodes any `chrome://` paths.
 *
 * Workers don't have ChromeUtils/NetUtil and `fetch('chrome://...')` is
 * unreliable in worker scope, so XHR is the only reliable path for the
 * WASM binary.
 *
 * Cache state lives in `./apiCache.ts` so the Node CLI bootstrap can
 * pre-populate it via fs-based loading; subsequent `ensureApi()` calls
 * then short-circuit on the cached value.
 */

import { makeDocumentApi, type MuPDFApi, type LibMuPdf } from "./mupdfApi";
import { loadWasmBinaryXHR } from "./wasmHelpers";
import { getWorkerUrls } from "./config";
import {
    getCachedApi,
    getCachedLibMuPdf,
    setCachedApi,
} from "./apiCache";

// MuPDF font-loading callback (must be installed before WASM init).
declare const globalThis: { $libmupdf_load_font_file?: (name: string) => null };
if (typeof globalThis.$libmupdf_load_font_file !== "function") {
    globalThis.$libmupdf_load_font_file = function (_name: string) {
        return null;
    };
}

let _initPromise: Promise<LibMuPdf> | null = null;

export async function ensureInit(): Promise<LibMuPdf> {
    const cached = getCachedLibMuPdf();
    if (cached) return cached;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        const urls = getWorkerUrls();
        // Local consts — keeps the dynamic-import specifier non-literal at
        // the call site (see file header).
        const factoryUrl = urls.mupdfWasmFactoryUrl;
        const binaryUrl = urls.mupdfWasmBinaryUrl;

        const wasmBinary = await loadWasmBinaryXHR(binaryUrl);
        const wasmConfig = {
            wasmBinary,
            locateFile: (path: string) =>
                path && path.endsWith(".wasm") ? binaryUrl : path,
        };

        // Dynamic import of the WASM factory at runtime — see file header.
        // esbuild leaves this dynamic because the specifier is a variable.
        const mod: { default: (config: unknown) => Promise<LibMuPdf> } =
            await import(factoryUrl);
        const wasmFactory = mod.default;

        const libmupdf = await wasmFactory(wasmConfig);
        libmupdf._wasm_init_context();
        return libmupdf;
    })();

    try {
        return await _initPromise;
    } catch (e) {
        _initPromise = null;
        throw e;
    }
}

/**
 * Lazily build (and cache) the API wrappers around the libmupdf module.
 *
 * `makeDocumentApi` allocates real WASM heap on construction (the
 * `_wasm_string` scratch slot, the `_wasm_matrix` writer, ColorSpace
 * pointers). Calling it per-op would leak those allocations on every
 * request, so the API is cached for the worker's lifetime in `apiCache`.
 */
export async function ensureApi(): Promise<MuPDFApi> {
    const cached = getCachedApi();
    if (cached) return cached;
    const libmupdf = await ensureInit();
    const api = makeDocumentApi(libmupdf);
    setCachedApi(api, libmupdf);
    return api;
}
