import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { SCHEMA_VERSION } from '@beaver/agent-core/extract/schema';
import { EMBEDDING_EXTRACT_PRIORITY } from '../../../src/services/backgroundProcessing/constants';
import { EMBEDDING_TEXT_VERSION } from '../../../src/services/documentExtraction/embeddingText';

const mocks = vi.hoisted(() => ({
    extractAndCacheDocument: vi.fn(),
    markDirty: vi.fn(),
    duringExtraction: null as null | (() => void),
    parentAbstract: '',
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: () => false }));
vi.mock('../../../src/utils/zoteroItemUtils', () => ({ safeIsInTrash: () => false }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    liveAttachmentContentKind: () => 'pdf',
}));
vi.mock('../../../src/services/documentExtraction/attachmentSource', () => ({
    resolveAttachmentFileSource: vi.fn(async () => ({
        kind: 'ok', source: { kind: 'local', filePath: '/tmp/paper.pdf', isRemoteOnly: false },
    })),
    loadAttachmentData: vi.fn(),
}));
vi.mock('../../../src/services/documentFileIdentity', () => ({
    getFileSignature: vi.fn(async () => ({ mtime_ms: 1, size_bytes: 2 })),
    getRemoteFileHash: vi.fn(),
    isRemoteFilePath: () => false,
}));
vi.mock('../../../src/services/documentExtraction/sourceObservation', () => ({
    observeAttachmentSource: vi.fn(async () => ({ identity: 'source-a' })),
}));
vi.mock('../../../src/services/documentExtraction/structuredDocumentHash', () => ({
    computeStructuredDocumentHash: vi.fn(async () => 'hash-a'),
}));
vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheDocument: mocks.extractAndCacheDocument,
    extractAndCacheEpubDocument: vi.fn(),
    extractAndCacheSnapshotDocument: vi.fn(),
}));
vi.mock('../../../src/services/ocr/enqueueOcr', () => ({ enqueueOcrJob: vi.fn(), maybeEnqueueOcrJob: vi.fn() }));

import { DocumentExtractExecutor } from '../../../src/services/backgroundQueue/documentExtractExecutor';
import { resolveAttachmentFileSource } from '../../../src/services/documentExtraction/attachmentSource';

const structuredResult = {
    schemaVersion: SCHEMA_VERSION,
    mode: 'structured',
    infoTitle: 'Neighborhood Conditions and Educational Outcomes',
    document: {
        pageCount: 1, bboxOrigin: 'top-left', bboxPrecision: 1, citationIndex: {},
        pages: [{
            index: 0, width: 600, height: 800, viewBox: [0, 0, 600, 800], rotation: 0,
            items: [{
                id: 't0.0', kind: 'text', pageIndex: 0, order: 0, bbox: [50, 200, 550, 300],
                text: ('This study examines how neighborhood conditions shape the educational outcomes of children '
                    + 'across several decades, drawing on longitudinal survey data and administrative records. ').repeat(3),
            }],
        }],
    },
};

describe('DocumentExtractExecutor derived embedding text', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        vi.clearAllMocks();
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        mocks.parentAbstract = '';
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn(async () => ({
                id: 7, libraryID: 1, key: 'PAPER001', parentID: 3,
                loadAllData: async () => undefined,
                isRegularItem: () => false,
                attachmentHash: Promise.resolve('a'.repeat(32)),
            })),
            getAsync: vi.fn(async (id: number) => id === 3 && {
                id: 3, libraryID: 1, key: 'PARENT01', deleted: false,
                loadDataType: async () => undefined,
                isRegularItem: () => true,
                getField: (field: string) => field === 'abstractNote' ? mocks.parentAbstract : '',
            }),
        };
        (globalThis as any).Zotero.Beaver = {
            db,
            libraryScopeInitialized: true,
            searchableLibraryIds: [1],
            background: { markEmbeddingDirty: mocks.markDirty },
        };
        mocks.extractAndCacheDocument.mockImplementation(async () => {
            mocks.duringExtraction?.();
            return { kind: 'ok', cached: true, result: structuredResult };
        });
    });

    afterEach(async () => {
        mocks.duringExtraction = null;
        await connection.closeDatabase();
        delete (globalThis as any).Zotero.Beaver;
    });

    async function runJob() {
        await connection.queryAsync('DELETE FROM background_jobs');
        await db.enqueueBackgroundJob({
            jobType: 'document_extract', libraryId: 1, itemId: 7, zoteroKey: 'PAPER001',
            contentKind: 'pdf', payloadKind: 'structured', priority: EMBEDDING_EXTRACT_PRIORITY,
            payload: { content_kind: 'pdf', maxPages: null, timeoutSeconds: 120 }, now: 0,
        });
        const record = await db.claimNextBackgroundJob(Date.now(), 60_000);
        return new DocumentExtractExecutor().execute(record!, {
            db: db as any,
            runOnMuPDFWorker: async (fn) => fn(),
            externalAbortSignal: new AbortController().signal,
            shouldSkipDbWrites: () => false,
            enqueue: async () => {},
        });
    }

    it('stores derived text for the extracted file and wakes the index', async () => {
        expect(await runJob()).toEqual({ kind: 'complete', reason: 'ok' });

        const row = (await db.getAttachmentEmbeddingTexts([{ libraryId: 1, zoteroKey: 'PAPER001' }]))
            .get('1/PAPER001');
        expect(row).toMatchObject({
            itemId: 7, contentKind: 'pdf', fileMtimeMs: 1, fileSizeBytes: 2, fileHash: 'a'.repeat(32),
            extractionSource: 'native', textVersion: EMBEDDING_TEXT_VERSION, bodySource: 'opening',
        });
        expect(row!.body).toContain('neighborhood conditions');
        // The PDF Info title comes with the extraction result; no second file read.
        expect(row).toMatchObject({ title: 'Neighborhood Conditions and Educational Outcomes', titleSource: 'pdf_metadata' });
        expect((globalThis as any).IOUtils.read).not.toHaveBeenCalled();
        expect(mocks.markDirty).toHaveBeenCalledWith([7]);
        expect(await db.getAttachmentProcessingState(1, 'PAPER001')).toMatchObject({ extractStatus: 'done' });
    });

    it('does not wake the index when a re-extraction yields the same text', async () => {
        await runJob();
        await db.clearAttachmentEmbeddingTextPending([7], Date.now() + 1);
        mocks.markDirty.mockClear();

        await runJob();

        expect(mocks.markDirty).not.toHaveBeenCalled();
        expect(await db.getPendingAttachmentEmbeddingTextIds([1])).toEqual([]);
    });

    it('stores text without waking the index when no unit can use it', async () => {
        mocks.parentAbstract = 'x'.repeat(400);

        await runJob();

        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual(['PAPER001']);
        expect(await db.getPendingAttachmentEmbeddingTextIds([1])).toEqual([]);
        expect(mocks.markDirty).not.toHaveBeenCalled();
    });

    it('wakes the index for a unit that already embeds this attachment\'s text', async () => {
        mocks.parentAbstract = 'x'.repeat(400);
        await db.upsertEmbedding({
            item_id: 12, library_id: 1, zotero_key: 'OTHER001', version: 1,
            client_date_modified: '2024-01-01 00:00:00', content_hash: 'h',
            embedding: new Uint8Array([1, 2, 3, 4]), dimensions: 4, model_id: 'test-model',
            source: 'attachment_text', source_attachment_id: 7,
        });

        await runJob();

        expect(mocks.markDirty).toHaveBeenCalledWith([7]);
    });

    it('never downloads a file that became remote-only with background processing off', async () => {
        vi.mocked(resolveAttachmentFileSource).mockResolvedValueOnce({
            kind: 'ok', source: { kind: 'remote', filePath: 'remote:h:abc', isRemoteOnly: true },
        } as any);
        expect(await runJob()).toEqual({ kind: 'complete', reason: 'remote_only' });
        expect(mocks.extractAndCacheDocument).not.toHaveBeenCalled();
        expect(await db.getAttachmentProcessingState(1, 'PAPER001')).toMatchObject({ extractStatus: null });
    });

    it('does not store text for a completion the ledger rejects as stale', async () => {
        mocks.duringExtraction = () => {
            // Another producer advances the ledger while this extraction runs.
            void db.markAttachmentExtractFailure({
                libraryId: 1, zoteroKey: 'PAPER001', status: 'failed', error: 'other', attemptedAt: 0,
            });
        };
        expect(await runJob()).toEqual({ kind: 'complete', reason: 'stale_completion_ignored' });
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual([]);
        expect(mocks.markDirty).not.toHaveBeenCalled();
    });

    it('does not store text for a library excluded during extraction', async () => {
        mocks.duringExtraction = () => { (globalThis as any).Zotero.Beaver.searchableLibraryIds = []; };
        await runJob();
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual([]);
        expect(mocks.markDirty).not.toHaveBeenCalled();
    });

    it('stores nothing for a scan without a text layer', async () => {
        mocks.extractAndCacheDocument.mockResolvedValue({
            kind: 'cached_error', code: 'no_text_layer', message: 'requires OCR', pageCount: 1,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'PAPER001' },
        });
        expect(await runJob()).toEqual({ kind: 'complete', reason: 'needs_ocr' });
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual([]);
    });

    it('drops text of an earlier file when the replacement has no text layer', async () => {
        const stored = {
            libraryId: 1, zoteroKey: 'PAPER001', itemId: 7, contentKind: 'pdf' as const,
            extractionSource: 'native' as const, textVersion: EMBEDDING_TEXT_VERSION, title: null,
            titleSource: null, keywords: null, body: 'Old text', bodySource: 'opening' as const,
        };
        mocks.extractAndCacheDocument.mockResolvedValue({
            kind: 'cached_error', code: 'no_text_layer', message: 'requires OCR', pageCount: 1,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'PAPER001' },
        });
        // Text of the same file stays (the scan verdict may be for a cached copy).
        const sameFile = { ...stored, fileMtimeMs: 1, fileSizeBytes: 2, fileHash: 'a'.repeat(32) };
        await db.upsertAttachmentEmbeddingText(sameFile);
        await runJob();
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual(['PAPER001']);
        expect(mocks.markDirty).not.toHaveBeenCalled();

        // Same content under a new signature (e.g. derived while remote-only) also stays.
        await db.upsertAttachmentEmbeddingText({ ...sameFile, fileMtimeMs: 0, fileSizeBytes: 0 });
        await runJob();
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual(['PAPER001']);

        await db.upsertAttachmentEmbeddingText({ ...sameFile, fileHash: 'b'.repeat(32) });
        await runJob();
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual([]);
        expect(mocks.markDirty).toHaveBeenCalledWith([7]);
    });

    it('keeps extraction successful when deriving the text fails', async () => {
        mocks.extractAndCacheDocument.mockResolvedValue({
            kind: 'ok', cached: true, result: { ...structuredResult, document: { ...structuredResult.document, pages: null } },
        });
        expect(await runJob()).toEqual({ kind: 'complete', reason: 'ok' });
        expect(await db.getAttachmentProcessingState(1, 'PAPER001')).toMatchObject({ extractStatus: 'done' });
    });
});
