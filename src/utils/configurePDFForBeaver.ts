/**
 * Beaver-side adapter for the PDF package.
 *
 * Sole owner of the Zotero / Firefox glue (`chrome://` URLs,
 * `ChromeUtils.importESModule`, the `Zotero.__beaverMuPDFWorkerClient`
 * singleton slot, the Beaver logger). The package itself
 * (`src/services/pdf/`) has no Zotero awareness; it just consumes the
 * config installed here.
 *
 * Called once per bundle:
 *  - esbuild (`src/`): from `src/hooks.ts` — both `onStartup()` and
 *    `onMainWindowLoad()` (idempotent; macOS may close the last window
 *    without quitting the app, so the main-window-load path must
 *    re-bootstrap independently).
 *  - webpack (`react/`): from `react/index.tsx` at module-init time.
 */

import { configurePDF, type MuPDFLoaderModule } from "../services/pdf/config";
import { logger } from "./logger";

declare const ChromeUtils: {
    importESModule: (url: string) => any;
};

/**
 * Install the PDF package config for Beaver. Idempotent — a later call
 * replaces the prior config.
 */
export function configurePDFForBeaver(): void {
    configurePDF({
        workerUrl: "chrome://beaver/content/scripts/mupdf-worker.js",
        getWorkerHost: () => Zotero.getMainWindow?.() ?? null,
        workerClientSlot: {
            get: () => (Zotero as any).__beaverMuPDFWorkerClient,
            set: (v) => {
                (Zotero as any).__beaverMuPDFWorkerClient = v;
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
        mupdfService: {
            loadLoader: async (): Promise<MuPDFLoaderModule> => {
                const { MuPDFLoader } = ChromeUtils.importESModule(
                    "chrome://beaver/content/modules/mupdf-loader.mjs",
                );
                return MuPDFLoader as MuPDFLoaderModule;
            },
            baseUrl: "chrome://beaver/content/",
        },
    });
}
