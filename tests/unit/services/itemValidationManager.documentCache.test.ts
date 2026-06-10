import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/utils/sourceUtils', () => ({
    isValidZoteroItem: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../react/store', () => ({
    store: {
        get: vi.fn((atom: unknown) => {
            if (atom === 'searchableLibraryIdsAtom') return [1];
            if (atom === 'selectedModelAtom') return { supports_vision: false };
            return undefined;
        }),
    },
}));

vi.mock('../../../react/atoms/profile', () => ({
    planFeaturesAtom: 'planFeaturesAtom',
    searchableLibraryIdsAtom: 'searchableLibraryIdsAtom',
}));

vi.mock('../../../react/atoms/models', () => ({
    selectedModelAtom: 'selectedModelAtom',
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn((key: string) => {
        if (key === 'maxFileSizeMB') return 50;
        if (key === 'requestPlusTools') return false;
        return undefined;
    }),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeFileExists: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/services/attachmentsService', () => ({
    attachmentsService: {
        validateAttachment: vi.fn(),
    },
}));

vi.mock('../../../src/services/itemsService', () => ({
    itemsService: {},
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    isRemoteAccessAvailable: vi.fn().mockReturnValue(true),
}));

const { extractorMethods, BeaverExtractorMock } = vi.hoisted(() => {
    const methods = {
        getPageCount: vi.fn().mockResolvedValue(3),
        analyzeOCRNeeds: vi.fn().mockResolvedValue({ needsOCR: false }),
    };
    return {
        extractorMethods: methods,
        BeaverExtractorMock: vi.fn(() => methods),
    };
});

vi.mock('../../../src/beaver-extract', () => ({
    BeaverExtractor: BeaverExtractorMock,
    ExtractionError: class ExtractionError extends Error {
        code: string;
        constructor(code: string, message: string) {
            super(message);
            this.code = code;
        }
    },
    ExtractionErrorCode: {
        ENCRYPTED: 'encrypted',
        INVALID_PDF: 'invalid_pdf',
        EMPTY_DOCUMENT: 'empty_document',
        WASM_ERROR: 'wasm_error',
    },
}));

import { itemValidationManager, ItemValidationType } from '../../../src/services/itemValidationManager';
import { HARD_ATTACHMENT_LIMITS } from '../../../src/services/attachmentLimits';

const MAX_PAGE_COUNT = HARD_ATTACHMENT_LIMITS.maxPageCount;

function makeAttachment(options: { contentType?: string } = {}): Zotero.Item {
    const contentType = options.contentType ?? 'application/pdf';
    return {
        id: 10,
        libraryID: 1,
        key: '2YWA8DTZ',
        attachmentContentType: contentType,
        attachmentHash: Promise.resolve('hash'),
        isAttachment: () => true,
        isRegularItem: () => false,
        isAnnotation: () => false,
        isNote: () => false,
        isInTrash: () => false,
        isPDFAttachment: () => contentType === 'application/pdf',
        getFilePathAsync: vi.fn().mockResolvedValue('/tmp/test.pdf'),
    } as unknown as Zotero.Item;
}

function makeMetadata(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        itemId: 10,
        libraryId: 1,
        zoteroKey: '2YWA8DTZ',
        contentKind: 'pdf',
        filePath: '/tmp/test.pdf',
        fileSignature: { mtime_ms: 1, size_bytes: 1024 },
        sourceSizeBytes: 1024,
        contentType: 'application/pdf',
        documentMetadata: null,
        pageCount: 3,
        pageLabels: null,
        pages: null,
        errorCode: null,
        extractionSchemaVersion: 'test',
        metadataFormatVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: null,
        ...overrides,
    };
}

function makeEpubMetadata(overrides: Record<string, unknown> = {}) {
    return makeMetadata({
        contentKind: 'epub',
        contentType: 'application/epub+zip',
        pageCount: null,
        documentMetadata: { content_kind: 'epub', sectionCount: 12, sections: [] },
        ...overrides,
    });
}

describe('ItemValidationManager document-cache frontend validation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        itemValidationManager.clearCache();
        (globalThis as any).Zotero.Libraries.get = vi.fn(() => ({ name: 'Library' }));
        (globalThis as any).Zotero.Attachments = {
            getTotalFileSize: vi.fn().mockResolvedValue(1024),
        };
        (globalThis as any).IOUtils.read = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
    });

    it('uses successful document-cache metadata before dispatching to MuPDF', async () => {
        const documentCache = {
            getMetadata: vi.fn().mockResolvedValue(makeMetadata()),
        };
        (globalThis as any).Zotero.Beaver = { documentCache };

        const result = await itemValidationManager.validateItem(makeAttachment(), {
            validationType: ItemValidationType.FRONTEND,
            forceRefresh: true,
        });

        expect(result).toEqual({ isValid: true, reason: undefined, backendChecked: false });
        expect(documentCache.getMetadata).toHaveBeenCalledWith(
            { libraryId: 1, zoteroKey: '2YWA8DTZ' },
            '/tmp/test.pdf',
        );
        expect((globalThis as any).IOUtils.read).not.toHaveBeenCalled();
        expect(BeaverExtractorMock).not.toHaveBeenCalled();
    });

    it('uses cached no-text-layer metadata as a validation failure when OCR is unavailable', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn().mockResolvedValue(makeMetadata({ errorCode: 'no_text_layer' })),
            },
        };

        const result = await itemValidationManager.validateItem(makeAttachment(), {
            validationType: ItemValidationType.FRONTEND,
            forceRefresh: true,
        });

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('PDF requires OCR');
        expect((globalThis as any).IOUtils.read).not.toHaveBeenCalled();
        expect(BeaverExtractorMock).not.toHaveBeenCalled();
    });

    it('rejects cached metadata over the hard page-count cap before dispatching to MuPDF', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn().mockResolvedValue(makeMetadata({ pageCount: MAX_PAGE_COUNT + 1 })),
            },
        };

        const result = await itemValidationManager.validateItem(makeAttachment(), {
            validationType: ItemValidationType.FRONTEND,
            forceRefresh: true,
        });

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain(`exceeds the ${MAX_PAGE_COUNT}-page limit`);
        expect((globalThis as any).IOUtils.read).not.toHaveBeenCalled();
        expect(BeaverExtractorMock).not.toHaveBeenCalled();
    });

    it('falls back to MuPDF when document-cache metadata is absent', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn().mockResolvedValue(null),
            },
        };

        const result = await itemValidationManager.validateItem(makeAttachment(), {
            validationType: ItemValidationType.FRONTEND,
            forceRefresh: true,
        });

        expect(result.isValid).toBe(true);
        expect((globalThis as any).IOUtils.read).toHaveBeenCalledWith('/tmp/test.pdf');
        expect(BeaverExtractorMock).toHaveBeenCalledTimes(1);
        expect(extractorMethods.getPageCount).toHaveBeenCalledTimes(1);
    });

    it('rejects parser metadata over the hard page-count cap before OCR analysis', async () => {
        extractorMethods.getPageCount.mockResolvedValueOnce(MAX_PAGE_COUNT + 1);
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn().mockResolvedValue(null),
            },
        };

        const result = await itemValidationManager.validateItem(makeAttachment(), {
            validationType: ItemValidationType.FRONTEND,
            forceRefresh: true,
        });

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain(`exceeds the ${MAX_PAGE_COUNT}-page limit`);
        expect(extractorMethods.analyzeOCRNeeds).not.toHaveBeenCalled();
    });

    it('validates an EPUB with cached successful extraction metadata', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn().mockResolvedValue(makeEpubMetadata()),
            },
        };

        const result = await itemValidationManager.validateItem(
            makeAttachment({ contentType: 'application/epub+zip' }),
            { validationType: ItemValidationType.FRONTEND, forceRefresh: true },
        );

        expect(result).toEqual({ isValid: true, reason: undefined, backendChecked: false });
        expect((globalThis as any).IOUtils.read).not.toHaveBeenCalled();
        expect(BeaverExtractorMock).not.toHaveBeenCalled();
    });

    it('validates a cold-cache EPUB without invoking the PDF extractor', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn().mockResolvedValue(null),
            },
        };

        const result = await itemValidationManager.validateItem(
            makeAttachment({ contentType: 'application/epub+zip' }),
            { validationType: ItemValidationType.FRONTEND, forceRefresh: true },
        );

        expect(result.isValid).toBe(true);
        expect((globalThis as any).IOUtils.read).not.toHaveBeenCalled();
        expect(BeaverExtractorMock).not.toHaveBeenCalled();
    });

    it('rejects an EPUB whose cached extraction found no sections', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn().mockResolvedValue(makeEpubMetadata({
                    documentMetadata: { content_kind: 'epub', sectionCount: 0, sections: [] },
                })),
            },
        };

        const result = await itemValidationManager.validateItem(
            makeAttachment({ contentType: 'application/epub+zip' }),
            { validationType: ItemValidationType.FRONTEND, forceRefresh: true },
        );

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('no readable sections');
    });

    it('rejects an EPUB whose cached metadata carries an error code', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn().mockResolvedValue(makeEpubMetadata({
                    errorCode: 'extraction_failed',
                    documentMetadata: null,
                })),
            },
        };

        const result = await itemValidationManager.validateItem(
            makeAttachment({ contentType: 'application/epub+zip' }),
            { validationType: ItemValidationType.FRONTEND, forceRefresh: true },
        );

        expect(result.isValid).toBe(false);
        expect(result.reason).toContain('could not be read');
    });

    it('does not interpret an EPUB cache row through the PDF metadata reader', async () => {
        // A PDF attachment whose cache row is (unexpectedly) EPUB-shaped must
        // fall through to the parser instead of reading PDF fields off it.
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn().mockResolvedValue(makeEpubMetadata()),
            },
        };

        const result = await itemValidationManager.validateItem(makeAttachment(), {
            validationType: ItemValidationType.FRONTEND,
            forceRefresh: true,
        });

        expect(result.isValid).toBe(true);
        expect(BeaverExtractorMock).toHaveBeenCalledTimes(1);
    });
});
