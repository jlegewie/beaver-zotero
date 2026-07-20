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
    SerializedBeaverExtractResult,
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
// Last-resort backstops: a lease must stay a few seconds ABOVE the longest
// deadline after which callers legitimately reclaim a slot operation
// themselves (per-request timeouts — including backend-provided
// timeout_seconds — plus any shared-extraction grace), so the lease only
// fires when those reclaim paths failed. A lease at or below such a deadline
// would reap in-budget work instead. Interactive hot-slot request timeouts
// are clamped to MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS (agentDataProvider
// timeout module) to keep the hot invariant enforced; raise the lease
// alongside any increase to those budgets (hot:
// MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS plus the shared-extraction grace;
// background: MAX_PDF_TIMEOUT_SECONDS).
export const DEFAULT_BUSY_LEASE_MS_HOT = 65_000;
export const DEFAULT_BUSY_LEASE_MS_BACKGROUND = 240_000;
const BUSY_LEASE_WATCHDOG_SLACK_MS = 1_000;
const DEFAULT_RECYCLE_HEAP_BYTES = 512 * 1024 * 1024;
const DEFAULT_RECYCLE_AFTER_DATA_OPERATIONS_HOT = 32;
const PROACTIVE_RECYCLE_FOLLOWUP_DATA_OPERATIONS = 1;

export type ProactiveRecycleReason = "heap_limit" | "data_operation_limit";

function defaultIdleTimeoutForSlot(name: PDFWorkerSlotName): number {
    return name === "background"
        ? DEFAULT_IDLE_TIMEOUT_MS_BACKGROUND
        : DEFAULT_IDLE_TIMEOUT_MS_HOT;
}

function defaultBusyLeaseForSlot(name: PDFWorkerSlotName): number {
    return name === "background"
        ? DEFAULT_BUSY_LEASE_MS_BACKGROUND
        : DEFAULT_BUSY_LEASE_MS_HOT;
}

function defaultRecycleHeapBytesForSlot(
    _name: PDFWorkerSlotName,
): number | null {
    return DEFAULT_RECYCLE_HEAP_BYTES;
}

function defaultRecycleDataOperationsForSlot(
    name: PDFWorkerSlotName,
): number | null {
    return name === "hot" ? DEFAULT_RECYCLE_AFTER_DATA_OPERATIONS_HOT : null;
}

function normalizePositiveThreshold(value: number | null): number | null {
    return value !== null && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : null;
}

/** Worker control/introspection operations use the `__` prefix. */
function isDataOperation(op: string): boolean {
    return !op.startsWith("__");
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
    op: string;
    fatalCandidate?: FatalOperationCandidate;
    /** Epoch-ms when the client accepted this operation. */
    startedAt: number;
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
    heapBytes?: number | null;
}

interface WorkerFailureReply {
    id: number;
    ok: false;
    error: WorkerErrorPayload;
    heapBytes?: number | null;
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

export interface MuPDFWorkerStats {
    hasWorker: boolean;
    disposed: boolean;
    spawnCount: number;
    retryCount: number;
    consecutiveStartFailures: number;
    pendingCount: number;
    nextId: number;
    dispatchCounts: Record<string, number>;
    lastSpawnTime: number | null;
    idleTimerArmed: boolean;
    workerHeapBytes: number | null;
    peakWorkerHeapBytes: number | null;
    completedDataOperationsSinceSpawn: number;
    recycleHeapThresholdBytes: number | null;
    recycleDataOperationThreshold: number | null;
    proactiveRecyclePending: boolean;
    proactiveRecycleCount: number;
    lastProactiveRecycleReason: ProactiveRecycleReason | null;
    lastProactiveRecycleTime: number | null;
    lastProactiveRecycleHeapBytes: number | null;
    lastProactiveRecycleDataOperations: number | null;
    leaseReapCount: number;
    lastLeaseReapTime: number | null;
    lastLeaseReapOp: string | null;
    lastLeaseReapAgeMs: number | null;
}

/**
 * Sentinel rejection thrown when the worker dies mid-flight.
 * Callers may treat this as transient and retry with a fresh worker.
 */
export class StaleWorkerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StaleWorkerError";
    }
}

/**
 * Thrown when the host window cannot currently spawn a worker.
 * This is separate from disposal, which is a permanent shutdown state.
 */
export class WorkerSpawnError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkerSpawnError";
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

/**
 * Sentinel rejection for worker-level policy expiration. Unlike
 * `WorkerAbortError`, this is not caller-initiated cancellation, and unlike
 * `StaleWorkerError`, the operation whose lease expired must not be retried.
 */
export class WorkerDeadlineError extends Error {
    constructor(message = "worker busy-age lease exceeded") {
        super(message);
        this.name = "WorkerDeadlineError";
    }
}

/** Cross-bundle-safe classification for worker-level deadline expiration. */
export function isWorkerDeadlineError(error: unknown): boolean {
    return error instanceof WorkerDeadlineError
        || (error as { name?: unknown } | null | undefined)?.name
            === "WorkerDeadlineError";
}

export class MuPDFWorkerClient {
    private readonly slotName: PDFWorkerSlotName;
    private idleTimeoutMs: number;
    private readonly busyLeaseMs: number | null;
    private readonly recycleHeapThresholdBytes: number | null;
    private readonly recycleDataOperationThreshold: number | null;
    private worker: Worker | null = null;
    private spawnedFromWindowInternal: Window | null = null;
    private startup: StartupEntry | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingEntry>();
    /** Cached for O(1) busy-context reads on every backend request. */
    private oldestPendingStartedAt: number | null = null;
    private nextStartupWaiterId = 1;
    private startupWaiters = new Map<number, number>();
    /** Cached so startup-wait age is also an O(1) property read. */
    private oldestStartupWaitStartedAt: number | null = null;
    /**
     * Once true, the client refuses to spawn a new worker. Set by `dispose()`.
     * Distinguishes a stale-but-recoverable worker (transparent retry OK) from
     * an explicit teardown (no respawn; the new worker would be detached from
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
    /**
     * Consecutive worker start-phase failures (module load / configure
     * handshake) since the last successful handshake.
     */
    private consecutiveStartFailures = 0;
    private dispatchCounts: Record<string, number> = {};
    private lastSpawnTime: number | null = null;
    private fatalOperationKeys = new Set<string>();
    private fatalOperationEntries: Array<{ key: string; prefix: string }> = [];
    private fatalOperationPrefixCounts = new Map<string, number>();
    private idleTimerId: ReturnType<typeof setTimeout> | undefined;
    private busyLeaseWatchdogTimerId: ReturnType<typeof setTimeout> | undefined;
    private proactiveRecycleTimerId: ReturnType<typeof setTimeout> | undefined;
    private proactiveRecycleReason: ProactiveRecycleReason | null = null;
    private proactiveRecycleFollowupDataOperationsRemaining = 0;
    private proactiveRecycleBarrierPromise: Promise<void> | null = null;
    private resolveProactiveRecycleBarrier: (() => void) | null = null;
    private workerHeapBytes: number | null = null;
    private peakWorkerHeapBytes: number | null = null;
    private completedDataOperationsSinceSpawn = 0;
    private proactiveRecycleCount = 0;
    private lastProactiveRecycleReason: ProactiveRecycleReason | null = null;
    private lastProactiveRecycleTime: number | null = null;
    private lastProactiveRecycleHeapBytes: number | null = null;
    private lastProactiveRecycleDataOperations: number | null = null;
    private leaseReapCount = 0;
    private lastLeaseReapTime: number | null = null;
    private lastLeaseReapOp: string | null = null;
    private lastLeaseReapAgeMs: number | null = null;
    // Populated only after a fatal reply so healthy dispatch never walks a
    // whole PDF on the UI thread before posting work to the worker.
    private pdfDigestCache = new WeakMap<object, Map<string, string>>();

    constructor(
        opts: {
            slotName?: PDFWorkerSlotName;
            idleTimeoutMs?: number;
            busyLeaseMs?: number | null;
            recycleHeapBytes?: number | null;
            recycleAfterDataOperations?: number | null;
        } = {},
    ) {
        this.slotName = opts.slotName ?? "hot";
        const override = testIdleTimeoutOverrides[this.slotName];
        this.idleTimeoutMs =
            opts.idleTimeoutMs
            ?? override
            ?? defaultIdleTimeoutForSlot(this.slotName);
        this.busyLeaseMs = normalizePositiveThreshold(
            opts.busyLeaseMs === undefined
                ? defaultBusyLeaseForSlot(this.slotName)
                : opts.busyLeaseMs,
        );
        this.recycleHeapThresholdBytes = normalizePositiveThreshold(
            opts.recycleHeapBytes === undefined
                ? defaultRecycleHeapBytesForSlot(this.slotName)
                : opts.recycleHeapBytes,
        );
        this.recycleDataOperationThreshold = normalizePositiveThreshold(
            opts.recycleAfterDataOperations === undefined
                ? defaultRecycleDataOperationsForSlot(this.slotName)
                : opts.recycleAfterDataOperations,
        );
    }

    /** The window that spawned the current worker. Used for stale detection. */
    get spawnedFromWindow(): Window | null {
        return this.spawnedFromWindowInternal;
    }

    /** The logical slot name this client owns. */
    get name(): PDFWorkerSlotName {
        return this.slotName;
    }

    /**
     * Number of accepted worker operations, including calls waiting for the
     * configure handshake; 0 = idle.
     * Read cross-bundle via the `Zotero.__beaverMuPDFWorkerClient_*` globals to
     * feed `busy_extracting` in busy-context diagnostics.
     */
    get inFlight(): number {
        return this.pending.size + this.startupWaiters.size;
    }

    /** Epoch-ms for the oldest in-flight operation, or 0 while idle. */
    get oldestInFlightStartedAt(): number {
        if (this.oldestPendingStartedAt === null) {
            return this.oldestStartupWaitStartedAt ?? 0;
        }
        if (this.oldestStartupWaitStartedAt === null) {
            return this.oldestPendingStartedAt;
        }
        return Math.min(
            this.oldestPendingStartedAt,
            this.oldestStartupWaitStartedAt,
        );
    }

    /** Track a call only while it waits for the worker configure handshake. */
    private addStartupWaiter(): number {
        const id = this.nextStartupWaiterId++;
        const startedAt = Date.now();
        this.startupWaiters.set(id, startedAt);
        this.oldestStartupWaitStartedAt = this.oldestStartupWaitStartedAt === null
            ? startedAt
            : Math.min(this.oldestStartupWaitStartedAt, startedAt);
        this.syncBusyLeaseWatchdog();
        return id;
    }

    /** Remove a configure waiter and refresh its cached oldest timestamp. */
    private deleteStartupWaiter(id: number): number | null {
        const removedStartedAt = this.startupWaiters.get(id);
        if (removedStartedAt === undefined || !this.startupWaiters.delete(id)) {
            return null;
        }
        if (this.startupWaiters.size === 0) {
            this.oldestStartupWaitStartedAt = null;
        } else if (removedStartedAt === this.oldestStartupWaitStartedAt) {
            let oldest = Infinity;
            for (const startedAt of this.startupWaiters.values()) {
                oldest = Math.min(oldest, startedAt);
            }
            this.oldestStartupWaitStartedAt = oldest;
        }
        this.syncBusyLeaseWatchdog();
        return removedStartedAt;
    }

    /** Add an operation and update the cached oldest timestamp. */
    private addPending(
        id: number,
        entry: Omit<PendingEntry, "startedAt">,
        startedAt: number = Date.now(),
    ): void {
        this.pending.set(id, { ...entry, startedAt });
        this.oldestPendingStartedAt = this.oldestPendingStartedAt === null
            ? startedAt
            : Math.min(this.oldestPendingStartedAt, startedAt);
        this.syncBusyLeaseWatchdog();
    }

    /** Remove an operation and refresh age tracking outside the stats hot path. */
    private deletePending(id: number): boolean {
        const removed = this.pending.get(id);
        if (!removed || !this.pending.delete(id)) return false;

        if (this.pending.size === 0) {
            this.oldestPendingStartedAt = null;
        } else if (removed.startedAt === this.oldestPendingStartedAt) {
            let oldest = Infinity;
            for (const entry of this.pending.values()) {
                oldest = Math.min(oldest, entry.startedAt);
            }
            this.oldestPendingStartedAt = oldest;
        }
        this.syncBusyLeaseWatchdog();
        return true;
    }

    /** Clear all operations and reset the cached oldest timestamp. */
    private clearPending(): PendingEntry[] {
        const entries = Array.from(this.pending.values());
        this.pending.clear();
        this.oldestPendingStartedAt = null;
        return entries;
    }

    private clearBusyLeaseWatchdog(): void {
        if (this.busyLeaseWatchdogTimerId === undefined) return;
        clearTimeout(this.busyLeaseWatchdogTimerId);
        this.busyLeaseWatchdogTimerId = undefined;
    }

    /** Keep one worker-level watchdog aligned with the oldest accepted work. */
    private syncBusyLeaseWatchdog(): void {
        this.clearBusyLeaseWatchdog();
        const leaseMs = this.busyLeaseMs;
        const worker = this.worker;
        const oldestStartedAt = this.oldestInFlightStartedAt;
        if (
            this.disposed
            || leaseMs === null
            || !worker
            || this.inFlight === 0
            || oldestStartedAt === 0
        ) {
            return;
        }

        const delayMs = Math.max(
            0,
            oldestStartedAt + leaseMs + BUSY_LEASE_WATCHDOG_SLACK_MS - Date.now(),
        );
        const id = setTimeout(() => {
            this.busyLeaseWatchdogTimerId = undefined;
            if (
                this.disposed
                || this.worker !== worker
                || this.inFlight === 0
                || this.busyLeaseMs === null
            ) {
                return;
            }
            const ageMs = Date.now() - this.oldestInFlightStartedAt;
            if (ageMs >= this.busyLeaseMs) {
                this.reapOverdueWorker();
            } else {
                this.syncBusyLeaseWatchdog();
            }
        }, delayMs);
        (id as any)?.unref?.();
        this.busyLeaseWatchdogTimerId = id;
    }

    /**
     * Reap a continuously busy worker whose oldest accepted operation has
     * exhausted the slot lease. When the oldest in-flight item is a posted
     * operation, it receives a non-retriable deadline error while innocent
     * siblings retry through the normal stale-worker path. When the oldest
     * item is a startup waiter (the worker is wedged in the configure
     * handshake), no posted operation caused it, so no deadline error is
     * issued: markStale rejects the startup waiters with a retriable stale
     * error instead. Either way the reap counters record the event.
     */
    private reapOverdueWorker(): void {
        const leaseMs = this.busyLeaseMs;
        const oldestStartedAt = this.oldestInFlightStartedAt;
        if (
            leaseMs === null
            || !this.worker
            || this.inFlight === 0
            || oldestStartedAt === 0
        ) {
            return;
        }

        const ageMs = Date.now() - oldestStartedAt;
        if (ageMs < leaseMs) {
            this.syncBusyLeaseWatchdog();
            return;
        }

        let reapedOp = "startup";
        let oldestPendingId: number | null = null;
        let oldestPending: PendingEntry | null = null;
        // pending iterates in dispatch order (monotonic ids), so the first
        // entry matching the oldest start time is the oldest posted operation.
        for (const [id, entry] of this.pending) {
            if (entry.startedAt === oldestStartedAt) {
                oldestPendingId = id;
                oldestPending = entry;
                break;
            }
        }

        if (oldestPendingId !== null && oldestPending) {
            reapedOp = oldestPending.op;
            this.deletePending(oldestPendingId);
            oldestPending.reject(
                new WorkerDeadlineError(
                    `worker busy-age lease exceeded (op=${reapedOp}, age=${ageMs}ms)`,
                ),
            );
        }

        this.leaseReapCount += 1;
        this.lastLeaseReapTime = Date.now();
        this.lastLeaseReapOp = reapedOp;
        this.lastLeaseReapAgeMs = ageMs;
        this.markStale(
            `busy-age lease exceeded (op=${reapedOp}, age=${ageMs}ms)`,
        );
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

    private clearProactiveRecycleTimer(): void {
        if (this.proactiveRecycleTimerId === undefined) return;
        clearTimeout(this.proactiveRecycleTimerId);
        this.proactiveRecycleTimerId = undefined;
    }

    private releaseProactiveRecycleBarrier(): void {
        const resolve = this.resolveProactiveRecycleBarrier;
        this.proactiveRecycleBarrierPromise = null;
        this.resolveProactiveRecycleBarrier = null;
        resolve?.();
    }

    private resetCurrentWorkerRecycleState(): void {
        this.clearProactiveRecycleTimer();
        this.proactiveRecycleReason = null;
        this.proactiveRecycleFollowupDataOperationsRemaining = 0;
        this.workerHeapBytes = null;
        this.completedDataOperationsSinceSpawn = 0;
        this.releaseProactiveRecycleBarrier();
    }

    /**
     * Record a completed worker reply and decide whether this worker has
     * crossed a proactive-retirement threshold. The completed-data-operation
     * limit controls steady-state accumulation; heap size catches outlier ops.
     */
    private recordCompletedOperation(
        worker: Worker,
        entry: PendingEntry,
        heapBytes: number | null | undefined,
    ): ProactiveRecycleReason | null {
        if (this.worker !== worker) return null;

        if (
            typeof heapBytes === "number"
            && Number.isFinite(heapBytes)
            && heapBytes >= 0
        ) {
            this.workerHeapBytes = heapBytes;
            this.peakWorkerHeapBytes = this.peakWorkerHeapBytes === null
                ? heapBytes
                : Math.max(this.peakWorkerHeapBytes, heapBytes);
        }

        if (isDataOperation(entry.op)) {
            this.completedDataOperationsSinceSpawn += 1;
        }

        if (
            this.recycleHeapThresholdBytes !== null
            && this.workerHeapBytes !== null
            && this.workerHeapBytes >= this.recycleHeapThresholdBytes
        ) {
            return "heap_limit";
        }
        if (
            this.recycleDataOperationThreshold !== null
            && this.completedDataOperationsSinceSpawn
                >= this.recycleDataOperationThreshold
        ) {
            return "data_operation_limit";
        }
        return null;
    }

    /**
     * Request a recycle without interrupting accepted work. The zero-delay
     * timer gives a promise continuation one related follow-up operation
     * (for example getPageCount -> extract); the dispatch gate below bounds
     * that grace and holds later calls until retirement completes.
     */
    private requestProactiveRecycle(
        worker: Worker,
        reason: ProactiveRecycleReason,
    ): void {
        if (this.disposed || this.worker !== worker) return;
        // Heap pressure is the more informative reason when both thresholds
        // are crossed by the same worker.
        if (this.proactiveRecycleReason === null) {
            this.proactiveRecycleReason = reason;
            this.proactiveRecycleFollowupDataOperationsRemaining =
                PROACTIVE_RECYCLE_FOLLOWUP_DATA_OPERATIONS;
        } else if (reason === "heap_limit") {
            this.proactiveRecycleReason = reason;
        }
        if (
            this.pending.size !== 0
            || this.startupWaiters.size !== 0
        ) {
            return;
        }
        if (this.proactiveRecycleBarrierPromise) {
            this.clearProactiveRecycleTimer();
            this.performProactiveRecycle(worker);
            return;
        }
        if (this.proactiveRecycleTimerId !== undefined) return;

        const id = setTimeout(() => {
            this.proactiveRecycleTimerId = undefined;
            if (
                this.disposed
                || this.worker !== worker
                || this.proactiveRecycleReason === null
                || this.pending.size !== 0
                || this.startupWaiters.size !== 0
            ) {
                return;
            }

            this.performProactiveRecycle(worker);
        }, 0);
        (id as any)?.unref?.();
        this.proactiveRecycleTimerId = id;
    }

    /** Retire the current worker after all accepted work has drained. */
    private performProactiveRecycle(worker: Worker): boolean {
        if (
            this.disposed
            || this.worker !== worker
            || this.proactiveRecycleReason === null
            || this.pending.size !== 0
            || this.startupWaiters.size !== 0
        ) {
            return false;
        }

        const recycleReason = this.proactiveRecycleReason;
        const heapAtRecycle = this.workerHeapBytes;
        const dataOpsAtRecycle = this.completedDataOperationsSinceSpawn;
        this.proactiveRecycleCount += 1;
        this.lastProactiveRecycleReason = recycleReason;
        this.lastProactiveRecycleTime = Date.now();
        this.lastProactiveRecycleHeapBytes = heapAtRecycle;
        this.lastProactiveRecycleDataOperations = dataOpsAtRecycle;
        getConfig().log(
            `[MuPDFWorkerClient ${this.slotName}] proactive recycle reason=${recycleReason} heapBytes=${heapAtRecycle ?? "unknown"} completedDataOperations=${dataOpsAtRecycle}`,
            3,
        );
        this.markStale(`proactive ${recycleReason}`, { proactive: true });
        return true;
    }

    private getProactiveRecycleBarrier(): Promise<void> {
        if (!this.proactiveRecycleBarrierPromise) {
            this.proactiveRecycleBarrierPromise = new Promise<void>((resolve) => {
                this.resolveProactiveRecycleBarrier = resolve;
            });
        }
        return this.proactiveRecycleBarrierPromise;
    }

    private waitForProactiveRecycle(
        barrier: Promise<void>,
        signal?: AbortSignal,
    ): Promise<void> {
        if (signal?.aborted) {
            return Promise.reject(new WorkerAbortError());
        }
        if (!signal) return barrier;

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                signal.removeEventListener("abort", onAbort);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new WorkerAbortError());
            };
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
                onAbort();
                return;
            }
            barrier.then(() => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            });
        });
    }

    /**
     * Allow one related data operation after a threshold crossing, then put
     * later data calls behind a drain barrier so a microtask chain cannot keep
     * the retiring worker alive indefinitely.
     */
    private prepareForDataOperationDispatch(
        op: string,
        signal?: AbortSignal,
    ): Promise<void> | null {
        const worker = this.worker;
        const recycleReason = this.proactiveRecycleReason;
        if (!isDataOperation(op) || !worker || recycleReason === null) {
            return null;
        }

        if (this.proactiveRecycleFollowupDataOperationsRemaining > 0) {
            this.proactiveRecycleFollowupDataOperationsRemaining -= 1;
            return null;
        }

        if (this.performProactiveRecycle(worker)) {
            return null;
        }

        const barrier = this.getProactiveRecycleBarrier();
        this.requestProactiveRecycle(worker, recycleReason);
        return this.waitForProactiveRecycle(barrier, signal);
    }

    private ensureWorker(): Worker {
        if (this.disposed) {
            throw new Error("MuPDFWorkerClient: client has been disposed");
        }
        const cfg = getConfig();
        const mainWindow = cfg.getWorkerHost();
        if (!mainWindow) {
            // Pre-spawn failure: no StartupEntry exists, so this never reaches
            // markStale. Count it here so repeated hot-slot spawn failures still
            // raise the restart prompt (this surfaces as worker_unavailable).
            this.recordStartFailure("spawn failed: no main window available");
            throw new WorkerSpawnError(
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
            this.recordStartFailure("spawn failed: no Worker constructor");
            throw new WorkerSpawnError(
                "MuPDFWorkerClient: main window has no Worker constructor",
            );
        }

        let worker: Worker;
        try {
            worker = new WorkerCtor(cfg.workerUrl, { type: "module" });
        } catch (e) {
            // A synchronous construction failure is also a pre-spawn failure
            // (no StartupEntry yet). Count it and normalize to WorkerSpawnError
            // so it classifies as worker_unavailable like the other paths.
            const detail = e instanceof Error ? e.message : String(e);
            this.recordStartFailure(`spawn failed: ${detail}`);
            throw new WorkerSpawnError(
                `MuPDFWorkerClient: worker construction failed: ${detail}`,
            );
        }
        this.spawnCount++;
        this.lastSpawnTime = Date.now();
        cfg.log(`[MuPDFWorkerClient ${this.slotName}] spawned new worker`, 3);
        (worker as any).onmessage = (event: MessageEvent) =>
            this.onWorkerMessage(worker, event);
        (worker as any).onerror = (event: any) => {
            const message = event?.message || "worker onerror";
            cfg.log(`[MuPDFWorkerClient ${this.slotName}] worker.onerror: ${message}`, 1);
            this.markStale(`worker.onerror: ${message}`, { startError: true });
        };
        (worker as any).onmessageerror = (event: any) => {
            const message = event?.message || "worker onmessageerror";
            cfg.log(`[MuPDFWorkerClient ${this.slotName}] worker.onmessageerror: ${message}`, 1);
            this.markStale(`worker.onmessageerror: ${message}`, { startError: true });
        };

        this.worker = worker;
        this.spawnedFromWindowInternal = mainWindow;
        this.resetCurrentWorkerRecycleState();
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
            this.markStale("configure handshake timed out", { startError: true });
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
                { startError: true },
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
                // The worker completed its handshake — the slot is healthy
                // again, so clear the consecutive start-failure streak.
                this.consecutiveStartFailures = 0;
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
        this.deletePending(reply.id);
        const proactiveRecycleReason = this.recordCompletedOperation(
            worker,
            entry,
            reply.heapBytes,
        );

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

        if (proactiveRecycleReason && this.worker === worker) {
            this.requestProactiveRecycle(worker, proactiveRecycleReason);
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
     * Record a worker start-phase failure: bump the consecutive-failure streak
     * and notify the host hook so it can prompt the user after repeated
     * failures. Covers both post-spawn failures (handshake timeout, `onerror`,
     * routed here from `markStale`) and pre-spawn failures (the
     * `WorkerSpawnError` paths in `ensureWorker`, which never create a
     * `StartupEntry` and so never reach `markStale`). Guarded so a host callback
     * error can never break the caller.
     */
    private recordStartFailure(reason: string): void {
        if (this.disposed) return;
        this.consecutiveStartFailures++;
        if (!isConfigured()) return;
        try {
            getConfig().onWorkerStartFailure?.({
                slotName: this.slotName,
                consecutiveFailures: this.consecutiveStartFailures,
                reason,
            });
        } catch (e) {
            getConfig().log(
                `[MuPDFWorkerClient ${this.slotName}] onWorkerStartFailure hook threw: ${e}`,
                2,
            );
        }
    }

    /**
     * Mark the worker as stale: terminate it, reject all pending entries,
     * clear singleton state. Idempotent.
     */
    private markStale(
        reason: string,
        opts?: { startError?: boolean; proactive?: boolean },
    ): void {
        this.clearIdleTimer();
        this.clearBusyLeaseWatchdog();
        this.clearProactiveRecycleTimer();
        const w = this.worker;
        this.worker = null;
        this.spawnedFromWindowInternal = null;
        const startup = this.startup;
        this.startup = null;

        // A "start-phase" failure is a worker that died before it ever completed
        // its configure handshake
        const startPhaseFailure =
            !!opts?.startError && !this.disposed && !!startup && !startup.configured;

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
            // shutdown teardown after configure has been wiped. Proactive
            // retirement already emitted a detailed policy log above.
            if (isConfigured() && !opts?.proactive) {
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
        const pending = this.clearPending();
        for (const entry of pending) {
            entry.reject(stale);
        }
        this.resetCurrentWorkerRecycleState();

        // Surface a repeated inability to start the worker to the host (e.g. to
        // prompt the user to restart). Fired after state is cleared and pending
        // is rejected.
        if (startPhaseFailure) {
            this.recordStartFailure(reason);
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
        this.reapOverdueWorker();
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
        const recycleBarrier = this.prepareForDataOperationDispatch(op, signal);
        if (recycleBarrier) {
            return recycleBarrier.then(() => this.dispatch<T>(op, args, signal));
        }
        const worker = this.ensureWorker();
        const startup = this.pendingStartupFor(worker);
        if (startup) {
            const waiterId = this.addStartupWaiter();
            return this.waitForStartup(worker, startup, signal).then(
                () => {
                    const startedAt = this.deleteStartupWaiter(waiterId);
                    return this.dispatchConfigured<T>(
                        worker,
                        op,
                        args,
                        signal,
                        fatalCandidate,
                        startedAt ?? undefined,
                    );
                },
                (error) => {
                    this.deleteStartupWaiter(waiterId);
                    throw error;
                },
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
        startedAt?: number,
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
                    this.deletePending(id);
                    rejectWithCleanup(new WorkerAbortError());
                    this.markStale("op aborted by caller");
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }
            this.addPending(
                id,
                {
                    resolve: resolveWithCleanup,
                    reject: rejectWithCleanup,
                    op,
                    fatalCandidate: fatalCandidate ?? undefined,
                },
                startedAt,
            );
            if (signal?.aborted) {
                this.deletePending(id);
                rejectWithCleanup(new WorkerAbortError());
                return;
            }
            try {
                this.clearIdleTimer();
                worker.postMessage({ id, op, args });
            } catch (e) {
                this.deletePending(id);
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
            /**
             * Attach the opt-in `diagnostics` block (settings, engine,
             * per-page timings) to the result. Default false.
             */
            includeDiagnostics?: boolean;
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
            includeDiagnostics: args?.includeDiagnostics,
        }, { signal });
    }

    async extractSerialized(
        pdfData: Uint8Array | ArrayBuffer,
        args?: Parameters<MuPDFWorkerClient["extract"]>[1],
        signal?: AbortSignal,
    ): Promise<SerializedBeaverExtractResult> {
        const bytes =
            pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        return this.call<SerializedBeaverExtractResult>("extractSerialized", {
            pdfData: bytes,
            mode: args?.mode,
            markdown: args?.markdown,
            structured: args?.structured,
            settings: args?.settings,
            paragraphSettings: args?.paragraphSettings,
            pageIndices: args?.pageIndices,
            pageRange: args?.pageRange,
            analysisWindow: args?.analysisWindow,
            includeDiagnostics: args?.includeDiagnostics,
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
    getStats(): MuPDFWorkerStats {
        return {
            hasWorker: this.worker !== null,
            disposed: this.disposed,
            spawnCount: this.spawnCount,
            retryCount: this.retryCount,
            consecutiveStartFailures: this.consecutiveStartFailures,
            pendingCount: this.pending.size,
            nextId: this.nextId,
            dispatchCounts: { ...this.dispatchCounts },
            lastSpawnTime: this.lastSpawnTime,
            idleTimerArmed: this.idleTimerId !== undefined,
            workerHeapBytes: this.workerHeapBytes,
            peakWorkerHeapBytes: this.peakWorkerHeapBytes,
            completedDataOperationsSinceSpawn:
                this.completedDataOperationsSinceSpawn,
            recycleHeapThresholdBytes: this.recycleHeapThresholdBytes,
            recycleDataOperationThreshold: this.recycleDataOperationThreshold,
            proactiveRecyclePending: this.proactiveRecycleReason !== null,
            proactiveRecycleCount: this.proactiveRecycleCount,
            lastProactiveRecycleReason: this.lastProactiveRecycleReason,
            lastProactiveRecycleTime: this.lastProactiveRecycleTime,
            lastProactiveRecycleHeapBytes: this.lastProactiveRecycleHeapBytes,
            lastProactiveRecycleDataOperations:
                this.lastProactiveRecycleDataOperations,
            leaseReapCount: this.leaseReapCount,
            lastLeaseReapTime: this.lastLeaseReapTime,
            lastLeaseReapOp: this.lastLeaseReapOp,
            lastLeaseReapAgeMs: this.lastLeaseReapAgeMs,
        };
    }

    /** Test-only: zero out cumulative counters. Does not touch the worker. */
    resetStats(): void {
        this.spawnCount = 0;
        this.retryCount = 0;
        this.consecutiveStartFailures = 0;
        this.dispatchCounts = {};
        this.lastSpawnTime = null;
        this.peakWorkerHeapBytes = this.workerHeapBytes;
        this.proactiveRecycleCount = 0;
        this.lastProactiveRecycleReason = null;
        this.lastProactiveRecycleTime = null;
        this.lastProactiveRecycleHeapBytes = null;
        this.lastProactiveRecycleDataOperations = null;
        this.leaseReapCount = 0;
        this.lastLeaseReapTime = null;
        this.lastLeaseReapOp = null;
        this.lastLeaseReapAgeMs = null;
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
            this.addPending(id, { resolve, reject, op });
            try {
                this.clearIdleTimer();
                worker.postMessage({ id, op, args });
            } catch (e) {
                this.deletePending(id);
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
        // Worker replies keep optional extraction details in a JSON-friendly
        // payload shape; missing fields are valid for errors without details.
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
 * Return true for worker lifecycle or runtime-pressure failures that are worth
 * retrying. Document verdicts and caller cancellation are not transient.
 *
 * String checks complement `instanceof` because this module can be loaded by
 * more than one bundle, which gives exported classes distinct identities.
 */
export function isTransientWorkerError(error: unknown): boolean {
    if (error instanceof StaleWorkerError || error instanceof WorkerSpawnError) {
        return true;
    }
    if (
        error instanceof ExtractionError
        && error.code === ExtractionErrorCode.HEAP_EXHAUSTION
    ) {
        return true;
    }
    const name = (error as { name?: unknown } | null | undefined)?.name;
    if (name === "StaleWorkerError" || name === "WorkerSpawnError") {
        return true;
    }
    const code = (error as { code?: unknown } | null | undefined)?.code;
    return name === "ExtractionError" && code === ExtractionErrorCode.HEAP_EXHAUSTION;
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
    options?: { force?: boolean },
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
        // dispose() only nulls the slot when it still holds *this* client;
        // force-clear ignores that guard for the no-respawn shutdown case.
        if (options?.force) slots[slotName].set(undefined);
    }
}
