import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { resetLocalProcessingState } from '../../../src/services/backgroundProcessing/resetLocalState';

describe('resetLocalProcessingState', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
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

        const result = await resetLocalProcessingState();
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

        await resetLocalProcessingState(2);
        expect(await db.getAttachmentProcessingState(1, 'KEEPME01')).not.toBeNull();
        expect(await db.getAttachmentProcessingState(2, 'DROPME01')).toBeNull();
        expect(await db.getDocumentProcessingFailure('keep-hash', 'ocr')).not.toBeNull();
    });
});
