/**
 * Mock-config helper for unit tests of the PDF package.
 *
 * The PDF package requires `configurePDF()` before any worker / loader op.
 * Production wires it via `src/utils/configurePDFForBeaver.ts`; unit tests
 * supply a mock here so they can drive the surface without Zotero or
 * `chrome://` URLs.
 *
 * The `workerClientSlot` defaults to a small object slot (the test owns
 * the storage); pass `slotHost` to share an existing storage object
 * between configure and assertions (e.g. `globalThis.Zotero` so existing
 * tests that introspect `Zotero.__beaverMuPDFWorkerClient` continue to
 * work).
 */

import { configurePDF, type PDFConfig } from "../../src/services/pdf/config";

interface ConfigureForTestsOptions {
    /**
     * Object that owns the singleton slot (typically `globalThis.Zotero`).
     * Defaults to a fresh anonymous object — supply this when tests assert
     * against a specific slot location.
     */
    slotHost?: Record<string, unknown>;
    slotKey?: string;
    /** Override the host window (default: returns null). */
    getWorkerHost?: () => Window | null;
    /** Override the log sink (default: no-op). */
    log?: (msg: string, level: number) => void;
}

export function configurePDFForTests(opts: ConfigureForTestsOptions = {}): {
    config: PDFConfig;
    slotHost: Record<string, unknown>;
    slotKey: string;
} {
    const slotHost = opts.slotHost ?? ({} as Record<string, unknown>);
    const slotKey = opts.slotKey ?? "__beaverMuPDFWorkerClient";

    const config: PDFConfig = {
        workerUrl: "test://worker.js",
        getWorkerHost:
            opts.getWorkerHost ?? (() => null as Window | null),
        workerClientSlot: {
            get: () => slotHost[slotKey],
            set: (v) => {
                if (v === undefined) delete slotHost[slotKey];
                else slotHost[slotKey] = v;
            },
        },
        log: opts.log ?? (() => {}),
        worker: {
            mupdfWasmFactoryUrl: "test://mupdf-factory.mjs",
            mupdfWasmBinaryUrl: "test://mupdf.wasm",
            sentencexWasmFactoryUrl: "test://sentencex.js",
            sentencexWasmBinaryUrl: "test://sentencex.wasm",
        },
        mupdfService: {
            loadLoader: async () => ({
                init: async () => ({}),
                dispose: async () => {},
            }),
            baseUrl: "test://",
        },
    };

    configurePDF(config);
    return { config, slotHost, slotKey };
}
