import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB, type BackgroundJobRecord } from '../../../src/services/database';
import { FulltextUpsertExecutor } from '../../../src/services/backgroundQueue/fulltextUpsertExecutor';
import type { JobExecutionContext } from '../../../src/services/backgroundQueue/jobExecutor';
import { ApiError } from '@beaver/agent-core/types/apiErrors';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { BACKGROUND_EXTRACT_PRIORITY, BACKGROUND_UPSERT_PRIORITY } from '../../../src/services/backgroundProcessing/constants';
import { OCR_PRIORITY_ON_DEMAND } from '../../../src/services/ocr/constants';

vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({
    searchIndexApiClient: {},
}));

vi.mock('../../../src/services/documentExtraction/attachmentSource', () => ({
    resolveAttachmentFileSource: vi.fn(async () => ({
        kind: 'ok',
        source: { kind: 'local', filePath: '/tmp/file.pdf', isRemoteOnly: false },
    })),
}));

vi.mock('../../../src/services/documentExtraction/structuredDocumentHash', () => ({
    computeStructuredDocumentHash: vi.fn(async () => 'a'.repeat(64)),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getIndexScopeRef: vi.fn(() => 'lLOCAL123'),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'LOCAL123' })),
}));

vi.mock('../../../src/services/backgroundProcessing/utils', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        isBackgroundProcessingLibraryEnabled: vi.fn(() => true),
    };
});

function response(status: 'completed' | 'tagged' = 'tagged', indexVersion = 2) {
    return {
        status,
        namespace_ready: true,
        chunks_total: 2,
        chunks_upserted: status === 'completed' ? 2 : 0,
        chunks_patched: 0,
        chunks_skipped: 0,
        chunks_deleted: 0,
        index_version: indexVersion,
        extract_schema_version: '4',
        embed_tokens: status === 'completed' ? 10 : 0,
    };
}

describe('FulltextUpsertExecutor', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;
    let api: {
        upsertHash: ReturnType<typeof vi.fn>;
        upsertPayload: ReturnType<typeof vi.fn>;
        untag: ReturnType<typeof vi.fn>;
    };
    let enqueue: ReturnType<typeof vi.fn>;
    let ctx: JobExecutionContext;
    let record: BackgroundJobRecord;

    beforeEach(async () => {
        vi.clearAllMocks();
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            itemId: 10,
            contentKind: 'pdf',
        });
        await db.markAttachmentExtracted({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            expectedFileMtimeMs: null,
            expectedFileSizeBytes: null,
            previousDocumentHash: null,
            expectedExtractStatus: null,
            fileMtimeMs: 1,
            fileSizeBytes: 2,
            fileHash: 'file-md5',
            structuredDocumentHash: 'a'.repeat(64),
            extractSchemaVersion: '4',
            ocrStatus: 'na',
        });
        api = {
            upsertHash: vi.fn().mockResolvedValue(response('tagged')),
            upsertPayload: vi.fn().mockResolvedValue(response('completed')),
            untag: vi.fn().mockResolvedValue({ results: [] }),
        };
        enqueue = vi.fn(async () => undefined);
        ctx = {
            db: db as any,
            runOnMuPDFWorker: vi.fn(async (fn) => fn()),
            externalAbortSignal: new AbortController().signal,
            shouldSkipDbWrites: () => false,
            enqueue,
        };
        record = {
            id: 1,
            jobType: 'fulltext_upsert',
            libraryId: 1,
            itemId: 10,
            zoteroKey: 'ABCDEFGH',
            contentKind: 'pdf',
            payloadKind: 'structured',
            priority: 115,
            payload: {
                content_kind: 'pdf',
                maxPages: null,
                timeoutSeconds: 120,
                index_action: 'upsert',
            },
            enqueuedAt: 0,
            availableAt: 0,
            attemptCount: 0,
            lastError: null,
        };
        const payload = {
            schemaVersion: '4',
            mode: 'structured',
            document: { pageCount: 0, bboxOrigin: 'top-left', bboxPrecision: 1, pages: [], citationIndex: {} },
        };
        (globalThis as any).Zotero.Beaver = {
            db,
            data: { env: 'production' },
            hasSearchIndexAccess: true,
            documentCache: { getResult: vi.fn(async () => payload) },
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn(async () => ({
                libraryID: 1,
                key: 'ABCDEFGH',
                isAttachment: () => true,
                isInTrash: () => false,
            })),
        };
    });

    afterEach(async () => {
        await connection.closeDatabase();
    });

    it('uses the hash-only tagged path and stamps stored versions', async () => {
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'complete', reason: 'index_tagged' });
        expect(api.upsertPayload).not.toHaveBeenCalled();
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({
            upsertStatus: 'done',
            upsertIndexVersion: '2',
        });
    });

    it('sends the payload when hash-only tagging finds an older index generation', async () => {
        api.upsertHash.mockResolvedValueOnce(response('tagged', 1));
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'complete', reason: 'index_completed' });
        expect(api.upsertPayload).toHaveBeenCalledTimes(1);
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({
            upsertStatus: 'done',
            upsertIndexVersion: '2',
        });
    });

    it('retries payload_required with the cached structured document', async () => {
        api.upsertHash.mockRejectedValueOnce(
            new ApiError(409, 'Conflict', 'payload needed', 'payload_required'),
        );
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'complete', reason: 'index_completed' });
        expect(api.upsertPayload).toHaveBeenCalledWith(expect.objectContaining({
            doc_hash: 'a'.repeat(64),
            payload: expect.objectContaining({ schemaVersion: '4' }),
        }));
    });

    it.each([
        { priority: BACKGROUND_UPSERT_PRIORITY, extractionPriority: BACKGROUND_EXTRACT_PRIORITY },
        { priority: OCR_PRIORITY_ON_DEMAND, extractionPriority: OCR_PRIORITY_ON_DEMAND },
    ])('recovers a missing payload at priority $extractionPriority for an upsert at priority $priority', async ({ priority, extractionPriority }) => {
        record.priority = priority;
        enqueue.mockImplementation((job) => db.enqueueBackgroundJob(job));
        api.upsertHash.mockRejectedValueOnce(
            new ApiError(409, 'Conflict', 'payload needed', 'payload_required'),
        );
        (Zotero.Beaver.documentCache!.getResult as any).mockResolvedValueOnce(null);
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'defer', reason: 'payload_cache_miss' });
        expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
            jobType: 'document_extract',
            zoteroKey: 'ABCDEFGH',
            priority: extractionPriority,
        }));
        // Paused processing only claims jobs below the background priority ceiling.
        const recovery = await db.claimNextBackgroundJob(Date.now(), 60_000, 100, ['document_extract']);
        if (priority === OCR_PRIORITY_ON_DEMAND) {
            expect(recovery).toMatchObject({ jobType: 'document_extract', priority });
        } else {
            expect(recovery).toBeNull();
        }
    });

    it('keeps a paused index retry queued through OCR cache recovery and indexes after OCR completes', async () => {
        enqueue.mockImplementation((job) => db.enqueueBackgroundJob(job));
        const executor = new FulltextUpsertExecutor(api as any);
        const now = Date.now();
        await db.enqueueBackgroundJob({ ...record, priority: OCR_PRIORITY_ON_DEMAND, now });
        const claim = (time: number) => db.claimNextBackgroundJob(time, 60_000, 100, ['fulltext_upsert']);
        const first = (await claim(now))!;
        expect(first).toMatchObject({ priority: OCR_PRIORITY_ON_DEMAND });
        api.upsertHash.mockRejectedValueOnce(new ApiError(409, 'Conflict', 'payload needed', 'payload_required'));
        (Zotero.Beaver.documentCache!.getResult as any).mockResolvedValueOnce(null);
        expect(await executor.execute(first, ctx)).toEqual({ kind: 'defer', reason: 'payload_cache_miss' });

        // Extraction of the original scan needs OCR before it has an indexable hash.
        await connection.queryAsync(`UPDATE attachment_processing_state
            SET structured_document_hash = NULL, ocr_status = 'needed'`);
        const waiting = (await claim(now + 60_001))!;
        expect(await executor.execute(waiting, ctx)).toEqual({ kind: 'defer', reason: 'waiting_for_ocr' });
        expect(api.upsertHash).toHaveBeenCalledTimes(1);

        expect(await db.markAttachmentOcrDone({
            libraryId: 1, zoteroKey: 'ABCDEFGH', fileHash: 'file-md5',
            ocrEngineVersion: '1', structuredDocumentHash: 'a'.repeat(64),
            expectedOcrStatus: 'needed', expectedOcrEngineVersion: null, expectedExtractStatus: 'done',
        })).toBe(true);
        // No replacement upsert is produced: the original request survives at its priority.
        const ready = (await claim(now + 120_002))!;
        expect(ready).toMatchObject({ id: first.id, priority: OCR_PRIORITY_ON_DEMAND });
        expect(await executor.execute(ready, ctx)).toEqual({ kind: 'complete', reason: 'index_tagged' });
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({ upsertStatus: 'done' });
    });

    it.each(['failed', 'na'])('does not wait for OCR when its status is %s and no document hash exists', async (ocrStatus) => {
        await connection.queryAsync(`UPDATE attachment_processing_state
            SET structured_document_hash = NULL, ocr_status = ?`, [ocrStatus]);
        expect(await new FulltextUpsertExecutor(api as any).execute(record, ctx))
            .toEqual({ kind: 'complete', reason: 'ledger_not_ready' });
    });

    it('pairs a replacement upsert with an idempotent old-hash untag', async () => {
        record.payload = { ...record.payload!, previous_doc_hash: 'b'.repeat(64) } as any;
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome.kind).toBe('complete');
        expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
            jobType: 'fulltext_untag',
            zoteroKey: 'ABCDEFGH',
            payload: expect.objectContaining({ doc_hash: 'b'.repeat(64) }),
        }));
        expect((await db.getAttachmentProcessingState(1, 'ABCDEFGH'))?.upsertStatus)
            .toBe('done');
    });

    it('executes a dedicated untag job without requiring an accessible local library', async () => {
        record.jobType = 'fulltext_untag';
        record.payload = {
            ...record.payload!,
            index_action: 'untag',
            doc_hash: 'b'.repeat(64),
        } as any;
        api.untag.mockResolvedValueOnce({
            results: [{
                scope_ref: 'lLOCAL123',
                zotero_key: 'ABCDEFGH',
                doc_hash: 'b'.repeat(64),
                outcome: 'untagged',
            }],
        });

        const outcome = await new FulltextUpsertExecutor(
            api as any,
            'fulltext_untag',
        ).execute(record, ctx);
        expect(outcome).toEqual({ kind: 'complete', reason: 'index_untagged' });
        expect(api.untag).toHaveBeenCalledWith('LOCAL123', [{
            scope_ref: 'lLOCAL123',
            zotero_key: 'ABCDEFGH',
            doc_hash: 'b'.repeat(64),
        }]);
    });

    it('marks payload_too_large terminal and never retries it', async () => {
        api.upsertHash.mockRejectedValueOnce(
            new ApiError(413, 'Payload Too Large', 'too large', 'payload_too_large'),
        );
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome.kind).toBe('failPermanent');
        expect((await db.getAttachmentProcessingState(1, 'ABCDEFGH'))?.upsertStatus)
            .toBe('failed');
    });

    it('honors a zero-second backend retry hint', async () => {
        api.upsertHash.mockRejectedValueOnce(
            new ApiError(429, 'Rate Limited', 'retry', 'claim_busy', {
                retry_after_seconds: 0,
            }),
        );
        const outcome = await new FulltextUpsertExecutor(api as any).execute(record, ctx);
        expect(outcome).toMatchObject({
            kind: 'retry',
            retryAfterMs: 1_000,
        });
    });
});
