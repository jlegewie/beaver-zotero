/**
 * Beaver-side adapter for the PDF package.
 *
 * Sole owner of the Zotero / Firefox glue (`chrome://` URLs,
 * `ChromeUtils.importESModule`, the per-name `Zotero.__beaverMuPDFWorkerClient_*`
 * singleton slots, the Beaver logger). The package itself
 * (`src/beaver-extract/`) has no Zotero awareness; it just consumes the
 * config installed here.
 *
 * Called once per bundle:
 *  - esbuild (`src/`): from `src/hooks.ts` — both `onStartup()` and
 *    `onMainWindowLoad()` (idempotent; macOS may close the last window
 *    without quitting the app, so the main-window-load path must
 *    re-bootstrap independently).
 *  - webpack (`react/`): from `react/index.tsx` at module-init time.
 */

import {
    configurePDF,
    type PDFTimerFunctions,
    type WorkerStartFailureInfo,
} from "../beaver-extract/config";
import { logger } from "./logger";

/**
 * Realm-independent timers for the PDF package's internal watchdogs (idle
 * reap, busy-age lease, configure timeout). The package's module realm is
 * a specific window's bundle; bare `setTimeout` there dies with that
 * window even though the shared client survives on the `Zotero` global
 * (macOS can close the last window without quitting). `Timer.sys.mjs`
 * timers live in the shared system global, so watchdogs keep firing
 * across window generations.
 */
function getRealmSafeTimers(): PDFTimerFunctions | undefined {
    try {
        const { setTimeout: systemSetTimeout, clearTimeout: systemClearTimeout } =
            (globalThis as any).ChromeUtils.importESModule(
                "resource://gre/modules/Timer.sys.mjs",
            );
        return {
            setTimeout: (callback: () => void, delayMs: number) =>
                systemSetTimeout(callback, delayMs),
            clearTimeout: (id: unknown) => systemClearTimeout(id),
        };
    } catch {
        // Non-Gecko host (unit tests): the package falls back to the
        // module realm's timers, which cannot outlive the process there.
        return undefined;
    }
}

/**
 * Options for `configurePDFForBeaver`.
 *
 * `onWorkerStartFailure` is supplied only by the webpack (React) bundle
 */
export interface ConfigurePDFForBeaverOptions {
    onWorkerStartFailure?: (info: WorkerStartFailureInfo) => void;
}

/**
 * Install the PDF package config for Beaver. Idempotent — a later call
 * replaces the prior config.
 */
export function configurePDFForBeaver(options: ConfigurePDFForBeaverOptions = {}): void {
    configurePDF({
        workerUrl: "chrome://beaver/content/scripts/mupdf-worker.js",
        getWorkerHost: () => Zotero.getMainWindow?.() ?? null,
        onWorkerStartFailure: options.onWorkerStartFailure,
        timers: getRealmSafeTimers(),
        workerClientSlots: {
            hot: {
                get: () => (Zotero as any).__beaverMuPDFWorkerClient_hot,
                set: (v) => {
                    (Zotero as any).__beaverMuPDFWorkerClient_hot = v;
                },
            },
            background: {
                get: () => (Zotero as any).__beaverMuPDFWorkerClient_background,
                set: (v) => {
                    (Zotero as any).__beaverMuPDFWorkerClient_background = v;
                },
            },
        },
        log: (msg, level) => logger(msg, level),
        worker: {
            mupdfWasmFactoryUrl:
                "chrome://beaver/content/lib/mupdf-wasm.mjs",
            mupdfWasmBinaryUrl:
                "chrome://beaver/content/lib/mupdf-wasm.wasm",
            sentencexWasmFactoryUrl:
                "chrome://beaver/content/lib/sentencex/sentencex_wasm.js",
            sentencexWasmBinaryUrl:
                "chrome://beaver/content/lib/sentencex/sentencex_wasm_bg.wasm",
        },
    });
}
