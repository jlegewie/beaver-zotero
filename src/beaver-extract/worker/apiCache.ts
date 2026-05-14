/**
 * Shared module-level cache for the WASM-backed runtime handles
 * (libmupdf + the wrapped API, plus the sentencex module).
 *
 * Two init paths populate the same slots:
 *   - Worker bundle: `wasmInit.ts` and `sentencexInit.ts` load via XHR
 *     against URLs supplied by the `configure` worker message.
 *   - Node CLI: `node/bootstrap.ts` loads via `fs.readFileSync` and a
 *     dynamic import of the factory file URL.
 *
 * Centralizing the slots here lets `worker/ops.ts` keep its single
 * `ensureApi()` call site while either init path satisfies it. The init
 * promises themselves stay private to each loader (they are an init-time
 * concurrency concern, not cache state).
 */

import type { LibMuPdf, MuPDFApi } from "./mupdfApi";
import type { SentencexModule } from "./sentencexInit";

let _libmupdf: LibMuPdf | null = null;
let _api: MuPDFApi | null = null;
let _sentencex: SentencexModule | null = null;

export function getCachedLibMuPdf(): LibMuPdf | null {
    return _libmupdf;
}

export function getCachedApi(): MuPDFApi | null {
    return _api;
}

export function setCachedApi(api: MuPDFApi, lib: LibMuPdf): void {
    _api = api;
    _libmupdf = lib;
}

export function getCachedSentencex(): SentencexModule | null {
    return _sentencex;
}

export function setCachedSentencex(mod: SentencexModule): void {
    _sentencex = mod;
}
