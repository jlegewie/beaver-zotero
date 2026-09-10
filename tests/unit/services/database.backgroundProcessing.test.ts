import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { groupProcessingIssues } from '../../../src/services/backgroundProcessing/issues';

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

    it('records OCR and upsert completion when the claimed guards are null', async () => {
        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            itemId: null,
            contentKind: 'pdf',
        });
        const extractHash = 'e'.repeat(64);
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
            structuredDocumentHash: extractHash,
            extractSchemaVersion: '4',
            ocrStatus: 'needed',
        });
        const claimed = await db.getAttachmentProcessingState(1, 'ABCDEFGH');
        expect(claimed?.ocrEngineVersion).toBeNull();

        const ocrHash = 'f'.repeat(64);
        await expect(db.markAttachmentOcrDone({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            fileHash: 'file',
            ocrEngineVersion: 'engine-1',
            structuredDocumentHash: ocrHash,
            expectedOcrStatus: claimed!.ocrStatus,
            expectedOcrEngineVersion: claimed!.ocrEngineVersion,
            expectedExtractStatus: claimed!.extractStatus,
        })).resolves.toBe(true);

        const ocrDone = await db.getAttachmentProcessingState(1, 'ABCDEFGH');
        expect(ocrDone).toMatchObject({
            ocrStatus: 'done',
            ocrEngineVersion: 'engine-1',
            structuredDocumentHash: ocrHash,
            upsertStatus: null,
        });

        await expect(db.markAttachmentUpsertDone({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            structuredDocumentHash: ocrHash,
            upsertIndexVersion: '1',
            expectedUpsertStatus: ocrDone!.upsertStatus,
            expectedUpsertIndexVersion: ocrDone!.upsertIndexVersion,
            expectedExtractStatus: ocrDone!.extractStatus,
        })).resolves.toBe(true);
        expect((await db.getAttachmentProcessingState(1, 'ABCDEFGH'))?.upsertStatus)
            .toBe('done');
    });

    it('refreshes the content kind of an identity row that has no item id', async () => {
        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            itemId: null,
            contentKind: 'pdf',
        });
        await db.ensureAttachmentProcessingState({
            libraryId: 1,
            zoteroKey: 'ABCDEFGH',
            itemId: null,
            contentKind: 'epub',
        });
        expect(await db.getAttachmentProcessingState(1, 'ABCDEFGH')).toMatchObject({
            itemId: null,
            contentKind: 'epub',
        });
    });

    it('keeps text-readiness categories disjoint across extraction, OCR and index failures', async () => {
        const states = [
            ['done', 'na', 'failed'],
            ['done', 'failed', null],
            ['done', 'needed', null],
            ['failed', 'failed', null],
            ['skipped', null, null],
            [null, null, null],
        ];
        for (const [index, [extract, ocr, upsert]] of states.entries()) {
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: `FILE000${index}`, contentKind: 'pdf' });
            await connection.queryAsync(
                'UPDATE attachment_processing_state SET extract_status = ?, ocr_status = ?, upsert_status = ? WHERE zotero_key = ?',
                [extract, ocr, upsert, `FILE000${index}`],
            );
        }
        for (const ocr of [true, false]) {
            const stats = await db.getAttachmentProcessingAggregates(1, { ocr });
            expect(stats).toMatchObject({
                total: 6, readable: 1, unreadable: ocr ? 3 : 4, awaitingOcr: ocr ? 1 : 0,
            });
            expect(stats.total - stats.readable - stats.unreadable - stats.awaitingOcr).toBe(1);
        }
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
                content_kind: 'pdf', maxPages: null,
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
                content_kind: 'pdf', maxPages: null,
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
                content_kind: 'pdf', maxPages: null,
                timeoutSeconds: 120, doc_hash: 'c'.repeat(64),
            },
        });
        for (const hash of ['a'.repeat(64), 'b'.repeat(64)]) {
            await db.enqueueBackgroundJob({
                ...common,
                jobType: 'fulltext_untag',
                payload: {
                    content_kind: 'pdf', maxPages: null,
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

    it('includes older failures behind more than 5000 OCR-needed rows before grouping', async () => {
        await connection.queryAsync(`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001)
            INSERT INTO attachment_processing_state
                (library_id, zotero_key, content_kind, extract_status, ocr_status, updated_at)
            SELECT 1, printf('SCAN%04d', i), 'pdf', 'done', 'needed', '2026-09-09 00:00:00' FROM n
        `);
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'OLDERROR', contentKind: 'pdf' });
        await connection.queryAsync(`UPDATE attachment_processing_state
            SET extract_status = 'failed', updated_at = '2026-09-01 00:00:00' WHERE zotero_key = 'OLDERROR'`);
        const entitled = { hasOcrAccess: true, hasSearchIndexAccess: true };
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([{ reason: 'extract_failed', count: 1 }]);
        const page = await db.getProcessingIssuePage(entitled, 'extract_failed');
        expect(page.map((item) => item.zoteroKey)).toEqual(['OLDERROR']);
        const noOcr = { hasOcrAccess: false, hasSearchIndexAccess: false };
        const withoutOcr = await db.getProcessingIssueCounts(noOcr);
        expect(withoutOcr.reduce((sum, group) => sum + group.count, 0)).toBe(5002);
        expect(await db.getProcessingIssuePage(noOcr, 'scanned')).toHaveLength(10);
        expect((await db.getProcessingIssuePage(noOcr, 'scanned', 5000)).map((item) => item.zoteroKey))
            .toEqual(['SCAN5001']);
    });

    it('includes the complete dead-letter inventory beyond 1000 jobs', async () => {
        await connection.queryAsync(`
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
            INSERT INTO background_jobs_dead
                (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            SELECT 'document_extract', 1, printf('DEAD%04d', i), 'pdf', 'structured', 0, i, 3 FROM n
        `);
        await connection.queryAsync(`INSERT INTO attachment_processing_state (library_id, zotero_key, content_kind)
            SELECT library_id, zotero_key, content_kind FROM background_jobs_dead`);
        const entitled = { hasOcrAccess: true, hasSearchIndexAccess: true };
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([{ reason: 'extract_failed', count: 1001 }]);
        expect(await db.getProcessingIssuePage(entitled, 'extract_failed')).toHaveLength(10);
        expect((await db.getProcessingIssuePage(entitled, 'extract_failed', 1000)).map((item) => item.zoteroKey))
            .toEqual(['DEAD0001']);
    });

    it('omits recovered stages from current dead-letter issues but preserves failure history', async () => {
        for (const jobType of ['document_extract', 'document_ocr', 'fulltext_upsert'] as const) {
            await db.enqueueBackgroundJob({
                jobType, libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'pdf',
                payloadKind: 'structured', now: 0,
            });
            const job = await db.claimNextBackgroundJob(1, 1000, undefined, [jobType]);
            await db.failBackgroundJob(job!.id, 'failed', { maxAttempts: 1, backoffMs: () => 0, now: 2 });
        }
        expect(await db.getBackgroundDeadLetters(undefined, true)).toHaveLength(0);
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'pdf' });
        await connection.queryAsync(
            "UPDATE attachment_processing_state SET extract_status = 'done', ocr_status = 'done', upsert_status = 'failed'",
        );
        const unresolved = await db.getBackgroundDeadLetters(undefined, true);
        expect(unresolved.map((row) => row.jobType)).toEqual(['fulltext_upsert']);
        await connection.queryAsync("UPDATE attachment_processing_state SET upsert_status = 'done'");
        expect(await db.getAttachmentProcessingIssueRows()).toEqual([]);
        expect(await db.getBackgroundDeadLetters(undefined, true)).toEqual([]);
        expect(await db.getBackgroundDeadLetters()).toHaveLength(3);
    });

    it.each(['attachment', 'library'])('hides orphaned issues after %s cleanup while retaining history', async (cleanup) => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'ABCDEFGH', contentKind: 'pdf' });
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            VALUES ('document_extract', 1, 'ABCDEFGH', 'pdf', 'structured', 0, 1, 3)`);
        const entitled = { hasOcrAccess: true, hasSearchIndexAccess: true };
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([{ reason: 'extract_failed', count: 1 }]);
        if (cleanup === 'attachment') await db.deleteAttachmentProcessingState(1, 'ABCDEFGH');
        else await db.deleteAttachmentProcessingStatesByLibrary(1);
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([]);
        expect(await db.getProcessingIssuePage(entitled, 'extract_failed')).toEqual([]);
        expect(await db.getBackgroundDeadLetters(undefined, true)).toEqual([]);
        expect(await db.getBackgroundDeadLetters()).toHaveLength(1);
    });

    it.each(['failed', 'skipped'] as const)('classifies a %s extraction retry before stale downstream failures', async (status) => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'RETRY000', contentKind: 'pdf' });
        await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'done', ocr_status = 'failed', upsert_status = 'failed'");
        await db.resetAttachmentExtraction(1, 'RETRY000');
        await db.markAttachmentExtractFailure({ attemptedAt: Date.now(), libraryId: 1, zoteroKey: 'RETRY000', status, error: 'encrypted' });
        const entitlements = { hasOcrAccess: true, hasSearchIndexAccess: true };
        expect(await db.getProcessingIssueCounts(entitlements)).toEqual([{ reason: 'encrypted', count: 1 }]);
        expect((await db.getProcessingIssuePage(entitlements, 'encrypted')).map((item) => item.zoteroKey))
            .toEqual(['RETRY000']);
        expect(await db.getProcessingIssuePage(entitlements, 'index_failed')).toEqual([]);
        expect(await db.getProcessingIssuePage(entitlements, 'ocr_failed')).toEqual([]);
    });

    it.each(['file_missing', 'download_failed: 404', 'ocr_remote_download_failed: download_failed',
        'ocr_remote_download_failed: read_failed'])('groups OCR file access failure %s as unavailable in counts and pages', async (lastError) => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'OCRFILE0', contentKind: 'pdf' });
        await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'done', ocr_status = 'failed', last_error = ?", [lastError]);
        for (const hasOcrAccess of [true, false]) {
            const entitlements = { hasOcrAccess, hasSearchIndexAccess: true };
            expect(await db.getProcessingIssueCounts(entitlements)).toEqual([{ reason: 'file_unavailable', count: 1 }]);
            expect((await db.getProcessingIssuePage(entitlements, 'file_unavailable')).map((item) => item.zoteroKey))
                .toEqual(['OCRFILE0']);
            expect(await db.getProcessingIssuePage(entitlements, 'ocr_failed')).toEqual([]);
            expect(groupProcessingIssues(await db.getAttachmentProcessingIssueRows(), [], entitlements)
                .map(({ reason, count }) => ({ reason, count })))
                .toEqual(await db.getProcessingIssueCounts(entitlements));
        }
    });

    it('keeps text-empty EPUBs and snapshots out of the PDF OCR group', async () => {
        for (const contentKind of ['pdf', 'epub', 'snapshot'] as const) {
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: contentKind, contentKind });
            await db.markAttachmentExtractFailure({ attemptedAt: Date.now(), libraryId: 1, zoteroKey: contentKind, status: 'failed', error: 'no_text_layer' });
        }
        for (const hasOcrAccess of [true, false]) {
            const entitlements = { hasOcrAccess, hasSearchIndexAccess: true };
            const expected = hasOcrAccess ? [{ reason: 'no_text', count: 3 }]
                : [{ reason: 'scanned', count: 1 }, { reason: 'no_text', count: 2 }];
            expect(await db.getProcessingIssueCounts(entitlements)).toEqual(expected);
            expect(groupProcessingIssues(await db.getAttachmentProcessingIssueRows(), [], entitlements)
                .map(({ reason, count }) => ({ reason, count }))).toEqual(expected);
            expect((await db.getProcessingIssuePage(entitlements, 'scanned')).map((item) => item.zoteroKey))
                .toEqual(hasOcrAccess ? [] : ['pdf']);
            expect((await db.getProcessingIssuePage(entitlements, 'no_text')).map((item) => item.zoteroKey).sort())
                .toEqual(hasOcrAccess ? ['epub', 'pdf', 'snapshot'] : ['epub', 'snapshot']);
        }
    });

    it('SQL grouping matches issue classification, with stable non-overlapping pages', async () => {
        const errors = ['file_missing', 'download_failed: 404', 'ocr load: read_failed', 'encrypted',
            'file_too_large: 120MB', 'too_many_pages', 'unsupported_type', 'wrapped: unsupported_type',
            'empty_document', 'no_text_layer', 'insufficient_text', 'unknown'];
        for (const [i, error] of errors.entries()) {
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: `FILE${String(i).padStart(4, '0')}`, contentKind: 'pdf' });
            await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'failed', last_error = ? WHERE zotero_key = ?",
                [error, `FILE${String(i).padStart(4, '0')}`]);
        }
        for (const hasOcrAccess of [true, false]) {
            const entitlements = { hasOcrAccess, hasSearchIndexAccess: true };
            const expected = groupProcessingIssues(await db.getAttachmentProcessingIssueRows(), [], entitlements);
            expect(await db.getProcessingIssueCounts(entitlements)).toEqual(expected.map(({ reason, count }) => ({ reason, count })));
            for (const group of expected) {
                const first = await db.getProcessingIssuePage(entitlements, group.reason, 0, 1);
                const rest = await db.getProcessingIssuePage(entitlements, group.reason, 1);
                expect([...first, ...rest].map((item) => item.zoteroKey).sort())
                    .toEqual(group.items.map((item) => item.zoteroKey).sort());
            }
        }
    });

    it('deduplicates dead letters, prefers ledger issues, and filters recovery and entitlement', async () => {
        for (const zoteroKey of ['LEDGER00', 'DEAD0000', 'HEALTH00', 'CLEAN000']) {
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey, contentKind: 'pdf' });
        }
        await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'skipped', last_error = 'encrypted' WHERE zotero_key = 'LEDGER00'");
        await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'done', ocr_status = 'done', upsert_status = 'done' WHERE zotero_key = 'HEALTH00'");
        for (const [key, type, died] of [
            ['LEDGER00', 'document_extract', 1],
            ['DEAD0000', 'document_extract', 1],
            ['DEAD0000', 'fulltext_upsert', 2],
            ['DEAD0000', 'fulltext_upsert', 3],
            ['HEALTH00', 'document_extract', 1],
            ['HEALTH00', 'document_ocr', 2],
            ['HEALTH00', 'fulltext_upsert', 3],
            ['CLEAN000', 'fulltext_untag', 1],
        ]) {
            await connection.queryAsync(`INSERT INTO background_jobs_dead
                (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
                VALUES (?, 1, ?, 'pdf', 'structured', 0, ?, 3)`, [type, key, died]);
        }
        expect(await db.getProcessingIssueCounts({ hasOcrAccess: true, hasSearchIndexAccess: true }))
            .toEqual([{ reason: 'index_failed', count: 1 }, { reason: 'encrypted', count: 1 }]);
        expect(await db.getProcessingIssueCounts({ hasOcrAccess: false, hasSearchIndexAccess: false }))
            .toEqual([{ reason: 'extract_failed', count: 1 }, { reason: 'encrypted', count: 1 }]);
    });

    it('lists every attachment of one issue group for a group-level retry', async () => {
        const entitlements = { hasOcrAccess: true, hasSearchIndexAccess: true };
        for (const key of ['MISSING1', 'MISSING2']) {
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: key, contentKind: 'pdf' });
            await db.markAttachmentExtractFailure({ attemptedAt: Date.now(), libraryId: 1, zoteroKey: key, status: 'skipped', error: 'file_missing' });
        }
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'LOCKED00', contentKind: 'pdf' });
        await db.markAttachmentExtractFailure({ attemptedAt: Date.now(), libraryId: 1, zoteroKey: 'LOCKED00', status: 'failed', error: 'encrypted' });

        const refs = await db.getProcessingIssueRefs(entitlements, 'file_unavailable');
        expect(refs.map((ref) => ref.zoteroKey).sort()).toEqual(['MISSING1', 'MISSING2']);
        expect(refs.every((ref) => ref.libraryId === 1)).toBe(true);
        expect(await db.getProcessingIssueRefs(entitlements, 'extract_failed')).toEqual([]);
        expect(await db.getProcessingIssueRefs(entitlements, 'file_unavailable', 1)).toHaveLength(1);
    });

    it('drops one attachment\'s processing dead letters but keeps untag intents and other attachments', async () => {
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            VALUES ('document_extract', 1, 'ABCDEFGH', 'pdf', 'structured', 0, 1, 3),
                   ('document_ocr', 1, 'ABCDEFGH', 'pdf', 'structured', 0, 2, 3),
                   ('fulltext_untag', 1, 'ABCDEFGH', 'pdf', 'structured', 0, 3, 3),
                   ('document_extract', 1, 'ZZZZZZZZ', 'pdf', 'structured', 0, 4, 3)`);
        await db.deleteBackgroundDeadLetters(1, 'ABCDEFGH');
        const remaining = await db.getBackgroundDeadLetters();
        expect(remaining.map((row) => `${row.zoteroKey}:${row.jobType}`).sort())
            .toEqual(['ABCDEFGH:fulltext_untag', 'ZZZZZZZZ:document_extract']);
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
                content_kind: 'pdf', maxPages: null,
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
