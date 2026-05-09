/**
 * Node-side bootstrap for the BeaverExtract package.
 *
 * Loads `mupdf-wasm` and `sentencex` from disk and pre-populates the
 * shared `worker/apiCache` so subsequent calls into `worker/ops.ts` don't
 * hit the worker XHR loaders (which would crash in Node — there is no
 * `XMLHttpRequest`, and `getWorkerUrls()` is unset). The factory files
 * already detect Node (`process.versions.node`), so the only Node-side
 * concerns are: pick the file URL, read the binary, populate the cache.
 *
 * Also wires `setPDFLogger` to stderr so analyzer log lines surface in
 * CLI runs, and (Node 18 safety) installs a `globalThis.crypto` shim so
 * `worker/docCache.ts`'s `crypto.subtle.digest` fingerprint works.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { makeDocumentApi, type LibMuPdf } from "../worker/mupdfApi";
import {
    getCachedApi,
    getCachedSentencex,
    setCachedApi,
    setCachedSentencex,
} from "../worker/apiCache";
import type { SentencexModule } from "../worker/sentencexInit";
import { setPDFLogger, type PDFLogLevel } from "../logging";
import { defaultWasmDir } from "./paths";

interface SentencexFactory extends SentencexModule {
    initSync: (config: { module: ArrayBuffer | WebAssembly.Module }) => unknown;
}

declare const globalThis: {
    $libmupdf_load_font_file?: (name: string) => null;
    crypto?: { subtle?: unknown };
};

let _loggerInstalled = false;
let _mupdfPromise: Promise<void> | null = null;
let _sentencexPromise: Promise<void> | null = null;

export type CliLogLevel = "error" | "warn" | "info" | "silent";

// `PDFLogLevel` is `1 (error) | 2 (warn) | 3 (info)`. We extend with `0` to
// model "silent" (drop everything) at the sink. Default = warn so analyzer
// errors and warnings still surface but the chatty info-level doc-cache and
// trace lines stay quiet for agent / piped usage.
let _maxLevel: 0 | PDFLogLevel = 2;

const LEVEL_TO_NUM: Record<CliLogLevel, 0 | PDFLogLevel> = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
};

/**
 * Set the stderr log threshold for the Node CLI. Lines emitted via
 * `pdfLog()` / worker-side `postLog()` whose level exceeds this threshold
 * are dropped at the sink. Idempotent; the latest call wins.
 */
export function setCliLogLevel(level: CliLogLevel): void {
    _maxLevel = LEVEL_TO_NUM[level];
}

function resolveWasmDir(): string {
    return process.env.BEAVER_EXTRACT_WASM_DIR || defaultWasmDir;
}

function ensureNodeRuntimeShims(): void {
    if (typeof globalThis.$libmupdf_load_font_file !== "function") {
        globalThis.$libmupdf_load_font_file = function (_name: string) {
            return null;
        };
    }
    // Node 18 ships WebCrypto but not on `globalThis` by default. The doc
    // cache's fingerprint helper uses `crypto.subtle.digest`; without this
    // shim it silently disables caching (and logs a warning). One-time
    // copy from the `node:crypto` namespace makes the cache work everywhere.
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const nodeCrypto = require("node:crypto") as { webcrypto?: unknown };
        if (nodeCrypto.webcrypto) {
            (globalThis as Record<string, unknown>).crypto =
                nodeCrypto.webcrypto;
        }
    }
}

function ensureLoggerInstalled(): void {
    if (_loggerInstalled) return;
    setPDFLogger((msg, level) => {
        // Filter at the sink so the worker / analyzer call sites stay
        // unchanged and the threshold can be adjusted at runtime.
        if (level > _maxLevel) return;
        const prefix = level === 1 ? "ERROR" : level === 2 ? "WARN" : "INFO";
        process.stderr.write(`[pdf:${prefix}] ${msg}\n`);
    });
    _loggerInstalled = true;
}

/**
 * Idempotently loads MuPDF WASM into the shared apiCache. Subsequent
 * `ensureApi()` calls from `worker/ops.ts` short-circuit on the cached
 * value.
 */
export function ensureMuPDFNode(): Promise<void> {
    if (getCachedApi()) return Promise.resolve();
    if (_mupdfPromise) return _mupdfPromise;

    _mupdfPromise = (async () => {
        ensureNodeRuntimeShims();
        ensureLoggerInstalled();

        const wasmDir = resolveWasmDir();
        const factoryPath = join(wasmDir, "mupdf-wasm.mjs");
        const binaryPath = join(wasmDir, "mupdf-wasm.wasm");

        const wasmBinary = readFileSync(binaryPath);
        const factoryUrl = pathToFileURL(factoryPath).href;
        const mod: { default: (config: unknown) => Promise<LibMuPdf> } =
            await import(factoryUrl);
        const wasmFactory = mod.default;

        const libmupdf = await wasmFactory({
            wasmBinary,
            // The Node-aware mjs factory handles its own file resolution,
            // but `locateFile` is harmless and keeps the call site
            // consistent with the worker bootstrap.
            locateFile: (path: string) =>
                path && path.endsWith(".wasm") ? binaryPath : path,
        });
        libmupdf._wasm_init_context();

        const api = makeDocumentApi(libmupdf);
        setCachedApi(api, libmupdf);
    })();

    return _mupdfPromise.catch((e) => {
        _mupdfPromise = null;
        throw e;
    });
}

/**
 * Idempotently loads sentencex into the shared apiCache. Subsequent
 * `ensureSentencex()` calls from worker code short-circuit on the cached
 * value, which is the only thing keeping that worker init out of its
 * `getWorkerUrls()` + XHR fallback path under Node.
 */
export function ensureSentencexNode(): Promise<void> {
    if (getCachedSentencex()) return Promise.resolve();
    if (_sentencexPromise) return _sentencexPromise;

    _sentencexPromise = (async () => {
        ensureNodeRuntimeShims();
        ensureLoggerInstalled();

        const wasmDir = resolveWasmDir();
        const factoryPath = join(wasmDir, "sentencex/sentencex_wasm.js");
        const binaryPath = join(wasmDir, "sentencex/sentencex_wasm_bg.wasm");

        const wasmBinary = readFileSync(binaryPath);
        const factoryUrl = pathToFileURL(factoryPath).href;
        const mod = (await import(factoryUrl)) as SentencexFactory;

        // initSync, NOT default — same reason as the worker init: avoids
        // the wasm-bindgen shim's `import.meta.url` / `fetch(.wasm)` path.
        mod.initSync({ module: wasmBinary });
        setCachedSentencex(mod);
    })();

    return _sentencexPromise.catch((e) => {
        _sentencexPromise = null;
        throw e;
    });
}

/**
 * Loads BOTH MuPDF and sentencex into the shared cache.
 *
 * Structured-mode `extractPdf` and the overlay command both reach the
 * splitter path (`worker/sentenceExtraction.ts` → `splitterResolver.ts` →
 * `sentencexInit.ensureSentencex()`). If sentencex isn't pre-populated
 * in the shared cache, that init falls back to the worker XHR path and
 * crashes in Node. The Node API surface always uses this wrapper rather
 * than `ensureMuPDFNode()` alone.
 *
 * Cost: one extra `fs.readFileSync` of the sentencex binary (~few MB).
 */
export async function ensureExtractionRuntime(): Promise<void> {
    await Promise.all([ensureMuPDFNode(), ensureSentencexNode()]);
}
