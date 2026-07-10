/**
 * Mock-config helper for unit tests of the PDF package.
 *
 * The PDF package requires `configurePDF()` before any worker op.
 * Production wires it via `src/utils/configurePDFForBeaver.ts`; unit tests
 * supply a mock here so they can drive the surface without Zotero or
 * `chrome://` URLs.
 *
 * The slots default to a small object host (the test owns the storage);
 * pass `slotHost` to share an existing storage object between configure
 * and assertions (e.g. `globalThis.Zotero` so existing tests that
 * introspect `Zotero.__beaverMuPDFWorkerClient_*` continue to work).
 *
 * `slotKey` is kept for back-compat with tests that customize the hot slot
 * key. Background slot key derives from it by replacing the suffix where
 * possible; otherwise a separate suffix is appended.
 */

import {
    configurePDF,
    type PDFConfig,
    type WorkerStartFailureInfo,
} from "../../src/beaver-extract/config";

interface ConfigureForTestsOptions {
    /**
     * Object that owns the singleton slots (typically `globalThis.Zotero`).
     * Defaults to a fresh anonymous object — supply this when tests assert
     * against a specific slot location.
     */
    slotHost?: Record<string, unknown>;
    /** Hot-slot key. Defaults to `__beaverMuPDFWorkerClient_hot`. */
    slotKey?: string;
    /** Background-slot key. Defaults to `__beaverMuPDFWorkerClient_background`. */
    backgroundSlotKey?: string;
    /** Override the host window (default: returns null). */
    getWorkerHost?: () => Window | null;
    /** Override the log sink (default: no-op). */
    log?: (msg: string, level: number) => void;
    /** Host hook for worker start-phase failures (default: unset). */
    onWorkerStartFailure?: (info: WorkerStartFailureInfo) => void;
}

export function configurePDFForTests(opts: ConfigureForTestsOptions = {}): {
    config: PDFConfig;
    slotHost: Record<string, unknown>;
    slotKey: string;
    backgroundSlotKey: string;
} {
    const slotHost = opts.slotHost ?? ({} as Record<string, unknown>);
    const slotKey = opts.slotKey ?? "__beaverMuPDFWorkerClient_hot";
    const backgroundSlotKey =
        opts.backgroundSlotKey
        ?? deriveBackgroundSlotKey(slotKey);

    const makeSlot = (key: string) => ({
        get: () => slotHost[key],
        set: (v: unknown) => {
            if (v === undefined) delete slotHost[key];
            else slotHost[key] = v;
        },
    });

    const config: PDFConfig = {
        workerUrl: "test://worker.js",
        getWorkerHost:
            opts.getWorkerHost ?? (() => null as Window | null),
        workerClientSlots: {
            hot: makeSlot(slotKey),
            background: makeSlot(backgroundSlotKey),
        },
        log: opts.log ?? (() => {}),
        onWorkerStartFailure: opts.onWorkerStartFailure,
        worker: {
            mupdfWasmFactoryUrl: "test://mupdf-factory.mjs",
            mupdfWasmBinaryUrl: "test://mupdf.wasm",
            sentencexWasmFactoryUrl: "test://sentencex.js",
            sentencexWasmBinaryUrl: "test://sentencex.wasm",
        },
    };

    configurePDF(config);
    return { config, slotHost, slotKey, backgroundSlotKey };
}

function deriveBackgroundSlotKey(hotKey: string): string {
    if (hotKey.endsWith("_hot")) {
        return `${hotKey.slice(0, -"_hot".length)}_background`;
    }
    return `${hotKey}_background`;
}
