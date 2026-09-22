import { captureAccountGuard } from '../accountGuard';
import type {
    AttachmentProcessingStateRecord,
    BackgroundJobRecord,
    BackgroundJobType,
    DocumentProcessingFailureInput,
} from '../database';
import { resolveAttachmentFileSource } from '../documentExtraction/attachmentSource';
import { computeStructuredDocumentHash } from '../documentExtraction/structuredDocumentHash';
import type { DocumentExtractResult } from '@beaver/agent-core/extract/document/shared/documentExtractResult';
import { expectedExtractionSchemaVersion } from '../documentExtraction/shared/extractionSchemaVersions';
import {
    type IndexDocumentRef,
    type IndexUpsertRequest,
    type SearchIndexApiClient,
    searchIndexApiClient,
} from '../searchIndex/searchIndexApiClient';
import {
    BACKGROUND_EXTRACT_PRIORITY,
} from '../backgroundProcessing/constants';
import {
    buildBackgroundExtractPayload,
    buildUntagJobInput,
    isBackgroundProcessingLibraryEnabled,
} from '../backgroundProcessing/utils';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { isLibraryScopeKnown } from '../libraryScope';
import { logger } from '@beaver/agent-core/platform/logger';
import { isApiError, isSessionExpiredError, isSessionRefreshError, isServerError } from '@beaver/agent-core/types/apiErrors';
import type {
    JobExecutionContext,
    JobExecutor,
    JobOutcome,
} from './jobExecutor';

type ProcessableKind = AttachmentProcessingStateRecord['contentKind'];

const TERMINAL_CODES = new Set([
    'invalid_payload',
    'kind_mismatch',
    'schema_version_mismatch',
    'unsupported_schema_version',
    'invalid_scope_ref',
    'invalid_gzip',
    'payload_too_large',
]);

/** Authenticated cloud-index work owned by the background runtime. */
export class FulltextUpsertExecutor implements JobExecutor {
    // Upsert and cleanup use separate lanes but mutate the same membership.
    private static activeAttachments = new Set<string>();
    readonly jobType: Extract<BackgroundJobType, 'fulltext_upsert' | 'fulltext_untag'>;

    private disposed = false;

    dispose(): void { this.disposed = true; }

    constructor(
        private readonly api: SearchIndexApiClient = searchIndexApiClient,
        jobType: Extract<BackgroundJobType, 'fulltext_upsert' | 'fulltext_untag'> = 'fulltext_upsert',
    ) {
        this.jobType = jobType;
    }

    async execute(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        const key = `${record.libraryId}-${record.zoteroKey}`;
        if (FulltextUpsertExecutor.activeAttachments.has(key)) {
            return { kind: 'retry', error: 'index_membership_busy', countsAsAttempt: false, retryAfterMs: 1_000 };
        }
        FulltextUpsertExecutor.activeAttachments.add(key);
        try {
            return await this.executeExclusive(record, ctx);
        } finally {
            FulltextUpsertExecutor.activeAttachments.delete(key);
        }
    }

    private async executeExclusive(record: BackgroundJobRecord, ctx: JobExecutionContext): Promise<JobOutcome> {
        if (record.jobType === 'fulltext_untag') {
            return this.executeUntag(record, ctx);
        }
        if (Zotero.Beaver?.hasSearchIndexAccess !== true) {
            return { kind: 'release', reason: 'not_entitled' };
        }
        if (!isBackgroundProcessingLibraryEnabled(record.libraryId)) {
            return { kind: 'complete', reason: 'library_excluded' };
        }
        return this.executeUpsert(record, ctx);
    }

    describeFailure(
        record: BackgroundJobRecord,
        error: string,
    ): DocumentProcessingFailureInput | null {
        const hash = record.payload?.doc_hash;
        if (!hash) return null;
        return {
            fileHash: hash,
            task: 'fulltext_upsert',
            sourceType: 'zotero',
            sourceKey: `${record.libraryId}-${record.zoteroKey}`,
            error,
        };
    }

    private async executeUpsert(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        const accountId = Zotero.Beaver?.account?.getSnapshot().session?.user.id;
        const accountIsCurrent = captureAccountGuard(accountId);
        const accessChanged = () => this.disposed || ctx.externalAbortSignal.aborted
            || ctx.shouldSkipDbWrites() || !accountIsCurrent() || !isLibraryScopeKnown()
            || Zotero.Beaver?.hasSearchIndexAccess !== true
            || !isBackgroundProcessingLibraryEnabled(record.libraryId);
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        const initial = await ctx.db.getAttachmentProcessingState(
            record.libraryId,
            record.zoteroKey,
        );
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        if (!initial?.structuredDocumentHash || initial.extractStatus !== 'done') {
            if (initial?.extractStatus === 'done' && initial.ocrStatus === 'needed') {
                // Cache recovery can temporarily remove the hash while OCR runs.
                // Keep this request (and its priority) until the claim becomes visible
                // again; OCR need not create a replacement upsert while paused.
                return { kind: 'defer', reason: 'waiting_for_ocr' };
            }
            return { kind: 'complete', reason: 'ledger_not_ready' };
        }
        let row = { ...initial, structuredDocumentHash: initial.structuredDocumentHash };
        const checkEligibility = async (): Promise<JobOutcome | null> => {
            let item: Zotero.Item | false;
            try {
                item = await Zotero.Items.getByLibraryAndKeyAsync(record.libraryId, record.zoteroKey);
                if (item && item.parentID) await Zotero.Items.getAsync(item.parentID);
            } catch {
                return { kind: 'retry', error: 'trash_state_unavailable' };
            }
            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
            const trash = item ? safeIsInTrash(item) : true;
            if (trash === null) return { kind: 'retry', error: 'trash_state_unavailable' };
            if (!trash) return null;
            if (row.upsertRemoteIdentity) {
                await ctx.enqueue(buildUntagJobInput(row, Date.now()));
            }
            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
            await ctx.db.deleteAttachmentProcessingState(record.libraryId, record.zoteroKey);
            await Zotero.Beaver?.documentCache?.invalidate(record.libraryId, record.zoteroKey);
            if (record.itemId) {
                Zotero.Beaver?.processingReconciler?.notifyAttachments([{ id: record.itemId, event: 'modify' }]);
            }
            return { kind: 'complete', reason: item ? 'in_trash' : 'item_missing' };
        };
        const initialEligibility = await checkEligibility();
        if (initialEligibility) return initialEligibility;
        const scopeRef = getIndexScopeRef(record.libraryId);
        if (!scopeRef) return { kind: 'complete', reason: 'invalid_scope_ref' };
        const { localUserKey } = getZoteroUserIdentifier();
        const remoteIdentity = accountId ? { index_account_id: accountId, index_scope_ref: scopeRef, index_local_id: localUserKey } : undefined;
        let requirements;
        try {
            requirements = await this.api.requirements();
        } catch (error) {
            return this.mapApiError(record, row, error, ctx, accessChanged);
        }
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        const schemaVersion = row.extractSchemaVersion
            ?? expectedExtractionSchemaVersion(row.contentKind);
        if (!schemaVersion || !requirements.extract_schema_versions[row.contentKind]?.includes(schemaVersion)) {
            return this.terminal(record, row, 'unsupported_schema_version', undefined, ctx, accessChanged);
        }
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        if (remoteIdentity) {
            const acquired = await ctx.db.recordAttachmentIndexIdentity(row.libraryId, row.zoteroKey,
                row.structuredDocumentHash, remoteIdentity);
            if (!acquired) return { kind: 'defer', reason: 'index_identity_changed' };
            row = acquired;
        }
        const baseRequest: IndexUpsertRequest = {
            source: 'zotero_attachment',
            scope_ref: scopeRef,
            zotero_key: row.zoteroKey,
            zotero_local_id: localUserKey,
            content_kind: row.contentKind,
            doc_hash: row.structuredDocumentHash,
            extract_schema_version: schemaVersion,
            ...(row.fileHash ? { file_hash: row.fileHash } : {}),
        };

        const upsertWithPayload = async (): Promise<
            Awaited<ReturnType<SearchIndexApiClient['upsertPayload']>> | JobOutcome
        > => {
            const enqueueCacheRecovery = async (): Promise<JobOutcome> => {
                const armed = accountId
                    ? await ctx.db.beginFulltextCacheRecovery(
                        record, accountId, row.structuredDocumentHash, row.extractionSource)
                    : false;
                try {
                    await ctx.enqueue({
                        jobType: 'document_extract',
                        libraryId: record.libraryId,
                        itemId: record.itemId,
                        zoteroKey: record.zoteroKey,
                        contentKind: row.contentKind,
                        payloadKind: 'structured',
                        // Cache recovery must remain runnable for an on-demand retry while paused.
                        priority: Math.min(record.priority, BACKGROUND_EXTRACT_PRIORITY),
                        payload: buildBackgroundExtractPayload(row.contentKind),
                        now: Date.now(),
                    });
                } catch (error) {
                    if (armed) await ctx.db.cancelFulltextCacheRecovery(record.id, record.availableAt);
                    throw error;
                }
                return { kind: 'defer', reason: 'payload_cache_miss' };
            };
            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
            const eligibility = await checkEligibility();
            if (eligibility) return eligibility;
            const cached = await this.readCachedPayload(record, row);
            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
            if (!cached) {
                return enqueueCacheRecovery();
            }
            const { payload, filePath } = cached;
            const liveHash = await computeStructuredDocumentHash(row.contentKind, payload);
            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
            if (liveHash !== row.structuredDocumentHash) {
                const discarded = await Zotero.Beaver?.documentCache?.discardRejectedStructuredPayload(
                    { libraryId: row.libraryId, zoteroKey: row.zoteroKey },
                    row.contentKind,
                    filePath,
                    liveHash,
                );
                if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
                if (discarded === 'protected') {
                    return this.terminal(record, row, 'cached_payload_hash_mismatch',
                        'Protected OCR payload differs from recorded document hash', ctx, accessChanged);
                }
                if (discarded !== 'discarded') {
                    return { kind: 'retry', error: 'cached_payload_changed', countsAsAttempt: false,
                        retryAfterMs: 1_000 };
                }
                return enqueueCacheRecovery();
            }
            try {
                if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
                const eligibility = await checkEligibility();
                if (eligibility) return eligibility;
                return await this.api.upsertPayload({ ...baseRequest, payload });
            } catch (payloadError) {
                return this.mapApiError(record, row, payloadError, ctx, accessChanged);
            }
        };

        let response;
        try {
            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
            const eligibility = await checkEligibility();
            if (eligibility) return eligibility;
            response = await this.api.upsertHash(baseRequest);
        } catch (error) {
            if (!(isApiError(error))
                || error.status !== 409
                || error.code !== 'payload_required') {
                return this.mapApiError(record, row, error, ctx, accessChanged);
            }
            const result = await upsertWithPayload();
            if ('kind' in result) return result;
            response = result;
        }

        const completedEligibility = await checkEligibility();
        if (completedEligibility) return completedEligibility;

        // A tag append reports the generation already stored remotely.
        // Older rows require an explicit payload request; repeating the
        // hash-only request would only return the same old generation.
        if (
            response.status === 'tagged'
            && (
                response.index_version !== requirements.index_version
                || response.extract_schema_version !== schemaVersion
            )
        ) {
            const result = await upsertWithPayload();
            if ('kind' in result) return result;
            response = result;
        }

        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        if (response.status === 'accepted') {
            return { kind: 'retry', error: 'index_upsert_accepted', countsAsAttempt: false, retryAfterMs: 5_000 };
        }
        if (response.index_version !== requirements.index_version
            || response.extract_schema_version !== schemaVersion) {
            return { kind: 'retry', error: 'index_requirements_changed', countsAsAttempt: false, retryAfterMs: 5_000 };
        }

        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        await ctx.db.clearDocumentProcessingFailure(
            row.structuredDocumentHash,
            'fulltext_upsert',
        ).catch(() => undefined);
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        const finalEligibility = await checkEligibility();
        if (finalEligibility) return finalEligibility;
        const applied = await ctx.db.markAttachmentUpsertDone({
            libraryId: row.libraryId,
            zoteroKey: row.zoteroKey,
            structuredDocumentHash: row.structuredDocumentHash,
            upsertIndexVersion: String(response.index_version),
            remoteIdentity,
            expectedUpsertStatus: row.upsertStatus,
            expectedUpsertIndexVersion: row.upsertIndexVersion,
            expectedExtractStatus: row.extractStatus,
        });
        if (!applied) {
            await ctx.enqueue(buildUntagJobInput({ ...row, upsertRemoteIdentity: remoteIdentity },
                Date.now(), { reason: 'stale_completion' }));
        }
        return {
            kind: 'complete',
            reason: applied ? `index_${response.status}` : 'stale_completion_ignored',
        };
    }

    private async executeUntag(record: BackgroundJobRecord, ctx: JobExecutionContext): Promise<JobOutcome> {
        const accountId = record.payload?.index_account_id;
        // Older releases could queue cleanup without ever having index access.
        // There is no trustworthy remote owner to remove on their behalf.
        if (!accountId) return { kind: 'complete', reason: 'legacy_unowned' };
        if (accountId !== Zotero.Beaver?.account?.getSnapshot().session?.user.id) {
            // Keep the durable intent; its owner's next lane startup restores it.
            return { kind: 'complete', reason: 'cleanup_account_unavailable' };
        }
        const accountIsCurrent = captureAccountGuard(accountId);
        const accessChanged = () => this.disposed || ctx.shouldSkipDbWrites() || ctx.externalAbortSignal.aborted || !accountIsCurrent() || !isLibraryScopeKnown();
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        const scopeRef = record.payload?.index_scope_ref ?? getIndexScopeRef(record.libraryId);
        const hash = record.payload?.doc_hash;
        if (!scopeRef || !hash) return { kind: 'complete', reason: 'invalid_untag' };
        // Excluded libraries need no supersession read.
        if (isBackgroundProcessingLibraryEnabled(record.libraryId)) {
            const current = await ctx.db.getAttachmentProcessingState(record.libraryId, record.zoteroKey);
            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
            if (isBackgroundProcessingLibraryEnabled(record.libraryId) && current?.structuredDocumentHash === hash
                && current.extractStatus === 'done'
                && current.upsertRemoteIdentity?.index_account_id === accountId
                && current.upsertRemoteIdentity?.index_scope_ref === scopeRef
                && current.upsertRemoteIdentity?.index_local_id === record.payload?.index_local_id) {
                // Ownership is recorded before upload. Its response can still be
                // pending even after the remote membership has been restored.
                if (current.upsertStatus !== 'done') {
                    return { kind: 'defer', reason: 'index_acquisition_pending' };
                }
                await ctx.db.acknowledgeIndexCleanup(record);
                return { kind: 'complete', reason: 'cleanup_superseded' };
            }
        }
        const outcome = await this.untagOne({
            scope_ref: scopeRef,
            zotero_key: record.zoteroKey,
            doc_hash: hash,
        }, record.payload?.index_local_id, accessChanged);
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        if (outcome.kind === 'complete') {
            await ctx.db.acknowledgeIndexCleanup(record);
        }
        return outcome;
    }

    private async untagOne(ref: IndexDocumentRef, storedLocalId: string | undefined, accessChanged: () => boolean): Promise<JobOutcome> {
        const { localUserKey } = getZoteroUserIdentifier();
        try {
            const response = await this.api.untag(storedLocalId ?? localUserKey, [ref]);
            const result = response.results[0];
            if (!result || result.outcome === 'failed') {
                return { kind: 'retry', error: 'index_untag_failed' };
            }
            if (result.outcome === 'busy') {
                return {
                    kind: 'retry',
                    error: 'index_untag_busy',
                    countsAsAttempt: false,
                    retryAfterMs: Math.max(1, result.retry_after_seconds ?? 1) * 1_000,
                };
            }
            return { kind: 'complete', reason: 'index_untagged' };
        } catch (error) {
            return this.mapApiError(null, null, error, undefined, accessChanged);
        }
    }

    private async readCachedPayload(
        record: BackgroundJobRecord,
        row: AttachmentProcessingStateRecord,
    ): Promise<{ payload: DocumentExtractResult; filePath: string } | null> {
        let item: Zotero.Item | null = null;
        try {
            item = await Zotero.Items.getByLibraryAndKeyAsync(
                record.libraryId,
                record.zoteroKey,
            ) || null;
        } catch { /* handled below */ }
        if (item?.parentID) await Zotero.Items.getAsync(item.parentID);
        if (!item || safeIsInTrash(item) !== false) return null;
        const source = await resolveAttachmentFileSource({
            item,
            localSizeStrategy: 'stat',
        });
        if (source.kind === 'error') return null;
        const cache = Zotero.Beaver?.documentCache;
        if (!cache) return null;
        if (row.contentKind === 'pdf') {
            const payload = await cache.getResult(
                { libraryId: row.libraryId, zoteroKey: row.zoteroKey },
                'structured',
                source.source.filePath,
            ) as DocumentExtractResult | null;
            return payload ? { payload, filePath: source.source.filePath } : null;
        }
        if (row.contentKind === 'epub') {
            const payload = await cache.getEpubResult(
                { libraryId: row.libraryId, zoteroKey: row.zoteroKey },
                source.source.filePath,
            );
            return payload ? { payload, filePath: source.source.filePath } : null;
        }
        const payload = await cache.getSnapshotResult(
            { libraryId: row.libraryId, zoteroKey: row.zoteroKey },
            source.source.filePath,
        );
        return payload ? { payload, filePath: source.source.filePath } : null;
    }

    private async mapApiError(
        record: BackgroundJobRecord | null,
        row: AttachmentProcessingStateRecord | null,
        error: unknown,
        ctx?: JobExecutionContext,
        accessChanged: () => boolean = () => false,
    ): Promise<JobOutcome> {
        const lifecycleError = error as { code?: string; name?: string } | null;
        if (accessChanged()
            || lifecycleError?.code === 'ACCOUNT_CHANGED' || lifecycleError?.name === 'AbortError') {
            return { kind: 'release', reason: 'access_changed' };
        }
        // Session recovery is asynchronous; keep this claim parked while the
        // account owner refreshes instead of immediately reclaiming it.
        if (isSessionExpiredError(error)) return { kind: 'defer', reason: 'session_expired' };
        if (record && isServerError(error)) {
            return this.remoteRetry(error.message);
        }
        if (!(isApiError(error))) {
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'retry', error: `index_unexpected_error: ${message}` };
        }
        const code = error.code ?? `http_${error.status}`;
        if (error.status === 403 && code === 'not_entitled') {
            // Cleanup runs without search access, so revocation cannot gate it.
            if (!record) return {
                kind: 'retry', error: `${code}: ${error.message}`, reason: code,
                countsAsAttempt: false, retryAfterMs: 30_000,
            };
            Zotero.Beaver.account?.revokeSearchIndexAccess();
            return { kind: 'release', reason: 'not_entitled' };
        }
        if (TERMINAL_CODES.has(code) || error.status === 400 || error.status === 413) {
            if (record && row) {
                return this.terminal(record, row, code, error.message, ctx, accessChanged);
            }
            return { kind: 'complete', reason: `terminal:${code}` };
        }
        const retryAfterMs = Number.isFinite(error.retryAfterSeconds)
            ? Math.max(1, error.retryAfterSeconds!) * 1_000 : undefined;
        const message = `${code}: ${error.message}`;
        if (code === 'claim_busy' || code === 'lease_lost' || code === 'index_untag_busy') {
            return { kind: 'retry', error: message, countsAsAttempt: false, retryAfterMs: retryAfterMs ?? 5_000 };
        }
        if (record && (error.status === 429 || [500, 502, 503, 504].includes(error.status)
            || isSessionRefreshError(error)
            || code === 'embedding_unavailable' || code === 'index_write_ambiguous')) {
            return this.remoteRetry(message, retryAfterMs ?? (error.status === 429 ? 5_000 : undefined));
        }
        return { kind: 'retry', error: message, retryAfterMs };
    }

    private remoteRetry(error: string, delayMs = 30_000 + Math.floor(Math.random() * 3_000)): JobOutcome {
        return { kind: 'retry', error, countsAsAttempt: false, retryAfterMs: delayMs, laneCooldownMs: delayMs };
    }

    private async terminal(
        record: BackgroundJobRecord,
        row: AttachmentProcessingStateRecord,
        code: string,
        message = code,
        ctx?: JobExecutionContext,
        accessChanged: () => boolean = () => false,
    ): Promise<JobOutcome> {
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        await (ctx?.db ?? Zotero.Beaver?.db)?.markAttachmentUpsertFailed(
            row.libraryId, row.zoteroKey, row.structuredDocumentHash!, message,
        );
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        logger(`FulltextUpsertExecutor: terminal ${code} for ${row.libraryId}-${row.zoteroKey}`, 2);
        return {
            kind: 'failPermanent',
            failure: {
                fileHash: row.structuredDocumentHash!,
                task: 'fulltext_upsert',
                sourceType: 'zotero',
                sourceKey: `${record.libraryId}-${record.zoteroKey}`,
                error: message,
                terminalCode: code,
            },
            reason: `terminal:${code}`,
        };
    }
}
