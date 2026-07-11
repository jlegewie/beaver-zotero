import { extractAndCacheDocument } from '../documentExtractionCore';
import { liveAttachmentContentKind } from '../documentExtraction/attachmentResolution';
import type { BackgroundJobRecord } from '../database';
import { logger } from '../../utils/logger';
import { UNRESOLVED_LIBRARY_ID } from '../../utils/libraryIdentity';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import type {
    JobExecutionContext,
    JobExecutor,
    JobOutcome,
} from './jobExecutor';

/**
 * Executes local document extraction jobs on the serialized MuPDF lane.
 */
export class DocumentExtractExecutor implements JobExecutor {
    readonly jobType = 'document_extract' as const;

    async execute(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        return ctx.runOnMuPDFWorker(() => this.executeOnWorker(record, ctx));
    }

    describeFailure(): null {
        return null;
    }

    private async executeOnWorker(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        let item: Zotero.Item | null = null;
        if (record.libraryId === UNRESOLVED_LIBRARY_ID) {
            logger(
                `DocumentExtractExecutor: library not available on this device for ${record.libraryId}-${record.zoteroKey}`,
                1,
            );
        } else {
            try {
                const lookup = await Zotero.Items.getByLibraryAndKeyAsync(
                    record.libraryId,
                    record.zoteroKey,
                );
                item = lookup || null;
            } catch (e) {
                logger(
                    `DocumentExtractExecutor: getByLibraryAndKeyAsync failed for ${record.libraryId}-${record.zoteroKey}: ${e}`,
                    1,
                );
            }
        }

        if (!item || safeIsInTrash(item) === true) {
            return {
                kind: 'complete',
                reason: !item ? 'item_missing' : 'in_trash',
            };
        }

        const liveKind = liveAttachmentContentKind(item);
        const canResolvePdfFromParent =
            liveKind === null
            && record.contentKind === 'pdf'
            && typeof item.isRegularItem === 'function'
            && item.isRegularItem();
        if (
            (liveKind === null && !canResolvePdfFromParent)
            || (liveKind !== null && liveKind !== record.contentKind)
        ) {
            return { kind: 'complete', reason: 'content_kind_stale' };
        }

        if (record.contentKind !== 'pdf') {
            logger(
                `DocumentExtractExecutor: job id=${record.id} done (unsupported_content_kind:${record.contentKind})`,
                2,
            );
            return { kind: 'complete', reason: 'unsupported_content_kind' };
        }

        const payload = record.payload;
        if (!payload || payload.content_kind !== 'pdf') {
            return { kind: 'complete', reason: 'missing_payload' };
        }

        let result: Awaited<ReturnType<typeof extractAndCacheDocument>>;
        try {
            result = await extractAndCacheDocument({
                libraryId: record.libraryId,
                zoteroKey: record.zoteroKey,
                mode: record.payloadKind,
                maxPages: payload.maxPages,
                maxFileSizeMB: payload.maxFileSizeMB,
                timeoutSeconds: payload.timeoutSeconds,
                workerName: 'background',
                externalAbortSignal: ctx.externalAbortSignal,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'retry', error: `unexpected: ${message}` };
        }

        return this.toOutcome(result);
    }

    private toOutcome(
        result: Awaited<ReturnType<typeof extractAndCacheDocument>>,
    ): JobOutcome {
        switch (result.kind) {
            case 'ok':
                logger(
                    `DocumentExtractExecutor: extraction done (ok) pages=${result.totalPages}`,
                    3,
                );
                return { kind: 'complete', reason: 'ok' };
            case 'external_abort':
                return { kind: 'release', reason: 'external_abort' };
            case 'cached_error':
                return {
                    kind: 'complete',
                    reason: `cached_error:${result.code}`,
                };
            case 'timeout':
                return {
                    kind: 'retry',
                    error: `timeout:${result.phase}`,
                    reason: `timeout:${result.phase}`,
                };
            case 'response_error':
                if (isTransientResponseError(result.code)) {
                    return {
                        kind: 'retry',
                        error: `${result.code}: ${result.message}`,
                        reason: result.code,
                    };
                }
                return {
                    kind: 'complete',
                    reason: `terminal:${result.code}`,
                };
        }
    }
}

function isTransientResponseError(code: string): boolean {
    return code === 'download_failed'
        || code === 'extraction_failed'
        // The local PDF engine failed to start / respawn — machine-local and
        // transient, so a background job should retry rather than complete
        // terminally (the worker host may recover before the next attempt).
        || code === 'worker_unavailable';
}
