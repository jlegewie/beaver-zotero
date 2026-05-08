/**
 * Cross-bundle log sink for analyzer modules.
 *
 * The analyzer modules (ColumnDetector, LineDetector, MarginFilter,
 * PageExtractor, ParagraphDetector, SearchScorer, StyleAnalyzer) run in
 * BOTH the main-thread bundle (when callers like the dev test handlers
 * import them directly) AND the worker bundle (every production
 * extraction passes through `worker/ops.ts`). Bare `console.*` calls
 * from these modules bypass any host-wired log sink — a host that wires
 * `PDFConfig.log` to a structured/file destination silently loses them.
 *
 * Each bundle installs a sink at startup:
 *  - Main bundle: `configurePDF()` wires it to `PDFConfig.log`.
 *  - Worker bundle: `worker/index.ts` wires it to `postLog`, which the
 *    main-thread `MuPDFWorkerClient` forwards into `PDFConfig.log`.
 *
 * The level argument follows the package convention:
 *   1 = error, 2 = warn, 3 = info / debug.
 */

export type PDFLogLevel = 1 | 2 | 3;
export type PDFLogger = (msg: string, level: PDFLogLevel) => void;

let _logger: PDFLogger | null = null;

/**
 * Install the bundle-local log sink. Idempotent — a later call replaces
 * the prior sink. Both bundles must call this once at startup.
 */
export function setPDFLogger(fn: PDFLogger): void {
    _logger = fn;
}

/**
 * Forward a message to the installed sink. No-op when no sink has been
 * installed (so analyzer modules can be imported in isolated unit tests
 * without a configure step).
 */
export function pdfLog(msg: string, level: PDFLogLevel = 3): void {
    if (_logger) _logger(msg, level);
}
