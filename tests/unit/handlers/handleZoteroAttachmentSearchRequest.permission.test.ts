import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/beaver-extract', () => ({
    BeaverExtractor: class {
        async search() {
            return { pageCount: 1, totalMatches: 0, pagesWithMatches: 0, pages: [] };
        }
    },
    ExtractionErrorCode: { ENCRYPTED: 'encrypted', INVALID_PDF: 'invalid_pdf' },
    isWorkerDeadlineError: () => false,
}));
vi.mock('../../../src/beaver-extract/MuPDFWorkerClient', () => ({ isWorkerAbortError: () => false }));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));
vi.mock('../../../src/services/agentDataProvider/utils', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/agentDataProvider/utils')>(
        '../../../src/services/agentDataProvider/utils',
    );
    return {
        ...actual,
        validateZoteroItemReference: vi.fn(() => null),
        loadPdfData: vi.fn(async () => new Uint8Array([1, 2, 3])),
        checkRemotePdfSize: vi.fn(() => null),
        isRemoteAccessAvailable: vi.fn(() => false),
    };
});

import { handleZoteroAttachmentSearchRequest } from '../../../src/services/agentDataProvider/handleZoteroAttachmentSearchRequest';
import { loadPdfData } from '../../../src/services/agentDataProvider/utils';

const denied = () => Object.assign(new Error('Could not open /Dropbox/paper.pdf'), { name: 'NotAllowedError' });

function setupZoteroEnv() {
    const item = {
        id: 42,
        key: 'ABCD1234',
        libraryID: 1,
        attachmentContentType: 'application/pdf',
        isAttachment: () => true,
        getFilePathAsync: vi.fn().mockResolvedValue('/Dropbox/paper.pdf'),
        fileExists: vi.fn().mockResolvedValue(true),
    };
    (globalThis as any).Zotero.Items = { getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(item) };
    (globalThis as any).Zotero.Attachments = {
        ...(globalThis as any).Zotero.Attachments,
        getTotalFileSize: vi.fn().mockResolvedValue(1024),
    };
    (globalThis as any).Zotero.Beaver = { data: { env: 'test' }, documentCache: { getMetadata: vi.fn().mockResolvedValue(null) } };
}

describe('handleZoteroAttachmentSearchRequest local access denial', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupZoteroEnv();
    });

    it.each([
        ['stat', () => { (globalThis as any).Zotero.Attachments.getTotalFileSize = vi.fn().mockRejectedValue(denied()); }],
        ['read', () => { vi.mocked(loadPdfData).mockRejectedValueOnce(denied()); }],
    ])('maps a local file the OS refuses to %s to file_permission_denied', async (_label, deny) => {
        deny();

        const response = await handleZoteroAttachmentSearchRequest({
            event: 'zotero_attachment_search_request',
            request_id: 'req-denied',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            query: 'needle',
        } as any);

        expect(response.error_code).toBe('file_permission_denied');
        expect(response.error).toContain('does not have permission to read the PDF file for 1-ABCD1234');
    });
});
