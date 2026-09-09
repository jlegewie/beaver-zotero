/**
 * Whole-library background-processing helpers.
 *
 * Wraps the `/beaver/test/processing-*` and `/beaver/test/set-pref` endpoints.
 * The queue-level helpers (`backgroundEnqueue`, `backgroundProcessOnce`, …)
 * live in `cacheInspector.ts`; these drive the producer above it.
 */

import { getBaseUrl } from './fixtures';
import type { BackgroundQueueStats } from './cacheInspector';

async function post<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${getBaseUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Processing inspector: HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
}

export interface AttachmentProcessingAggregates {
    total: number;
    readable: number;
    unreadable: number;
    awaitingOcr: number;
    extracted: number;
    ocrNeeded: number;
    ocrDone: number;
    upserted: number;
    failed: number;
    skipped: number;
    oldestPendingAt: string | null;
}

export interface BackgroundProcessingFailureSummary {
    source: 'ledger' | 'dead_letter' | 'content_failure';
    stage: string;
    libraryId: number | null;
    zoteroKey: string | null;
    error: string | null;
    attempts: number | null;
    timestamp: string | number | null;
}

export type AttachmentExtractStatus = 'done' | 'failed' | 'skipped' | null;
export type AttachmentOcrStatus = 'na' | 'needed' | 'done' | 'failed' | null;
export type AttachmentUpsertStatus = 'done' | 'failed' | null;

export interface LedgerRow {
    libraryId: number;
    zoteroKey: string;
    itemId: number | null;
    contentKind: 'pdf' | 'epub' | 'snapshot';
    fileMtimeMs: number | null;
    fileSizeBytes: number | null;
    fileHash: string | null;
    structuredDocumentHash: string | null;
    extractStatus: AttachmentExtractStatus;
    extractSchemaVersion: string | null;
    ocrStatus: AttachmentOcrStatus;
    ocrEngineVersion: string | null;
    upsertStatus: AttachmentUpsertStatus;
    upsertIndexVersion: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface ProcessingCursor {
    libraryId: number;
    maxClientDateModified: string | null;
    attachmentCount: number;
    ledgerRowCount: number;
    lastScanTimestamp: number;
}

export interface DocumentCacheStats {
    metadata_count: number;
    payload_count: number;
    payload_cache_dir: string;
    payload_total_bytes: number;
    payload_budget_bytes: number;
}

export interface ProcessingStatusResponse {
    ok: boolean;
    error?: string;
    queue?: BackgroundQueueStats;
    ledger?: AttachmentProcessingAggregates;
    failures?: BackgroundProcessingFailureSummary[];
    issues?: Array<{
        reason: string;
        count: number;
    }>;
    worker?: { available: number; deferred: number; inFlight: number; drainNow: boolean; backlogGateOpen: boolean };
    coverage?: unknown;
    documentCache?: DocumentCacheStats | null;
    entitlements?: {
        hasOcrAccess: boolean;
        hasSearchIndexAccess: boolean;
        mirrored_ocr: boolean | null;
        mirrored_search_index: boolean | null;
    };
    prefs?: {
        backgroundProcessingEnabled: boolean;
        backgroundProcessingContinuous: boolean;
        backgroundExtractorEnabled: boolean;
        backgroundProcessingLibrariesToSkip: unknown;
        accessRemoteFiles: boolean;
    };
    library_scope?: {
        initialized: boolean | null;
        searchable_library_ids: number[] | null;
    };
}

export interface ProcessingLedgerResponse {
    ok: boolean;
    error?: string;
    total?: number;
    rows?: LedgerRow[];
    cursor?: ProcessingCursor | null;
    cursors?: Record<string, ProcessingCursor | null>;
}

export function processingStatus(
    body: { libraryId?: number; includeCoverage?: boolean; includeFailures?: boolean } = {},
): Promise<ProcessingStatusResponse> {
    return post('/beaver/test/processing-status', body);
}

export function processingLedger(
    body: { libraryId?: number; zoteroKey?: string; limit?: number } = {},
): Promise<ProcessingLedgerResponse> {
    return post('/beaver/test/processing-ledger', body);
}

export function processingReset(
    body: { libraryId?: number } = {},
): Promise<{ ok: boolean; error?: string; library_ids?: number[] }> {
    return post('/beaver/test/processing-reset', body);
}

export function processingReconcileNow(): Promise<{
    ok: boolean;
    error?: string;
    duration_ms?: number;
}> {
    return post('/beaver/test/processing-reconcile-now', {});
}

export function setPref(
    key: string,
    value: unknown,
): Promise<{ ok: boolean; key: string; value: unknown }> {
    return post('/beaver/test/set-pref', { key, value });
}

/** One ledger row, or null when the reconciler never created it. */
export async function getLedgerRow(
    libraryId: number,
    zoteroKey: string,
): Promise<LedgerRow | null> {
    const response = await processingLedger({ libraryId, zoteroKey });
    return response.rows?.[0] ?? null;
}

/** A queue row to wait on, identified by its dedup coordinates. */
export interface JobTarget {
    libraryId: number;
    zoteroKey: string;
    jobType: string;
}

/**
 * Drive `background-process-once` until every one of `targets` has left the
 * queue, then return.
 *
 * Deliberately *not* "wait for the queue to be empty". Draining a fixture's
 * extract job can spawn follow-on work that the caller never asked for and
 * must not wait on:
 *   - an OCR-entitled account enqueues `document_ocr` for a scanned PDF at
 *     priority 90, which is below the idle-gate ceiling and so runs on its own
 *     — advancing the very `ocr_status` the caller is about to assert;
 *   - a search-entitled account enqueues `fulltext_upsert` at priority 115,
 *     which cannot be claimed at all while continuous mode is off and the
 *     machine is in use, so waiting for an empty queue would simply time out.
 *
 * `peekBackgroundJobs` lists rows irrespective of their visibility window, so a
 * claimed-but-unfinished row is still visible; a target disappears only when
 * its job actually completes.
 */
export async function drainJobs(
    targets: JobTarget[],
    opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ passes: number; elapsedMs: number }> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const pollMs = opts.pollMs ?? 150;
    const start = Date.now();
    let passes = 0;
    let remaining: JobTarget[] = targets;
    while (Date.now() - start < timeoutMs) {
        const peek = await post<{ ok: boolean; jobs?: Array<{
            jobType: string; libraryId: number; zoteroKey: string;
        }> }>('/beaver/test/background-peek', { limit: 1000 });
        const jobs = peek.jobs ?? [];
        remaining = targets.filter((target) => jobs.some((job) =>
            job.jobType === target.jobType
            && job.libraryId === target.libraryId
            && job.zoteroKey === target.zoteroKey));
        if (remaining.length === 0) {
            return { passes, elapsedMs: Date.now() - start };
        }
        await post('/beaver/test/background-process-once', {});
        passes += 1;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
        `jobs did not complete within ${timeoutMs}ms after ${passes} passes; still queued: `
        + remaining.map((t) => `${t.jobType} ${t.libraryId}-${t.zoteroKey}`).join(', '),
    );
}

/** True when no row for `target` remains in the queue. */
export async function isJobQueued(target: JobTarget): Promise<boolean> {
    const peek = await post<{ ok: boolean; jobs?: Array<{
        jobType: string; libraryId: number; zoteroKey: string;
    }> }>('/beaver/test/background-peek', { limit: 1000 });
    return (peek.jobs ?? []).some((job) =>
        job.jobType === target.jobType
        && job.libraryId === target.libraryId
        && job.zoteroKey === target.zoteroKey);
}
