/**
 * PDF package configuration.
 *
 * Module-scope config that lets the package run without referencing the
 * host application or its runtime globals. The host calls `configurePDF()`
 * once during startup with all the URLs, accessors, and sinks the package
 * needs.
 *
 * If the host loads this package into more than one bundle (e.g. a separate
 * main-thread bundle and UI bundle), each bundle has its own copy of this
 * module and must be configured independently. The cross-bundle
 * `MuPDFWorkerClient` singleton is shared via the `workerClientSlot`
 * accessor (which the host implements over a shared global slot).
 */

import { setPDFLogger } from "./logging";

/** Logger sink shape — `(msg, level)` where `level` follows the
 * 1=error / 2=warn / 3=info convention this package emits. */
export type PDFLogSink = (msg: string, level: number) => void;

/**
 * Cross-bundle slot accessor for the singleton `MuPDFWorkerClient`. The
 * package never sees the underlying storage (typically a property on a
 * shared global like `Zotero`).
 */
export interface PDFWorkerClientSlot {
    get(): unknown | undefined;
    set(client: unknown | undefined): void;
}

/** Worker-side URLs sent to the worker as the first message after spawn. */
export interface PDFWorkerUrls {
    mupdfWasmFactoryUrl: string;
    mupdfWasmBinaryUrl: string;
    sentencexWasmFactoryUrl: string;
    sentencexWasmBinaryUrl: string;
}

export interface PDFConfig {
    /** URL passed to `new Worker(url, { type: "module" })`. */
    workerUrl: string;
    /** Returns the host window from which the Worker is constructed. */
    getWorkerHost: () => Window | null;
    /** Cross-bundle singleton slot accessor. */
    workerClientSlot: PDFWorkerClientSlot;
    /** Logger sink (see `PDFLogSink`). */
    log: PDFLogSink;

    /** URLs forwarded to the worker via the configure message. */
    worker: PDFWorkerUrls;
}

let _config: PDFConfig | null = null;

/**
 * Install the package configuration. Idempotent — a later call replaces
 * the prior config. Hosts may call this more than once (e.g. on app
 * startup and again on window reload) without ill effect.
 *
 * Also installs the analyzer-module log sink (see `./logging.ts`) so
 * bare `pdfLog()` calls from ColumnDetector / MarginFilter / etc. land
 * in the host-configured destination.
 */
export function configurePDF(cfg: PDFConfig): void {
    _config = cfg;
    setPDFLogger((msg, level) => cfg.log(msg, level));
}

/**
 * Read the current config. Throws if `configurePDF()` has not run — the
 * package is unusable without it.
 */
export function getConfig(): PDFConfig {
    if (!_config) {
        throw new Error(
            "PDF package not configured: call configurePDF() before any PDF op.",
        );
    }
    return _config;
}

/**
 * Whether `configurePDF()` has been called. Disposal paths use this to
 * silently skip work when the package was never configured (e.g. error
 * paths during shutdown).
 */
export function isConfigured(): boolean {
    return _config !== null;
}
