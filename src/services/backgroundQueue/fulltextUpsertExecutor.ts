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
import { isApiError } from '@beaver/agent-core/types/apiErrors';
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
    'not_entitled',
    'payload_too_large',
]);

/** Authenticated cloud-index lane. Registered from the webpack bundle. */
export class FulltextUpsertExecutor implements JobExecutor {
    readonly jobType: Extract<BackgroundJobType, 'fulltext_upsert' | 'fulltext_untag'>;

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
        const initial = await ctx.db.getAttachmentProcessingState(
            record.libraryId,
            record.zoteroKey,
        );
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
        const scopeRef = getIndexScopeRef(record.libraryId);
        if (!scopeRef) return { kind: 'complete', reason: 'invalid_scope_ref' };
        const { localUserKey } = getZoteroUserIdentifier();
        const accountId = Zotero.Beaver?.account?.getSnapshot().session?.user.id;
        const accountIsCurrent = captureAccountGuard(accountId);
        const accessChanged = () => ctx.externalAbortSignal.aborted || !accountIsCurrent();
        const remoteIdentity = accountId ? { index_account_id: accountId, index_scope_ref: scopeRef, index_local_id: localUserKey } : undefined;
        let requirements;
        try {
            requirements = await this.api.requirements();
        } catch (error) {
            return this.mapApiError(record, row, error, ctx);
        }
        const schemaVersion = row.extractSchemaVersion
            ?? expectedExtractionSchemaVersion(row.contentKind);
        if (!schemaVersion || !requirements.extract_schema_versions[row.contentKind]?.includes(schemaVersion)) {
            return this.terminal(record, row, 'unsupported_schema_version', undefined, ctx);
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
            const payload = await this.readCachedPayload(record, row);
            if (!payload) {
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
                return { kind: 'defer', reason: 'payload_cache_miss' };
            }
            const liveHash = await computeStructuredDocumentHash(row.contentKind, payload);
            if (liveHash !== row.structuredDocumentHash) {
                await ctx.db.resetAttachmentExtraction(
                    record.libraryId,
                    record.zoteroKey,
                    'cached_payload_hash_mismatch',
                );
                return { kind: 'complete', reason: 'stale_payload' };
            }
            try {
                if (accessChanged() || Zotero.Beaver?.hasSearchIndexAccess !== true
                    || !isBackgroundProcessingLibraryEnabled(record.libraryId)) return { kind: 'release', reason: 'access_changed' };
                return await this.api.upsertPayload({ ...baseRequest, payload });
            } catch (payloadError) {
                return this.mapApiError(record, row, payloadError, ctx);
            }
        };

        let response;
        try {
            if (accessChanged() || Zotero.Beaver?.hasSearchIndexAccess !== true
                || !isBackgroundProcessingLibraryEnabled(record.libraryId)) return { kind: 'release', reason: 'access_changed' };
            response = await this.api.upsertHash(baseRequest);
        } catch (error) {
            if (!(isApiError(error))
                || error.status !== 409
                || error.code !== 'payload_required') {
                return this.mapApiError(record, row, error, ctx);
            }
            const result = await upsertWithPayload();
            if ('kind' in result) return result;
            response = result;
        }

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

        if (response.status === 'accepted') {
            return { kind: 'retry', error: 'index_upsert_accepted' };
        }
        if (response.index_version !== requirements.index_version
            || response.extract_schema_version !== schemaVersion) {
            return { kind: 'retry', error: 'index_requirements_changed' };
        }

        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        await ctx.db.clearDocumentProcessingFailure(
            row.structuredDocumentHash,
            'fulltext_upsert',
        ).catch(() => undefined);
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
        const accessChanged = () => ctx.externalAbortSignal.aborted || !accountIsCurrent() || !isLibraryScopeKnown();
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
        }, record.payload?.index_local_id);
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        if (outcome.kind === 'complete') {
            await ctx.db.acknowledgeIndexCleanup(record);
        }
        return outcome;
    }

    private async untagOne(ref: IndexDocumentRef, storedLocalId?: string): Promise<JobOutcome> {
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
                    retryAfterMs: Math.max(1, result.retry_after_seconds ?? 1) * 1_000,
                };
            }
            return { kind: 'complete', reason: 'index_untagged' };
        } catch (error) {
            return this.mapApiError(null, null, error);
        }
    }

    private async readCachedPayload(
        record: BackgroundJobRecord,
        row: AttachmentProcessingStateRecord,
    ): Promise<DocumentExtractResult | null> {
        let item: Zotero.Item | null = null;
        try {
            item = await Zotero.Items.getByLibraryAndKeyAsync(
                record.libraryId,
                record.zoteroKey,
            ) || null;
        } catch { /* handled below */ }
        if (!item || safeIsInTrash(item) === true) return null;
        const source = await resolveAttachmentFileSource({
            item,
            localSizeStrategy: 'stat',
        });
        if (source.kind === 'error') return null;
        const cache = Zotero.Beaver?.documentCache;
        if (!cache) return null;
        if (row.contentKind === 'pdf') {
            return await cache.getResult(
                { libraryId: row.libraryId, zoteroKey: row.zoteroKey },
                'structured',
                source.source.filePath,
            ) as DocumentExtractResult | null;
        }
        if (row.contentKind === 'epub') {
            return await cache.getEpubResult(
                { libraryId: row.libraryId, zoteroKey: row.zoteroKey },
                source.source.filePath,
            );
        }
        return await cache.getSnapshotResult(
            { libraryId: row.libraryId, zoteroKey: row.zoteroKey },
            source.source.filePath,
        );
    }

    private async mapApiError(
        record: BackgroundJobRecord | null,
        row: AttachmentProcessingStateRecord | null,
        error: unknown,
        ctx?: JobExecutionContext,
    ): Promise<JobOutcome> {
        if (!(isApiError(error))) {
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'retry', error: `index_network_error: ${message}` };
        }
        const code = error.code ?? `http_${error.status}`;
        if (error.status === 403 && code === 'not_entitled') {
            Zotero.Beaver.account!.revokeSearchIndexAccess();
        }
        if (TERMINAL_CODES.has(code) || error.status === 400 || error.status === 413) {
            if (record && row) {
                return this.terminal(record, row, code, error.message, ctx);
            }
            return { kind: 'complete', reason: `terminal:${code}` };
        }
        return {
            kind: 'retry',
            error: `${code}: ${error.message}`,
            retryAfterMs: error.retryAfterSeconds != null
                ? Math.max(1, error.retryAfterSeconds) * 1_000
                : undefined,
        };
    }

    private async terminal(
        record: BackgroundJobRecord,
        row: AttachmentProcessingStateRecord,
        code: string,
        message = code,
        ctx?: JobExecutionContext,
    ): Promise<JobOutcome> {
        await (ctx?.db ?? Zotero.Beaver?.db)?.markAttachmentUpsertFailed(
            row.libraryId, row.zoteroKey, row.structuredDocumentHash!, message,
        );
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
