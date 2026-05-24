/**
 * MuPDFWorkerClient — main-thread client for the MuPDF WASM worker.
 *
 * Cross-bundle per-name singletons: each client lives in the slot
 * supplied by `getConfig().workerClientSlots[name]` — the host wires
 * those slots to shared globals so every bundle that imports this file
 * (transitively or directly) sees the same client per name. Module-scope
 * state would otherwise create one worker per bundle and shutdown would
 * only dispose one of them.
 *
 * Two names are defined: `"hot"` (user-facing agent work) and
 * `"background"` (long-running background extraction). They run as
 * independent workers with independent WASM heaps so a leak or long
 * extract in one slot does not block the other.
 */
import {
    getConfig,
    isConfigured,
    type PDFWorkerSlotName,
    type PDFWorkerUrls,
} from "./config";
import {
    ExtractionError,
    ExtractionErrorCode,
    type RawPageDataDetailed,
    type PageImageOptions,
    type PageImageResult,
    type PDFMetadata,
    type ExtractionSettings,
    type LayoutAnalysisResult,
    type OCRDetectionOptions,
    type OCRDetectionResult,
    type PDFSearchOptions,
    type PDFSearchResult,
} from "./types";
import type {
    BeaverExtractResult,
    StructuredExtractWithDebugResult,
} from "./schema";
import type {
    SentenceTraceResult,
    SentenceSplitterConfig,
    WorkerSentenceDebugOptions,
} from "./sentenceTypes";
import type { ParagraphDetectionSettings } from "./ParagraphDetector";

const DEFAULT_IDLE_TIMEOUT_MS_HOT = 5 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS_BACKGROUND = 60 * 1000;

function defaultIdleTimeoutForSlot(name: PDFWorkerSlotName): number {
    return name === "background"
        ? DEFAULT_IDLE_TIMEOUT_MS_BACKGROUND
        : DEFAULT_IDLE_TIMEOUT_MS_HOT;
}

/**
 * Test-time idle timeout overrides keyed by slot name. New `MuPDFWorkerClient`
 * instances pick these up at construction so tests can shorten timeouts
 * before triggering a spawn.
 */
const testIdleTimeoutOverrides: Partial<Record<PDFWorkerSlotName, number>> = {};

/**
 * Test-only override of the idle timeout. Accepts either the historical
 * single-arg `(ms)` form (defaults to the `"hot"` slot) or the new
 * `(name, ms)` form for per-slot overrides.
 */
export function __setIdleTimeoutForTest(
    arg1: number | PDFWorkerSlotName,
    arg2?: number,
): void {
    const name: PDFWorkerSlotName =
        typeof arg1 === "string" ? arg1 : "hot";
    const ms = typeof arg1 === "number" ? arg1 : arg2!;
    testIdleTimeoutOverrides[name] = ms;
    const slot = isConfigured() ? getConfig().workerClientSlots[name] : null;
    const existing = slot?.get() as MuPDFWorkerClient | undefined;
    if (existing) {
        existing.setIdleTimeoutForTest(ms);
    }
}

/** Test-only: restore the production idle timeout for a slot (default hot). */
export function __resetIdleTimeoutForTest(
    name: PDFWorkerSlotName = "hot",
): void {
    delete testIdleTimeoutOverrides[name];
    const slot = isConfigured() ? getConfig().workerClientSlots[name] : null;
    const existing = slot?.get() as MuPDFWorkerClient | undefined;
    if (existing) {
        existing.setIdleTimeoutForTest(defaultIdleTimeoutForSlot(name));
    }
}

interface PendingEntry {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    fatalCandidate?: FatalOperationCandidate;
}

interface StartupEntry {
    worker: Worker;
    urls: PDFWorkerUrls;
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: any) => void;
    configured: boolean;
    timeoutId: ReturnType<typeof setTimeout> | undefined;
}

interface FatalOperationCandidate {
    op: string;
    bytes: Uint8Array;
    argsSignature: string;
    prefix: string;
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

interface WorkerLifecycleMessage {
    kind: "ready" | "configured";
}

type WorkerReply =
    | WorkerSuccessReply
    | WorkerFailureReply
    | WorkerLogMessage
    | WorkerLifecycleMessage;

/**
 * Snapshot of the worker-side document cache. Mirrors the `CacheStats` type
 * declared inside `src/beaver-extract/worker/docCache.ts` so the wire shape
 * stays explicit on both sides.
 */
export interface MuPDFWorkerCacheStats {
    entries: number;
    totalBytes: number;
    hits: number;
    misses: number;
    evictions: number;
    discards: number;
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

/**
 * Sentinel rejection for caller-initiated cancellation. Unlike stale-worker
 * failures, aborted operations are not retried by `call()`.
 */
export class WorkerAbortError extends Error {
    constructor(message = "worker operation aborted by caller") {
        super(message);
        this.name = "WorkerAbortError";
    }
}

export class MuPDFWorkerClient {
    private readonly slotName: PDFWorkerSlotName;
    private idleTimeoutMs: number;
    private worker: Worker | null = null;
    private spawnedFromWindowInternal: Window | null = null;
    private startup: StartupEntry | null = null;
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
    private fatalOperationKeys = new Set<string>();
    private fatalOperationEntries: Array<{ key: string; prefix: string }> = [];
    private fatalOperationPrefixCounts = new Map<string, number>();
    private idleTimerId: ReturnType<typeof setTimeout> | undefined;
    // Populated only after a fatal reply so healthy dispatch never walks a
    // whole PDF on the UI thread before posting work to the worker.
    private pdfDigestCache = new WeakMap<object, Map<string, string>>();

    constructor(opts: {
        slotName?: PDFWorkerSlotName;
        idleTimeoutMs?: number;
    } = {}) {
        this.slotName = opts.slotName ?? "hot";
        const override = testIdleTimeoutOverrides[this.slotName];
        this.idleTimeoutMs =
            opts.idleTimeoutMs
            ?? override
            ?? defaultIdleTimeoutForSlot(this.slotName);
    }

    /** The window that spawned the current worker. Used for stale detection. */
    get spawnedFromWindow(): Window | null {
        return this.spawnedFromWindowInternal;
    }

    /** The logical slot name this client owns. */
    get name(): PDFWorkerSlotName {
        return this.slotName;
    }

    /** Test-only: change the idle timeout on a live instance. */
    setIdleTimeoutForTest(ms: number): void {
        this.idleTimeoutMs = ms;
    }

    private clearIdleTimer(): void {
        if (this.idleTimerId === undefined) return;
        clearTimeout(this.idleTimerId);
        this.idleTimerId = undefined;
    }

    private armIdleTimer(): void {
        this.clearIdleTimer();
        if (this.disposed || !this.worker || this.pending.size !== 0) return;

        const id = setTimeout(() => {
            this.idleTimerId = undefined;
            if (this.disposed || !this.worker || this.pending.size !== 0) return;
            this.markStale("idle timeout");
        }, this.idleTimeoutMs);
        (id as any)?.unref?.();
        this.idleTimerId = id;
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
        cfg.log(`[MuPDFWorkerClient ${this.slotName}] spawned new worker`, 3);
        (worker as any).onmessage = (event: MessageEvent) =>
            this.onWorkerMessage(worker, event);
        (worker as any).onerror = (event: any) => {
            const message = event?.message || "worker onerror";
            cfg.log(`[MuPDFWorkerClient ${this.slotName}] worker.onerror: ${message}`, 1);
            this.markStale(`worker.onerror: ${message}`);
        };
        (worker as any).onmessageerror = (event: any) => {
            const message = event?.message || "worker onmessageerror";
            cfg.log(`[MuPDFWorkerClient ${this.slotName}] worker.onmessageerror: ${message}`, 1);
            this.markStale(`worker.onmessageerror: ${message}`);
        };

        this.worker = worker;
        this.spawnedFromWindowInternal = mainWindow;
        this.startup = this.createStartupEntry(worker, cfg.worker);
        // Send one configure frame immediately for the normal fast path. The
        // worker also emits `ready` after installing its message handler; if
        // this early frame is lost during startup, the ready handler sends a
        // second configure before any op is allowed through.
        this.postConfigure(worker, "spawn");
        return worker;
    }

    private createStartupEntry(worker: Worker, urls: PDFWorkerUrls): StartupEntry {
        let resolve!: () => void;
        let reject!: (reason: any) => void;
        const promise = new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        promise.catch(() => {
            // Startup failures are surfaced through the op waiting on this
            // promise; this handler prevents a standalone unhandled rejection
            // if the worker dies before dispatch attaches its continuation.
        });
        const entry: StartupEntry = {
            worker,
            urls,
            promise,
            resolve: () => {
                if (entry.configured) return;
                entry.configured = true;
                if (entry.timeoutId !== undefined) {
                    clearTimeout(entry.timeoutId);
                    entry.timeoutId = undefined;
                }
                resolve();
            },
            reject: (reason: any) => {
                if (entry.configured) return;
                if (entry.timeoutId !== undefined) {
                    clearTimeout(entry.timeoutId);
                    entry.timeoutId = undefined;
                }
                reject(reason);
            },
            configured: false,
            timeoutId: undefined,
        };
        entry.timeoutId = setTimeout(() => {
            if (this.startup !== entry || entry.configured) return;
            this.markStale("configure handshake timed out");
        }, 15000);
        (entry.timeoutId as any)?.unref?.();
        return entry;
    }

    private postConfigure(worker: Worker, reason: string): void {
        const startup = this.startup;
        if (!startup || startup.worker !== worker || startup.configured) return;
        try {
            worker.postMessage({ kind: "configure", urls: startup.urls });
        } catch (e) {
            this.markStale(
                `configure postMessage threw during ${reason}: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
    }

    private onWorkerMessage(worker: Worker, event: MessageEvent): void {
        const data = event.data as WorkerReply | undefined;
        if (!data || typeof data !== "object") return;

        // Log messages are out-of-band — branch first, do not consume `pending`.
        if ((data as WorkerLogMessage).kind === "log") {
            const log = data as WorkerLogMessage;
            const level = log.level === "error" ? 1 : log.level === "warn" ? 2 : 3;
            getConfig().log(log.msg, level);
            return;
        }

        const lifecycle = data as WorkerLifecycleMessage;
        if (lifecycle.kind === "ready") {
            this.postConfigure(worker, "worker ready");
            return;
        }
        if (lifecycle.kind === "configured") {
            if (this.startup?.worker === worker) {
                this.startup.resolve();
            }
            return;
        }

        const reply = data as WorkerSuccessReply | WorkerFailureReply;
        const entry = this.pending.get(reply.id);
        if (!entry) {
            getConfig().log(
                `[MuPDFWorkerClient ${this.slotName}] received reply for unknown id ${reply.id}`,
                2,
            );
            return;
        }
        this.pending.delete(reply.id);

        if (reply.ok) {
            entry.resolve(reply.result);
        } else {
            const error = rehydrateError(reply.error);
            if (isUnconfiguredWorkerError(reply.error)) {
                this.markStale("worker received op before configure");
                entry.reject(new StaleWorkerError("worker received op before configure"));
            } else if (isFatalWorkerError(reply.error)) {
                if (entry.fatalCandidate) {
                    this.rememberFatalOperation(
                        this.computeFatalOperationKey(entry.fatalCandidate),
                    );
                }
                this.markStale("fatal WASM error from worker");
            } else if (isHeapExhaustionWorkerError(reply.error)) {
                this.markStale("MuPDF WASM heap exhaustion from worker");
            }
            entry.reject(error);
        }

        this.armIdleTimer();
    }

    private pendingStartupFor(worker: Worker): Promise<void> | null {
        const startup = this.startup;
        if (!startup || startup.worker !== worker || startup.configured) {
            return null;
        }
        return startup.promise.then(() => {
            if (this.worker !== worker) {
                throw new StaleWorkerError("stale worker: configured worker changed");
            }
        });
    }

    /**
     * Mark the worker as stale: terminate it, reject all pending entries,
     * clear singleton state. Idempotent.
     */
    private markStale(reason: string): void {
        this.clearIdleTimer();
        const w = this.worker;
        this.worker = null;
        this.spawnedFromWindowInternal = null;
        const startup = this.startup;
        this.startup = null;

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
                    `[MuPDFWorkerClient ${this.slotName}] markStale (${reason}); rejecting ${pendingCount} pending`,
                    2,
                );
            }
        }

        const stale = new StaleWorkerError(`stale worker: ${reason}`);
        if (startup && startup.worker === w) {
            startup.reject(stale);
        }
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
    async call<T>(
        op: string,
        args: Record<string, unknown> = {},
        opts: { signal?: AbortSignal } = {},
    ): Promise<T> {
        if (opts.signal?.aborted) {
            throw new WorkerAbortError();
        }
        this.dispatchCounts[op] = (this.dispatchCounts[op] ?? 0) + 1;
        getConfig().log(`[MuPDFWorkerClient ${this.slotName}] dispatch op=${op}`, 3);
        try {
            return await this.dispatch<T>(op, args, opts.signal);
        } catch (e) {
            // Only retry on stale-worker recovery, and only when the client is
            // still live. After dispose() the singleton slot has been cleared
            // and respawning would orphan the new worker from shutdown
            // cleanup — propagate the StaleWorkerError instead.
            if (e instanceof StaleWorkerError && !this.disposed) {
                if (opts.signal?.aborted) {
                    throw new WorkerAbortError();
                }
                this.retryCount++;
                getConfig().log(
                    `[MuPDFWorkerClient ${this.slotName}] retry op=${op} after stale worker`,
                    2,
                );
                return await this.dispatch<T>(op, args, opts.signal);
            }
            throw e;
        }
    }

    private dispatch<T>(
        op: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<T> {
        if (signal?.aborted) {
            return Promise.reject(new WorkerAbortError());
        }
        const fatalCandidate = getFatalOperationCandidate(op, args);
        const fatalKey = fatalCandidate
            ? this.getCachedFatalOperationKey(fatalCandidate)
            : null;
        if (fatalKey && this.fatalOperationKeys.has(fatalKey)) {
            return Promise.reject(createKnownFatalWasmError());
        }
        const worker = this.ensureWorker();
        const startup = this.pendingStartupFor(worker);
        if (startup) {
            return this.waitForStartup(worker, startup, signal).then(() =>
                this.dispatchConfigured<T>(
                    worker,
                    op,
                    args,
                    signal,
                    fatalCandidate,
                ),
            );
        }
        return this.dispatchConfigured<T>(
            worker,
            op,
            args,
            signal,
            fatalCandidate,
        );
    }

    private waitForStartup(
        worker: Worker,
        startup: Promise<void>,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) {
            this.markStale("startup aborted by caller");
            return Promise.reject(new WorkerAbortError());
        }
        if (!signal) return startup;

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                signal.removeEventListener("abort", onAbort);
            };
            const settleResolve = () => {
                if (settled) return;
                settled = true;
                cleanup();
                if (signal.aborted) {
                    this.markStale("startup aborted by caller");
                    reject(new WorkerAbortError());
                    return;
                }
                resolve();
            };
            const settleReject = (reason: any) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(reason);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                if (this.worker === worker) {
                    this.markStale("startup aborted by caller");
                }
                reject(new WorkerAbortError());
            };

            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
                onAbort();
                return;
            }
            startup.then(settleResolve, settleReject);
        });
    }

    private dispatchConfigured<T>(
        worker: Worker,
        op: string,
        args: Record<string, unknown>,
        signal: AbortSignal | undefined,
        fatalCandidate: FatalOperationCandidate | null,
    ): Promise<T> {
        if (signal?.aborted) {
            return Promise.reject(new WorkerAbortError());
        }
        if (this.worker !== worker) {
            return Promise.reject(new StaleWorkerError("configured worker changed"));
        }
        const id = this.nextId++;

        return new Promise<T>((resolve, reject) => {
            let settled = false;
            let onAbort: (() => void) | null = null;
            const cleanup = () => {
                if (onAbort && signal) {
                    signal.removeEventListener("abort", onAbort);
                    onAbort = null;
                }
            };
            const resolveWithCleanup = (value: T) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };
            const rejectWithCleanup = (reason: any) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(reason);
            };
            if (signal) {
                onAbort = () => {
                    if (!this.pending.has(id)) return;
                    this.pending.delete(id);
                    rejectWithCleanup(new WorkerAbortError());
                    this.markStale("op aborted by caller");
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }
            this.pending.set(id, {
                resolve: resolveWithCleanup,
                reject: rejectWithCleanup,
                fatalCandidate: fatalCandidate ?? undefined,
            });
            if (signal?.aborted) {
                this.pending.delete(id);
                rejectWithCleanup(new WorkerAbortError());
                return;
            }
            try {
                this.clearIdleTimer();
                worker.postMessage({ id, op, args });
            } catch (e) {
                this.pending.delete(id);
                this.markStale(
                    `postMessage threw: ${e instanceof Error ? e.message : String(e)}`,
                );
                rejectWithCleanup(new StaleWorkerError("postMessage threw"));
            }
        });
    }

    private getCachedFatalOperationKey(
        candidate: FatalOperationCandidate,
    ): string | null {
        let digest = getCachedPdfDigest(this.pdfDigestCache, candidate.bytes);
        if (!digest && this.fatalOperationPrefixCounts.has(candidate.prefix)) {
            digest = getOrComputePdfDigest(this.pdfDigestCache, candidate.bytes);
        }
        if (!digest) return null;
        return makeFatalOperationKey(candidate, digest);
    }

    private computeFatalOperationKey(
        candidate: FatalOperationCandidate,
    ): string {
        const digest = getOrComputePdfDigest(this.pdfDigestCache, candidate.bytes);
        return makeFatalOperationKey(candidate, digest);
    }

    /**
     * Get the page count of a PDF.
     *
     * Posts by copy (no transfer list) — current callers reuse `pdfData`
     * across multiple `BeaverExtractor` calls, so transferring would detach the
     * caller's buffer.
     */
    async getPageCount(
        pdfData: Uint8Array | ArrayBuffer,
        signal?: AbortSignal,
    ): Promise<number> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        const result = await this.call<{ count: number }>("getPageCount", {
            pdfData: bytes,
        }, { signal });
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
        signal?: AbortSignal,
    ): Promise<PDFMetadata> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<PDFMetadata>("getMetadata", { pdfData: bytes }, { signal });
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
        signal?: AbortSignal,
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
            { signal },
        );
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
     * `mode === "structured"` enables sentence-level extraction. The result
     * is the same `InternalExtractionResult` shape; per-page sentence /
     * paragraph / column / line data lives on `InternalProcessedPage`. Pass the
     * splitter as a serializable `structured.splitterConfig` (the
     * facade does the `splitter`/`language` translation before crossing
     * the worker boundary).
     */
    async extract(
        pdfData: Uint8Array | ArrayBuffer,
        args?: {
            mode?: "markdown" | "structured";
            markdown?: { engine?: "block" | "paragraph" };
            structured?: {
                splitterConfig?: SentenceSplitterConfig;
                bboxPrecision?: number;
            };
            settings?: ExtractionSettings;
            paragraphSettings?: ParagraphDetectionSettings;
            pageIndices?: number[];
            pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
            /**
             * Cross-page analysis window for margin smart-removal and
             * the document-wide style profile. `0` (default) analyzes
             * only the requested target pages; `N>0` adds ±N neighbors
             * around each target; `Infinity` covers the whole doc.
             */
            analysisWindow?: number;
        },
        signal?: AbortSignal,
    ): Promise<BeaverExtractResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<BeaverExtractResult>("extract", {
            pdfData: bytes,
            mode: args?.mode,
            markdown: args?.markdown,
            structured: args?.structured,
            settings: args?.settings,
            paragraphSettings: args?.paragraphSettings,
            pageIndices: args?.pageIndices,
            pageRange: args?.pageRange,
            analysisWindow: args?.analysisWindow,
        }, { signal });
    }

    async structuredExtractWithDebug(
        pdfData: Uint8Array | ArrayBuffer,
        args: {
            structured?: {
                splitterConfig?: SentenceSplitterConfig;
                bboxPrecision?: number;
            };
            settings?: ExtractionSettings;
            paragraphSettings?: ParagraphDetectionSettings;
            analysisWindow?: number;
            capturePages: number[];
            debugMode?: "triage" | "full";
        },
        signal?: AbortSignal,
    ): Promise<StructuredExtractWithDebugResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<StructuredExtractWithDebugResult>(
            "structuredExtractWithDebug",
            {
                pdfData: bytes,
                mode: "structured",
                structured: args.structured,
                settings: args.settings,
                paragraphSettings: args.paragraphSettings,
                analysisWindow: args.analysisWindow,
                capturePages: args.capturePages,
                debugMode: args.debugMode,
            },
            { signal },
        );
    }

    /**
     * Document-wide style + margin analysis without per-page extraction.
     *
     * Runs the EXACT shared analysis prefix `extract` runs (page count,
     * page labels, optional OCR check, JSON walk over the analysis
     * window, `buildPageAnalysisContext`). Returns the analysis context
     * extract would have passed to per-page processing
     * (`styleProfile`, `marginAnalysis`, `marginRemoval`) plus the
     * JSON-walked target pages.
     *
     * Output is byte-identical to the analysis context built by
     * `extract({ mode: "structured" })` for the same `settings` /
     * `pageIndices` / `analysisWindow`. Use this to inspect what the
     * production extract pipeline saw before per-page processing.
     *
     * **Map/Set boundary.** `result.analysis.styleProfile.styleCounts`,
     * `result.analysis.marginAnalysis.elements`,
     * `result.analysis.marginRemoval.removalsByPage`, and
     * `result.analysis.marginRemoval.textsToRemove` carry `Map`/`Set`
     * fields. `postMessage` preserves them via structured clone, but
     * `JSON.stringify` does NOT — flatten before writing HTTP responses.
     */
    async analyzeLayout(
        pdfData: Uint8Array | ArrayBuffer,
        args?: {
            settings?: ExtractionSettings;
            pageIndices?: number[];
            pageRange?: { startIndex: number; endIndex?: number; maxPages?: number };
            /** Same semantics as `extract({ analysisWindow })`. */
            analysisWindow?: number;
        },
    ): Promise<LayoutAnalysisResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<LayoutAnalysisResult>("analyzeLayout", {
            pdfData: bytes,
            settings: args?.settings,
            pageIndices: args?.pageIndices,
            pageRange: args?.pageRange,
            analysisWindow: args?.analysisWindow,
        });
    }

    /** Detailed OCR analysis. */
    async analyzeOCRNeeds(
        pdfData: Uint8Array | ArrayBuffer,
        options?: OCRDetectionOptions,
        signal?: AbortSignal,
    ): Promise<OCRDetectionResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<OCRDetectionResult>("analyzeOCRNeeds", {
            pdfData: bytes,
            options,
        }, { signal });
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
        signal?: AbortSignal,
    ): Promise<PDFSearchResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<PDFSearchResult>("search", {
            pdfData: bytes,
            query,
            options,
            maxPageCount: args?.maxPageCount,
        }, { signal });
    }

    /**
     * Single-page sentence-bbox extraction with pipeline intermediates.
     * Debug-only — production sentence-level extraction goes through
     * `extract({ mode: "structured" })` which returns the same
     * `InternalExtractionResult` shape with `pages[i].sentences` populated.
     *
     * Powers the dev visualizer / fixture capture / extract-trace
     * endpoints. Returns `SentenceTraceResult = { result, trace }`
     * with `result` being the production sentence result and `trace`
     * carrying all pipeline intermediates (analysis-window indices, raw
     * doc, detailed page, font-bridged `pagesForFilter`, margin
     * analysis/removal, filtered-paragraph result).
     *
     * The splitter is described by a serializable `splitterConfig`
     * (sentencex with language, or simple regex). The worker resolves
     * the actual splitter function via its own `resolveSplitter`,
     * including the sentencex→simple fallback on init failure.
     *
     * `options` is restricted to `WorkerSentenceDebugOptions`: no
     * function-valued `splitter` (not structurally cloneable) and no
     * `precomputed` (the worker always runs the full filtered-paragraph
     * pipeline).
     *
     * **Map/Set boundary.** `trace.marginAnalysis`, `trace.marginRemoval`,
     * and `trace.filteredResult.styleProfile` carry `Map`/`Set` fields.
     * `postMessage` preserves them via structured clone, but
     * `JSON.stringify` does NOT — flatten before writing HTTP responses.
     */
    async extractSentenceDebug(
        pdfData: Uint8Array | ArrayBuffer,
        pageIndex: number,
        options?: WorkerSentenceDebugOptions,
    ): Promise<SentenceTraceResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<SentenceTraceResult>(
            "extractSentenceDebug",
            { pdfData: bytes, pageIndex, options },
        );
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
        idleTimerArmed: boolean;
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
            idleTimerArmed: this.idleTimerId !== undefined,
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
            getConfig().log(`[MuPDFWorkerClient ${this.slotName}] getCacheStats failed: ${e}`, 2);
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
                `[MuPDFWorkerClient ${this.slotName}] clearWorkerCacheForTest failed: ${e}`,
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
        const startup = this.pendingStartupFor(worker);
        if (startup) {
            return startup.then(() => this.callUncountedConfigured<T>(worker, op, args));
        }
        return this.callUncountedConfigured<T>(worker, op, args);
    }

    private callUncountedConfigured<T>(
        worker: Worker,
        op: string,
        args: Record<string, unknown>,
    ): Promise<T> {
        if (this.worker !== worker) {
            return Promise.reject(new StaleWorkerError("configured worker changed"));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.clearIdleTimer();
                worker.postMessage({ id, op, args });
            } catch (e) {
                this.pending.delete(id);
                this.armIdleTimer();
                reject(
                    new Error(
                        `postMessage threw: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                );
            }
        });
    }

    private rememberFatalOperation(key: string): void {
        if (this.fatalOperationKeys.has(key)) return;
        const prefix = getFatalOperationPrefixFromKey(key);
        this.fatalOperationKeys.add(key);
        this.fatalOperationEntries.push({ key, prefix });
        this.fatalOperationPrefixCounts.set(
            prefix,
            (this.fatalOperationPrefixCounts.get(prefix) ?? 0) + 1,
        );
        if (this.fatalOperationEntries.length > 128) {
            const oldest = this.fatalOperationEntries.shift();
            if (oldest) {
                this.fatalOperationKeys.delete(oldest.key);
                const count = this.fatalOperationPrefixCounts.get(oldest.prefix) ?? 0;
                if (count <= 1) {
                    this.fatalOperationPrefixCounts.delete(oldest.prefix);
                } else {
                    this.fatalOperationPrefixCounts.set(oldest.prefix, count - 1);
                }
            }
        }
    }

    dispose(): void {
        // Set BEFORE markStale so that any rejection that races with this
        // call (or runs synchronously inside it) sees the disposed flag and
        // refuses to retry / respawn.
        this.disposed = true;
        this.markStale("dispose");
        if (isConfigured()) {
            const slot = getConfig().workerClientSlots[this.slotName];
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

function isFatalWorkerError(payload: WorkerErrorPayload | undefined): boolean {
    return payload?.name === "ExtractionError"
        && payload.code === ExtractionErrorCode.WASM_ERROR;
}

function isHeapExhaustionWorkerError(payload: WorkerErrorPayload | undefined): boolean {
    return payload?.name === "ExtractionError"
        && payload.code === ExtractionErrorCode.HEAP_EXHAUSTION;
}

function isUnconfiguredWorkerError(payload: WorkerErrorPayload | undefined): boolean {
    return payload?.name === "Error"
        && payload.message === "MuPDF worker received op before configure message";
}

function createKnownFatalWasmError(): ExtractionError {
    return new ExtractionError(
        ExtractionErrorCode.WASM_ERROR,
        "This PDF previously crashed the MuPDF WASM parser and cannot be processed.",
    );
}

function getFatalOperationCandidate(
    op: string,
    args: Record<string, unknown>,
): FatalOperationCandidate | null {
    const bytes = getPdfBytes(args.pdfData);
    if (!bytes) return null;
    const argsSignature = stableStringifyWithoutPdfData(args);
    return {
        op,
        bytes,
        argsSignature,
        prefix: makeFatalOperationPrefix(op, bytes.byteLength, argsSignature),
    };
}

function makeFatalOperationPrefix(
    op: string,
    byteLength: number,
    argsSignature: string,
): string {
    return `${op}:${byteLength}:${argsSignature}`;
}

function makeFatalOperationKey(
    candidate: FatalOperationCandidate,
    digest: string,
): string {
    return `${candidate.prefix}:${digest}`;
}

function getFatalOperationPrefixFromKey(key: string): string {
    const idx = key.lastIndexOf(":");
    return idx >= 0 ? key.slice(0, idx) : key;
}

function getPdfBytes(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
}

function getCachedPdfDigest(
    cache: WeakMap<object, Map<string, string>>,
    bytes: Uint8Array,
): string | null {
    const bufferKey = bytes.buffer as object;
    const viewKey = getPdfViewKey(bytes);
    return cache.get(bufferKey)?.get(viewKey) ?? null;
}

function getOrComputePdfDigest(
    cache: WeakMap<object, Map<string, string>>,
    bytes: Uint8Array,
): string {
    const bufferKey = bytes.buffer as object;
    const viewKey = getPdfViewKey(bytes);
    let digests = cache.get(bufferKey);
    if (!digests) {
        digests = new Map();
        cache.set(bufferKey, digests);
    }
    const cached = digests.get(viewKey);
    if (cached) return cached;
    const digest = hashBytes(bytes);
    digests.set(viewKey, digest);
    return digest;
}

function getPdfViewKey(bytes: Uint8Array): string {
    return `${bytes.byteOffset}:${bytes.byteLength}`;
}

function hashBytes(bytes: Uint8Array): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
    }
    const hex = hash.toString(16);
    return "00000000".slice(hex.length) + hex;
}

function stableStringifyWithoutPdfData(args: Record<string, unknown>): string {
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(args)) {
        if (key !== "pdfData") {
            filtered[key] = args[key];
        }
    }
    return stableStringify(filtered);
}

function stableStringify(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map((v) => stableStringify(v)).join(",")}]`;
    }
    if (ArrayBuffer.isView(value)) {
        return `"${value.constructor.name}:${value.byteLength}"`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(",")}}`;
}

/**
 * Get (or lazily spawn) the cross-bundle MuPDFWorkerClient for `name`. The
 * actual storage location lives in `getConfig().workerClientSlots[name]` —
 * the host wires each slot to a shared global so every bundle resolves to
 * the same client instance per name. Defaults to `"hot"` so existing call
 * sites stay valid.
 */
export function getMuPDFWorkerClient(
    name: PDFWorkerSlotName = "hot",
): MuPDFWorkerClient {
    const slot = getConfig().workerClientSlots[name];
    const existing = slot.get() as MuPDFWorkerClient | undefined;
    if (existing) return existing;
    const client = new MuPDFWorkerClient({ slotName: name });
    slot.set(client);
    return client;
}

/**
 * Read the existing client in `name`'s slot without spawning. Returns
 * `null` when the slot is empty or the package isn't configured. Used by
 * introspection paths (dev stats, cooperative throttle) that must not
 * pollute the slot just to peek.
 */
export function getExistingMuPDFWorkerClient(
    name: PDFWorkerSlotName = "hot",
): MuPDFWorkerClient | null {
    if (!isConfigured()) return null;
    const slot = getConfig().workerClientSlots[name];
    const existing = slot.get() as MuPDFWorkerClient | undefined;
    return existing ?? null;
}

/**
 * Dispose the MuPDFWorkerClient for the given slot, or both when `name`
 * is omitted. Safe to call multiple times.
 *
 * Early-returns when the package was never configured (e.g. error paths
 * during shutdown that run before `configurePDF` ever fired). The async
 * signature lets callers `await` it uniformly with other shutdown steps,
 * even though the underlying `worker.terminate()` is synchronous.
 */
export async function disposeMuPDFWorker(
    name?: PDFWorkerSlotName,
): Promise<void> {
    if (!isConfigured()) return;
    const slots = getConfig().workerClientSlots;
    const targets: PDFWorkerSlotName[] =
        name === undefined ? ["hot", "background"] : [name];
    for (const slotName of targets) {
        const existing = slots[slotName].get() as
            | MuPDFWorkerClient
            | undefined;
        if (existing) existing.dispose();
    }
}
