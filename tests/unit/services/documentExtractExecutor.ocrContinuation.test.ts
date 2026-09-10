import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { OCR_PRIORITY_BACKFILL, OCR_PRIORITY_ON_DEMAND } from '../../../src/services/ocr/constants';

const mocks = vi.hoisted(() => ({
    extractAndCacheDocument: vi.fn(),
    enqueueOcrJob: vi.fn(async () => undefined),
    ocrTicketedWhileInFlight: null as boolean | null,
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => key === 'backgroundProcessingEnabled',
}));
vi.mock('../../../src/utils/zoteroItemUtils', () => ({ safeIsInTrash: () => false }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    liveAttachmentContentKind: () => 'pdf',
}));
vi.mock('../../../src/services/documentExtraction/attachmentSource', () => ({
    resolveAttachmentFileSource: vi.fn(async () => ({
        kind: 'ok', source: { kind: 'local', filePath: '/tmp/scan.pdf', isRemoteOnly: false },
    })),
    loadAttachmentData: vi.fn(),
}));
vi.mock('../../../src/services/documentFileIdentity', () => ({
    getFileSignature: vi.fn(async () => ({ mtime_ms: 1, size_bytes: 2 })),
}));
vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheDocument: mocks.extractAndCacheDocument,
    extractAndCacheEpubDocument: vi.fn(),
    extractAndCacheSnapshotDocument: vi.fn(),
}));
vi.mock('../../../src/services/ocr/enqueueOcr', () => ({
    enqueueOcrJob: mocks.enqueueOcrJob,
    maybeEnqueueOcrJob: vi.fn(),
}));

import { DocumentExtractExecutor } from '../../../src/services/backgroundQueue/documentExtractExecutor';

/**
 * The ledger path of the extract executor must ticket OCR itself when the
 * extraction verdict is "no text layer": a cached verdict never reaches the
 * fire-and-forget enqueue inside extraction, and a ticket that only lands
 * after the job retires can miss an immediate-drain request.
 */
describe('DocumentExtractExecutor OCR continuation', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        vi.clearAllMocks();
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn(async () => ({
                id: 7,
                libraryID: 1,
                key: 'SCANNED1',
                loadAllData: async () => undefined,
                isRegularItem: () => false,
                attachmentHash: Promise.resolve('a'.repeat(32)),
            })),
        };
        (globalThis as any).Zotero.Beaver = {
            db,
            libraryScopeInitialized: true,
            searchableLibraryIds: [1],
            hasOcrAccess: true,
        };
        mocks.extractAndCacheDocument.mockResolvedValue({
            kind: 'cached_error',
            code: 'no_text_layer',
            message: 'requires OCR',
            pageCount: 5,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'SCANNED1' },
        });
    });

    afterEach(async () => {
        await connection.closeDatabase();
        delete (globalThis as any).Zotero.Beaver;
    });

    async function runExtractJob(priority: number) {
        await db.enqueueBackgroundJob({
            jobType: 'document_extract', libraryId: 1, itemId: 7, zoteroKey: 'SCANNED1',
            contentKind: 'pdf', payloadKind: 'structured', priority,
            payload: { content_kind: 'pdf', maxPages: 200, timeoutSeconds: 120 }, now: 0,
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

    it('tickets backfill OCR before a background job with a cached no_text_layer verdict retires', async () => {
        const outcome = await runExtractJob(100);

        expect(outcome).toEqual({ kind: 'complete', reason: 'needs_ocr' });
        expect(await db.getAttachmentProcessingState(1, 'SCANNED1')).toMatchObject({
            extractStatus: 'done', ocrStatus: 'needed',
        });
        expect(mocks.enqueueOcrJob).toHaveBeenCalledOnce();
        expect(mocks.enqueueOcrJob).toHaveBeenCalledWith(expect.objectContaining({
            libraryId: 1, zoteroKey: 'SCANNED1', itemId: 7, priority: OCR_PRIORITY_BACKFILL,
        }));
    });

    it('lets an on-demand job keep the default OCR priority', async () => {
        await runExtractJob(10);

        const args = mocks.enqueueOcrJob.mock.calls[0]?.[0] as { priority?: number } | undefined;
        expect(args).toBeDefined();
        expect(args!.priority ?? OCR_PRIORITY_ON_DEMAND).toBe(OCR_PRIORITY_ON_DEMAND);
    });

    it('does not ticket OCR when extraction found a text layer', async () => {
        mocks.extractAndCacheDocument.mockResolvedValue({
            kind: 'ok', cached: false, totalPages: 1, contentType: 'application/pdf',
            result: { mode: 'structured', document: { pageCount: 1, pages: [] } },
            resolvedAttachment: { libraryId: 1, zoteroKey: 'SCANNED1' },
        });

        expect((await runExtractJob(100)).kind).toBe('complete');
        expect(mocks.enqueueOcrJob).not.toHaveBeenCalled();
    });

    it('still retires the job when the OCR enqueue throws', async () => {
        mocks.enqueueOcrJob.mockRejectedValueOnce(new Error('queue unavailable'));

        expect(await runExtractJob(100)).toEqual({ kind: 'complete', reason: 'needs_ocr' });
        expect(await db.getAttachmentProcessingState(1, 'SCANNED1')).toMatchObject({ ocrStatus: 'needed' });
    });
});
