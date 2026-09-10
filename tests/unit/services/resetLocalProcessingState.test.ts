import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { clearDocumentCache, resetLocalProcessingState } from '../../../src/services/backgroundProcessing/resetLocalState';

describe('resetLocalProcessingState', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        vi.clearAllMocks();
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        (globalThis as any).Zotero.Beaver = { db };
        (globalThis as any).Zotero.Libraries = {
            getAll: () => [
                { libraryID: 1, libraryType: 'user' },
                { libraryID: 2, libraryType: 'group' },
            ],
        };
    });

    afterEach(async () => {
        await connection.closeDatabase();
        delete (globalThis as any).Zotero.Beaver;
    });

    it('drops the ledger, queue, scan cursors, and content-addressed failures', async () => {
        await db.ensureAttachmentProcessingState({
            libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'pdf',
        });
        await db.markAttachmentExtracted({
            libraryId: 1, zoteroKey: 'ABCDEFGH',
            expectedFileMtimeMs: null, expectedFileSizeBytes: null,
            previousDocumentHash: null, expectedExtractStatus: null,
            fileMtimeMs: 1, fileSizeBytes: 2, fileHash: 'file-1',
            structuredDocumentHash: 'a'.repeat(64), extractSchemaVersion: '4',
            ocrStatus: 'na',
        });
        await db.enqueueBackgroundJob({
            jobType: 'document_extract', libraryId: 1, itemId: 10,
            zoteroKey: 'ABCDEFGH', contentKind: 'pdf', payloadKind: 'structured',
            priority: 100, now: 1,
            payload: { content_kind: 'pdf', maxPages: null, timeoutSeconds: 120 },
        });
        await db.upsertProcessingIndexState({
            libraryId: 1, maxClientDateModified: '2026-01-01',
            attachmentCount: 1, ledgerRowCount: 1, lastScanTimestamp: 1,
        });
        await db.recordDocumentProcessingFailure({
            fileHash: 'file-1', task: 'ocr', error: 'ocr_failed',
        });

        const result = await resetLocalProcessingState(undefined, { discardRemoteState: true });
        expect(result.libraryIds).toEqual([1, 2]);
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toBeNull();
        expect(await db.getProcessingIndexState(1)).toBeNull();
        expect((await db.getBackgroundQueueStats(Date.now())).pending).toBe(0);
        expect(await db.getDocumentProcessingFailure('file-1', 'ocr')).toBeNull();
    });

    it('can reset a single library without wiping other libraries or global failures', async () => {
        await db.ensureAttachmentProcessingState({
            libraryId: 1, zoteroKey: 'KEEPME01', contentKind: 'pdf',
        });
        await db.ensureAttachmentProcessingState({
            libraryId: 2, zoteroKey: 'DROPME01', contentKind: 'pdf',
        });
        await db.recordDocumentProcessingFailure({
            fileHash: 'keep-hash', task: 'ocr', error: 'ocr_failed',
        });

        await resetLocalProcessingState(2, { discardRemoteState: true });
        expect(await db.getAttachmentProcessingState(1, 'KEEPME01')).not.toBeNull();
        expect(await db.getAttachmentProcessingState(2, 'DROPME01')).toBeNull();
        expect(await db.getDocumentProcessingFailure('keep-hash', 'ocr')).not.toBeNull();
    });
    it('preserves remote membership and pending/dead cleanup when resetting progress', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'pdf' });
        await connection.queryAsync(`UPDATE attachment_processing_state SET
            extract_status = 'done', ocr_status = 'done', upsert_status = 'done',
            structured_document_hash = ?, file_mtime_ms = 1, file_size_bytes = 2`, ['a'.repeat(64)]);
        for (const jobType of ['fulltext_untag', 'document_extract'] as const) {
            await db.enqueueBackgroundJob({ jobType, libraryId: 1, zoteroKey: 'DELETED1',
                contentKind: 'pdf', payloadKind: 'structured', priority: 80, now: 1,
                payload: { content_kind: 'pdf', doc_hash: 'b'.repeat(64), scope_ref: 'local' } });
        }
        const dead = await db.enqueueBackgroundJob({ jobType: 'fulltext_untag', libraryId: 99,
            zoteroKey: 'DEADJOB1', contentKind: 'pdf', payloadKind: 'structured', priority: 80, now: 1,
            payload: { content_kind: 'pdf', doc_hash: 'c'.repeat(64), scope_ref: 'local' } });
        await db.failBackgroundJob(dead.id, 'offline', { maxAttempts: 1, backoffMs: () => 0, now: 2 });
        // A library that no longer exists must still have its local progress cleared.
        await db.ensureAttachmentProcessingState({ libraryId: 99, zoteroKey: 'ORPHAN01', contentKind: 'pdf' });
        await resetLocalProcessingState();
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({
            extractStatus: null, ocrStatus: null, upsertStatus: 'done',
            structuredDocumentHash: 'a'.repeat(64), fileMtimeMs: null, fileSizeBytes: null,
        });
        expect(await connection.queryAsync('SELECT job_type FROM background_jobs')).toEqual([{ job_type: 'fulltext_untag' }]);
        expect(await connection.queryAsync('SELECT job_type FROM background_jobs_dead')).toEqual([{ job_type: 'fulltext_untag' }]);
        await resetLocalProcessingState(undefined, { discardRemoteState: true });
        expect(await connection.queryAsync('SELECT * FROM background_jobs')).toEqual([]);
        expect(await connection.queryAsync('SELECT * FROM background_jobs_dead')).toEqual([]);
        expect(await db.getAttachmentProcessingState(99, 'ORPHAN01')).toBeNull();
    });

    it('preserves the old hash cleanup carried by an unfinished upsert', async () => {
        await db.enqueueBackgroundJob({ jobType: 'fulltext_upsert', libraryId: 1, zoteroKey: 'ABCDEFGH',
            contentKind: 'pdf', payloadKind: 'structured', priority: 100, now: 1,
            payload: { content_kind: 'pdf', scope_ref: 'local', doc_hash: 'b'.repeat(64), previous_doc_hash: 'a'.repeat(64) } });
        await resetLocalProcessingState();
        const jobs = await connection.queryAsync('SELECT job_type, payload_json FROM background_jobs');
        expect(jobs).toHaveLength(1);
        expect(jobs[0].job_type).toBe('fulltext_untag');
        expect(JSON.parse(jobs[0].payload_json)).toMatchObject({ doc_hash: 'a'.repeat(64) });
    });

    it('resumes services after a failed cache deletion without resetting progress', async () => {
        const resume = vi.fn();
        const suspend = vi.fn(async () => resume);
        const reset = vi.spyOn(db, 'resetLocalProcessingState');
        Object.assign((globalThis as any).Zotero.Beaver, {
            documentCache: { runMaintenance: (work: () => Promise<void>) => work(), clearAll: vi.fn().mockRejectedValue(new Error('disk failure')) },
            processingReconciler: { suspendForMaintenance: suspend },
            backgroundExtractor: { suspendForMaintenance: suspend },
        });
        await expect(clearDocumentCache(true)).rejects.toThrow('disk failure');
        expect(suspend).toHaveBeenCalledTimes(2);
        expect(resume).toHaveBeenCalledTimes(2);
        expect(reset).not.toHaveBeenCalled();
    });

    it('keeps processing state for settings deletion and resets it for the dev action', async () => {
        Object.assign((globalThis as any).Zotero.Beaver, { documentCache: { runMaintenance: (work: () => Promise<void>) => work(), clearAll: vi.fn() } });
        const reset = vi.spyOn(db, 'resetLocalProcessingState');
        await clearDocumentCache();
        expect(reset).not.toHaveBeenCalled();
        await clearDocumentCache(true);
        expect(reset).toHaveBeenCalledWith(undefined, false);
    });

});
