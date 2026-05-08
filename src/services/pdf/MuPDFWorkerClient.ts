/**
 * MuPDFWorkerClient — main-thread client for the MuPDF WASM worker.
 *
 * Cross-bundle singleton: the client lives in a slot supplied by
 * `getConfig().workerClientSlot` — the host wires this to a shared
 * global so every bundle that imports this file (transitively or
 * directly) sees the same client. Module-scope state would otherwise
 * create one worker per bundle and shutdown would only dispose one of
 * them.
 */
import { getConfig, isConfigured } from "./config";
import {
    ExtractionError,
    ExtractionErrorCode,
    type MarginRemovalResult,
    type MarginSettings,
    type RawDocumentData,
    type RawPageDataDetailed,
    type PageImageOptions,
    type PageImageResult,
    type PDFMetadata,
    type PDFPageSearchResult,
    type ExtractionSettings,
    type ExtractionResult,
    type OCRDetectionOptions,
    type OCRDetectionResult,
    type PDFSearchOptions,
    type PDFSearchResult,
} from "./types";
import type { PageSentenceBBoxResult } from "./ParagraphSentenceMapper";
import type {
    SentenceBBoxTraceResult,
    WorkerSentenceBBoxOptions,
    WorkerSentenceBBoxTraceOptions,
} from "./sentenceTypes";

interface PendingEntry {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
}

/**
 * Optional payload carried by ExtractionError envelopes. Populated by the
 * worker when an error needs to convey additional context (e.g. NO_TEXT_LAYER
 * carries `ocrAnalysis`, `pageLabels`, `pageCount`). The wire field name
 * `ocrAnalysis` is preserved for self-documenting JSON; the rehydrated
 * ExtractionError instance stores it on `error.details` (per types.ts:599).
 */
interface WorkerExtractionErrorPayload {
    ocrAnalysis?: unknown;
    pageLabels?: Record<number, string>;
    pageCount?: number;
}

interface WorkerErrorPayload {
    name?: string;
    code?: string;
    message?: string;
    payload?: WorkerExtractionErrorPayload;
}

interface WorkerSuccessReply {
    id: number;
    ok: true;
    result: any;
}

interface WorkerFailureReply {
    id: number;
    ok: false;
    error: WorkerErrorPayload;
}

interface WorkerLogMessage {
    kind: "log";
    level: "warn" | "info" | "error";
    msg: string;
}

type WorkerReply = WorkerSuccessReply | WorkerFailureReply | WorkerLogMessage;

/**
 * Snapshot of the worker-side document cache. Mirrors the `CacheStats` type
 * declared inside `src/services/pdf/worker/docCache.ts` so the wire shape
 * stays explicit on both sides.
 */
export interface MuPDFWorkerCacheStats {
    entries: number;
    totalBytes: number;
    hits: number;
    misses: number;
    evictions: number;
    ttlMs: number;
    maxEntries: number;
    maxBytes: number;
    /** null until the worker has run a cache lookup (lazy feature-detect). */
    cryptoUsable: boolean | null;
}

/**
 * Sentinel rejection thrown when the worker dies mid-flight. Used to drive
 * a single transparent retry inside `call()`.
 */
class StaleWorkerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StaleWorkerError";
    }
}

export class MuPDFWorkerClient {
    private worker: Worker | null = null;
    private spawnedFromWindowInternal: Window | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingEntry>();
    /**
     * Once true, the client refuses to spawn a new worker. Set by `dispose()`.
     * Distinguishes a stale-but-recoverable worker (transparent retry OK) from
     * an explicit teardown (no respawn — would orphan the new worker from
     * shutdown cleanup and tie it to a closing window realm).
     */
    private disposed = false;

    /**
     * Cumulative counters surfaced via `getStats()` so a host can verify
     * dispatch fan-out without log grepping. Incremented in `call()`
     * (per-op) and `ensureWorker()` (spawn).
     */
    private spawnCount = 0;
    private retryCount = 0;
    private dispatchCounts: Record<string, number> = {};
    private lastSpawnTime: number | null = null;

    /** The window that spawned the current worker. Used for stale detection. */
    get spawnedFromWindow(): Window | null {
        return this.spawnedFromWindowInternal;
    }

    private ensureWorker(): Worker {
        if (this.disposed) {
            throw new Error("MuPDFWorkerClient: client has been disposed");
        }
        const cfg = getConfig();
        const mainWindow = cfg.getWorkerHost();
        if (!mainWindow) {
            throw new Error(
                "MuPDFWorkerClient: no main window available to spawn worker",
            );
        }

        // If the worker was spawned from a different window, treat it as stale.
        if (
            this.worker &&
            this.spawnedFromWindowInternal &&
            this.spawnedFromWindowInternal !== mainWindow
        ) {
            this.markStale("spawning window changed");
        }

        if (this.worker) return this.worker;

        const WorkerCtor = (mainWindow as any).Worker as typeof Worker;
        if (!WorkerCtor) {
            throw new Error(
                "MuPDFWorkerClient: main window has no Worker constructor",
            );
        }

        const worker = new WorkerCtor(cfg.workerUrl, { type: "module" });
        this.spawnCount++;
        this.lastSpawnTime = Date.now();
        cfg.log(`[MuPDFWorkerClient] spawned new worker`, 3);
        (worker as any).onmessage = (event: MessageEvent) =>
            this.onWorkerMessage(event);
        (worker as any).onerror = (event: any) => {
            const message = event?.message || "worker onerror";
            cfg.log(`[MuPDFWorkerClient] worker.onerror: ${message}`, 1);
            this.markStale(`worker.onerror: ${message}`);
        };
        (worker as any).onmessageerror = (event: any) => {
            const message = event?.message || "worker onmessageerror";
            cfg.log(`[MuPDFWorkerClient] worker.onmessageerror: ${message}`, 1);
            this.markStale(`worker.onmessageerror: ${message}`);
        };

        // Configure the worker before any op is dispatched. FIFO message
        // ordering on a single Worker guarantees the configure frame is
        // processed before any subsequent op postMessage. Stale-worker
        // retries flow through this same path, so retried ops are
        // automatically preceded by a fresh configure.
        worker.postMessage({ kind: "configure", urls: cfg.worker });

        this.worker = worker;
        this.spawnedFromWindowInternal = mainWindow;
        return worker;
    }

    private onWorkerMessage(event: MessageEvent): void {
        const data = event.data as WorkerReply | undefined;
        if (!data || typeof data !== "object") return;

        // Log messages are out-of-band — branch first, do not consume `pending`.
        if ((data as WorkerLogMessage).kind === "log") {
            const log = data as WorkerLogMessage;
            const level = log.level === "error" ? 1 : log.level === "warn" ? 2 : 3;
            getConfig().log(log.msg, level);
            return;
        }

        const reply = data as WorkerSuccessReply | WorkerFailureReply;
        const entry = this.pending.get(reply.id);
        if (!entry) {
            getConfig().log(
                `[MuPDFWorkerClient] received reply for unknown id ${reply.id}`,
                2,
            );
            return;
        }
        this.pending.delete(reply.id);

        if (reply.ok) {
            entry.resolve(reply.result);
        } else {
            entry.reject(rehydrateError(reply.error));
        }
    }

    /**
     * Mark the worker as stale: terminate it, reject all pending entries,
     * clear singleton state. Idempotent.
     */
    private markStale(reason: string): void {
        const w = this.worker;
        this.worker = null;
        this.spawnedFromWindowInternal = null;

        if (w) {
            try {
                w.terminate();
            } catch (_) {
                // best-effort
            }
        }

        const pendingCount = this.pending.size;
        if (pendingCount > 0 || w) {
            // Log only when configured. markStale can be reached during
            // shutdown teardown after configure has been wiped.
            if (isConfigured()) {
                getConfig().log(
                    `[MuPDFWorkerClient] markStale (${reason}); rejecting ${pendingCount} pending`,
                    2,
                );
            }
        }

        const stale = new StaleWorkerError(`stale worker: ${reason}`);
        const pending = Array.from(this.pending.values());
        this.pending.clear();
        for (const entry of pending) {
            entry.reject(stale);
        }
    }

    /**
     * Send an RPC to the worker. Transparently retries once if the worker
     * went stale between dispatch and reply.
     */
    async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
        this.dispatchCounts[op] = (this.dispatchCounts[op] ?? 0) + 1;
        getConfig().log(`[MuPDFWorkerClient] dispatch op=${op}`, 3);
        try {
            return await this.dispatch<T>(op, args);
        } catch (e) {
            // Only retry on stale-worker recovery, and only when the client is
            // still live. After dispose() the singleton slot has been cleared
            // and respawning would orphan the new worker from shutdown
            // cleanup — propagate the StaleWorkerError instead.
            if (e instanceof StaleWorkerError && !this.disposed) {
                this.retryCount++;
                getConfig().log(
                    `[MuPDFWorkerClient] retry op=${op} after stale worker`,
                    2,
                );
                return await this.dispatch<T>(op, args);
            }
            throw e;
        }
    }

    private dispatch<T>(op: string, args: Record<string, unknown>): Promise<T> {
        const worker = this.ensureWorker();
        const id = this.nextId++;

        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                worker.postMessage({ id, op, args });
            } catch (e) {
                this.pending.delete(id);
                this.markStale(
                    `postMessage threw: ${e instanceof Error ? e.message : String(e)}`,
                );
                reject(new StaleWorkerError("postMessage threw"));
            }
        });
    }

    /**
     * Get the page count of a PDF.
     *
     * Posts by copy (no transfer list) — current callers reuse `pdfData`
     * across multiple `PDFExtractor` calls, so transferring would detach the
     * caller's buffer.
     */
    async getPageCount(pdfData: Uint8Array | ArrayBuffer): Promise<number> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        const result = await this.call<{ count: number }>("getPageCount", {
            pdfData: bytes,
        });
        return result.count;
    }

    /**
     * Get document-level metadata in a single doc-open.
     *
     * Returns page count, page labels, and cheap info-dict fields
     * (title, author, format, etc.). Page-label collection requires a
     * per-page load; the info-dict reads are essentially free.
     */
    async getMetadata(
        pdfData: Uint8Array | ArrayBuffer,
    ): Promise<PDFMetadata> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<PDFMetadata>("getMetadata", { pdfData: bytes });
    }

    /**
     * Extract raw structured-text pages.
     *
     * Index handling (see `worker/docHelpers.ts:resolvePageIndices`): invalid
     * indices in `pageIndices` are silently filtered out, and an
     * empty/undefined `pageIndices` means "all pages."
     */
    async extractRawPages(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndices?: number[],
    ): Promise<RawDocumentData> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<RawDocumentData>("extractRawPages", {
            pdfData: bytes,
            pageIndices,
        });
    }

    /**
     * Cross-page margin-removal analysis without extraction or rendering.
     *
     * Backs the dev-only `/pdf-smart-removal-summary` triage endpoint.
     * Page resolution: explicit `pageIndices` wins, else `pageRange`
     * (inclusive `start..end`), else all pages. Out-of-range entries are
     * silently filtered, then capped at `DEFAULT_ANALYSIS_WINDOW_CAP`.
     *
     * **Map/Set boundary.** `result.removalsByPage` and `result.textsToRemove`
     * carry `Map`/`Set` fields. `postMessage` preserves them via structured
     * clone, but `JSON.stringify` does NOT — flatten before writing HTTP
     * responses.
     */
    async analyzeMarginRemoval(
        pdfData: Uint8Array | ArrayBuffer,
        args: {
            pageIndices?: number[];
            pageRange?: { start: number; end: number };
            repeatThreshold?: number;
            detectPageSequences?: boolean;
            marginZone?: MarginSettings;
        } = {},
    ): Promise<{
        totalPages: number;
        analysisPages: number[];
        result: MarginRemovalResult;
    }> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<{
            totalPages: number;
            analysisPages: number[];
            result: MarginRemovalResult;
        }>("analyzeMarginRemoval", { pdfData: bytes, ...args });
    }

    /**
     * Extract one page with full per-character detail (quad + bbox).
     *
     * Single-page op — out-of-range `pageIndex` throws
     * `ExtractionError(PAGE_OUT_OF_RANGE)` (rehydrated by `rehydrateError`).
     */
    async extractRawPageDetailed(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndex: number,
        options?: { includeImages?: boolean },
    ): Promise<RawPageDataDetailed> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<RawPageDataDetailed>("extractRawPageDetailed", {
            pdfData: bytes,
            pageIndex,
            includeImages: options?.includeImages,
        });
    }

    /**
     * Strict, fused render-pages variant for the agent images handler.
     *
     * Fuses page-count + page-labels + render in a single doc-open. Uses
     * the worker's strict resolvers — explicit-but-all-invalid `pageIndices`
     * (or out-of-range `pageRange`) throws `ExtractionError(PAGE_OUT_OF_RANGE)`
     * with the worker's known `pageCount` in the error payload.
     *
     * Image buffers are transferred from the worker.
     */
    async renderPages(
        pdfData: Uint8Array | ArrayBuffer,
        args?: {
            pageIndices?: number[];
            pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
            options?: PageImageOptions;
        },
    ): Promise<{ pageCount: number; pageLabels: Record<number, string>; pages: PageImageResult[] }> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<{ pageCount: number; pageLabels: Record<number, string>; pages: PageImageResult[] }>(
            "renderPages",
            {
                pdfData: bytes,
                pageIndices: args?.pageIndices,
                pageRange: args?.pageRange,
                options: args?.options,
            },
        );
    }

    /**
     * Search a PDF for a literal phrase. Returns unscored, page-level hits.
     *
     * Index handling (see `worker/docHelpers.ts:resolvePageIndices`): invalid
     * indices in `pageIndices` are silently filtered.
     */
    async searchPages(
        pdfData: Uint8Array | ArrayBuffer,
        query: string,
        pageIndices?: number[],
        maxHitsPerPage?: number,
    ): Promise<PDFPageSearchResult[]> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<PDFPageSearchResult[]>("searchPages", {
            pdfData: bytes,
            query,
            pageIndices,
            maxHitsPerPage,
        });
    }

    /**
     * Strict, fused extract variant for the agent pages handler.
     *
     * Combines page-count + page-labels + OCR check + extract in a single
     * doc-open. Uses the worker's strict resolvers — explicit-but-all-invalid
     * `pageIndices` (or out-of-range `pageRange`) throws
     * `ExtractionError(PAGE_OUT_OF_RANGE)` with the worker's known `pageCount`
     * in the error payload (rehydrated by `rehydrateError`).
     *
     * Honors `settings.useLineDetection` — when true, the per-page loop
     * runs line detection and `ProcessedPage.lines` is populated.
     */
    async extract(
        pdfData: Uint8Array | ArrayBuffer,
        args?: {
            settings?: ExtractionSettings;
            pageIndices?: number[];
            pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
        },
    ): Promise<ExtractionResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<ExtractionResult>("extract", {
            pdfData: bytes,
            settings: args?.settings,
            pageIndices: args?.pageIndices,
            pageRange: args?.pageRange,
        });
    }

    /** Detailed OCR analysis. */
    async analyzeOCRNeeds(
        pdfData: Uint8Array | ArrayBuffer,
        options?: OCRDetectionOptions,
    ): Promise<OCRDetectionResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<OCRDetectionResult>("analyzeOCRNeeds", {
            pdfData: bytes,
            options,
        });
    }

    /**
     * Search + score within one round-trip.
     *
     * `args.maxPageCount` is a pre-flight gate, not a search option — it lives
     * outside `options` so the worker can short-circuit before running the
     * search. When provided and exceeded, the worker returns a flagged result
     * (`exceedsPageCountLimit: true`) the handler maps to `too_many_pages`.
     */
    async search(
        pdfData: Uint8Array | ArrayBuffer,
        query: string,
        options?: PDFSearchOptions,
        args?: { maxPageCount?: number },
    ): Promise<PDFSearchResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<PDFSearchResult>("search", {
            pdfData: bytes,
            query,
            options,
            maxPageCount: args?.maxPageCount,
        });
    }

    /**
     * Sentence-bbox extraction with full mapper inside the worker.
     *
     * The splitter is described by a serializable `splitterConfig`
     * (sentencex with language, or simple regex). The worker resolves
     * the actual splitter function via its own `resolveSplitter`,
     * including the sentencex→simple fallback on init failure.
     *
     * `options` is restricted to `WorkerSentenceBBoxOptions`: no
     * function-valued `splitter` (not structurally cloneable) and no
     * `precomputed` (the worker always runs the full filtered-paragraph
     * pipeline; precomputed shortcuts live on the internal mapper
     * contract and are used only by main-thread debug paths).
     */
    async extractSentenceBBoxes(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndex: number,
        options?: WorkerSentenceBBoxOptions,
    ): Promise<PageSentenceBBoxResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<PageSentenceBBoxResult>("extractSentenceBBoxes", {
            pdfData: bytes,
            pageIndex,
            options,
        });
    }

    /**
     * Trace-mode sentence extraction.
     *
     * Returns the production sentence result alongside the worker
     * pipeline's intermediates (analysis-window indices, the JSON-walked
     * raw doc, the detailed target page, font-bridged `pagesForFilter`,
     * margin analysis/removal, and the filtered-paragraph result).
     *
     * Used by dev/debug surfaces — `/pdf-pipeline-trace`,
     * `/pdf-render-overlay`, the reader visualizer, and fixture capture
     * — so they all inspect the exact pipeline production used (no
     * main-thread reconstruction that can drift).
     *
     * `options.recordSplitter: true` adds a `splitterRecording` field
     * to the trace payload (deterministic deep-copies of every
     * `(text → ranges)` pair the splitter produced) for hermetic
     * unit-test replay in fixture capture.
     *
     * **Map/Set boundary.** `trace.marginAnalysis`, `trace.marginRemoval`,
     * and `trace.filteredResult.styleProfile` carry `Map`/`Set` fields.
     * `postMessage` preserves them via structured clone, but
     * `JSON.stringify` does NOT — flatten before writing HTTP responses.
     */
    async extractSentenceBBoxesTrace(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndex: number,
        options?: WorkerSentenceBBoxTraceOptions,
    ): Promise<SentenceBBoxTraceResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<SentenceBBoxTraceResult>("extractSentenceBBoxesTrace", {
            pdfData: bytes,
            pageIndex,
            options,
        });
    }

    /** Force WASM init in the worker. Useful for tests and pre-warm. */
    async ping(): Promise<void> {
        await this.call<void>("__init", {});
    }

    /**
     * Test-only: snapshot of dispatch / spawn counters. Hosts can expose
     * this through a debug endpoint so manual-test runners can verify
     * fan-out without grepping logs.
     */
    getStats(): {
        hasWorker: boolean;
        disposed: boolean;
        spawnCount: number;
        retryCount: number;
        pendingCount: number;
        nextId: number;
        dispatchCounts: Record<string, number>;
        lastSpawnTime: number | null;
    } {
        return {
            hasWorker: this.worker !== null,
            disposed: this.disposed,
            spawnCount: this.spawnCount,
            retryCount: this.retryCount,
            pendingCount: this.pending.size,
            nextId: this.nextId,
            dispatchCounts: { ...this.dispatchCounts },
            lastSpawnTime: this.lastSpawnTime,
        };
    }

    /** Test-only: zero out cumulative counters. Does not touch the worker. */
    resetStats(): void {
        this.spawnCount = 0;
        this.retryCount = 0;
        this.dispatchCounts = {};
        this.lastSpawnTime = null;
    }

    /**
     * Test-only: terminate the current worker as if it had died mid-flight.
     * Drives the same code path as a real stale-worker event so the next
     * `call()` either retries (live in-flight) or respawns on the next
     * dispatch.
     */
    markStaleForTest(reason = "test"): void {
        this.markStale(reason);
    }

    /**
     * Snapshot of the worker-side document cache. Returns null when there is
     * no live worker — this method NEVER spawns one, so reading stats from a
     * fresh client (or after `markStale`/`dispose`) is non-mutating.
     *
     * Stale-window detection: if the existing worker was spawned for a
     * different main window, mark it stale (so the next real op respawns
     * cleanly) and return null without RPCing into a doomed worker.
     *
     * Uses the uncounted dispatch path so introspection ops do not pollute
     * `dispatchCounts` (manual-test baselines depend on that).
     */
    async getCacheStats(): Promise<MuPDFWorkerCacheStats | null> {
        const worker = this.probeLiveWorker();
        if (!worker) return null;
        try {
            return await this.callUncounted<MuPDFWorkerCacheStats>(
                worker,
                "__cacheStats",
                {},
            );
        } catch (e) {
            getConfig().log(`[MuPDFWorkerClient] getCacheStats failed: ${e}`, 2);
            return null;
        }
    }

    /**
     * Test-only: clear the worker-side document cache. No-op when there is
     * no live worker. By default also resets the cache hit/miss/eviction
     * counters so live tests can assert exact values.
     *
     * Pass `{ resetCounters: false }` to keep counter history (useful when
     * the caller wants to inspect the running totals).
     */
    async clearWorkerCacheForTest(
        opts: { resetCounters?: boolean } = {},
    ): Promise<MuPDFWorkerCacheStats | null> {
        const worker = this.probeLiveWorker();
        if (!worker) return null;
        try {
            return await this.callUncounted<MuPDFWorkerCacheStats>(
                worker,
                "__cacheClear",
                { resetCounters: opts.resetCounters !== false },
            );
        } catch (e) {
            getConfig().log(
                `[MuPDFWorkerClient] clearWorkerCacheForTest failed: ${e}`,
                2,
            );
            return null;
        }
    }

    /**
     * Probe `this.worker` without spawning one. If the existing worker was
     * spawned for a different main window, mark it stale (so the next real
     * op respawns cleanly) and return null. Otherwise return the live
     * worker, or null when none exists.
     */
    private probeLiveWorker(): Worker | null {
        if (this.disposed) return null;
        const w = this.worker;
        if (!w) return null;
        const mainWindow = isConfigured() ? getConfig().getWorkerHost() : null;
        if (
            mainWindow &&
            this.spawnedFromWindowInternal &&
            this.spawnedFromWindowInternal !== mainWindow
        ) {
            this.markStale("stale window during introspection RPC");
            return null;
        }
        return w;
    }

    /**
     * Dispatch an introspection op against an already-validated worker
     * without incrementing `dispatchCounts` and without the stale-worker
     * retry that `call()` performs. Returns the worker's `result` payload.
     */
    private callUncounted<T>(
        worker: Worker,
        op: string,
        args: Record<string, unknown>,
    ): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                worker.postMessage({ id, op, args });
            } catch (e) {
                this.pending.delete(id);
                reject(
                    new Error(
                        `postMessage threw: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                );
            }
        });
    }

    dispose(): void {
        // Set BEFORE markStale so that any rejection that races with this
        // call (or runs synchronously inside it) sees the disposed flag and
        // refuses to retry / respawn.
        this.disposed = true;
        this.markStale("dispose");
        if (isConfigured()) {
            const slot = getConfig().workerClientSlot;
            if (slot.get() === this) {
                slot.set(undefined);
            }
        }
    }
}

function rehydrateError(payload: WorkerErrorPayload | undefined): Error {
    if (!payload) return new Error("Unknown worker error");
    if (payload.name === "ExtractionError" && payload.code) {
        // ExtractionError stores OCR data on `details` (types.ts:599); the
        // wire field name stays `payload.ocrAnalysis` for self-documenting
        // JSON. Payload usage by code:
        //   NO_TEXT_LAYER       → { ocrAnalysis, pageLabels, pageCount }
        //   PAGE_OUT_OF_RANGE   → { pageCount } (from strict resolvers in docHelpers.ts)
        //   ENCRYPTED/INVALID   → undefined
        // The constructor's optional fields default cleanly when absent.
        const p = payload.payload;
        return new ExtractionError(
            payload.code as ExtractionErrorCode,
            payload.message ?? "",
            p?.ocrAnalysis,
            p?.pageLabels,
            p?.pageCount,
        );
    }
    return new Error(payload.message ?? "Unknown worker error");
}

/**
 * Get (or lazily spawn) the cross-bundle MuPDFWorkerClient singleton. The
 * actual storage location lives in `getConfig().workerClientSlot` — the
 * host wires that slot to a shared global so every bundle resolves to the
 * same client instance.
 */
export function getMuPDFWorkerClient(): MuPDFWorkerClient {
    const slot = getConfig().workerClientSlot;
    const existing = slot.get() as MuPDFWorkerClient | undefined;
    if (existing) return existing;
    const client = new MuPDFWorkerClient();
    slot.set(client);
    return client;
}

/**
 * Dispose the singleton MuPDFWorkerClient. Safe to call multiple times.
 *
 * Early-returns when the package was never configured (e.g. error paths
 * during shutdown that run before `configurePDF` ever fired). The async
 * signature lets callers `await` it uniformly with other shutdown steps,
 * even though the underlying `worker.terminate()` is synchronous.
 */
export async function disposeMuPDFWorker(): Promise<void> {
    if (!isConfigured()) return;
    const existing = getConfig().workerClientSlot.get() as
        | MuPDFWorkerClient
        | undefined;
    if (!existing) return;
    existing.dispose();
}
