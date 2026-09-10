import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { expectedExtractionSchemaVersion } from '../../../src/services/documentExtraction/shared/extractionSchemaVersions';

const mocks = vi.hoisted(() => ({
    resolveAttachmentFileSource: vi.fn(),
    maybeEnqueueOcrJob: vi.fn(),
    enqueueOcrJob: vi.fn(async () => undefined),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => key === 'backgroundProcessingEnabled',
}));
vi.mock('../../../src/utils/idleService', () => ({ getSystemIdleTimeMs: () => 0 }));
vi.mock('../../../src/utils/zoteroItemUtils', () => ({ safeIsInTrash: () => false }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: () => 'pdf',
}));
vi.mock('../../../src/services/documentExtraction/attachmentSource', () => ({
    resolveAttachmentFileSource: mocks.resolveAttachmentFileSource,
}));
vi.mock('../../../src/services/documentFileIdentity', () => ({
    getFileSignature: vi.fn(),
    isRemoteFilePath: () => false,
}));
vi.mock('../../../src/services/ocr/enqueueOcr', () => ({
    maybeEnqueueOcrJob: mocks.maybeEnqueueOcrJob,
    enqueueOcrJob: mocks.enqueueOcrJob,
}));

import { ReconcilerService } from '../../../src/services/backgroundProcessing/reconciler';
import { OCR_ENGINE_VERSION, OCR_PRIORITY_BACKFILL } from '../../../src/services/ocr/constants';

const ENTITLED = { hasOcrAccess: true, hasSearchIndexAccess: true };

describe('ReconcilerService.retryAttachments', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;
    let reconciler: ReconcilerService;
    const items = new Map<string, { id: number; libraryID: number; key: string }>();
    const requestImmediateDrain = vi.fn();
    const notify = vi.fn();
    const invalidate = vi.fn(async () => undefined);
    const getMetadata = vi.fn(async () => ({ pageCount: 5 }));

    beforeEach(async () => {
        vi.clearAllMocks();
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        reconciler = new ReconcilerService();
        items.clear();
        items.set('1-MISSING1', { id: 11, libraryID: 1, key: 'MISSING1' });
        items.set('1-CRASHED1', { id: 12, libraryID: 1, key: 'CRASHED1' });
        items.set('1-INDEXED1', { id: 13, libraryID: 1, key: 'INDEXED1' });
        items.set('9-EXCLUDED', { id: 14, libraryID: 9, key: 'EXCLUDED' });
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) =>
                items.get(`${libraryID}-${key}`) ?? false),
        };
        (globalThis as any).Zotero.Beaver = {
            db,
            libraryScopeInitialized: true,
            searchableLibraryIds: [1],
            hasOcrAccess: true,
            hasSearchIndexAccess: true,
            backgroundExtractor: { requestImmediateDrain, notify },
            documentCache: { invalidate, getMetadata },
        };
        mocks.resolveAttachmentFileSource.mockResolvedValue({
            kind: 'ok', source: { kind: 'local', filePath: '/tmp/a.pdf', isRemoteOnly: false },
        });
    });

    afterEach(async () => {
        await connection.closeDatabase();
        delete (globalThis as any).Zotero.Beaver;
    });

    async function failedExtraction(key: string, error: string, status: 'failed' | 'skipped' = 'failed') {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: key, itemId: items.get(`1-${key}`)?.id, contentKind: 'pdf' });
        await db.markAttachmentExtractFailure({ libraryId: 1, zoteroKey: key, status, error });
    }

    it('requeues a failed extraction, clears its dead letter and drains immediately', async () => {
        await failedExtraction('CRASHED1', 'worker_crashed');
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            VALUES ('document_extract', 1, 'CRASHED1', 'pdf', 'structured', 0, 1, 3)`);
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'extract_failed', count: 1 }]);

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'CRASHED1' }])).toBe(1);

        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([]);
        expect(await db.getBackgroundDeadLetters()).toEqual([]);
        // The cache remembers terminal verdicts; a retry must not re-read one.
        expect(invalidate).toHaveBeenCalledWith(1, 'CRASHED1');
        const row = await db.getAttachmentProcessingState(1, 'CRASHED1');
        expect(row).toMatchObject({ extractStatus: null, lastError: 'user_retry' });
        expect((await db.getBackgroundQueueStats(Date.now())).byJobType.document_extract ?? 0).toBe(1);
        expect(requestImmediateDrain).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledOnce();
    });

    it('re-fails a still-missing file on the spot so it stays listed as unavailable', async () => {
        await failedExtraction('MISSING1', 'file_missing', 'skipped');
        mocks.resolveAttachmentFileSource.mockResolvedValue({ kind: 'error', code: 'file_missing', message: 'gone' });

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'MISSING1' }])).toBe(1);

        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'file_unavailable', count: 1 }]);
        expect((await db.getBackgroundQueueStats(Date.now())).pending).toBe(0);
    });

    it('tickets OCR directly for a failed OCR stage instead of re-running extraction', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'INDEXED1', itemId: 13, contentKind: 'pdf' });
        await connection.queryAsync(
            `UPDATE attachment_processing_state
             SET extract_status = 'done', extract_schema_version = ?, ocr_status = 'failed',
                 ocr_engine_version = ?, file_hash = ?, last_error = 'ocr_unexpected: boom'
             WHERE zotero_key = 'INDEXED1'`,
            [expectedExtractionSchemaVersion('pdf'), OCR_ENGINE_VERSION, 'f'.repeat(32)],
        );
        await db.recordDocumentProcessingFailure({
            fileHash: 'f'.repeat(32), task: 'ocr', engineVersion: OCR_ENGINE_VERSION, error: 'boom', terminalCode: 'boom',
        });
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            VALUES ('document_ocr', 1, 'INDEXED1', 'pdf', 'structured', 0, 1, 3)`);
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'ocr_failed', count: 1 }]);

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'INDEXED1' }])).toBe(1);

        expect(await db.getAttachmentProcessingState(1, 'INDEXED1')).toMatchObject({
            extractStatus: 'done', ocrStatus: 'needed', lastError: 'user_retry',
        });
        expect(await db.getDocumentProcessingFailure('f'.repeat(32), 'ocr', OCR_ENGINE_VERSION)).toBeNull();
        expect(await db.getBackgroundDeadLetters()).toEqual([]);
        expect(mocks.enqueueOcrJob).toHaveBeenCalledWith(expect.objectContaining({
            libraryId: 1, zoteroKey: 'INDEXED1', priority: OCR_PRIORITY_BACKFILL,
        }));
        // The shortcut is only valid while the OCR executor can read a page count.
        expect(getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'INDEXED1' }, '/tmp/a.pdf');
        expect(invalidate).not.toHaveBeenCalled();
        expect((await db.getBackgroundQueueStats(Date.now())).byJobType.document_extract ?? 0).toBe(0);
        expect(requestImmediateDrain).toHaveBeenCalledOnce();
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([]);
    });

    it.each([
        ['is missing', null],
        ['has no page count', { pageCount: null }],
    ])('restarts extraction for a failed OCR stage when the cached detection metadata %s', async (_label, meta) => {
        getMetadata.mockResolvedValueOnce(meta as any);
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'INDEXED1', itemId: 13, contentKind: 'pdf' });
        await connection.queryAsync(
            `UPDATE attachment_processing_state
             SET extract_status = 'done', extract_schema_version = ?, ocr_status = 'failed',
                 file_hash = ?, last_error = 'ocr_unexpected: boom'
             WHERE zotero_key = 'INDEXED1'`,
            [expectedExtractionSchemaVersion('pdf'), 'f'.repeat(32)],
        );

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'INDEXED1' }])).toBe(1);

        expect(await db.getAttachmentProcessingState(1, 'INDEXED1')).toMatchObject({
            extractStatus: null, ocrStatus: null, lastError: 'user_retry',
        });
        expect(invalidate).toHaveBeenCalledWith(1, 'INDEXED1');
        expect(mocks.enqueueOcrJob).not.toHaveBeenCalled();
        expect((await db.getBackgroundQueueStats(Date.now())).byJobType.document_extract ?? 0).toBe(1);
        expect(requestImmediateDrain).toHaveBeenCalledOnce();
    });

    it('restarts extraction when OCR failed because the file was unreachable', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'INDEXED1', itemId: 13, contentKind: 'pdf' });
        await connection.queryAsync(
            `UPDATE attachment_processing_state
             SET extract_status = 'done', extract_schema_version = ?, ocr_status = 'failed',
                 last_error = 'ocr_remote_download_failed: download_failed'
             WHERE zotero_key = 'INDEXED1'`,
            [expectedExtractionSchemaVersion('pdf')],
        );

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'INDEXED1' }])).toBe(1);

        expect(await db.getAttachmentProcessingState(1, 'INDEXED1')).toMatchObject({ extractStatus: null, ocrStatus: null });
        expect(invalidate).toHaveBeenCalledWith(1, 'INDEXED1');
        expect(mocks.enqueueOcrJob).not.toHaveBeenCalled();
        expect((await db.getBackgroundQueueStats(Date.now())).byJobType.document_extract ?? 0).toBe(1);
    });

    it('requeues only the index stage for a readable file whose upload failed', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'INDEXED1', itemId: 13, contentKind: 'pdf' });
        await connection.queryAsync(
            `UPDATE attachment_processing_state
             SET extract_status = 'done', extract_schema_version = ?, ocr_status = 'na',
                 upsert_status = 'failed', structured_document_hash = ?, last_error = 'index_unreachable'
             WHERE zotero_key = 'INDEXED1'`,
            [expectedExtractionSchemaVersion('pdf'), 'c'.repeat(64)],
        );
        await db.recordDocumentProcessingFailure({ fileHash: 'c'.repeat(64), task: 'fulltext_upsert', error: 'index_unreachable' });
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'index_failed', count: 1 }]);

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'INDEXED1' }])).toBe(1);

        expect(await db.getAttachmentProcessingState(1, 'INDEXED1')).toMatchObject({
            extractStatus: 'done', upsertStatus: null, lastError: 'user_retry',
        });
        expect(await db.getDocumentProcessingFailure('c'.repeat(64), 'fulltext_upsert')).toBeNull();
        expect(invalidate).not.toHaveBeenCalled();
        const stats = await db.getBackgroundQueueStats(Date.now());
        expect(stats.byJobType.fulltext_upsert ?? 0).toBe(1);
        expect(stats.byJobType.document_extract ?? 0).toBe(0);
    });

    it('skips excluded libraries, missing items and unknown ledger rows without draining', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 9, zoteroKey: 'EXCLUDED', itemId: 14, contentKind: 'pdf' });
        await db.markAttachmentExtractFailure({ libraryId: 9, zoteroKey: 'EXCLUDED', status: 'failed', error: 'boom' });

        expect(await reconciler.retryAttachments([
            { libraryId: 9, zoteroKey: 'EXCLUDED' },
            { libraryId: 1, zoteroKey: 'NOSUCHIT' },
            { libraryId: 1, zoteroKey: 'CRASHED1' },
        ])).toBe(0);

        expect(await db.getAttachmentProcessingState(9, 'EXCLUDED')).toMatchObject({ extractStatus: 'failed' });
        expect((await db.getBackgroundQueueStats(Date.now())).pending).toBe(0);
        expect(requestImmediateDrain).not.toHaveBeenCalled();
    });
});
