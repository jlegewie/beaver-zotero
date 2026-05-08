/**
 * PDF package configuration.
 *
 * Module-scope config that lets the package run without referencing Zotero,
 * Firefox/XULRunner globals (`ChromeUtils`), or Beaver utilities. The host
 * application (Beaver, here — see `src/utils/configurePDFForBeaver.ts`)
 * calls `configurePDF()` once during startup with all the URLs, accessors,
 * and sinks the package needs.
 *
 * Each bundle (esbuild `src/`, webpack `react/`) has its own copy of this
 * module. Both must be configured. The cross-bundle `MuPDFWorkerClient`
 * singleton is shared via the `workerClientSlot` accessor (which the host
 * implements over a shared global slot like `Zotero.__beaverMuPDFWorkerClient`).
 */

/** Logger sink shape — matches Beaver's `(msg, level)` signature. */
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
    /** Logger sink — same `(msg, level)` shape as Beaver's `logger`. */
    log: PDFLogSink;

    /** URLs forwarded to the worker via the configure message. */
    worker: PDFWorkerUrls;
}

let _config: PDFConfig | null = null;

/**
 * Install the package configuration. Idempotent — a later call replaces
 * the prior config. Beaver may call this from both `onStartup()` and
 * `onMainWindowLoad()` (macOS close-last-window-then-reopen).
 */
export function configurePDF(cfg: PDFConfig): void {
    _config = cfg;
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
