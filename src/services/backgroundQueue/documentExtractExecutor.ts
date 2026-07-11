import {
    extractAndCacheDocument,
    extractAndCacheEpubDocument,
    extractAndCacheSnapshotDocument,
} from '../documentExtractionCore';
import { liveAttachmentContentKind } from '../documentExtraction/attachmentResolution';
import {
    loadAttachmentData,
    resolveAttachmentFileSource,
    type AttachmentFileSource,
} from '../documentExtraction/attachmentSource';
import { computeStructuredDocumentHash } from '../documentExtraction/structuredDocumentHash';
import { expectedExtractionSchemaVersion } from '../documentExtraction/shared/extractionSchemaVersions';
import type { DocumentExtractResult } from '../documentExtraction/shared/documentExtractResult';
import type {
    AttachmentProcessingStateRecord,
    BackgroundJobRecord,
} from '../database';
import { getFileSignature } from '../documentFileIdentity';
import { logger } from '../../utils/logger';
import { UNRESOLVED_LIBRARY_ID } from '../../utils/libraryIdentity';
import { safeIsInTrash } from '../../utils/zoteroItemUtils';
import { OCR_PRIORITY_BACKFILL } from '../ocr/constants';
import {
    BACKGROUND_UPSERT_PRIORITY,
} from '../backgroundProcessing/constants';
import {
    backgroundProcessingEnabled,
    buildIndexJobPayload,
    isBackgroundProcessingLibraryEnabled,
} from '../backgroundProcessing/utils';
import type {
    JobExecutionContext,
    JobExecutor,
    JobOutcome,
} from './jobExecutor';

type ProcessableKind = AttachmentProcessingStateRecord['contentKind'];

interface ExtractSuccess {
    document: DocumentExtractResult | null;
    ocrStatus: 'na' | 'needed';
    reason: string;
}

/** Executes local document extraction jobs and advances the durable ledger. */
export class DocumentExtractExecutor implements JobExecutor {
    readonly jobType = 'document_extract' as const;

    async execute(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        if (
            record.libraryId !== UNRESOLVED_LIBRARY_ID
            && Zotero.Beaver?.libraryScopeInitialized === true
            && !(Zotero.Beaver.searchableLibraryIds ?? []).includes(record.libraryId)
        ) {
            return { kind: 'complete', reason: 'library_excluded' };
        }
        // The durable ledger describes the structured extraction pipeline.
        // Markdown requests are hot-path cache work and must never stamp a
        // structured schema version/hash into that ledger.
        if (record.payloadKind !== 'structured') {
            return ctx.runOnMuPDFWorker(() => this.executeLegacy(record, ctx));
        }
        // Older/test queue DB adapters predate the ledger surface. Preserve the
        // established hot-path behavior while production BeaverDB takes the
        // durable path below.
        if (typeof (ctx.db as any).ensureAttachmentProcessingState !== 'function') {
            return ctx.runOnMuPDFWorker(() => this.executeLegacy(record, ctx));
        }
        // Lightweight adapters used by existing integrations expose primary
        // item fields but not Zotero's lazy-data methods. Keep those callers on
        // the established non-ledger path.
        const compatibilityItem = record.libraryId === UNRESOLVED_LIBRARY_ID
            ? null
            : await Zotero.Items.getByLibraryAndKeyAsync(
                record.libraryId,
                record.zoteroKey,
            ).catch(() => null);
        if (
            compatibilityItem
            && (
                typeof compatibilityItem.loadAllData !== 'function'
                || compatibilityItem.isRegularItem?.() === true
            )
        ) {
            return ctx.runOnMuPDFWorker(() => this.executeLegacy(record, ctx));
        }
        const resolved = await this.resolveItem(record);
        if ('outcome' in resolved) return resolved.outcome;
        const { item, kind } = resolved;

        if (
            Zotero.Beaver?.libraryScopeInitialized === true
            && !(Zotero.Beaver.searchableLibraryIds ?? []).includes(item.libraryID)
        ) {
            return { kind: 'complete', reason: 'library_excluded' };
        }
        // Background producers must re-check exclusions after claim. Priority
        // <100 remains the on-demand path and was already validated upstream.
        if (record.priority >= 100 && !isBackgroundProcessingLibraryEnabled(item.libraryID)) {
            return { kind: 'complete', reason: 'library_excluded' };
        }

        const previous = await ctx.db.ensureAttachmentProcessingState({
            libraryId: item.libraryID,
            zoteroKey: item.key,
            itemId: item.id,
            contentKind: kind,
        });
        const source = await resolveAttachmentFileSource({
            item,
            maxFileSizeMB: 0,
            localSizeStrategy: 'stat',
        });
        if (source.kind === 'error') {
            await ctx.db.markAttachmentExtractFailure({
                libraryId: item.libraryID,
                zoteroKey: item.key,
                status: 'skipped',
                error: source.code,
            });
            return { kind: 'complete', reason: source.code };
        }
        const beforeSignature = await getFileSignature(source.source.filePath);

        let extracted: ExtractSuccess | JobOutcome;
        try {
            extracted = kind === 'pdf'
                ? await ctx.runOnMuPDFWorker(() => this.extractPdf(record, ctx))
                : await this.extractDom(record, item, kind, source.source, ctx);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'retry', error: `unexpected: ${message}` };
        }
        if ('kind' in extracted) return extracted;

        const afterSignature = await getFileSignature(source.source.filePath);
        if (
            beforeSignature.mtime_ms !== afterSignature.mtime_ms
            || beforeSignature.size_bytes !== afterSignature.size_bytes
        ) {
            return { kind: 'retry', error: 'source_changed_during_extraction' };
        }

        let fileHash: string | null = null;
        try {
            fileHash = source.source.isRemoteOnly
                ? item.attachmentSyncedHash || null
                : await item.attachmentHash || null;
        } catch (error) {
            logger(`DocumentExtractExecutor: attachmentHash failed: ${error}`, 2);
        }
        const documentHash = extracted.document
            ? await computeStructuredDocumentHash(kind, extracted.document)
            : null;
        const schemaVersion = expectedExtractionSchemaVersion(kind);
        if (!schemaVersion) {
            await ctx.db.markAttachmentExtractFailure({
                libraryId: item.libraryID,
                zoteroKey: item.key,
                status: 'skipped',
                error: 'unsupported_schema_version',
            });
            return { kind: 'complete', reason: 'unsupported_schema_version' };
        }

        const applied = await ctx.db.markAttachmentExtracted({
            libraryId: item.libraryID,
            zoteroKey: item.key,
            expectedFileMtimeMs: previous.fileMtimeMs,
            expectedFileSizeBytes: previous.fileSizeBytes,
            previousDocumentHash: previous.structuredDocumentHash,
            expectedExtractStatus: previous.extractStatus,
            fileMtimeMs: afterSignature.mtime_ms,
            fileSizeBytes: afterSignature.size_bytes,
            fileHash,
            structuredDocumentHash: documentHash,
            extractSchemaVersion: schemaVersion,
            ocrStatus: extracted.ocrStatus,
        });
        if (!applied) {
            return { kind: 'complete', reason: 'stale_completion_ignored' };
        }

        const hashChanged = previous.structuredDocumentHash !== documentHash;
        if (
            hashChanged
            && documentHash
            && extracted.ocrStatus === 'na'
            && Zotero.Beaver?.hasSearchIndexAccess === true
            && backgroundProcessingEnabled()
        ) {
            await ctx.enqueue({
                jobType: 'fulltext_upsert',
                libraryId: item.libraryID,
                itemId: item.id,
                zoteroKey: item.key,
                contentKind: kind,
                payloadKind: 'structured',
                priority: BACKGROUND_UPSERT_PRIORITY,
                payload: buildIndexJobPayload(kind, {
                    docHash: documentHash,
                    previousDocumentHash: previous.structuredDocumentHash ?? undefined,
                }),
                now: Date.now(),
            });
        }
        return { kind: 'complete', reason: extracted.reason };
    }

    describeFailure(): null {
        return null;
    }

    private async executeLegacy(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<JobOutcome> {
        let item: Zotero.Item | null = null;
        if (record.libraryId !== UNRESOLVED_LIBRARY_ID) {
            try {
                item = await Zotero.Items.getByLibraryAndKeyAsync(
                    record.libraryId,
                    record.zoteroKey,
                ) || null;
            } catch { /* missing is handled below */ }
        }
        if (!item || safeIsInTrash(item) === true) {
            return { kind: 'complete', reason: item ? 'in_trash' : 'item_missing' };
        }
        const liveKind = liveAttachmentContentKind(item);
        const canResolvePdfFromParent = liveKind === null
            && record.contentKind === 'pdf'
            && item.isRegularItem?.() === true;
        if (
            (liveKind === null && !canResolvePdfFromParent)
            || (liveKind !== null && liveKind !== record.contentKind)
        ) {
            return { kind: 'complete', reason: 'content_kind_stale' };
        }
        if (record.contentKind !== 'pdf') {
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
            return {
                kind: 'retry',
                error: `unexpected: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        switch (result.kind) {
            case 'ok': return { kind: 'complete', reason: 'ok' };
            case 'external_abort': return { kind: 'release', reason: 'external_abort' };
            case 'cached_error': return { kind: 'complete', reason: `cached_error:${result.code}` };
            case 'timeout': return { kind: 'retry', error: `timeout:${result.phase}`, reason: `timeout:${result.phase}` };
            case 'response_error':
                return isTransientResponseError(result.code)
                    ? { kind: 'retry', error: `${result.code}: ${result.message}`, reason: result.code }
                    : { kind: 'complete', reason: `terminal:${result.code}` };
        }
    }

    private async resolveItem(
        record: BackgroundJobRecord,
    ): Promise<
        { item: Zotero.Item; kind: ProcessableKind }
        | { outcome: JobOutcome }
    > {
        if (record.libraryId === UNRESOLVED_LIBRARY_ID) {
            return { outcome: { kind: 'complete', reason: 'item_missing' } };
        }
        let item: Zotero.Item | null = null;
        try {
            item = await Zotero.Items.getByLibraryAndKeyAsync(
                record.libraryId,
                record.zoteroKey,
            ) || null;
        } catch (error) {
            logger(`DocumentExtractExecutor: item lookup failed: ${error}`, 1);
        }
        if (!item || safeIsInTrash(item) === true) {
            return {
                outcome: {
                    kind: 'complete',
                    reason: item ? 'in_trash' : 'item_missing',
                },
            };
        }
        await item.loadAllData();
        const liveKind = liveAttachmentContentKind(item);
        if (liveKind !== record.contentKind) {
            return { outcome: { kind: 'complete', reason: 'content_kind_stale' } };
        }
        if (liveKind !== 'pdf' && liveKind !== 'epub' && liveKind !== 'snapshot') {
            return { outcome: { kind: 'complete', reason: 'unsupported_content_kind' } };
        }
        return { item, kind: liveKind };
    }

    private async extractPdf(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
    ): Promise<ExtractSuccess | JobOutcome> {
        const payload = record.payload;
        if (!payload || payload.content_kind !== 'pdf') {
            return { kind: 'complete', reason: 'missing_payload' };
        }
        const result = await extractAndCacheDocument({
            libraryId: record.libraryId,
            zoteroKey: record.zoteroKey,
            mode: record.payloadKind,
            maxPages: payload.maxPages,
            maxFileSizeMB: payload.maxFileSizeMB,
            timeoutSeconds: payload.timeoutSeconds,
            workerName: 'background',
            externalAbortSignal: ctx.externalAbortSignal,
            ocrPriority: record.priority >= 100 ? OCR_PRIORITY_BACKFILL : undefined,
        });
        switch (result.kind) {
            case 'ok':
                return {
                    document: result.result as DocumentExtractResult,
                    ocrStatus: 'na',
                    reason: 'ok',
                };
            case 'cached_error':
                if (result.code === 'no_text_layer') {
                    return { document: null, ocrStatus: 'needed', reason: 'needs_ocr' };
                }
                await this.persistTerminalExtractError(record, ctx, result.code, 'skipped');
                return { kind: 'complete', reason: `cached_error:${result.code}` };
            case 'external_abort':
                return { kind: 'release', reason: 'external_abort' };
            case 'timeout':
                return { kind: 'retry', error: `timeout:${result.phase}` };
            case 'response_error':
                if (isTransientResponseError(result.code)) {
                    return { kind: 'retry', error: `${result.code}: ${result.message}` };
                }
                await this.persistTerminalExtractError(
                    record,
                    ctx,
                    result.code,
                    isSkippedResponse(result.code) ? 'skipped' : 'failed',
                );
                return { kind: 'complete', reason: `terminal:${result.code}` };
        }
    }

    private async extractDom(
        record: BackgroundJobRecord,
        item: Zotero.Item,
        kind: Extract<ProcessableKind, 'epub' | 'snapshot'>,
        source: AttachmentFileSource,
        ctx: JobExecutionContext,
    ): Promise<ExtractSuccess | JobOutcome> {
        let temporaryPath: string | null = null;
        let resolvedFile: {
            cacheFilePath: string;
            extractionFilePath: string;
            sourceSizeBytes: number;
        } | undefined;
        if (source.isRemoteOnly) {
            const loaded = await loadAttachmentData({
                item,
                source,
                maxFileSizeMB: 0,
                signal: ctx.externalAbortSignal,
            });
            if (loaded.kind === 'error') {
                return loaded.code === 'download_failed' || loaded.code === 'read_failed'
                    ? { kind: 'retry', error: loaded.code }
                    : { kind: 'complete', reason: loaded.code };
            }
            const extension = kind === 'epub' ? 'epub' : 'html';
            temporaryPath = PathUtils.join(
                PathUtils.tempDir,
                `beaver-background-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`,
            );
            await IOUtils.write(temporaryPath, loaded.data);
            resolvedFile = {
                cacheFilePath: source.filePath,
                extractionFilePath: temporaryPath,
                sourceSizeBytes: loaded.data.byteLength,
            };
        }
        const common = {
            source: { kind: 'zotero' as const, item },
            resolvedKey: `${item.libraryID}-${item.key}`,
            contentType: item.attachmentContentType || (
                kind === 'epub' ? 'application/epub+zip' : 'text/html'
            ),
            maxPages: null,
            maxFileSizeMB: 0,
            externalAbortSignal: ctx.externalAbortSignal,
            resolvedFile,
        };
        let result;
        try {
            result = kind === 'epub'
                ? await extractAndCacheEpubDocument(common)
                : await extractAndCacheSnapshotDocument(common);
        } finally {
            if (temporaryPath) {
                await IOUtils.remove(temporaryPath).catch(() => undefined);
            }
        }
        if (result.kind === 'ok') {
            return {
                document: result.document,
                ocrStatus: 'na',
                reason: 'ok',
            };
        }
        if (ctx.externalAbortSignal.aborted || result.code === 'timeout') {
            return { kind: 'release', reason: 'external_abort' };
        }
        if (isTransientResponseError(result.code)) {
            return { kind: 'retry', error: `${result.code}: ${result.message}` };
        }
        await this.persistTerminalExtractError(
            record,
            ctx,
            result.code,
            isSkippedResponse(result.code) ? 'skipped' : 'failed',
        );
        return { kind: 'complete', reason: `terminal:${result.code}` };
    }

    private async persistTerminalExtractError(
        record: BackgroundJobRecord,
        ctx: JobExecutionContext,
        code: string,
        status: 'failed' | 'skipped',
    ): Promise<void> {
        await ctx.db.markAttachmentExtractFailure({
            libraryId: record.libraryId,
            zoteroKey: record.zoteroKey,
            status,
            error: code,
        });
    }
}

function isTransientResponseError(code: string): boolean {
    return code === 'download_failed'
        || code === 'extraction_failed'
        || code === 'worker_unavailable';
}

function isSkippedResponse(code: string): boolean {
    return code === 'file_missing'
        || code === 'file_too_large'
        || code === 'unsupported_type'
        || code === 'too_many_pages';
}
