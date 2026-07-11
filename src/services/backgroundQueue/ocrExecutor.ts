/**
 * OCR background lane for scanned PDFs without a text layer.
 *
 * This is a network/IO job: request OCR, upload the source PDF, wait for a
 * searchable PDF, re-extract it, and cache it against the original attachment.
 *
 * Backend waits are slot-free: queued OCR jobs are tracked by the shared poller,
 * and the queue row is woken later for download + re-extraction. Final
 * re-extraction still uses the serialized background MuPDF lane via
 * `ctx.runOnMuPDFWorker`.
 *
 * Registered from the webpack `GlobalContextInitializer` (it needs the
 * Supabase-authenticated backend client); the esbuild dispatcher only knows the
 * `JobExecutor` interface.
 */

import type {
    AttachmentProcessingStateRecord,
    BackgroundJobRecord,
    DocumentProcessingFailureInput,
} from '../database';
import {
    loadAttachmentData,
    resolveAttachmentFileSource,
    type AttachmentFileSource,
} from '../documentExtraction/attachmentSource';
import { ExternalAbortError } from '../agentDataProvider/timeout';
import { extractPdfBytesAndCacheAsOriginalAttachment } from '../documentExtraction/ocrReextract';
import { computeStructuredDocumentHash } from '../documentExtraction/structuredDocumentHash';
import {
    backgroundProcessingEnabled,
    buildIndexJobPayload,
} from '../backgroundProcessing/utils';
import { BACKGROUND_UPSERT_PRIORITY } from '../backgroundProcessing/constants';
import {
    ocrApiClient,
    type OcrError,
    type OcrRequestResponse,
    type OcrStatusResponse,
} from '../ocr/ocrApiClient';
import {
    getBytesFromSignedUrl,
    putBytesToSignedUrl,
} from '../ocr/gcsTransfer';
import {
    OcrAbort,
    type OcrPollResult,
    OcrStatusPoller,
    ocrStatusPoller,
} from '../ocr/ocrStatusPoller';
import {
    OCR_ENGINE_VERSION,
    OCR_OUTCOME_DETAIL_MAX,
    OCR_PRIORITY_BACKFILL,
    OCR_TRACK_BUDGET_MS,
    OCR_TERMINAL_FAILED,
    OCR_TERMINAL_GEOMETRY,
    OCR_TERMINAL_NO_TEXT,
} from '../ocr/constants';
import { logger } from '../../utils/logger';
import { UNRESOLVED_LIBRARY_ID } from '../../utils/libraryIdentity';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { ApiError } from '../../../react/types/apiErrors';
import {
    libraryScopeInitializedAtom,
    searchableLibraryIdsAtom,
} from '../../../react/atoms/profile';
import { store } from '../../../react/store';
import type {
    JobExecutionContext,
    JobExecutor,
    JobOutcome,
} from './jobExecutor';

interface ResolvedJob {
    item: Zotero.Item;
    /** Local path or supported remote source for the original scan. */
    source: AttachmentFileSource;
    /** Convenience alias of `source.filePath` (synthetic `remote:` path for remote). */
    filePath: string;
    fileHash: string;
    pageCount: number;
    /** Original byte length for a remote source (keys the cache); `0` for local. */
    sourceSizeBytes: number;
    sourceKey: string;
    /** Lazily reads/downloads the original scan bytes once, memoized per job. */
    loadOriginalBytes: () => Promise<Uint8Array>;
}

/** Sentinel raised when the original remote scan cannot be loaded for upload. */
class OcrRemoteLoadError extends Error {
    constructor(public readonly code: 'file_too_large' | 'download_failed' | 'read_failed') {
        super(`ocr_remote_load_failed: ${code}`);
        this.name = 'OcrRemoteLoadError';
    }
}

export class OcrExecutor implements JobExecutor {
    readonly jobType = 'document_ocr' as const;

    /**
     * Resume hints keyed by source item. The file hash keeps each hint scoped to
     * the attachment content that created the backend job.
     */
    private readonly resumeHints = new Map<string, { jobId: string; fileHash: string }>();

    /**
     * Slot-free background polls keyed by source item. At most one live track
     * polls and wakes the parked row for each source attachment.
     */
    private readonly tracks = new Map<string, { promise: Promise<void>; abort: AbortController }>();

    /** The poller is injectable so callers can provide scoped instances. */
    constructor(private readonly poller: OcrStatusPoller = ocrStatusPoller) {}

    /**
     * Abort background tracks when the dispatcher shuts down or replaces this
     * executor.
     */
    dispose(): void {
        for (const track of this.tracks.values()) {
            try {
                track.abort.abort();
            } catch {
                // best-effort
            }
        }
        this.tracks.clear();
    }

    /** Await all in-flight background tracks to settle before shutdown completes. */
    async drainTracks(): Promise<void> {
        await Promise.allSettled([...this.tracks.values()].map((t) => t.promise));
    }

    async execute(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        try {
            return await this.run(record, ctx);
        } catch (error) {
            if (error instanceof OcrAbort || ctx.externalAbortSignal.aborted) {
                return { kind: 'release', reason: 'aborted' };
            }
            if (error instanceof OcrRemoteLoadError) {
                // Oversized scans are terminal-for-now (recoverable if limits change);
                // a failed/partial download is transient, so let the queue retry.
                if (error.code === 'file_too_large') {
                    return { kind: 'complete', reason: 'file_too_large' };
                }
                return { kind: 'retry', error: `ocr_remote_download_failed: ${error.code}`, reason: 'ocr_remote_download_failed' };
            }
            const message = error instanceof Error ? error.message : String(error);
            logger(`OcrExecutor: job ${record.libraryId}-${record.zoteroKey} error: ${message}`, 1);
            return { kind: 'retry', error: `ocr_unexpected: ${message}`, reason: 'ocr_unexpected' };
        }
    }

    /** Transient dead-letters are tracked by the queue; no content row needed. */
    describeFailure(): DocumentProcessingFailureInput | null {
        return null;
    }

    private async run(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        const resolved = await this.resolveJob(record, ctx);
        if ('outcome' in resolved) return resolved.outcome;
        const job = resolved.job;
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
        if (typeof (ctx.db as any).ensureAttachmentProcessingState === 'function') {
            await ctx.db.ensureAttachmentProcessingState({
                libraryId: job.item.libraryID,
                zoteroKey: job.item.key,
                itemId: job.item.id,
                contentKind: 'pdf',
            });
            await ctx.db.ensureAttachmentFileHash(
                job.item.libraryID,
                job.item.key,
                job.fileHash,
            );
        }
        const ledgerGuard = typeof (ctx.db as any).getAttachmentProcessingState === 'function'
            ? await ctx.db.getAttachmentProcessingState(job.item.libraryID, job.item.key)
            : null;

        // Loop guard: skip scans this OCR engine has already marked terminal.
        if (
            await ctx.db.isDocumentProcessingPermanentlyFailed(
                job.fileHash,
                'ocr',
                OCR_ENGINE_VERSION,
            )
        ) {
            logger(`OcrExecutor: ${job.sourceKey} skipped, terminal OCR failure already recorded`, 3);
            return { kind: 'complete', reason: 'ocr_perm_failed' };
        }
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);

        const ready = await this.resolveReady(job, ctx, record.id);
        if ('outcome' in ready) {
            await this.persistFailedOutcome(job, ready.outcome, ctx);
            return ready.outcome;
        }

        const ocrBytes = await this.download(ready.getUrl, job, ctx);

        const outcome = await this.reextractAndCache(job, ocrBytes, ctx, ledgerGuard);
        await this.persistFailedOutcome(job, outcome, ctx);
        return outcome;
    }

    /** Resolve a ready GET URL, reusing a valid resume hint when available. */
    private async resolveReady(
        job: ResolvedJob,
        ctx: JobExecutionContext,
        recordId: number,
    ): Promise<{ getUrl: string } | { outcome: JobOutcome }> {
        const hint = this.resumeHints.get(job.sourceKey);
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
        if (hint?.fileHash === job.fileHash) {
            logger(`OcrExecutor: ${job.sourceKey} resuming OCR backend job ${hint.jobId}`, 3);
            const resumed = await this.resumeByJobId(hint.jobId, job, ctx, recordId);
            if (!('fallback' in resumed)) {
                // Keep hints only for outcomes that are resumed on a later claim.
                const willResume =
                    'outcome' in resumed
                    && (resumed.outcome.kind === 'defer' || resumed.outcome.kind === 'release');
                if (!willResume) this.resumeHints.delete(job.sourceKey);
                return resumed;
            }
            // This backend job cannot be resumed, so request again.
            logger(`OcrExecutor: ${job.sourceKey} resume unavailable for ${hint.jobId}; requesting OCR again`, 3);
            this.resumeHints.delete(job.sourceKey);
        } else if (hint) {
            // Attachment content changed since the hint was recorded.
            logger(`OcrExecutor: ${job.sourceKey} discarded stale OCR resume hint for changed file hash`, 3);
            this.resumeHints.delete(job.sourceKey);
        }

        logger(`OcrExecutor: ${job.sourceKey} requesting OCR (pages=${job.pageCount})`, 3);
        const requestResult = await ocrApiClient.requestOcr(job.fileHash, job.pageCount);
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
        return this.resolveToReadyGetUrl(requestResult, job, ctx, recordId);
    }

    /**
     * Check an existing backend job once. Completed jobs finish in this slot;
     * queued jobs park again, and non-resumable states fall back to /ocr/request.
     */
    private async resumeByJobId(
        jobId: string,
        job: ResolvedJob,
        ctx: JobExecutionContext,
        recordId: number,
    ): Promise<{ getUrl: string } | { outcome: JobOutcome } | { fallback: true }> {
        let status: OcrStatusResponse;
        try {
            status = await ocrApiClient.status(jobId);
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                // Missing rows are re-created or rejoined through /ocr/request.
                logger(`OcrExecutor: ${job.sourceKey} OCR backend job ${jobId} was not found`, 3);
                return { fallback: true };
            }
            throw error;
        }
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
        logger(`OcrExecutor: ${job.sourceKey} resumed OCR backend job ${jobId}: ${status.status}`, 3);

        switch (status.status) {
            case 'completed':
                if (status.get_url) return { getUrl: status.get_url };
                return { outcome: { kind: 'retry', error: 'ocr_completed_without_url', reason: 'ocr_completed_without_url' } };
            case 'failed':
                return { outcome: this.failureOutcome(job, status.error) };
            case 'queued':
                return this.defer(jobId, job, recordId);
            case 'pending':
                // /ocr/status cannot provide upload URLs.
                return { fallback: true };
        }
    }

    // ----------------------------------------------------------------------
    // Resolve attachment, file, hash, and page count.
    // ----------------------------------------------------------------------

    private async resolveJob(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<{ job: ResolvedJob } | { outcome: JobOutcome }> {
        let item: Zotero.Item | null = null;
        if (!store.get(libraryScopeInitializedAtom)) {
            // Normally the lane is unregistered while scope is unknown. Release
            // defensively in case readiness changes after the row is claimed.
            return { outcome: { kind: 'release', reason: 'library_scope_uninitialized' } };
        } else if (record.libraryId === UNRESOLVED_LIBRARY_ID) {
            logger(
                `OcrExecutor: library not available on this device for ${record.libraryId}-${record.zoteroKey}`,
                1,
            );
        } else if (!store.get(searchableLibraryIdsAtom).includes(record.libraryId)) {
            logger(
                `OcrExecutor: ${record.libraryId}-${record.zoteroKey} skipped (library_excluded)`,
                2,
            );
            return { outcome: { kind: 'complete', reason: 'library_excluded' } };
        } else {
            try {
                item = (await Zotero.Items.getByLibraryAndKeyAsync(
                    record.libraryId,
                    record.zoteroKey,
                )) || null;
            } catch (e) {
                logger(`OcrExecutor: getByLibraryAndKeyAsync failed for ${record.libraryId}-${record.zoteroKey}: ${e}`, 1);
            }
            this.throwIfLibraryUnavailable(record.libraryId, ctx);
        }
        if (!item || safeIsInTrash(item) === true) {
            return { outcome: { kind: 'complete', reason: !item ? 'item_missing' : 'in_trash' } };
        }
        const resolvedItem = item;

        // Resolve a local path or a supported remote source. OCR needs the scan
        // bytes (to upload) and a stable identity (to key the cache). Remote-only
        // sources are downloaded in-memory like every other extraction path; the
        // `accessRemoteFiles` gate is already enforced by resolveAttachmentFileSource.
        const source = await resolveAttachmentFileSource({
            item: resolvedItem,
            maxFileSizeMB: 0,
            localSizeStrategy: 'zotero-total',
        });
        this.throwIfLibraryUnavailable(record.libraryId, ctx);
        if (source.kind === 'error') {
            if (source.code === 'file_too_large') {
                return { outcome: { kind: 'complete', reason: 'file_too_large' } };
            }
            // Not available locally. Distinguish "on server but remote access is
            // disabled" from "not retrievable" so the skip is observable. Recorded
            // as `complete` (no permanent-failure row), so detection re-enqueues
            // once the file becomes local.
            const reason = source.remoteAvailable ? 'file_not_local_remote' : 'file_not_local';
            logger(`OcrExecutor: ${record.libraryId}-${record.zoteroKey} skipped (${reason})`, 2);
            return { outcome: { kind: 'complete', reason } };
        }

        const fileSource = source.source;
        const isRemoteOnly = fileSource.isRemoteOnly;
        const filePath = fileSource.filePath;

        // Backstop for a future whole-library backfill: a background sweep must not
        // pull remote bytes (it should pre-filter not-local items at enqueue time).
        if (isRemoteOnly && record.priority >= OCR_PRIORITY_BACKFILL) {
            logger(`OcrExecutor: ${record.libraryId}-${record.zoteroKey} skipped (file_not_local_remote; backfill)`, 2);
            return { outcome: { kind: 'complete', reason: 'file_not_local_remote' } };
        }

        // attachmentHash hashes the local file and is undefined for remote-only
        // items; the synced server MD5 is the same content hash, so backend OCR
        // dedup stays consistent across machines.
        let fileHash: string | undefined;
        if (isRemoteOnly) {
            fileHash = resolvedItem.attachmentSyncedHash || undefined;
        } else {
            try {
                fileHash = await resolvedItem.attachmentHash;
            } catch (e) {
                logger(`OcrExecutor: attachmentHash failed for ${record.libraryId}-${record.zoteroKey}: ${e}`, 1);
            }
            this.throwIfLibraryUnavailable(record.libraryId, ctx);
        }
        if (!fileHash) {
            return { outcome: { kind: 'complete', reason: 'no_file_hash' } };
        }

        // Page count and the original byte length both come from the cached
        // NO_TEXT_LAYER metadata written at detection. For remote the row is keyed
        // by the same synthetic path and stores the original byteLength, so no extra
        // download is needed here to learn the cache key.
        const meta = await this.resolveSourceMetadata(resolvedItem, filePath);
        this.throwIfLibraryUnavailable(record.libraryId, ctx);
        const pageCount = meta?.pageCount ?? null;
        if (pageCount == null || pageCount < 1) {
            return { outcome: { kind: 'complete', reason: 'no_page_count' } };
        }
        const sourceSizeBytes = isRemoteOnly ? (meta?.sourceSizeBytes ?? 0) : 0;

        // Lazy, memoized: only the first-time `pending` upload path reads/downloads
        // bytes; a cache hit (`ready`) or rejoin (`queued`) never loads the original.
        let bytesPromise: Promise<Uint8Array> | undefined;
        const loadOriginalBytes = () =>
            (bytesPromise ??= this.loadOriginalBytes(resolvedItem, fileSource, ctx));

        logger(`OcrExecutor: ${record.libraryId}-${record.zoteroKey} resolved OCR source (pages=${pageCount}${isRemoteOnly ? '; remote' : ''})`, 3);
        return {
            job: {
                item: resolvedItem,
                source: fileSource,
                filePath,
                fileHash,
                pageCount,
                sourceSizeBytes,
                sourceKey: `${record.libraryId}-${record.zoteroKey}`,
                loadOriginalBytes,
            },
        };
    }

    /** Page count + original byte length from the cached NO_TEXT_LAYER metadata. */
    private async resolveSourceMetadata(
        item: Zotero.Item,
        filePath: string,
    ): Promise<{ pageCount: number | null; sourceSizeBytes: number } | null> {
        const cache = Zotero.Beaver?.documentCache;
        if (!cache) return null;
        const meta = await cache
            .getMetadata({ libraryId: item.libraryID, zoteroKey: item.key }, filePath)
            .catch(() => null);
        if (!meta) return null;
        return { pageCount: meta.pageCount ?? null, sourceSizeBytes: meta.sourceSizeBytes ?? 0 };
    }

    /**
     * Read (local) or download (remote, in-memory) the original scan bytes. Remote
     * downloads honor the abort signal only when a `throwIfTimedOut` callback is
     * also passed; the underlying HTTP is otherwise bounded by the download timeout.
     */
    private async loadOriginalBytes(
        item: Zotero.Item,
        source: AttachmentFileSource,
        ctx: JobExecutionContext,
    ): Promise<Uint8Array> {
        this.throwIfLibraryUnavailable(item.libraryID, ctx);
        if (source.kind === 'local') {
            const data = await IOUtils.read(source.filePath);
            this.throwIfLibraryUnavailable(item.libraryID, ctx);
            return data;
        }
        const result = await loadAttachmentData({
            item,
            source,
            maxFileSizeMB: 0,
            signal: ctx.externalAbortSignal,
            throwIfTimedOut: (phase) => {
                if (ctx.externalAbortSignal.aborted) throw new ExternalAbortError(phase);
            },
        });
        if (result.kind === 'error') {
            throw new OcrRemoteLoadError(result.code);
        }
        this.throwIfLibraryUnavailable(item.libraryID, ctx);
        return result.data;
    }

    // ----------------------------------------------------------------------
    // Request OCR, then park the job for slot-free backend polling.
    // ----------------------------------------------------------------------

    private async resolveToReadyGetUrl(
        request: OcrRequestResponse,
        job: ResolvedJob,
        ctx: JobExecutionContext,
        recordId: number,
    ): Promise<{ getUrl: string } | { outcome: JobOutcome }> {
        logger(`OcrExecutor: ${job.sourceKey} OCR request response: ${request.status}`, 3);
        switch (request.status) {
            case 'disabled':
                // Backend says the user lacks OCR entitlement (gate backstop).
                logger(`OcrExecutor: ${job.sourceKey} OCR disabled by backend entitlement gate`, 3);
                return { outcome: { kind: 'complete', reason: 'ocr_disabled' } };
            case 'rejected':
                // Page-cap rejections depend on the current entitlement limits,
                // so they are not recorded as terminal OCR failures.
                logger(`OcrExecutor: ${job.sourceKey} rejected (${request.reason}; ${request.page_count}/${request.limit})`, 2);
                return { outcome: { kind: 'complete', reason: `ocr_${request.reason ?? 'rejected'}` } };
            case 'failed':
                return { outcome: this.failureOutcome(job, request.error) };
            case 'ready':
                logger(`OcrExecutor: ${job.sourceKey} OCR cache hit; downloading searchable PDF`, 3);
                if (request.get_url) return { getUrl: request.get_url };
                return { outcome: { kind: 'retry', error: 'ocr_ready_without_url', reason: 'ocr_ready_without_url' } };
            case 'pending': {
                if (!request.job_id || !request.put_url) {
                    return { outcome: { kind: 'retry', error: 'ocr_pending_without_put_url', reason: 'ocr_pending_without_put_url' } };
                }
                await this.upload(request.put_url, job, ctx);
                logger(`OcrExecutor: ${job.sourceKey} marking OCR upload complete for backend job ${request.job_id}`, 3);
                await ocrApiClient.markUploaded(request.job_id);
                this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
                return this.defer(request.job_id, job, recordId);
            }
            case 'queued':
                if (!request.job_id) {
                    return { outcome: { kind: 'retry', error: 'ocr_queued_without_job_id', reason: 'ocr_queued_without_job_id' } };
                }
                logger(`OcrExecutor: ${job.sourceKey} joined queued OCR backend job ${request.job_id}`, 3);
                return this.defer(request.job_id, job, recordId);
        }
    }

    private async upload(
        putUrl: string,
        job: ResolvedJob,
        ctx: JobExecutionContext,
    ): Promise<void> {
        // Read (local) or download (remote, in-memory) the scan bytes lazily, only
        // on the pending path where an upload is actually needed — a cache hit
        // (`ready`) or rejoin (`queued`) never loads the file. `loadOriginalBytes`
        // memoizes so the bytes are loaded at most once per job.
        const bytes = await job.loadOriginalBytes();
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
        logger(`OcrExecutor: ${job.sourceKey} uploading source PDF for OCR (${(bytes.length / 1024 / 1024).toFixed(2)}MB)`, 3);
        await putBytesToSignedUrl(putUrl, bytes, {
            contentType: 'application/pdf',
            signal: ctx.externalAbortSignal,
        });
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
        logger(`OcrExecutor: ${job.sourceKey} uploaded source PDF for OCR`, 3);
    }

    // ----------------------------------------------------------------------
    // Park the job: free the slot, let the shared poller track the backend job.
    // ----------------------------------------------------------------------

    /**
     * Park the queue row and track the backend job without holding a lane slot.
     * The resume hint lets the next claim continue this backend job.
     */
    private defer(
        jobId: string,
        job: ResolvedJob,
        recordId: number,
    ): { outcome: JobOutcome } {
        this.resumeHints.set(job.sourceKey, { jobId, fileHash: job.fileHash });
        this.startTracking(jobId, job, recordId);
        logger(`OcrExecutor: ${job.sourceKey} parked queue row while backend job ${jobId} runs`, 3);
        return { outcome: { kind: 'defer', reason: 'ocr_polling' } };
    }

    /**
     * Start the single slot-free poll for this attachment. Terminal states wake
     * the parked row; timeouts let the visibility window re-surface it.
     */
    private startTracking(jobId: string, job: ResolvedJob, recordId: number): void {
        // One live track per attachment. If a slow backend job outlives the
        // visibility window and the row re-surfaces, the re-claim defers again
        // without starting a second poll for the same source.
        if (this.tracks.has(job.sourceKey)) {
            logger(`OcrExecutor: ${job.sourceKey} OCR backend job ${jobId} already being tracked`, 4);
            return;
        }

        const abort = new AbortController();
        const deadline = Date.now() + OCR_TRACK_BUDGET_MS;
        logger(`OcrExecutor: ${job.sourceKey} tracking OCR backend job ${jobId}`, 3);
        const promise = this.poller
            .poll(jobId, { deadline, signal: abort.signal })
            .then((result) => this.wakeOnSettle(job, recordId, result))
            // Dispose/shutdown aborts the poll; there is no row to wake.
            .catch(() => undefined)
            .finally(() => {
                const current = this.tracks.get(job.sourceKey);
                if (current && current.abort === abort) {
                    this.tracks.delete(job.sourceKey);
                }
            });
        this.tracks.set(job.sourceKey, { promise, abort });
    }

    /**
     * Re-arm the parked queue row after a terminal backend status.
     */
    private async wakeOnSettle(
        job: ResolvedJob,
        recordId: number,
        result: OcrPollResult,
    ): Promise<void> {
        // Timeout: leave the row parked; its visibility window re-surfaces it
        // and the next claim resumes via the stored hint.
        if (result.kind === 'timeout') {
            logger(`OcrExecutor: ${job.sourceKey} OCR backend tracking timed out; queue visibility will resume it`, 3);
            return;
        }
        if (Zotero.__beaverShuttingDown === true) return;
        logger(`OcrExecutor: ${job.sourceKey} OCR backend settled (${result.kind}); waking queue row`, 3);

        const db = Zotero.Beaver?.db;
        if (!db) return;
        try {
            // Make the parked row claimable now; the next claim resumes the
            // backend job (resume hint) and runs the download + re-extract.
            await db.releaseBackgroundJob(recordId, Date.now());
        } catch (error) {
            logger(`OcrExecutor: ${job.sourceKey} wake release failed: ${error}`, 2);
            return;
        }
        Zotero.Beaver?.backgroundExtractor?.notify();
    }

    // ----------------------------------------------------------------------
    // Download, re-extract, and cache.
    // ----------------------------------------------------------------------

    private async download(
        getUrl: string,
        job: ResolvedJob,
        ctx: JobExecutionContext,
    ): Promise<Uint8Array> {
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
        logger(`OcrExecutor: ${job.sourceKey} downloading OCR searchable PDF`, 3);
        const bytes = await getBytesFromSignedUrl(getUrl, { signal: ctx.externalAbortSignal });
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
        logger(`OcrExecutor: ${job.sourceKey} downloaded OCR searchable PDF (${(bytes.length / 1024 / 1024).toFixed(2)}MB)`, 3);
        return bytes;
    }

    private async reextractAndCache(
        job: ResolvedJob,
        ocrBytes: Uint8Array,
        ctx: JobExecutionContext,
        ledgerGuard: AttachmentProcessingStateRecord | null,
    ): Promise<JobOutcome> {
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);
        // Hand the MuPDF extraction to the serialized background lane.
        logger(`OcrExecutor: ${job.sourceKey} re-extracting OCR searchable PDF`, 3);
        const result = await ctx.runOnMuPDFWorker(() =>
            extractPdfBytesAndCacheAsOriginalAttachment({
                item: job.item,
                filePath: job.filePath,
                ocrBytes,
                expectedPageCount: job.pageCount,
                isRemoteOnly: job.source.isRemoteOnly,
                sourceSizeBytes: job.sourceSizeBytes,
                workerName: 'background',
                abortSignal: ctx.externalAbortSignal,
            }),
        );
        this.throwIfLibraryUnavailable(job.item.libraryID, ctx);

        switch (result.kind) {
            case 'ok':
                // Re-extraction succeeded; clear any stale OCR failure backoff.
                await ctx.db
                    .clearDocumentProcessingFailure(job.fileHash, 'ocr', OCR_ENGINE_VERSION)
                    .catch(() => undefined);
                if (typeof (ctx.db as any).markAttachmentOcrDone === 'function') {
                    const cache = Zotero.Beaver?.documentCache;
                    const document = await cache?.getResult(
                        { libraryId: job.item.libraryID, zoteroKey: job.item.key },
                        'structured',
                        job.filePath,
                    );
                    if (!document) {
                        return { kind: 'retry', error: 'ocr_cache_missing_after_reextract' };
                    }
                    const previous = await ctx.db.getAttachmentProcessingState(
                        job.item.libraryID,
                        job.item.key,
                    );
                    const structuredDocumentHash = await computeStructuredDocumentHash(
                        'pdf',
                        document as any,
                    );
                    const applied = await ctx.db.markAttachmentOcrDone({
                        libraryId: job.item.libraryID,
                        zoteroKey: job.item.key,
                        fileHash: job.fileHash,
                        ocrEngineVersion: OCR_ENGINE_VERSION,
                        structuredDocumentHash,
                        expectedOcrStatus: ledgerGuard?.ocrStatus ?? null,
                        expectedOcrEngineVersion: ledgerGuard?.ocrEngineVersion ?? null,
                        expectedExtractStatus: ledgerGuard?.extractStatus ?? null,
                    });
                    if (
                        applied
                        && previous?.structuredDocumentHash !== structuredDocumentHash
                        && Zotero.Beaver?.hasSearchIndexAccess === true
                        && backgroundProcessingEnabled()
                    ) {
                        await ctx.enqueue({
                            jobType: 'fulltext_upsert',
                            libraryId: job.item.libraryID,
                            itemId: job.item.id,
                            zoteroKey: job.item.key,
                            contentKind: 'pdf',
                            payloadKind: 'structured',
                            priority: BACKGROUND_UPSERT_PRIORITY,
                            payload: buildIndexJobPayload('pdf', {
                                docHash: structuredDocumentHash,
                                previousDocumentHash:
                                    previous?.structuredDocumentHash ?? undefined,
                            }),
                            now: Date.now(),
                        });
                    }
                }
                logger(`OcrExecutor: ${job.sourceKey} OCR'd + cached (pages=${result.pageCount})`, 3);
                return { kind: 'complete', reason: 'ocr_ok' };
            case 'no_text':
                // OCR ran but produced no usable text; terminal for this engine.
                logger(`OcrExecutor: ${job.sourceKey} OCR re-extract found no usable text`, 2);
                this.reportTerminalOutcome(job, OCR_TERMINAL_NO_TEXT);
                return this.terminal(job, OCR_TERMINAL_NO_TEXT, 'OCR produced no usable text layer');
            case 'geometry_mismatch':
                // Geometry mismatches would misplace coordinate-based highlights.
                logger(`OcrExecutor: ${job.sourceKey} geometry mismatch: ${result.detail}`, 1);
                this.reportTerminalOutcome(job, OCR_TERMINAL_GEOMETRY, result.detail);
                return this.terminal(job, OCR_TERMINAL_GEOMETRY, `OCR geometry mismatch: ${result.detail}`);
            case 'aborted':
                return { kind: 'release', reason: 'aborted' };
            case 'unavailable':
                logger(`OcrExecutor: ${job.sourceKey} OCR re-extract unavailable (${result.reason})`, 2);
                return { kind: 'complete', reason: `ocr_${result.reason}` };
            case 'error':
                logger(`OcrExecutor: ${job.sourceKey} OCR re-extract failed: ${result.message}`, 2);
                return { kind: 'retry', error: `ocr_reextract: ${result.message}`, reason: 'ocr_reextract_failed' };
        }
    }

    // ----------------------------------------------------------------------
    // Shared helpers
    // ----------------------------------------------------------------------

    /** Map a backend failure to retry (transient) or terminal (permanent). */
    private failureOutcome(job: ResolvedJob, error: OcrError | null | undefined): JobOutcome {
        if (error?.kind === 'permanent') {
            logger(`OcrExecutor: ${job.sourceKey} OCR backend permanent failure: ${error.code}: ${error.message}`, 2);
            return this.terminal(job, OCR_TERMINAL_FAILED, `${error.code}: ${error.message}`);
        }
        const detail = error ? `${error.code}: ${error.message}` : 'unknown';
        logger(`OcrExecutor: ${job.sourceKey} OCR backend transient failure: ${detail}`, 2);
        return { kind: 'retry', error: `ocr_backend_failed: ${detail}`, reason: 'ocr_backend_failed' };
    }

    private terminal(job: ResolvedJob, terminalCode: string, message: string): JobOutcome {
        return {
            kind: 'failPermanent',
            failure: {
                fileHash: job.fileHash,
                task: 'ocr',
                engineVersion: OCR_ENGINE_VERSION,
                sourceType: 'zotero',
                sourceKey: job.sourceKey,
                error: message,
                terminalCode,
            },
            reason: `terminal:${terminalCode}`,
        };
    }

    private async persistFailedOutcome(
        job: ResolvedJob,
        outcome: JobOutcome,
        ctx: JobExecutionContext,
    ): Promise<void> {
        if (outcome.kind !== 'failPermanent') return;
        if (typeof (ctx.db as any).markAttachmentOcrFailed !== 'function') return;
        await ctx.db.markAttachmentOcrFailed(
            job.item.libraryID,
            job.item.key,
            job.fileHash,
            outcome.failure.error,
        );
    }

    /** Fire-and-forget telemetry for a client-detected terminal outcome. */
    private reportTerminalOutcome(job: ResolvedJob, outcomeCode: string, detail?: string): void {
        void ocrApiClient
            .reportOutcome({
                file_hash: job.fileHash,
                outcome_code: outcomeCode,
                engine_version: OCR_ENGINE_VERSION,
                page_count: job.pageCount,
                detail: detail?.slice(0, OCR_OUTCOME_DETAIL_MAX),
            })
            .catch((error) => {
                logger(`OcrExecutor: failed to report ${outcomeCode} for ${job.sourceKey}: ${error}`, 2);
            });
    }

    private throwIfAborted(ctx: JobExecutionContext): void {
        if (ctx.externalAbortSignal.aborted) throw new OcrAbort();
    }

    private throwIfLibraryUnavailable(libraryId: number, ctx: JobExecutionContext): void {
        this.throwIfAborted(ctx);
        if (
            !store.get(libraryScopeInitializedAtom)
            || !store.get(searchableLibraryIdsAtom).includes(libraryId)
        ) {
            throw new OcrAbort();
        }
    }
}
