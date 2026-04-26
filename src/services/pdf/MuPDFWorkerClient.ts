/**
 * MuPDFWorkerClient — main-thread client for the MuPDF WASM worker.
 *
 * Cross-bundle singleton: the client lives on `Zotero.__beaverMuPDFWorkerClient`
 * because both bundles (esbuild `src/` and webpack `react/`) import this file
 * transitively. Module-scope state would create one worker per bundle and
 * `src/hooks.ts` would only dispose the esbuild copy.
 */
import { logger } from "../../utils/logger";
import {
    ExtractionError,
    ExtractionErrorCode,
    type RawDocumentData,
    type RawPageDataDetailed,
    type PageImageOptions,
    type PageImageResult,
    type PDFPageSearchResult,
    type ExtractionSettings,
    type ExtractionResult,
    type LineExtractionResult,
    type OCRDetectionOptions,
    type OCRDetectionResult,
    type PDFSearchOptions,
    type PDFSearchResult,
} from "./types";
import type {
    PageSentenceBBoxOptions,
    PageSentenceBBoxResult,
} from "./ParagraphSentenceMapper";

const WORKER_URL = "chrome://beaver/content/scripts/mupdf-worker.js";

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
     * Cumulative counters used by the dev-only `/beaver/test/worker-stats`
     * endpoint to verify dispatch fan-out without log grepping. Incremented
     * in `call()` (per-op) and `ensureWorker()` (spawn).
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
        const mainWindow = (Zotero.getMainWindow?.() ?? null) as Window | null;
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

        const worker = new WorkerCtor(WORKER_URL, { type: "module" });
        this.spawnCount++;
        this.lastSpawnTime = Date.now();
        logger(`[MuPDFWorkerClient] spawned new worker`, 3);
        (worker as any).onmessage = (event: MessageEvent) =>
            this.onWorkerMessage(event);
        (worker as any).onerror = (event: any) => {
            const message = event?.message || "worker onerror";
            logger(`[MuPDFWorkerClient] worker.onerror: ${message}`, 1);
            this.markStale(`worker.onerror: ${message}`);
        };
        (worker as any).onmessageerror = (event: any) => {
            const message = event?.message || "worker onmessageerror";
            logger(`[MuPDFWorkerClient] worker.onmessageerror: ${message}`, 1);
            this.markStale(`worker.onmessageerror: ${message}`);
        };

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
            logger(log.msg, level);
            return;
        }

        const reply = data as WorkerSuccessReply | WorkerFailureReply;
        const entry = this.pending.get(reply.id);
        if (!entry) {
            logger(
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
            logger(`[MuPDFWorkerClient] markStale (${reason}); rejecting ${pendingCount} pending`, 2);
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
        logger(`[MuPDFWorkerClient] dispatch op=${op}`, 3);
        try {
            return await this.dispatch<T>(op, args);
        } catch (e) {
            // Only retry on stale-worker recovery, and only when the client is
            // still live. After dispose() the singleton slot has been cleared
            // and respawning would orphan the new worker from shutdown
            // cleanup — propagate the StaleWorkerError instead.
            if (e instanceof StaleWorkerError && !this.disposed) {
                this.retryCount++;
                logger(`[MuPDFWorkerClient] retry op=${op} after stale worker`, 2);
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

    /** Get page count + all custom page labels in one round-trip. */
    async getPageCountAndLabels(
        pdfData: Uint8Array | ArrayBuffer,
    ): Promise<{ count: number; labels: Record<number, string> }> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<{ count: number; labels: Record<number, string> }>(
            "getPageCountAndLabels",
            { pdfData: bytes },
        );
    }

    /**
     * Extract raw structured-text pages.
     *
     * Mirrors `MuPDFService.extractRawPages` semantics: invalid indices in
     * `pageIndices` are silently filtered, an empty/undefined `pageIndices`
     * means "all pages."
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
     * Render multiple pages to images.
     *
     * Mirrors `MuPDFService.renderPagesToImages` semantics: invalid indices
     * are silently filtered. The returned image bytes are transferred from
     * the worker (the worker does not retain them after asPNG/asJPEG copies).
     */
    async renderPagesToImages(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndices?: number[],
        options?: PageImageOptions,
    ): Promise<PageImageResult[]> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<PageImageResult[]>("renderPagesToImages", {
            pdfData: bytes,
            pageIndices,
            options,
        });
    }

    /**
     * Strict, fused render-pages variant for the agent images handler.
     *
     * Combines page-count + page-labels + render in a single doc-open. Uses
     * the worker's strict resolvers — explicit-but-all-invalid `pageIndices`
     * (or out-of-range `pageRange`) throws `ExtractionError(PAGE_OUT_OF_RANGE)`
     * with the worker's known `pageCount` in the error payload.
     *
     * Image buffers are transferred from the worker.
     */
    async renderPagesToImagesWithMeta(
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
            "renderPagesToImagesWithMeta",
            {
                pdfData: bytes,
                pageIndices: args?.pageIndices,
                pageRange: args?.pageRange,
                options: args?.options,
            },
        );
    }

    /**
     * Render a single page to an image.
     *
     * Single-page op — out-of-range `pageIndex` throws
     * `ExtractionError(PAGE_OUT_OF_RANGE)`. One doc-open per call (vs. the
     * two-open cost of "getPageCountAndLabels + renderPagesToImages([idx])").
     */
    async renderPageToImage(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndex: number,
        options?: PageImageOptions,
    ): Promise<PageImageResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<PageImageResult>("renderPageToImage", {
            pdfData: bytes,
            pageIndex,
            options,
        });
    }

    /**
     * Search a PDF for a literal phrase. Returns unscored, page-level hits.
     *
     * Mirrors `MuPDFService.searchPages` semantics: invalid indices are
     * silently filtered.
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
     * Run the full extraction orchestration in the worker.
     *
     * Returns an `ExtractionResult` (or `LineExtractionResult` if
     * `settings.useLineDetection` is true). Throws `ExtractionError(NO_TEXT_LAYER)`
     * when `checkTextLayer` is enabled and the document needs OCR — the
     * `ocrAnalysis`, `pageLabels`, and `pageCount` fields are preserved
     * across the worker boundary via the payload-aware rehydrateError.
     */
    async extract(
        pdfData: Uint8Array | ArrayBuffer,
        settings?: ExtractionSettings,
    ): Promise<ExtractionResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<ExtractionResult>("extract", {
            pdfData: bytes,
            settings,
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
     * Rejects `settings.useLineDetection` — line-extraction callers must use
     * `extractByLines` directly.
     */
    async extractWithMeta(
        pdfData: Uint8Array | ArrayBuffer,
        args?: {
            settings?: ExtractionSettings;
            pageIndices?: number[];
            pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
        },
    ): Promise<ExtractionResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<ExtractionResult>("extractWithMeta", {
            pdfData: bytes,
            settings: args?.settings,
            pageIndices: args?.pageIndices,
            pageRange: args?.pageRange,
        });
    }

    /** Line-detection variant of `extract`. */
    async extractByLines(
        pdfData: Uint8Array | ArrayBuffer,
        settings?: ExtractionSettings,
    ): Promise<LineExtractionResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<LineExtractionResult>("extractByLines", {
            pdfData: bytes,
            settings,
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

    /** Cheap text-layer presence check. */
    async hasTextLayer(pdfData: Uint8Array | ArrayBuffer): Promise<boolean> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<boolean>("hasTextLayer", { pdfData: bytes });
    }

    /**
     * Search + score within one round-trip.
     *
     * `options.maxPageCount` is lifted to a top-level worker arg and stripped
     * from the forwarded `options` payload. Keeps the `opSearch` worker-arg
     * shape clean and lets the handler pass it through the existing options
     * parameter without a separate signature change.
     */
    async search(
        pdfData: Uint8Array | ArrayBuffer,
        query: string,
        options?: PDFSearchOptions,
    ): Promise<PDFSearchResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        let forwardedOptions: PDFSearchOptions | undefined = options;
        let maxPageCount: number | undefined;
        if (options && options.maxPageCount != null) {
            const { maxPageCount: lifted, ...rest } = options;
            maxPageCount = lifted;
            forwardedOptions = rest;
        }
        return this.call<PDFSearchResult>("search", {
            pdfData: bytes,
            query,
            options: forwardedOptions,
            maxPageCount,
        });
    }

    /**
     * Sentence-bbox extraction with full mapper inside the worker.
     *
     * Callers that need a custom `options.splitter` (a function value, not
     * structurally cloneable) MUST route through the PR #2 split path:
     * call `extractRawPageDetailed` here, then run `extractPageSentenceBBoxes`
     * main-thread. `PDFExtractor.extractSentenceBBoxes` does this branch.
     * If a caller reaches this method directly with a `splitter`, we strip
     * it at runtime to avoid `DataCloneError` from postMessage; the worker
     * then uses the default regex splitter. The runtime strip is defensive
     * — direct callers should branch like PDFExtractor does.
     */
    async extractSentenceBBoxes(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndex: number,
        options?: PageSentenceBBoxOptions,
    ): Promise<PageSentenceBBoxResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        const { splitter: _drop, ...rest } = (options ?? {}) as PageSentenceBBoxOptions & {
            splitter?: unknown;
        };
        return this.call<PageSentenceBBoxResult>("extractSentenceBBoxes", {
            pdfData: bytes,
            pageIndex,
            options: rest,
        });
    }

    /** Force WASM init in the worker. Useful for tests and pre-warm. */
    async ping(): Promise<void> {
        await this.call<void>("__init", {});
    }

    /**
     * Test-only: snapshot of dispatch / spawn counters. Surfaced via the
     * dev-only `/beaver/test/worker-stats` HTTP endpoint so manual-test
     * runners can verify fan-out without grepping logs.
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

    dispose(): void {
        // Set BEFORE markStale so that any rejection that races with this
        // call (or runs synchronously inside it) sees the disposed flag and
        // refuses to retry / respawn.
        this.disposed = true;
        this.markStale("dispose");
        if ((Zotero as any).__beaverMuPDFWorkerClient === this) {
            (Zotero as any).__beaverMuPDFWorkerClient = undefined;
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
 * Get (or lazily spawn) the cross-bundle MuPDFWorkerClient singleton.
 */
export function getMuPDFWorkerClient(): MuPDFWorkerClient {
    const slot = (Zotero as any).__beaverMuPDFWorkerClient as
        | MuPDFWorkerClient
        | undefined;
    if (slot) return slot;
    const client = new MuPDFWorkerClient();
    (Zotero as any).__beaverMuPDFWorkerClient = client;
    return client;
}

/**
 * Dispose the singleton MuPDFWorkerClient. Safe to call multiple times.
 *
 * Async-signature for parity with `disposeMuPDF()` even though the underlying
 * `worker.terminate()` is synchronous — this keeps the call sites uniform
 * (`Promise.all([disposeMuPDF(), disposeMuPDFWorker()])`).
 */
export async function disposeMuPDFWorker(): Promise<void> {
    const slot = (Zotero as any).__beaverMuPDFWorkerClient as
        | MuPDFWorkerClient
        | undefined;
    if (!slot) return;
    slot.dispose();
}
