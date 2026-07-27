import { extractAndCacheDocument } from '../documentExtractionCore';
import { liveAttachmentContentKind } from '../documentExtraction/attachmentResolution';
import type { BackgroundJobRecord } from '../database';
import { isLibraryInScope, isLibraryScopeKnown } from '../libraryScope';
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

    /**
     * Outcome to return when the job may no longer touch its library, or null
     * when it may proceed.
     *
     * Unknown scope and exclusion are deliberately distinct: an unknown scope is
     * a transient startup / logout state, so the row is released to run later,
     * while a known exclusion retires it. Collapsing the two would silently drop
     * queued work on an account switch.
     */
    private checkScope(record: BackgroundJobRecord): JobOutcome | null {
        if (!isLibraryScopeKnown()) {
            return { kind: 'release', reason: 'library_scope_unknown' };
        }
        if (record.libraryId === UNRESOLVED_LIBRARY_ID) return null;
        if (isLibraryInScope(record.libraryId)) return null;
        logger(
            `DocumentExtractExecutor: ${record.libraryId}-${record.zoteroKey} skipped (library_excluded)`,
            2,
        );
        return { kind: 'complete', reason: 'library_excluded' };
    }

    private async executeOnWorker(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        let item: Zotero.Item | null = null;
        // Re-check the searchable-library boundary here, not just at claim time:
        // this lane serializes on the MuPDF worker, so a claimed job can wait
        // behind other work before it reads anything.
        const preLookup = this.checkScope(record);
        if (preLookup) return preLookup;

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

        // Re-assert the boundary immediately after the lookup await, before the
        // item is touched at all: the scope mirror is published in the same turn
        // as an exclusion, so it can change across that await. Everything below
        // this point is synchronous up to the extraction, so this is the only
        // re-check the rest of the method needs — keep it adjacent to the await.
        const postLookup = this.checkScope(record);
        if (postLookup) return postLookup;

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
