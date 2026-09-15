import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ extract: vi.fn(), put: vi.fn() }));
vi.mock('../../../src/beaver-extract', () => ({
    getMuPDFWorkerClient: () => ({ extract: mocks.extract }),
    ExtractionErrorCode: { NO_TEXT_LAYER: 'NO_TEXT_LAYER' },
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/documentExtractionCore', () => ({
    buildExtractedDocumentCacheMetadata: (result: any) => ({
        pageCount: result.document.pageCount, pages: result.document.pages,
    }),
}));
import { extractPdfBytesAndCacheAsOriginalAttachment } from '../../../src/services/documentExtraction/ocrReextract';

const original = { viewBox: [10, 20, 610, 820], width: 600, height: 800, rotation: 90 };
const identity = { sourcePath: '/original.pdf', sourceMtimeMs: 123, sourceSizeBytes: 456 };
const args = { item: { libraryID: 1, key: 'ORIGINAL', attachmentContentType: 'application/pdf' } as any,
    filePath: '/original.pdf', ocrBytes: new Uint8Array([1, 2, 3]), expectedPageCount: 1 };
const result = (page = original) => ({ document: { pageCount: 1, pages: [page] } });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.extract.mockResolvedValue(result());
    mocks.put.mockResolvedValue(undefined);
    vi.stubGlobal('Zotero', { Beaver: { documentCache: {
        getSourceIdentitySnapshot: vi.fn(async () => identity),
        getMetadata: vi.fn(async () => ({ pages: [original] })),
        putResult: mocks.put,
    } } });
});
afterEach(() => vi.unstubAllGlobals());

describe('OCR artifact validation and publication', () => {
    it('caches both validated modes as protected OCR under the original source identity', async () => {
        expect(await extractPdfBytesAndCacheAsOriginalAttachment(args)).toEqual({ kind: 'ok', pageCount: 1 });
        expect(mocks.extract).toHaveBeenCalledTimes(2);
        expect(mocks.put).toHaveBeenCalledTimes(2);
        for (const [input] of mocks.put.mock.calls) {
            expect(input).toMatchObject({ filePath: '/original.pdf', expectedSourceIdentity: identity,
                metadata: { extractionSource: 'ocr' } });
        }
        expect(mocks.put.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.extract.mock.invocationCallOrder[1]);
        expect(mocks.put.mock.calls.map(([input]) => input.mode)).toEqual(['structured', 'markdown']);
    });

    it.each([
        { ...original, viewBox: [0, 0, 600, 800] },
        { ...original, rotation: 0 },
        { ...original, width: 620 },
        { ...original, height: 820 },
    ])('rejects citation geometry divergence before cache publication: %j', async (page) => {
        mocks.extract.mockResolvedValue(result(page));
        expect(await extractPdfBytesAndCacheAsOriginalAttachment(args)).toMatchObject({ kind: 'geometry_mismatch' });
        expect(mocks.put).not.toHaveBeenCalled();
    });

    it('rejects changed page count', async () => {
        mocks.extract.mockResolvedValue({ document: { pageCount: 2, pages: [original, original] } });
        expect(await extractPdfBytesAndCacheAsOriginalAttachment(args)).toMatchObject({ kind: 'geometry_mismatch' });
        expect(mocks.put).not.toHaveBeenCalled();
    });

    it('does not publish structured text when the secondary extraction fails', async () => {
        mocks.extract.mockResolvedValueOnce(result()).mockRejectedValueOnce(new Error('secondary failure'));
        expect(await extractPdfBytesAndCacheAsOriginalAttachment(args)).toMatchObject({ kind: 'error' });
        expect(mocks.put).not.toHaveBeenCalled();
    });

    it('does not publish either mode when secondary geometry is invalid', async () => {
        mocks.extract.mockResolvedValueOnce(result()).mockResolvedValueOnce(result({ ...original, rotation: 0 }));
        expect(await extractPdfBytesAndCacheAsOriginalAttachment(args)).toMatchObject({ kind: 'geometry_mismatch' });
        expect(mocks.put).not.toHaveBeenCalled();
    });

    it('aborts without publishing', async () => {
        const controller = new AbortController();
        mocks.extract.mockImplementationOnce(async () => { controller.abort(); return result(); });
        expect(await extractPdfBytesAndCacheAsOriginalAttachment({ ...args, abortSignal: controller.signal }))
            .toEqual({ kind: 'aborted' });
        expect(mocks.put).not.toHaveBeenCalled();
    });
});
