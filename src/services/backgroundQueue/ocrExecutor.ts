/**
 * OCR background lane for scanned PDFs without a text layer.
 *
 * This is a network/IO job: request OCR, upload the source PDF, poll for the
 * searchable PDF, re-extract its bytes, cache the result against the original
 * attachment identity, and discard the OCR PDF. Multiple OCR jobs can run
 * concurrently, but final re-extraction uses the serialized background MuPDF
 * lane via `ctx.runOnMuPDFWorker`.
 *
 * Registered from the webpack `GlobalContextInitializer` (it needs the
 * Supabase-authenticated backend client); the esbuild dispatcher only knows the
 * `JobExecutor` interface.
 */

import type { BackgroundJobRecord, DocumentProcessingFailureInput } from '../database';
import { resolveAttachmentFileSource } from '../documentExtraction/attachmentSource';
import { extractPdfBytesAndCacheAsOriginalAttachment } from '../documentExtraction/ocrReextract';
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
    OcrStatusPoller,
    ocrStatusPoller,
} from '../ocr/ocrStatusPoller';
import {
    OCR_ENGINE_VERSION,
    OCR_OUTCOME_DETAIL_MAX,
    OCR_POLL_BUDGET_MS,
    OCR_TERMINAL_FAILED,
    OCR_TERMINAL_GEOMETRY,
    OCR_TERMINAL_NO_TEXT,
} from '../ocr/constants';
import { logger } from '../../utils/logger';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { ApiError } from '../../../react/types/apiErrors';
import type {
    JobExecutionContext,
    JobExecutor,
    JobOutcome,
} from './jobExecutor';

interface ResolvedJob {
    item: Zotero.Item;
    filePath: string;
    fileHash: string;
    pageCount: number;
    sourceKey: string;
}

export class OcrExecutor implements JobExecutor {
    readonly jobType = 'document_ocr' as const;

    /**
     * Resume hints keyed by source item after poll-budget release.
     * The file hash makes the hint valid only for the same attachment content.
     */
    private readonly resumeHints = new Map<string, { jobId: string; fileHash: string }>();

    /** The poller is injectable so callers can provide scoped instances. */
    constructor(private readonly poller: OcrStatusPoller = ocrStatusPoller) {}

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
        // Anchor the poll budget to the start of the whole run so that resolve
        // + upload time count against it, not just the polling loop.
        const startedAt = Date.now();

        const resolved = await this.resolveJob(record, ctx);
        if ('outcome' in resolved) return resolved.outcome;
        const job = resolved.job;

        // Loop guard: skip scans this OCR engine has already marked terminal.
        if (
            await ctx.db.isDocumentProcessingPermanentlyFailed(
                job.fileHash,
                'ocr',
                OCR_ENGINE_VERSION,
            )
        ) {
            return { kind: 'complete', reason: 'ocr_perm_failed' };
        }

        const ready = await this.resolveReady(job, ctx, startedAt);
        if ('outcome' in ready) return ready.outcome;

        const ocrBytes = await this.download(ready.getUrl, ctx);

        return this.reextractAndCache(job, ocrBytes, ctx);
    }

    /** Resolve a ready GET URL, reusing a valid resume hint when available. */
    private async resolveReady(
        job: ResolvedJob,
        ctx: JobExecutionContext,
        startedAt: number,
    ): Promise<{ getUrl: string } | { outcome: JobOutcome }> {
        const hint = this.resumeHints.get(job.sourceKey);
        if (hint?.fileHash === job.fileHash) {
            const resumed = await this.resumeByJobId(hint.jobId, job, ctx, startedAt);
            if (!('fallback' in resumed)) {
                // A release from poll() refreshes the hint; all other outcomes consume it.
                const releasedAgain =
                    'outcome' in resumed && resumed.outcome.kind === 'release';
                if (!releasedAgain) this.resumeHints.delete(job.sourceKey);
                return resumed;
            }
            // This backend job cannot be resumed, so request again.
            this.resumeHints.delete(job.sourceKey);
        } else if (hint) {
            // Attachment content changed since the hint was recorded.
            this.resumeHints.delete(job.sourceKey);
        }

        const requestResult = await ocrApiClient.requestOcr(job.fileHash, job.pageCount);
        this.throwIfAborted(ctx);
        return this.resolveToReadyGetUrl(requestResult, job, ctx, startedAt);
    }

    /**
     * Poll an existing backend job. Returns fallback when status cannot resume
     * the normal poll path, such as a missing row or pending upload.
     */
    private async resumeByJobId(
        jobId: string,
        job: ResolvedJob,
        ctx: JobExecutionContext,
        startedAt: number,
    ): Promise<{ getUrl: string } | { outcome: JobOutcome } | { fallback: true }> {
        let status: OcrStatusResponse;
        try {
            status = await ocrApiClient.status(jobId);
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                // Missing rows are re-created or rejoined through /ocr/request.
                return { fallback: true };
            }
            throw error;
        }
        this.throwIfAborted(ctx);

        switch (status.status) {
            case 'completed':
                if (status.get_url) return { getUrl: status.get_url };
                return { outcome: { kind: 'retry', error: 'ocr_completed_without_url', reason: 'ocr_completed_without_url' } };
            case 'failed':
                return { outcome: this.failureOutcome(job, status.error) };
            case 'queued':
                return this.poll(jobId, job, ctx, startedAt);
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
        try {
            item = (await Zotero.Items.getByLibraryAndKeyAsync(
                record.libraryId,
                record.zoteroKey,
            )) || null;
        } catch (e) {
            logger(`OcrExecutor: getByLibraryAndKeyAsync failed for ${record.libraryId}-${record.zoteroKey}: ${e}`, 1);
        }
        if (!item || safeIsInTrash(item) === true) {
            return { outcome: { kind: 'complete', reason: !item ? 'item_missing' : 'in_trash' } };
        }

        // OCR requires the local scan bytes (to upload) and a stable on-disk
        // path (to key the cache). Remote-only attachments are out of scope.
        const source = await resolveAttachmentFileSource({
            item,
            maxFileSizeMB: 0,
            localSizeStrategy: 'zotero-total',
        });
        if (source.kind === 'error' || source.source.isRemoteOnly) {
            return { outcome: { kind: 'complete', reason: 'file_unavailable' } };
        }
        const filePath = source.source.filePath;

        let fileHash: string | undefined;
        try {
            fileHash = await item.attachmentHash;
        } catch (e) {
            logger(`OcrExecutor: attachmentHash failed for ${record.libraryId}-${record.zoteroKey}: ${e}`, 1);
        }
        if (!fileHash) {
            return { outcome: { kind: 'complete', reason: 'no_file_hash' } };
        }

        const pageCount = await this.resolvePageCount(item, filePath);
        if (pageCount == null || pageCount < 1) {
            return { outcome: { kind: 'complete', reason: 'no_page_count' } };
        }

        return {
            job: {
                item,
                filePath,
                fileHash,
                pageCount,
                sourceKey: `${record.libraryId}-${record.zoteroKey}`,
            },
        };
    }

    /** Page count from the cached NO_TEXT_LAYER metadata (set at detection). */
    private async resolvePageCount(
        item: Zotero.Item,
        filePath: string,
    ): Promise<number | null> {
        const cache = Zotero.Beaver?.documentCache;
        if (!cache) return null;
        const meta = await cache
            .getMetadata({ libraryId: item.libraryID, zoteroKey: item.key }, filePath)
            .catch(() => null);
        return meta?.pageCount ?? null;
    }

    // ----------------------------------------------------------------------
    // Request OCR and poll until the backend provides a signed download URL.
    // ----------------------------------------------------------------------

    private async resolveToReadyGetUrl(
        request: OcrRequestResponse,
        job: ResolvedJob,
        ctx: JobExecutionContext,
        startedAt: number,
    ): Promise<{ getUrl: string } | { outcome: JobOutcome }> {
        switch (request.status) {
            case 'disabled':
                // Backend says the user lacks OCR entitlement (gate backstop).
                return { outcome: { kind: 'complete', reason: 'ocr_disabled' } };
            case 'rejected':
                // Page-cap rejections depend on the current entitlement limits,
                // so they are not recorded as terminal OCR failures.
                logger(`OcrExecutor: ${job.sourceKey} rejected (${request.reason}; ${request.page_count}/${request.limit})`, 2);
                return { outcome: { kind: 'complete', reason: `ocr_${request.reason ?? 'rejected'}` } };
            case 'failed':
                return { outcome: this.failureOutcome(job, request.error) };
            case 'ready':
                if (request.get_url) return { getUrl: request.get_url };
                return { outcome: { kind: 'retry', error: 'ocr_ready_without_url', reason: 'ocr_ready_without_url' } };
            case 'pending': {
                if (!request.job_id || !request.put_url) {
                    return { outcome: { kind: 'retry', error: 'ocr_pending_without_put_url', reason: 'ocr_pending_without_put_url' } };
                }
                await this.upload(request.put_url, job, ctx);
                await ocrApiClient.markUploaded(request.job_id);
                this.throwIfAborted(ctx);
                return this.poll(request.job_id, job, ctx, startedAt);
            }
            case 'queued':
                if (!request.job_id) {
                    return { outcome: { kind: 'retry', error: 'ocr_queued_without_job_id', reason: 'ocr_queued_without_job_id' } };
                }
                return this.poll(request.job_id, job, ctx, startedAt);
        }
    }

    private async upload(
        putUrl: string,
        job: ResolvedJob,
        ctx: JobExecutionContext,
    ): Promise<void> {
        // Read the scan bytes lazily, only on the pending path where an upload
        // is actually needed — a cache hit (`ready`) or rejoin (`queued`) never
        // loads the file. Worth keeping in mind for large scans: the content
        // hash (computed earlier for `/ocr/request`) reads the file too, so a
        // first-time OCR reads it twice; eagerly loading once to share the bytes
        // would instead waste a full read on every cross-machine cache hit.
        const bytes = await IOUtils.read(job.filePath);
        this.throwIfAborted(ctx);
        await putBytesToSignedUrl(putUrl, bytes, {
            contentType: 'application/pdf',
            signal: ctx.externalAbortSignal,
        });
    }

    private async poll(
        jobId: string,
        job: ResolvedJob,
        ctx: JobExecutionContext,
        startedAt: number,
    ): Promise<{ getUrl: string } | { outcome: JobOutcome }> {
        // Hand polling to the shared batched poller. The budget is measured from
        // the run start (not from here), so a slow upload eats into it and the
        // total stays under the queue lease. An abort rejects with OcrAbort,
        // which bubbles to execute()'s catch → release.
        const deadline = startedAt + OCR_POLL_BUDGET_MS;
        const result = await this.poller.poll(jobId, {
            deadline,
            signal: ctx.externalAbortSignal,
        });

        switch (result.kind) {
            case 'completed':
                if (result.getUrl) return { getUrl: result.getUrl };
                return { outcome: { kind: 'retry', error: 'ocr_completed_without_url', reason: 'ocr_completed_without_url' } };
            case 'failed':
                return { outcome: this.failureOutcome(job, result.error) };
            case 'gone':
                // The row vanished mid-poll; re-claim later and re-request.
                return { outcome: { kind: 'retry', error: 'ocr_status_gone', reason: 'ocr_status_gone' } };
            case 'timeout':
                // Store the backend job id so the next claim resumes polling.
                this.resumeHints.set(job.sourceKey, { jobId, fileHash: job.fileHash });
                logger(`OcrExecutor: ${job.sourceKey} poll budget exhausted; releasing to resume`, 2);
                return { outcome: { kind: 'release', reason: 'ocr_poll_timeout' } };
        }
    }

    // ----------------------------------------------------------------------
    // Download, re-extract, and cache.
    // ----------------------------------------------------------------------

    private async download(getUrl: string, ctx: JobExecutionContext): Promise<Uint8Array> {
        const bytes = await getBytesFromSignedUrl(getUrl, { signal: ctx.externalAbortSignal });
        this.throwIfAborted(ctx);
        return bytes;
    }

    private async reextractAndCache(
        job: ResolvedJob,
        ocrBytes: Uint8Array,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        // Hand the MuPDF extraction to the serialized background lane.
        const result = await ctx.runOnMuPDFWorker(() =>
            extractPdfBytesAndCacheAsOriginalAttachment({
                item: job.item,
                filePath: job.filePath,
                ocrBytes,
                expectedPageCount: job.pageCount,
                workerName: 'background',
                abortSignal: ctx.externalAbortSignal,
            }),
        );

        switch (result.kind) {
            case 'ok':
                // Re-extraction succeeded; clear any stale OCR failure backoff.
                await ctx.db
                    .clearDocumentProcessingFailure(job.fileHash, 'ocr', OCR_ENGINE_VERSION)
                    .catch(() => undefined);
                logger(`OcrExecutor: ${job.sourceKey} OCR'd + cached (pages=${result.pageCount})`, 3);
                return { kind: 'complete', reason: 'ocr_ok' };
            case 'no_text':
                // OCR ran but produced no usable text; terminal for this engine.
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
                return { kind: 'complete', reason: `ocr_${result.reason}` };
            case 'error':
                return { kind: 'retry', error: `ocr_reextract: ${result.message}`, reason: 'ocr_reextract_failed' };
        }
    }

    // ----------------------------------------------------------------------
    // Shared helpers
    // ----------------------------------------------------------------------

    /** Map a backend failure to retry (transient) or terminal (permanent). */
    private failureOutcome(job: ResolvedJob, error: OcrError | null | undefined): JobOutcome {
        if (error?.kind === 'permanent') {
            return this.terminal(job, OCR_TERMINAL_FAILED, `${error.code}: ${error.message}`);
        }
        const detail = error ? `${error.code}: ${error.message}` : 'unknown';
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
}
