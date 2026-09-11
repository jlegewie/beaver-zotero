import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { recordReadingOutcome } from '../../../src/services/documentExtraction/readingOutcome';

const entitled = { hasOcrAccess: true, hasSearchIndexAccess: true };
describe('reading outcomes shared by on-demand and background extraction', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;
    const item = { libraryID: 1, key: 'READTEST' };
    beforeEach(async () => {
        vi.clearAllMocks();
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        vi.stubGlobal('Zotero', { ...Zotero, Beaver: { db, searchableLibraryIds: [1], libraryScopeInitialized: true } });
    });
    afterEach(async () => {
        await connection.closeDatabase();
        vi.unstubAllGlobals();
    });
    it('lists a first on-demand failure with no background ledger, including pagination and retry targets', async () => {
        await recordReadingOutcome(item, 'pdf', { kind: 'response_error', code: 'file_missing' }, 100);
        expect(await db.getAttachmentProcessingState(1, item.key)).toBeNull();
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([{ reason: 'file_unavailable', count: 1 }]);
        expect(await db.getProcessingIssuePage(entitled, 'file_unavailable')).toEqual([
            { libraryId: 1, zoteroKey: item.key, error: 'file_missing', timestamp: 100 },
        ]);
        expect(await db.getProcessingIssueRefs(entitled, 'file_unavailable')).toEqual([{ libraryId: 1, zoteroKey: item.key }]);
    });
    it('successful reading clears an old reading failure and its dead letter but retains index failures', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: item.key, contentKind: 'pdf' });
        await connection.queryAsync(`UPDATE attachment_processing_state SET extract_status='failed', upsert_status='failed', last_error='file_missing'`);
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            VALUES ('document_extract', 1, 'READTEST', 'pdf', 'structured', 0, 1, 3)`);
        await recordReadingOutcome(item, 'pdf', { kind: 'ok' }, 200);
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([{ reason: 'index_failed', count: 1 }]);
        expect(await db.getProcessingIssueCounts({ ...entitled, hasSearchIndexAccess: false })).toEqual([]);
        expect((await db.getAttachmentProcessingState(1, item.key))?.upsertStatus).toBe('failed');
    });
    it('preserves completed OCR after access is lost, despite the original scan observation and dead letter', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: item.key, contentKind: 'pdf' });
        await connection.queryAsync(`UPDATE attachment_processing_state SET extract_status='done', ocr_status='needed', file_hash='source'`);
        await recordReadingOutcome(item, 'pdf', { kind: 'cached_error', code: 'no_text_layer' }, 100);
        const withoutOcr = { ...entitled, hasOcrAccess: false };
        expect(await db.getProcessingIssueCounts(withoutOcr)).toEqual([{ reason: 'scanned', count: 1 }]);
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            VALUES ('document_ocr', 1, 'READTEST', 'pdf', 'structured', 0, 1, 3)`);
        expect(await db.markAttachmentOcrDone({
            libraryId: 1, zoteroKey: item.key, fileHash: 'source', ocrEngineVersion: '1',
            structuredDocumentHash: 'ocr-result', expectedOcrStatus: 'needed',
            expectedOcrEngineVersion: null, expectedExtractStatus: 'done',
        })).toBe(true);
        for (const access of [withoutOcr, entitled, { ...withoutOcr, hasSearchIndexAccess: false }]) {
            expect(await db.getProcessingIssueCounts(access)).toEqual([]);
            expect(await db.getProcessingIssuePage(access, 'scanned')).toEqual([]);
            expect(await db.getProcessingIssueRefs(access, 'scanned')).toEqual([]);
        }
    });
    it('preserves an OCR failure when the reading observation still describes the original scan', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: item.key, contentKind: 'pdf' });
        await connection.queryAsync(`UPDATE attachment_processing_state SET extract_status='done', ocr_status='needed', file_hash='source'`);
        await recordReadingOutcome(item, 'pdf', { kind: 'cached_error', code: 'no_text_layer' }, 100);
        await db.markAttachmentOcrFailed(1, item.key, 'source', 'ocr_failed');
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([{ reason: 'ocr_failed', count: 1 }]);
        expect(await db.getProcessingIssueCounts({ ...entitled, hasOcrAccess: false })).toEqual([{ reason: 'ocr_failed', count: 1 }]);
    });
    it('an earlier slow failure cannot replace a later successful read', async () => {
        await recordReadingOutcome(item, 'pdf', { kind: 'ok' }, 200);
        await recordReadingOutcome(item, 'pdf', { kind: 'response_error', code: 'invalid_pdf' }, 100);
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([]);
    });
    it.each([100, 300])('orders terminal ledger failures by attempt time %s rather than completion time', async (attemptedAt) => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: item.key, contentKind: 'pdf' });
        await recordReadingOutcome(item, 'pdf', { kind: 'ok' }, 200);
        await db.markAttachmentExtractFailure({
            libraryId: 1, zoteroKey: item.key, status: 'failed', error: 'invalid_pdf', attemptedAt,
        });
        expect(await db.getProcessingIssueCounts(entitled)).toEqual(attemptedAt < 200
            ? [] : [{ reason: 'extract_failed', count: 1 }]);
    });
    it.each(['external_abort', 'timeout', 'worker_unavailable', 'invalid_format'])('does not turn %s into a reading problem', async (code) => {
        await recordReadingOutcome(item, 'pdf', { kind: code, code }, 100);
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([]);
    });
    it('preserves known problems through cache clearing and removes them on deletion and developer reset', async () => {
        await recordReadingOutcome(item, 'epub', { kind: 'response_error', code: 'extraction_failed' }, 100);
        await db.deleteAllDocumentCache();
        expect(await db.getProcessingIssueCounts(entitled)).toHaveLength(1);
        await db.deleteAttachmentProcessingState(1, item.key);
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([]);
        await recordReadingOutcome(item, 'epub', { kind: 'response_error', code: 'extraction_failed' }, 200);
        await db.resetLocalProcessingState();
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([]);
    });
    it('imports previously cached failures without overwriting a later successful observation', async () => {
        await connection.queryAsync(`INSERT INTO document_cache_metadata
            (item_id, library_id, zotero_key, content_kind, file_path, file_mtime_ms, file_size_bytes,
             source_size_bytes, content_type, document_metadata_json, error_code, extraction_schema_version, metadata_format_version)
             VALUES (1, 1, 'READTEST', 'pdf', '/test.pdf', 0, 0, 0, 'application/pdf', 'null', 'encrypted', '4', 1)`);
        await db.initDatabase('0.99.0');
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([{ reason: 'encrypted', count: 1 }]);
        await recordReadingOutcome(item, 'pdf', { kind: 'ok' }, Date.now());
        await db.initDatabase('0.99.0');
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([]);
    });
    it('does not use an old successful observation after the source identity changes', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: item.key, contentKind: 'pdf' });
        await recordReadingOutcome(item, 'pdf', { kind: 'ok' }, 100);
        await db.resetAttachmentExtraction(1, item.key, 'file_signature_changed');
        await db.markAttachmentExtractFailure({ attemptedAt: Date.now(), libraryId: 1, zoteroKey: item.key, status: 'failed', error: 'invalid_pdf' });
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([{ reason: 'extract_failed', count: 1 }]);
    });

    it('never records outcomes for excluded libraries', async () => {
        await recordReadingOutcome({ ...item, libraryID: 2 }, 'pdf', { kind: 'response_error', code: 'file_missing' }, 100);
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([]);
    });
    it('recognizes PDF OCR work independently of search access and treats empty EPUBs as reading problems', async () => {
        await recordReadingOutcome(item, 'pdf', { kind: 'cached_error', code: 'no_text_layer' }, 100);
        expect(await db.getProcessingIssueCounts({ ...entitled, hasSearchIndexAccess: false })).toEqual([]);
        expect(await db.getProcessingIssueCounts({ ...entitled, hasOcrAccess: false })).toEqual([{ reason: 'scanned', count: 1 }]);
        await recordReadingOutcome({ ...item, key: 'EPUBTEST' }, 'epub', { kind: 'response_error', code: 'no_text_layer' }, 100);
        expect(await db.getProcessingIssueCounts(entitled)).toEqual([{ reason: 'no_text', count: 1 }]);
    });
});
