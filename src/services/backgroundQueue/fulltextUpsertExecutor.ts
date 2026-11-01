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
import {
    expectedExtractionSchemaVersion,
    isCurrentExtractionSchemaVersion,
} from '../documentExtraction/shared/extractionSchemaVersions';
import {
    type IndexDocumentRef,
    type IndexRequirements,
    type IndexUpsertRequest,
    type IndexUpsertResponse,
    type SearchIndexApiClient,
    searchIndexApiClient,
} from '../searchIndex/searchIndexApiClient';
import {
    BACKGROUND_EXTRACT_PRIORITY,
    BACKGROUND_UPSERT_PRIORITY,
} from '../backgroundProcessing/constants';
import {
    backgroundProcessingEnabled,
    buildBackgroundExtractPayload,
    buildIndexJobPayload,
    buildUntagJobInput,
    isBackgroundProcessingLibraryEnabled,
} from '../backgroundProcessing/utils';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { isLibraryScopeKnown } from '../libraryScope';
import { logger } from '@beaver/agent-core/platform/logger';
import { isApiError, isSessionExpiredError, isSessionRefreshError, isServerError } from '@beaver/agent-core/types/apiErrors';
import { UntagBatcher } from './untagBatcher';
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

/**
 * After this many consecutive uploads that needed their payload, the lane
 * sends payloads without the hash-only probe first. A response showing the
 * content was already indexed turns probing back on.
 */
const PROBE_SKIP_AFTER_PAYLOAD_UPLOADS = 3;

/** Wait before retrying a job whose content another local job is indexing. */
const DOCUMENT_BUSY_RETRY_MS = 2_000;

/**
 * Longest wait on a busy document claim. The holder is almost always a live
 * request that finishes within seconds; the remaining lease the backend may
 * report only bounds recovery from a holder that died.
 */
const CLAIM_BUSY_MAX_RETRY_MS = 15_000;

/**
 * Probe hints are consumed by the hash's next upsert. Hints whose upsert never
 * runs (cancelled by an exclusion or account change) are dropped oldest first.
 */
const PROBE_FIRST_HASH_LIMIT = 1_000;

/** Wait after the server reports a cleanup ref failed on its side. */
const UNTAG_FAILED_RETRY_MS = 5_000;

/** An API error that rejects the request itself; repeating it cannot succeed. */
function isTerminalApiError(error: unknown): boolean {
    if (!isApiError(error)) return false;
    return TERMINAL_CODES.has(error.code ?? `http_${error.status}`)
        || error.status === 400 || error.status === 413;
}

export interface FulltextUpsertExecutorOptions {
    /** Called with each requirements response an upsert reads. */
    onRequirements?: (requirements: IndexRequirements) => void;
}

/** Authenticated cloud-index work owned by the background runtime. */
export class FulltextUpsertExecutor implements JobExecutor {
    // Upsert and cleanup use separate lanes but mutate the same membership.
    private static activeAttachments = new Set<string>();
    /**
     * Document hashes with a request in flight. Attachments with identical
     * content share one remote document and contend for its claim, so a
     * second job for the hash waits locally instead of the server.
     */
    private static activeHashes = new Set<string>();
    /**
     * Hashes whose next upsert probes before uploading: content another job
     * was indexing is usually already stored, which the probe tags cheaply.
     */
    private static probeFirstHashes = new Set<string>();

    private static markProbeFirst(hash: string): void {
        const hashes = FulltextUpsertExecutor.probeFirstHashes;
        hashes.delete(hash);
        hashes.add(hash);
        if (hashes.size > PROBE_FIRST_HASH_LIMIT) {
            hashes.delete(hashes.values().next().value as string);
        }
    }

    readonly jobType: Extract<BackgroundJobType, 'fulltext_upsert' | 'fulltext_untag'>;

    private disposed = false;
    /** Consecutive uploads the hash-only probe could not complete. */
    private payloadUploadStreak = 0;
    /** Shares `POST /index/delete` requests between concurrent cleanup jobs. */
    private untagBatcher?: UntagBatcher;

    dispose(): void {
        this.disposed = true;
        this.untagBatcher?.close();
    }

    constructor(
        private readonly api: SearchIndexApiClient = searchIndexApiClient,
        jobType: Extract<BackgroundJobType, 'fulltext_upsert' | 'fulltext_untag'> = 'fulltext_upsert',
        private readonly options: FulltextUpsertExecutorOptions = {},
    ) {
        this.jobType = jobType;
    }

    /**
     * Record whether an upload needed its payload. `null` leaves the streak
     * unchanged when the response cannot tell.
     */
    private recordPayloadNeed(needed: boolean | null): void {
        if (needed === null) return;
        this.payloadUploadStreak = needed ? this.payloadUploadStreak + 1 : 0;
    }

    /**
     * Whether a payload upload found content the index already had at the
     * current generation, which a hash-only probe would have tagged.
     */
    private static payloadWasNeeded(response: IndexUpsertResponse): boolean | null {
        if (response.status !== 'completed' || response.chunks_total === 0) return null;
        return response.chunks_upserted > 0 || response.embed_tokens > 0;
    }

    async execute(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        const key = `${record.libraryId}-${record.zoteroKey}`;
        if (FulltextUpsertExecutor.activeAttachments.has(key)) {
            return { kind: 'retry', error: 'index_membership_busy', countsAsAttempt: false, retryAfterMs: 1_000 };
        }
        const hash = record.payload?.doc_hash;
        if (hash && FulltextUpsertExecutor.activeHashes.has(hash)) {
            if (record.jobType === 'fulltext_upsert') FulltextUpsertExecutor.markProbeFirst(hash);
            return {
                kind: 'retry', error: 'index_document_busy', countsAsAttempt: false,
                retryAfterMs: DOCUMENT_BUSY_RETRY_MS,
            };
        }
        FulltextUpsertExecutor.activeAttachments.add(key);
        if (hash) FulltextUpsertExecutor.activeHashes.add(hash);
        try {
            return await this.executeExclusive(record, ctx);
        } finally {
            FulltextUpsertExecutor.activeAttachments.delete(key);
            if (hash) FulltextUpsertExecutor.activeHashes.delete(hash);
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
        const startedAt = Date.now();
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
        // A row extracted under an earlier schema is never indexed; the
        // reconciler re-extracts it, which queues a fresh upsert.
        if (!isCurrentExtractionSchemaVersion(row.contentKind, row.extractSchemaVersion)) {
            return { kind: 'complete', reason: 'extract_schema_changed' };
        }
        const scopeRef = getIndexScopeRef(record.libraryId);
        if (!scopeRef) return { kind: 'complete', reason: 'invalid_scope_ref' };
        const { localUserKey } = getZoteroUserIdentifier();
        const remoteIdentity = accountId ? { index_account_id: accountId, index_scope_ref: scopeRef, index_local_id: localUserKey } : undefined;
        const timings = { probeMs: 0, readMs: 0, hashMs: 0, sendMs: 0 };
        let requirements;
        try {
            requirements = await this.api.requirements();
        } catch (error) {
            return this.mapApiError(record, row, error, ctx, accessChanged);
        }
        this.options.onRequirements?.(requirements);
        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
        const schemaVersion = expectedExtractionSchemaVersion(row.contentKind);
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

        /**
         * Upload the cached payload. On a cache miss, `recover` re-extracts the
         * document and `probe` returns null so the caller can try the
         * hash-only request, which needs no local payload.
         */
        const upsertWithPayload = async (
            onCacheMiss: 'recover' | 'probe' = 'recover',
        ): Promise<IndexUpsertResponse | JobOutcome | null> => {
            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
            const eligibility = await checkEligibility();
            if (eligibility) return eligibility;
            let phaseStart = Date.now();
            const cached = await this.readCachedPayload(record, row);
            timings.readMs += Date.now() - phaseStart;
            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
            if (!cached) {
                return onCacheMiss === 'probe' ? null : enqueueCacheRecovery();
            }
            const { payload, filePath } = cached;
            phaseStart = Date.now();
            const liveHash = await computeStructuredDocumentHash(row.contentKind, payload);
            timings.hashMs += Date.now() - phaseStart;
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
                phaseStart = Date.now();
                const response = await this.api.upsertPayload({ ...baseRequest, payload });
                timings.sendMs += Date.now() - phaseStart;
                this.recordPayloadNeed(FulltextUpsertExecutor.payloadWasNeeded(response));
                return response;
            } catch (payloadError) {
                return this.mapApiError(record, row, payloadError, ctx, accessChanged);
            }
        };

        // Recovery mode never returns null; the fallback only narrows the type.
        const uploadPayload = async (): Promise<IndexUpsertResponse | JobOutcome> =>
            await upsertWithPayload('recover') ?? enqueueCacheRecovery();

        let response: IndexUpsertResponse | undefined;
        let probed = false;
        // During a bulk upload of new content nearly every probe answers
        // `payload_required`; skip that round trip until one upload shows the
        // index already had the content.
        const probeFirst = FulltextUpsertExecutor.probeFirstHashes.delete(row.structuredDocumentHash);
        if (!probeFirst && this.payloadUploadStreak >= PROBE_SKIP_AFTER_PAYLOAD_UPLOADS) {
            const result = await upsertWithPayload('probe');
            if (result && 'kind' in result) return result;
            if (result) response = result;
        }
        if (!response) {
            probed = true;
            try {
                if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
                const eligibility = await checkEligibility();
                if (eligibility) return eligibility;
                const probeStart = Date.now();
                try {
                    response = await this.api.upsertHash(baseRequest);
                } finally {
                    timings.probeMs += Date.now() - probeStart;
                }
            } catch (error) {
                if (!(isApiError(error))
                    || error.status !== 409
                    || error.code !== 'payload_required') {
                    return this.mapApiError(record, row, error, ctx, accessChanged);
                }
                const result = await uploadPayload();
                if ('kind' in result) return result;
                response = result;
            }
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
            const result = await uploadPayload();
            if ('kind' in result) return result;
            response = result;
        } else if (response.status === 'tagged') {
            this.recordPayloadNeed(false);
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
            supersedeIndexCleanup: true,
        });
        if (!applied) {
            await ctx.enqueue(buildUntagJobInput({ ...row, upsertRemoteIdentity: remoteIdentity },
                Date.now(), { reason: 'stale_completion' }));
        }
        logger(
            `FulltextUpsertExecutor: ${row.libraryId}-${row.zoteroKey} ${response.status}`
            + ` probe=${probed ? `${timings.probeMs}ms` : 'skipped'} read=${timings.readMs}ms`
            + ` hash=${timings.hashMs}ms send=${timings.sendMs}ms total=${Date.now() - startedAt}ms`,
            3,
        );
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
            const unchanged = current?.structuredDocumentHash === hash && current.extractStatus === 'done'
                ? current : null;
            const owner = unchanged?.upsertRemoteIdentity;
            if (unchanged && owner && isBackgroundProcessingLibraryEnabled(record.libraryId)
                && owner.index_scope_ref === scopeRef
                && owner.index_local_id === record.payload?.index_local_id) {
                if (owner.index_account_id === accountId) {
                    // Ownership is recorded before upload. Its response can still be
                    // pending even after the remote membership has been restored.
                    if (unchanged.upsertStatus === null) {
                        return { kind: 'defer', reason: 'index_acquisition_pending' };
                    }
                    // A failed upload still leaves the ledger tracking this
                    // membership; retiring the ledger later re-queues its cleanup.
                    await ctx.db.acknowledgeIndexCleanup(record);
                    return { kind: 'complete', reason: 'cleanup_superseded' };
                }
                // Only cleanups with a complete identity have a durable intent to
                // hand over, and only an entitled lane can recreate that identity.
                if (record.payload?.index_scope_ref && this.canReacquire(record, scopeRef)) {
                    // Another account took over this unchanged document while this
                    // account was signed out. Removing this account's membership
                    // first would delete remote rows that the returning account
                    // still needs and force a fresh embedding. Reacquire it with a
                    // hash-only upsert instead. Its completion retires this cleanup;
                    // until then the durable intent stays in the outbox and is
                    // re-evaluated on the lane's next cleanup restore.
                    const pending = await ctx.db.hasPendingFulltextUpsert(record.libraryId, record.zoteroKey);
                    if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
                    // The other account's upload may have failed, which is no reason
                    // to drop this account's membership. A failure after this
                    // account's own attempt is: it failed before ownership moved,
                    // and retrying it would only repeat the failure.
                    const attemptFailed = record.payload.index_reacquire_attempted === true
                        && unchanged.upsertStatus === 'failed' && !pending;
                    if (!attemptFailed) {
                        if (!pending) {
                            await ctx.enqueue({
                                jobType: 'fulltext_upsert',
                                libraryId: record.libraryId,
                                itemId: unchanged.itemId ?? record.itemId,
                                zoteroKey: record.zoteroKey,
                                contentKind: unchanged.contentKind,
                                payloadKind: 'structured',
                                priority: BACKGROUND_UPSERT_PRIORITY,
                                payload: buildIndexJobPayload(unchanged.contentKind, { docHash: hash }),
                                now: Date.now(),
                            });
                            if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
                            await ctx.db.markIndexCleanupReacquireAttempted(record);
                        }
                        if (accessChanged()) return { kind: 'release', reason: 'access_changed' };
                        return { kind: 'complete', reason: 'cleanup_reacquiring' };
                    }
                }
            }
        }
        const outcome = await this.untagOne(accountId, {
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

    /**
     * True when this account's upsert lane would recreate exactly the cleanup's
     * remote identity, so a later pass can confirm the cleanup as superseded.
     */
    private canReacquire(record: BackgroundJobRecord, scopeRef: string): boolean {
        return Zotero.Beaver?.hasSearchIndexAccess === true
            && backgroundProcessingEnabled()
            && scopeRef === getIndexScopeRef(record.libraryId)
            && record.payload?.index_local_id === getZoteroUserIdentifier().localUserKey;
    }

    private async untagOne(
        accountId: string,
        ref: IndexDocumentRef,
        storedLocalId: string | undefined,
        accessChanged: () => boolean,
    ): Promise<JobOutcome> {
        const { localUserKey } = getZoteroUserIdentifier();
        this.untagBatcher ??= new UntagBatcher(this.api, isTerminalApiError);
        try {
            const { result, batchFailed } = await this.untagBatcher.untag(
                accountId, storedLocalId ?? localUserKey, ref, accessChanged);
            if (!result || result.outcome === 'failed') {
                // The server reports a ref it could not process (a database or
                // connection failure) as `failed`; nothing is wrong with the ref.
                // Only a batch that failed throughout pauses the whole lane.
                return batchFailed
                    ? this.remoteRetry('index_untag_failed', UNTAG_FAILED_RETRY_MS)
                    : { kind: 'retry', error: 'index_untag_failed', countsAsAttempt: false,
                        retryAfterMs: UNTAG_FAILED_RETRY_MS };
            }
            if (result.outcome === 'busy') {
                const retryAfterMs = Math.max(1, result.retry_after_seconds ?? 1) * 1_000;
                return {
                    kind: 'retry',
                    error: 'index_untag_busy',
                    countsAsAttempt: false,
                    retryAfterMs,
                    // A document claim frees within seconds. A longer wait means the
                    // account takes no cleanup claims right now, which holds for
                    // every queued cleanup, so the whole lane waits with this one.
                    ...(retryAfterMs > CLAIM_BUSY_MAX_RETRY_MS ? { laneCooldownMs: retryAfterMs } : {}),
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
        if (isServerError(error)) {
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
        if (record && code === 'library_excluded') {
            // The account excluded this library on another device. Refreshing the
            // profile applies the exclusion here, which purges the library's
            // processing state; the claim-time gate then retires this job. The
            // retry covers the reverse case, a re-inclusion the server has not
            // seen yet.
            void Zotero.Beaver?.account?.refresh(true);
            return {
                kind: 'retry', error: `${code}: ${error.message}`, reason: code,
                countsAsAttempt: false, retryAfterMs: 60_000,
            };
        }
        if (isTerminalApiError(error)) {
            if (record && row) {
                return this.terminal(record, row, code, error.message, ctx, accessChanged);
            }
            return { kind: 'complete', reason: `terminal:${code}` };
        }
        const retryAfterMs = Number.isFinite(error.retryAfterSeconds)
            ? Math.max(1, error.retryAfterSeconds!) * 1_000 : undefined;
        const message = `${code}: ${error.message}`;
        if (code === 'claim_busy' || code === 'lease_lost' || code === 'index_untag_busy') {
            if (code === 'claim_busy' && row?.structuredDocumentHash) {
                // Another writer holds this content, so it is likely indexed by the retry.
                FulltextUpsertExecutor.markProbeFirst(row.structuredDocumentHash);
            }
            return {
                kind: 'retry', error: message, countsAsAttempt: false,
                retryAfterMs: Math.min(retryAfterMs ?? 5_000, CLAIM_BUSY_MAX_RETRY_MS),
            };
        }
        if (error.status === 429 || [500, 502, 503, 504].includes(error.status)
            || isSessionRefreshError(error)
            || code === 'embedding_unavailable' || code === 'index_write_ambiguous') {
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
