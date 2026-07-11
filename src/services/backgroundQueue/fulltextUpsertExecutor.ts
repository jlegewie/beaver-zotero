import type {
    AttachmentProcessingStateRecord,
    BackgroundJobRecord,
    BackgroundJobType,
    DocumentProcessingFailureInput,
} from '../database';
import { resolveAttachmentFileSource } from '../documentExtraction/attachmentSource';
import { computeStructuredDocumentHash } from '../documentExtraction/structuredDocumentHash';
import type { DocumentExtractResult } from '../documentExtraction/shared/documentExtractResult';
import { expectedExtractionSchemaVersion } from '../documentExtraction/shared/extractionSchemaVersions';
import {
    type IndexDocumentRef,
    type IndexUpsertRequest,
    type SearchIndexApiClient,
    searchIndexApiClient,
} from '../searchIndex/searchIndexApiClient';
import {
    BACKGROUND_EXTRACT_PRIORITY,
    BACKGROUND_UNTAG_PRIORITY,
    EXPECTED_SEARCH_INDEX_VERSION,
} from '../backgroundProcessing/constants';
import {
    buildBackgroundExtractPayload,
    isBackgroundProcessingLibraryEnabled,
} from '../backgroundProcessing/utils';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { logger } from '../../utils/logger';
import { ApiError } from '../../../react/types/apiErrors';
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
        if (Zotero.Beaver?.hasSearchIndexAccess !== true) {
            return { kind: 'complete', reason: 'not_entitled' };
        }
        if (record.jobType === 'fulltext_untag') {
            return this.executeUntag(record);
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
        const row = await ctx.db.getAttachmentProcessingState(
            record.libraryId,
            record.zoteroKey,
        );
        if (!row?.structuredDocumentHash || row.extractStatus !== 'done') {
            return { kind: 'complete', reason: 'ledger_not_ready' };
        }
        const scopeRef = getIndexScopeRef(record.libraryId);
        if (!scopeRef) return { kind: 'complete', reason: 'invalid_scope_ref' };
        const { localUserKey } = getZoteroUserIdentifier();
        const schemaVersion = row.extractSchemaVersion
            ?? expectedExtractionSchemaVersion(row.contentKind);
        if (!schemaVersion) {
            return this.terminal(record, row, 'unsupported_schema_version', undefined, ctx);
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
                    priority: BACKGROUND_EXTRACT_PRIORITY,
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
                return await this.api.upsertPayload({ ...baseRequest, payload });
            } catch (payloadError) {
                return this.mapApiError(record, row, payloadError, ctx);
            }
        };

        let response;
        const storedVersion = row.upsertIndexVersion == null
            ? null
            : Number(row.upsertIndexVersion);
        if (storedVersion != null && storedVersion < EXPECTED_SEARCH_INDEX_VERSION) {
            const result = await upsertWithPayload();
            if ('kind' in result) return result;
            response = result;
        } else {
            try {
                response = await this.api.upsertHash(baseRequest);
            } catch (error) {
                if (!(error instanceof ApiError)
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
                    response.index_version < EXPECTED_SEARCH_INDEX_VERSION
                    || response.extract_schema_version !== schemaVersion
                )
            ) {
                const result = await upsertWithPayload();
                if ('kind' in result) return result;
                response = result;
            }
        }

        if (response.status === 'accepted') {
            return { kind: 'retry', error: 'index_upsert_accepted' };
        }

        await ctx.db.clearDocumentProcessingFailure(
            row.structuredDocumentHash,
            'fulltext_upsert',
        ).catch(() => undefined);
        const applied = await ctx.db.markAttachmentUpsertDone({
            libraryId: row.libraryId,
            zoteroKey: row.zoteroKey,
            structuredDocumentHash: row.structuredDocumentHash,
            upsertIndexVersion: String(response.index_version),
            expectedUpsertStatus: row.upsertStatus,
            expectedUpsertIndexVersion: row.upsertIndexVersion,
            expectedExtractStatus: row.extractStatus,
        });
        const priorHash = record.payload?.previous_doc_hash;
        if (priorHash && priorHash !== row.structuredDocumentHash) {
            await ctx.enqueue({
                jobType: 'fulltext_untag',
                libraryId: row.libraryId,
                itemId: row.itemId,
                zoteroKey: row.zoteroKey,
                contentKind: row.contentKind,
                payloadKind: 'structured',
                priority: BACKGROUND_UNTAG_PRIORITY,
                payload: {
                    ...record.payload!,
                    index_action: 'untag',
                    doc_hash: priorHash,
                    previous_doc_hash: undefined,
                },
                now: Date.now(),
            });
        }
        return {
            kind: 'complete',
            reason: applied ? `index_${response.status}` : 'stale_completion_ignored',
        };
    }

    private async executeUntag(record: BackgroundJobRecord): Promise<JobOutcome> {
        const scopeRef = getIndexScopeRef(record.libraryId);
        const hash = record.payload?.doc_hash;
        if (!scopeRef || !hash) return { kind: 'complete', reason: 'invalid_untag' };
        return this.untagOne({
            scope_ref: scopeRef,
            zotero_key: record.zoteroKey,
            doc_hash: hash,
        });
    }

    private async untagOne(ref: IndexDocumentRef): Promise<JobOutcome> {
        const { localUserKey } = getZoteroUserIdentifier();
        try {
            const response = await this.api.untag(localUserKey, [ref]);
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
            maxFileSizeMB: 0,
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
        if (!(error instanceof ApiError)) {
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'retry', error: `index_network_error: ${message}` };
        }
        const code = error.code ?? `http_${error.status}`;
        if (error.status === 403 && code === 'not_entitled') {
            if (Zotero.Beaver) {
                (Zotero.Beaver as { hasSearchIndexAccess?: boolean })
                    .hasSearchIndexAccess = false;
            }
            Zotero.Beaver?.processingReconciler?.notify();
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
