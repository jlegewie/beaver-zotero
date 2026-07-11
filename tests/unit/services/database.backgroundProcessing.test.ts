import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

describe('BeaverDB background processing state', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
    });

    afterEach(async () => {
        await connection.closeDatabase();
    });

    it('creates identity rows without clobbering executor progress', async () => {
        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            itemId: 10,
            contentKind: 'pdf',
        });
        expect(await db.markAttachmentExtracted({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            expectedFileMtimeMs: null,
            expectedFileSizeBytes: null,
            previousDocumentHash: null,
            expectedExtractStatus: null,
            fileMtimeMs: 100,
            fileSizeBytes: 200,
            fileHash: 'file-1',
            structuredDocumentHash: 'a'.repeat(64),
            extractSchemaVersion: '4',
            ocrStatus: 'na',
        })).toBe(true);

        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            itemId: 11,
            contentKind: 'pdf',
        });
        const row = await db.getAttachmentProcessingState(1, 'ABCDEFGH');
        expect(row).toMatchObject({
            itemId: 11,
            extractStatus: 'done',
            structuredDocumentHash: 'a'.repeat(64),
        });
    });

    it('preserves downstream membership after a benign re-extraction', async () => {
        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            contentKind: 'pdf',
        });
        const hash = 'b'.repeat(64);
        await db.markAttachmentExtracted({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            expectedFileMtimeMs: null,
            expectedFileSizeBytes: null,
            previousDocumentHash: null,
            expectedExtractStatus: null,
            fileMtimeMs: 10,
            fileSizeBytes: 20,
            fileHash: 'old-file',
            structuredDocumentHash: hash,
            extractSchemaVersion: '4',
            ocrStatus: 'na',
        });
        await db.markAttachmentUpsertDone({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            structuredDocumentHash: hash,
            upsertIndexVersion: '1',
        });
        await db.resetAttachmentExtraction(1, 'ABCDEFGH', 'file_signature_changed');
        const pending = await db.getAttachmentProcessingState(1, 'ABCDEFGH');
        expect(pending?.upsertStatus).toBe('done');

        expect(await db.markAttachmentExtracted({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            expectedFileMtimeMs: 10,
            expectedFileSizeBytes: 20,
            previousDocumentHash: hash,
            expectedExtractStatus: null,
            fileMtimeMs: 11,
            fileSizeBytes: 21,
            fileHash: 'new-file',
            structuredDocumentHash: hash,
            extractSchemaVersion: '4',
            ocrStatus: 'na',
        })).toBe(true);
        expect((await db.getAttachmentProcessingState(1, 'ABCDEFGH'))?.upsertStatus)
            .toBe('done');
    });

    it('rejects stale completions after a reconciler reset', async () => {
        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            contentKind: 'pdf',
        });
        const hash = 'c'.repeat(64);
        await db.markAttachmentExtracted({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            expectedFileMtimeMs: null,
            expectedFileSizeBytes: null,
            previousDocumentHash: null,
            expectedExtractStatus: null,
            fileMtimeMs: 1,
            fileSizeBytes: 2,
            fileHash: 'file',
            structuredDocumentHash: hash,
            extractSchemaVersion: '4',
            ocrStatus: 'na',
        });
        await db.resetAttachmentExtraction(1, 'ABCDEFGH', 'version_changed');

        expect(await db.markAttachmentExtracted({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            expectedFileMtimeMs: 1,
            expectedFileSizeBytes: 2,
            previousDocumentHash: hash,
            expectedExtractStatus: 'done',
            fileMtimeMs: 1,
            fileSizeBytes: 2,
            fileHash: 'file',
            structuredDocumentHash: hash,
            extractSchemaVersion: '4',
            ocrStatus: 'na',
        })).toBe(false);
        expect((await db.getAttachmentProcessingState(1, 'ABCDEFGH'))?.extractStatus)
            .toBeNull();
    });

    it('does not let in-flight OCR or upsert revive an invalidated extraction', async () => {
        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            contentKind: 'pdf',
        });
        const hash = 'd'.repeat(64);
        await db.markAttachmentExtracted({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            expectedFileMtimeMs: null,
            expectedFileSizeBytes: null,
            previousDocumentHash: null,
            expectedExtractStatus: null,
            fileMtimeMs: 1,
            fileSizeBytes: 2,
            fileHash: 'file',
            structuredDocumentHash: hash,
            extractSchemaVersion: '4',
            ocrStatus: 'needed',
        });
        const claimed = await db.getAttachmentProcessingState(1, 'ABCDEFGH');
        await db.resetAttachmentExtraction(1, 'ABCDEFGH', 'file_changed');

        await expect(db.markAttachmentOcrDone({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            fileHash: 'file',
            ocrEngineVersion: 'engine-1',
            structuredDocumentHash: hash,
            expectedOcrStatus: claimed!.ocrStatus,
            expectedOcrEngineVersion: claimed!.ocrEngineVersion,
            expectedExtractStatus: claimed!.extractStatus,
        })).resolves.toBe(false);
        await expect(db.markAttachmentUpsertDone({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            structuredDocumentHash: hash,
            upsertIndexVersion: '1',
            expectedUpsertStatus: claimed!.upsertStatus,
            expectedUpsertIndexVersion: claimed!.upsertIndexVersion,
            expectedExtractStatus: claimed!.extractStatus,
        })).resolves.toBe(false);

        const row = await db.getAttachmentProcessingState(1, 'ABCDEFGH');
        expect(row).toMatchObject({
            extractStatus: null,
            ocrStatus: 'needed',
            upsertStatus: null,
        });
    });

    it('stores scan cursors and reports aggregate progress', async () => {
        await db.ensureAttachmentProcessingState({
            libraryId: 2,
            zoteroKey: 'ABCDEFGH',
            contentKind: 'epub',
        });
        await db.upsertProcessingIndexState({
            libraryId: 2,
            maxClientDateModified: '2026-07-10 12:00:00',
            attachmentCount: 1,
            ledgerRowCount: 1,
            lastScanTimestamp: 123,
        });
        await expect(db.getProcessingIndexState(2)).resolves.toEqual({
            libraryId: 2,
            maxClientDateModified: '2026-07-10 12:00:00',
            attachmentCount: 1,
            ledgerRowCount: 1,
            lastScanTimestamp: 123,
        });
        await expect(db.getAttachmentProcessingAggregates(2)).resolves.toMatchObject({
            total: 1,
            extracted: 0,
            upserted: 0,
        });
    });

    it('keeps the newest replacement metadata on a deduplicated upsert job', async () => {
        const base = {
            jobType: 'fulltext_upsert' as const,
            libraryId: 1,
            itemId: 10,
            zoteroKey: 'ABCDEFGH',
            contentKind: 'pdf' as const,
            payloadKind: 'structured' as const,
            priority: 115,
            now: 1,
        };
        const first = await db.enqueueBackgroundJob({
            ...base,
            payload: {
                content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0,
                timeoutSeconds: 120, doc_hash: 'a'.repeat(64),
            },
        });
        await db.failBackgroundJob(first.id, 'temporary index error', {
            maxAttempts: 5,
            backoffMs: () => 60_000,
            now: 10,
        });
        await db.enqueueBackgroundJob({
            ...base,
            now: 2,
            payload: {
                content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0,
                timeoutSeconds: 120, doc_hash: 'b'.repeat(64),
                previous_doc_hash: 'a'.repeat(64),
            },
        });
        const [job] = await db.peekBackgroundJobs();
        expect(job.payload).toMatchObject({
            doc_hash: 'b'.repeat(64),
            previous_doc_hash: 'a'.repeat(64),
        });
        expect(job.attemptCount).toBe(1);
        expect(job.lastError).toBe('temporary index error');
        expect(job.availableAt).toBe(60_010);
    });

    it('keeps independent upsert and per-hash untag intents', async () => {
        const common = {
            libraryId: 1,
            itemId: 10,
            zoteroKey: 'ABCDEFGH',
            contentKind: 'pdf' as const,
            payloadKind: 'structured' as const,
            priority: 80,
            now: 1,
        };
        await db.enqueueBackgroundJob({
            ...common,
            jobType: 'fulltext_upsert',
            payload: {
                content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0,
                timeoutSeconds: 120, doc_hash: 'c'.repeat(64),
            },
        });
        for (const hash of ['a'.repeat(64), 'b'.repeat(64)]) {
            await db.enqueueBackgroundJob({
                ...common,
                jobType: 'fulltext_untag',
                payload: {
                    content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0,
                    timeoutSeconds: 120, index_action: 'untag', doc_hash: hash,
                },
            });
        }

        const jobs = await db.peekBackgroundJobs();
        expect(jobs).toHaveLength(3);
        expect(jobs.filter((job) => job.jobType === 'fulltext_untag')
            .map((job) => job.payload?.doc_hash).sort()).toEqual([
                'a'.repeat(64), 'b'.repeat(64),
            ]);
    });

    it('redrives dead content-addressed untag jobs', async () => {
        const hash = 'e'.repeat(64);
        const queued = await db.enqueueBackgroundJob({
            jobType: 'fulltext_untag',
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            contentKind: 'pdf',
            payloadKind: 'structured',
            priority: 80,
            payload: {
                content_kind: 'pdf', maxPages: null, maxFileSizeMB: 0,
                timeoutSeconds: 120, index_action: 'untag', doc_hash: hash,
            },
            now: 0,
        });
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await db.failBackgroundJob(queued.id, 'network unavailable', {
                maxAttempts: 3,
                backoffMs: () => 0,
                now: attempt + 1,
            });
        }
        expect((await db.getBackgroundQueueStats(10)).dead).toBe(1);

        await expect(db.redriveDeadUntagJobs(100)).resolves.toBe(1);
        const [redriven] = await db.peekBackgroundJobs();
        expect(redriven).toMatchObject({
            jobType: 'fulltext_untag',
            zoteroKey: 'ABCDEFGH',
            attemptCount: 0,
            availableAt: 100,
        });
        expect(redriven.payload?.doc_hash).toBe(hash);
        expect((await db.getBackgroundQueueStats(100)).dead).toBe(0);
    });
});
