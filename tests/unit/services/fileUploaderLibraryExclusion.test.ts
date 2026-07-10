import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    reportFileUploadFailed: vi.fn(),
}));

vi.mock('../../../react/utils/pdfUtils', () => ({
    getPDFPageCount: vi.fn(),
    getPDFPageCountFromData: vi.fn(),
}));
vi.mock('../../../react/atoms/auth', () => ({
    isAuthenticatedAtom: Symbol('isAuthenticatedAtom'),
    userAtom: Symbol('userAtom'),
    userIdAtom: Symbol('userIdAtom'),
}));
vi.mock('../../../react/atoms/sync', () => ({
    isFileUploaderRunningAtom: Symbol('isFileUploaderRunningAtom'),
    isFileUploaderFailedAtom: Symbol('isFileUploaderFailedAtom'),
    fileUploaderBackoffUntilAtom: Symbol('fileUploaderBackoffUntilAtom'),
}));
vi.mock('../../../react/atoms/profile', () => ({
    hasCompletedOnboardingAtom: Symbol('hasCompletedOnboardingAtom'),
    planFeaturesAtom: Symbol('planFeaturesAtom'),
}));
vi.mock('../../../react/atoms/ui', () => ({
    showFileStatusDetailsAtom: Symbol('showFileStatusDetailsAtom'),
    zoteroServerCredentialsErrorAtom: Symbol('zoteroServerCredentialsErrorAtom'),
    zoteroServerDownloadErrorAtom: Symbol('zoteroServerDownloadErrorAtom'),
}));
vi.mock('../../../react/store', () => ({
    store: {
        get: vi.fn((atom: symbol) => atom.description === 'userIdAtom' ? 'user-1' : false),
        set: vi.fn(),
    },
}));
vi.mock('../../../src/services/attachmentsService', () => ({
    attachmentsService: {
        reportFileUploadFailed: mocks.reportFileUploadFailed,
    },
}));
vi.mock('../../../src/services/supabaseClient', () => ({ supabase: {} }));
vi.mock('../../../react/utils/popupMessageUtils', () => ({
    addOrUpdateFailedUploadMessageAtom: Symbol('addOrUpdateFailedUploadMessageAtom'),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getMimeType: vi.fn(),
    getMimeTypeFromData: vi.fn(),
    safeFileExists: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(),
    getAttachmentDataInMemory: vi.fn(),
}));
vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

describe('FileUploader library exclusions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero = {
            ...(globalThis as any).Zotero,
            __beaverShuttingDown: false,
            __beaverGetSearchableLibraryIds: vi.fn(() => []),
            Items: {
                getByLibraryAndKeyAsync: vi.fn(),
            },
            logError: vi.fn(),
        };
    });

    it('rejects a queued upload before looking up or reading the attachment', async () => {
        const { FileUploader } = await import('../../../src/services/FileUploader');
        const uploader = new FileUploader();
        const item = {
            library_id: 1,
            zotero_key: 'AAAAAAAA',
            file_hash: 'hash-1',
            storage_path: 'path',
            signed_upload_url: 'https://example.invalid/upload',
            mime_type: 'application/pdf',
        };

        await (uploader as any).uploadFile(item, 'user-1');

        expect((Zotero as any).Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        expect(IOUtils.read).not.toHaveBeenCalled();
        expect(mocks.reportFileUploadFailed).toHaveBeenCalledWith(
            'hash-1',
            'failed_user',
            'attachment_not_found',
            expect.stringContaining('Library excluded from Beaver'),
        );
    });
});
