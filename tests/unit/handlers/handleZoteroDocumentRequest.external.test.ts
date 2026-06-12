import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

// Transitive webpack-context imports pulled in via documentExtraction utils.
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));

vi.mock('../../../src/services/externalFiles', () => ({
    EXTERNAL_LIBRARY_ID: -1,
    resolveExternalFile: vi.fn(),
}));

vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheEpubDocument: vi.fn(),
    extractAndCacheResolvedPdfDocument: vi.fn(),
}));

import { handleZoteroDocumentRequest } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import { resolveExternalFile } from '../../../src/services/externalFiles';
import {
    extractAndCacheEpubDocument,
    extractAndCacheResolvedPdfDocument,
} from '../../../src/services/documentExtractionCore';
import type { WSZoteroDocumentRequest } from '../../../src/services/agentProtocol';

const EXT_KEY = 'AB12CD34';

const baseRecord = {
    extKey: EXT_KEY,
    filename: 'paper.pdf',
    originalPath: '/home/user/paper.pdf',
    storedPath: '/mock/data/beaver/external-files/AB12CD34.pdf',
    contentKind: 'pdf' as const,
    mimeType: 'application/pdf',
    fileSize: 1024,
    mtimeMs: 1718000000000,
    pageCount: 12,
    createdAt: '2026-06-01T00:00:00.000Z',
};

function baseRequest(overrides: Partial<WSZoteroDocumentRequest> = {}): WSZoteroDocumentRequest {
    return {
        event: 'zotero_document_request',
        request_id: 'req-1',
        external_file_key: EXT_KEY,
        mode: 'markdown',
        ...overrides,
    } as WSZoteroDocumentRequest;
}

describe('handleZoteroDocumentRequest (external files)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Beaver = undefined;
    });

    it('returns the different-computer file_missing error when the registry has no row', async () => {
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: false, record: null });

        const response = await handleZoteroDocumentRequest(baseRequest());

        expect(response.error_code).toBe('file_missing');
        expect(response.error).toContain('not available on this device');
        expect(response.error).toContain('different computer');
        expect(response.external_file_key).toBe(EXT_KEY);
    });

    it('names the file when the copy is gone from disk', async () => {
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: false, record: baseRecord });

        const response = await handleZoteroDocumentRequest(baseRequest());

        expect(response.error_code).toBe('file_missing');
        expect(response.error).toContain("'paper.pdf'");
    });

    it('reads text files directly from the managed copy', async () => {
        const record = {
            ...baseRecord,
            filename: 'notes.txt',
            contentKind: 'text' as const,
            mimeType: 'text/plain',
            storedPath: '/mock/data/beaver/external-files/AB12CD34.txt',
        };
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record });
        (globalThis as any).IOUtils.read = vi.fn().mockResolvedValue(
            new TextEncoder().encode('alpha\nbeta\n'),
        );

        const response = await handleZoteroDocumentRequest(baseRequest());

        expect(response.error).toBeUndefined();
        expect(response.external_file_key).toBe(EXT_KEY);
        expect(response.resolved_attachment).toBeUndefined();
        expect(response.content_kind).toBe('text');
        expect(response.result).toBeTruthy();
    });

    it('rejects image files with unsupported_type pointing at the view tool', async () => {
        const record = {
            ...baseRecord,
            filename: 'figure.png',
            contentKind: 'image' as const,
            mimeType: 'image/png',
        };
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record });

        const response = await handleZoteroDocumentRequest(baseRequest());

        expect(response.error_code).toBe('unsupported_type');
        expect(response.error).toContain('view tool');
    });

    it('routes PDFs through the extraction core with an external source', async () => {
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record: baseRecord });
        vi.mocked(extractAndCacheResolvedPdfDocument).mockResolvedValue({
            kind: 'ok',
            cached: false,
            result: { mode: 'markdown', schema_version: 'x', document: { pageCount: 12, pages: [] } } as any,
            totalPages: 12,
            resolvedAttachment: { libraryId: -1, zoteroKey: EXT_KEY },
            contentType: 'application/pdf',
        });

        const response = await handleZoteroDocumentRequest(baseRequest());

        expect(response.error).toBeUndefined();
        expect(response.external_file_key).toBe(EXT_KEY);
        const args = vi.mocked(extractAndCacheResolvedPdfDocument).mock.calls[0][0];
        expect(args.source).toEqual({
            kind: 'external',
            filePath: baseRecord.storedPath,
            itemRef: { id: 0, libraryID: -1, key: EXT_KEY },
        });
        expect(args.resolvedKey).toBe(`ext-${EXT_KEY}`);
    });

    it('routes EPUBs through the EPUB extraction core', async () => {
        const record = {
            ...baseRecord,
            filename: 'book.epub',
            contentKind: 'epub' as const,
            mimeType: 'application/epub+zip',
        };
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record });
        vi.mocked(extractAndCacheEpubDocument).mockResolvedValue({
            kind: 'ok',
            cached: true,
            document: { kind: 'epub-document', sections: [], diagnostics: { extractedTextChars: 10 } } as any,
            resolvedAttachment: { libraryId: -1, zoteroKey: EXT_KEY },
            contentType: 'application/epub+zip',
        });

        const response = await handleZoteroDocumentRequest(baseRequest());

        expect(response.error).toBeUndefined();
        expect(response.content_kind).toBe('epub');
        const args = vi.mocked(extractAndCacheEpubDocument).mock.calls[0][0];
        expect(args.source).toEqual({
            kind: 'external',
            filePath: record.storedPath,
            itemRef: { id: 0, libraryID: -1, key: EXT_KEY },
        });
    });

    it('maps a core file_missing error to the different-computer message', async () => {
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record: baseRecord });
        vi.mocked(extractAndCacheResolvedPdfDocument).mockResolvedValue({
            kind: 'response_error',
            code: 'file_missing',
            message: 'The PDF file for ext-AB12CD34 is not available on this device.',
            pageCount: null,
            resolvedAttachment: { libraryId: -1, zoteroKey: EXT_KEY },
        });

        const response = await handleZoteroDocumentRequest(baseRequest());

        expect(response.error_code).toBe('file_missing');
        expect(response.error).toContain('different computer');
    });

    it('rejects requests with neither attachment nor external file key', async () => {
        const response = await handleZoteroDocumentRequest(
            baseRequest({ external_file_key: undefined }),
        );
        expect(response.error_code).toBe('invalid_format');
    });
});
