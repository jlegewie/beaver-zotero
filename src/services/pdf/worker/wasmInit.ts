/**
 * MuPDF WASM bootstrap inside the worker bundle.
 *
 * Keeping the chrome:// WASM factory dynamic at bundle time:
 *
 *   1. The actual mechanism is the indirection through a `const` variable —
 *      `await import(WASM_FACTORY_URL)` is a dynamic import whose specifier
 *      isn't a string literal at the call site, so esbuild leaves it alone.
 *   2. `external: ["chrome://*"]` in zotero-plugin.config.ts is the
 *      belt-and-braces backup that catches any static `import "chrome://..."`
 *      a future refactor might introduce. (Esbuild requires `external` to be
 *      `string[]`; a regex like /^chrome:/ is rejected.)
 *
 * The `"chrome:" + "//..."` literal-splitting below is a historical guard
 * from the pre-implementation spike — esbuild constant-folds it back to the
 * full literal in the emitted bundle, so it does NOT contribute to defeating
 * static analysis. Kept only because it's harmless and self-documenting.
 *
 * Workers don't have ChromeUtils/NetUtil and `fetch('chrome://...')` is
 * unreliable in worker scope, so XHR is the only reliable path for the
 * WASM binary.
 */

import { makeDocumentApi, type MuPDFApi, type LibMuPdf } from "./mupdfApi";
import { loadWasmBinaryXHR } from "./wasmHelpers";

const WASM_FACTORY_URL = "chrome:" + "//beaver/content/lib/mupdf-wasm.mjs";
const WASM_BINARY_URL = "chrome:" + "//beaver/content/lib/mupdf-wasm.wasm";

// MuPDF font-loading callback (must be installed before WASM init).
declare const globalThis: { $libmupdf_load_font_file?: (name: string) => null };
if (typeof globalThis.$libmupdf_load_font_file !== "function") {
    globalThis.$libmupdf_load_font_file = function (_name: string) {
        return null;
    };
}

let _libmupdf: LibMuPdf | null = null;
let _initPromise: Promise<LibMuPdf> | null = null;
let _api: MuPDFApi | null = null;

export async function ensureInit(): Promise<LibMuPdf> {
    if (_libmupdf) return _libmupdf;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        const wasmBinary = await loadWasmBinaryXHR(WASM_BINARY_URL);
        const wasmConfig = {
            wasmBinary,
            locateFile: (path: string) =>
                path && path.endsWith(".wasm") ? WASM_BINARY_URL : path,
        };

        // Dynamic import of the WASM factory at runtime — see file header.
        // esbuild leaves this dynamic because the specifier is a variable.
        const mod: { default: (config: unknown) => Promise<LibMuPdf> } =
            await import(WASM_FACTORY_URL);
        const wasmFactory = mod.default;

        const libmupdf = await wasmFactory(wasmConfig);
        libmupdf._wasm_init_context();
        _libmupdf = libmupdf;
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
 * request, so the API is cached for the worker's lifetime.
 */
export async function ensureApi(): Promise<MuPDFApi> {
    const libmupdf = await ensureInit();
    if (!_api) _api = makeDocumentApi(libmupdf);
    return _api;
}
