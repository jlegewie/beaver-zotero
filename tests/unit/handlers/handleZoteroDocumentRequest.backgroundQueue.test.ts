import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    searchable: true,
    enqueueBackgroundJob: vi.fn(),
    notify: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    isLibrarySearchable: vi.fn(() => mocks.searchable),
    notifyRemoteDownloadFailure: vi.fn(),
    notifyRemoteFileNotSynced: vi.fn(),
    preflightZoteroAttachmentRequest: vi.fn((attachment: any) => ({
        ok: true,
        responseAttachment: attachment,
        requestKey: `${attachment.library_id}-${attachment.zotero_key}`,
        resolvedLibraryId: attachment.library_id,
    })),
    validateZoteroItemReference: vi.fn(() => null),
}));
vi.mock('../../../src/services/documentExtraction', () => ({
    extractTextDocument: vi.fn(),
    loadAttachmentData: vi.fn(),
    resolveAttachmentFileSource: vi.fn(),
    resolveToReadableAttachment: vi.fn(),
}));
vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheEpubDocument: vi.fn(),
    extractAndCacheResolvedPdfDocument: vi.fn(),
    extractAndCacheSnapshotDocument: vi.fn(),
}));
vi.mock('../../../src/services/externalFiles', () => ({
    EXTERNAL_LIBRARY_ID: -1,
    resolveExternalFile: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroSerializers', () => ({
    serializeAttachmentStub: vi.fn(() => ({ zotero_key: 'ABCD1234' })),
    serializeItemStub: vi.fn(),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: vi.fn(() => 'u'),
    modelObjectIdFromReference: vi.fn((ref: any) => `${ref.library_id}-${ref.zotero_key}`),
}));

import { handleZoteroDocumentRequest } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import { resolveToReadableAttachment } from '../../../src/services/documentExtraction';
import { extractAndCacheResolvedPdfDocument } from '../../../src/services/documentExtractionCore';

describe('handleZoteroDocumentRequest background queue', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.searchable = true;

        const resolvedItem = {
            id: 42,
            key: 'ABCD1234',
            libraryID: 1,
            isAttachment: vi.fn(() => false),
        };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue({
                loadAllData: vi.fn().mockResolvedValue(undefined),
            }),
        };
        (globalThis as any).Zotero.Beaver = {
            db: { enqueueBackgroundJob: mocks.enqueueBackgroundJob },
            backgroundExtractor: { notify: mocks.notify },
        };
        vi.mocked(resolveToReadableAttachment).mockResolvedValue({
            resolved: true,
            item: resolvedItem,
            key: '1-ABCD1234',
            contentKind: 'pdf',
            contentType: 'application/pdf',
        } as any);
        vi.mocked(extractAndCacheResolvedPdfDocument).mockResolvedValue({
            kind: 'timeout',
            phase: 'extract',
            timeoutSeconds: 2,
            pageCount: 10,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'ABCD1234' },
        });
    });

    it('does not enqueue or notify when the library was excluded during extraction', async () => {
        mocks.searchable = false;

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-excluded-timeout',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            mode: 'structured',
        });

        expect(response).toMatchObject({ error_code: 'timeout', content_kind: 'pdf' });
        expect(mocks.enqueueBackgroundJob).not.toHaveBeenCalled();
        expect(mocks.notify).not.toHaveBeenCalled();
    });

    it('still enqueues the timeout retry when the library is searchable', async () => {
        await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-searchable-timeout',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            mode: 'structured',
        });

        expect(mocks.enqueueBackgroundJob).toHaveBeenCalledWith(
            expect.objectContaining({
                jobType: 'document_timeout_retry',
                libraryId: 1,
                zoteroKey: 'ABCD1234',
            }),
        );
        expect(mocks.notify).toHaveBeenCalledOnce();
    });

    it('does not enqueue for hard-cap too_many_pages rejections', async () => {
        vi.mocked(extractAndCacheResolvedPdfDocument).mockResolvedValue({
            kind: 'response_error',
            code: 'too_many_pages',
            message: 'exceeds the 1500-page limit',
            pageCount: 2000,
            resolvedAttachment: { libraryId: 1, zoteroKey: 'ABCD1234' },
        });

        const response = await handleZoteroDocumentRequest({
            event: 'zotero_document_request',
            request_id: 'req-hard-cap',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            mode: 'structured',
        });

        expect(response).toMatchObject({ error_code: 'too_many_pages' });
        expect(mocks.enqueueBackgroundJob).not.toHaveBeenCalled();
    });
});
