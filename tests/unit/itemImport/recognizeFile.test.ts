import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    isApiAvailable: vi.fn(),
    getPdfRecognizerData: vi.fn(),
    queryRecognizerService: vi.fn(),
    loadEpubModule: vi.fn(),
    resolveExternalFile: vi.fn(),
}));

vi.mock('../../../src/services/itemImport/zoteroApis', () => ({
    isApiAvailable: mocks.isApiAvailable,
    getPdfRecognizerData: mocks.getPdfRecognizerData,
    queryRecognizerService: mocks.queryRecognizerService,
    loadEpubModule: mocks.loadEpubModule,
    looksLikeApiDrift: (error: any) => error instanceof TypeError && /is not a function/.test(error.message),
    markApiUnavailable: vi.fn(),
    withTimeout: <T>(work: Promise<T>) => work,
}));
vi.mock('../../../src/services/externalFiles', () => ({ resolveExternalFile: mocks.resolveExternalFile }));

import { locateImportFile, recognizeFile, type LocatedFile } from '../../../src/services/itemImport/recognizeFile';

const pdf: LocatedFile = {
    path: '/files/paper.pdf',
    filename: 'paper.pdf',
    mimeType: 'application/pdf',
    size: 10,
    ref: { ext_key: 'ABCD1234' },
};

const word = (text: string) => [1, 2, 3, 4, 10, 0, 0, 0, 0, 0, 0, 0, 0, text];

beforeEach(() => {
    vi.clearAllMocks();
    mocks.isApiAvailable.mockReturnValue(true);
    (globalThis as any).IOUtils.read = vi.fn(async () => new Uint8Array([37, 80, 68, 70]));
});

describe('recognizeFile (PDF)', () => {
    it('reports no_text when the pages carry only empty text blocks', async () => {
        mocks.getPdfRecognizerData.mockResolvedValue({ pages: [[612, 792, [[[[0, 0, 0, 0, []]]]]]] });
        const result = await recognizeFile(pdf, 10_000);
        expect(result).toMatchObject({ kind: 'error', code: 'no_text' });
        expect(mocks.queryRecognizerService).not.toHaveBeenCalled();
    });

    it('returns identifiers in Zotero order (arXiv, DOI, ISBN) with the recognizer hints', async () => {
        mocks.getPdfRecognizerData.mockResolvedValue({ pages: [[612, 792, [[[[0, 0, 0, 0, [[word('Title')]]]]]]]] });
        mocks.queryRecognizerService.mockResolvedValue({
            doi: '10.1/x', arxiv: '2106.09685', isbn: '9780262046824', abstract: 'An abstract', language: 'en',
            title: 'Fallback Title', authors: [{ firstName: 'A', lastName: 'B' }],
        });
        const result = await recognizeFile(pdf, 10_000);
        expect(result.kind).toBe('identifiers');
        if (result.kind !== 'identifiers') return;
        expect(result.identifiers.map((identifier) => identifier.type)).toEqual(['arxiv', 'doi', 'isbn']);
        expect(result.hints).toEqual({ abstract: 'An abstract', language: 'en' });
        expect(result.titleItem).toMatchObject({ itemType: 'journalArticle', title: 'Fallback Title' });
    });

    it('builds a minimal item from a recognized title without identifiers', async () => {
        mocks.getPdfRecognizerData.mockResolvedValue({ pages: [[612, 792, [[word('x')]]]] });
        mocks.queryRecognizerService.mockResolvedValue({ title: 'A Chapter', type: 'book-chapter', authors: [], container: 'The Book' });
        const result = await recognizeFile(pdf, 10_000);
        expect(result).toMatchObject({ kind: 'item', json: { itemType: 'bookSection', title: 'A Chapter', bookTitle: 'The Book' } });
    });

    it('fails as unrecognized when the service finds nothing', async () => {
        mocks.getPdfRecognizerData.mockResolvedValue({ pages: [[612, 792, [[word('x')]]]] });
        mocks.queryRecognizerService.mockResolvedValue({});
        expect(await recognizeFile(pdf, 10_000)).toMatchObject({ kind: 'error', code: 'unrecognized_file' });
    });

    it('defers recognition when the internal APIs are unavailable', async () => {
        mocks.isApiAvailable.mockImplementation((name: string) => name !== 'pdfRecognizerData');
        expect(await recognizeFile(pdf, 10_000)).toMatchObject({ kind: 'deferred' });
        expect(mocks.getPdfRecognizerData).not.toHaveBeenCalled();
    });

    it('defers when the worker call fails like API drift', async () => {
        mocks.getPdfRecognizerData.mockRejectedValue(new TypeError('worker._query is not a function'));
        expect(await recognizeFile(pdf, 10_000)).toMatchObject({ kind: 'deferred' });
    });
});

describe('recognizeFile (other types)', () => {
    it('rejects files that are neither PDF nor EPUB', async () => {
        const result = await recognizeFile({ ...pdf, filename: 'notes.txt', mimeType: 'text/plain' }, 10_000);
        expect(result).toMatchObject({ kind: 'error', code: 'unsupported_type' });
    });

    it('defers EPUB recognition when the EPUB module is unavailable', async () => {
        mocks.loadEpubModule.mockReturnValue(null);
        const result = await recognizeFile({ ...pdf, filename: 'book.epub', mimeType: 'application/epub+zip' }, 10_000);
        expect(result).toMatchObject({ kind: 'deferred' });
    });
});

describe('locateImportFile', () => {
    it('reports a missing external file copy', async () => {
        mocks.resolveExternalFile.mockResolvedValue({ ok: false, record: { filename: 'x.pdf' } });
        expect(await locateImportFile({ ext_key: 'ABCD1234' })).toMatchObject({ ok: false, code: 'file_not_found' });
    });

    it('fills filename, mime type and size from the external file record', async () => {
        mocks.resolveExternalFile.mockResolvedValue({
            ok: true,
            record: { storedPath: '/store/x.pdf', filename: 'x.pdf', mimeType: 'application/pdf', fileSize: 42, mtimeMs: 1 },
        });
        const result = await locateImportFile({ ext_key: 'ABCD1234' });
        expect(result).toMatchObject({
            ok: true,
            file: { path: '/store/x.pdf', ref: { ext_key: 'ABCD1234', filename: 'x.pdf', size: 42, mode: 'import' } },
        });
    });
});

describe('locateImportFile link mode', () => {
    it('always copies an attached file, even when link mode was asked for', async () => {
        mocks.resolveExternalFile.mockResolvedValue({
            ok: true,
            record: { storedPath: '/store/x.pdf', filename: 'x.pdf', mimeType: 'application/pdf', fileSize: 42, mtimeMs: 1 },
        });
        const result = await locateImportFile({ ext_key: 'ABCD1234', mode: 'link' });
        expect(result).toMatchObject({ ok: true, file: { ref: { mode: 'import' } } });
    });
});
