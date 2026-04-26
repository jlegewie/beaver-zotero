import { beforeEach, describe, expect, it, vi } from 'vitest';

// Test-controlled mock state — reset in beforeEach.
const mockState = {
    extractWithMetaImpl: null as ((args: any) => Promise<any>) | null,
    extractWithMetaCalls: [] as any[],
};

vi.mock('../../../src/services/pdf', () => {
    class MockPDFExtractor {
        async getPageCount(): Promise<number> {
            return 3;
        }
        async getPageCountAndLabels(): Promise<{ count: number; labels: Record<number, string> }> {
            return { count: 3, labels: {} };
        }
        async extractWithMeta(_pdfData: Uint8Array | ArrayBuffer, args: any): Promise<any> {
            mockState.extractWithMetaCalls.push(args);
            if (mockState.extractWithMetaImpl) {
                return mockState.extractWithMetaImpl(args);
            }
            return {
                pages: [{ index: 0, label: '1', content: 'page-1', width: 100, height: 200 }],
                analysis: { pageCount: 3, hasTextLayer: true, styleProfile: {}, marginAnalysis: {} },
                fullText: 'page-1',
                pageLabels: undefined,
                metadata: { extractedAt: 'now', version: '2.0.0', settings: {} },
            };
        }
    }

    class MockExtractionError extends Error {
        code: string;
        pageLabels?: Record<number, string>;
        pageCount?: number;

        constructor(code: string, message: string, details?: unknown, pageLabels?: Record<number, string>, pageCount?: number) {
            super(message);
            this.code = code;
            this.pageLabels = pageLabels;
            this.pageCount = pageCount;
        }
    }

    return {
        PDFExtractor: MockPDFExtractor,
        ExtractionError: MockExtractionError,
        ExtractionErrorCode: {
            ENCRYPTED: 'encrypted',
            NO_TEXT_LAYER: 'no_text_layer',
            INVALID_PDF: 'invalid_pdf',
            PAGE_OUT_OF_RANGE: 'page_out_of_range',
        },
    };
});

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    resolveToPdfAttachment: vi.fn(),
    validateZoteroItemReference: vi.fn(() => null),
    backfillMetadataForError: vi.fn(),
    loadPdfData: vi.fn(async () => new Uint8Array([1, 2, 3])),
    checkRemotePdfSize: vi.fn(() => null),
    isRemoteAccessAvailable: vi.fn(() => false),
}));

import { handleZoteroAttachmentPagesRequest } from '../../../src/services/agentDataProvider/handleZoteroAttachmentPagesRequest';
import { resolveToPdfAttachment } from '../../../src/services/agentDataProvider/utils';
import { ExtractionError, ExtractionErrorCode } from '../../../src/services/pdf';

describe('handleZoteroAttachmentPagesRequest page label persistence', () => {
    const mockIOUtils = (globalThis as any).IOUtils as {
        read: ReturnType<typeof vi.fn>;
        stat: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockState.extractWithMetaImpl = null;
        mockState.extractWithMetaCalls = [];
    });

    it('stores page_labels as {} when extraction checked labels and none were found', async () => {
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({
                is_encrypted: false,
                is_invalid: false,
                needs_ocr: false,
                page_count: 3,
            }),
            getContentRange: vi.fn().mockResolvedValue(null),
            setMetadata: vi.fn().mockResolvedValue(undefined),
            setContentPages: vi.fn().mockResolvedValue(undefined),
        };

        const resolvedPdfItem = {
            id: 42,
            key: 'ABCD1234',
            libraryID: 1,
            attachmentContentType: 'application/pdf',
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/ABCD1234/test.pdf'),
        };

        const requestItem = {
            loadAllData: vi.fn().mockResolvedValue(undefined),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(requestItem),
        };
        (globalThis as any).Zotero.Beaver = {
            data: { env: 'test' },
            attachmentFileCache: cache,
        };

        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: true,
            item: resolvedPdfItem,
            key: '1-ABCD1234',
        } as any);

        mockIOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

        await handleZoteroAttachmentPagesRequest({
            event: 'zotero_attachment_pages_request',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            start_page: 1,
            end_page: 1,
            skip_local_limits: true,
        });

        expect(cache.setMetadata).toHaveBeenCalledWith(expect.objectContaining({
            item_id: 42,
            page_labels: {},
            page_count: 3,
        }));
    });

    /**
     * Helper that wires up a standard request scenario. Tests just override the
     * cache state and request shape.
     */
    function setupRequestScenario(opts: {
        cachedPageCount: number | null;
        cachedPageLabels?: Record<number, string> | null;
    }) {
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(
                opts.cachedPageCount == null
                    ? null
                    : {
                          is_encrypted: false,
                          is_invalid: false,
                          needs_ocr: false,
                          page_count: opts.cachedPageCount,
                          page_labels: opts.cachedPageLabels ?? null,
                      },
            ),
            getContentRange: vi.fn().mockResolvedValue(null),
            setMetadata: vi.fn().mockResolvedValue(undefined),
            setContentPages: vi.fn().mockResolvedValue(undefined),
        };

        const resolvedPdfItem = {
            id: 42,
            key: 'ABCD1234',
            libraryID: 1,
            attachmentContentType: 'application/pdf',
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/ABCD1234/test.pdf'),
        };
        const requestItem = {
            loadAllData: vi.fn().mockResolvedValue(undefined),
        };

        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(requestItem),
        };
        (globalThis as any).Zotero.Beaver = {
            data: { env: 'test' },
            attachmentFileCache: cache,
        };

        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: true,
            item: resolvedPdfItem,
            key: '1-ABCD1234',
        } as any);

        mockIOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

        return { cache };
    }

    it('passes a pageRange to extractWithMeta for open-ended end_page (no upfront getPageCount)', async () => {
        setupRequestScenario({ cachedPageCount: null });

        const response = await handleZoteroAttachmentPagesRequest({
            event: 'zotero_attachment_pages_request',
            request_id: 'req-open',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            start_page: 2,
            end_page: null as any,
            max_pages: 5,
            skip_local_limits: true,
        } as any);

        expect(response).toMatchObject({
            type: 'zotero_attachment_pages',
            total_pages: 3,
        });
        expect(mockState.extractWithMetaCalls).toHaveLength(1);
        expect(mockState.extractWithMetaCalls[0]).toMatchObject({
            pageRange: { startIndex: 1, maxPages: 5 },
        });
        // No endIndex set — open-ended; worker resolves it.
        expect(mockState.extractWithMetaCalls[0].pageRange.endIndex).toBeUndefined();
    });

    it('maps worker PAGE_OUT_OF_RANGE to page_out_of_range with total_pages from error.pageCount', async () => {
        setupRequestScenario({ cachedPageCount: null });

        mockState.extractWithMetaImpl = async () => {
            throw new ExtractionError(
                ExtractionErrorCode.PAGE_OUT_OF_RANGE,
                'All requested page indices are out of range or non-integer (document has 3 pages)',
                undefined,
                undefined,
                3,
            );
        };

        const response = await handleZoteroAttachmentPagesRequest({
            event: 'zotero_attachment_pages_request',
            request_id: 'req-oor',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            start_page: 99999,
            end_page: 99999,
            skip_local_limits: true,
        } as any);

        expect(response).toMatchObject({
            type: 'zotero_attachment_pages',
            error_code: 'page_out_of_range',
            total_pages: 3,
        });
    });

    it('honors max_pages even when start_page and end_page are both omitted (regression)', async () => {
        // Without explicit start/end the handler historically clamped 1..total.
        // The fused refactor must still send a pageRange so the worker clamps —
        // otherwise the worker extracts the entire document and the response
        // exceeds max_pages.
        setupRequestScenario({ cachedPageCount: 100 });

        await handleZoteroAttachmentPagesRequest({
            event: 'zotero_attachment_pages_request',
            request_id: 'req-maxonly',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            // start_page and end_page omitted (all-pages request)
            max_pages: 5,
            skip_local_limits: true,
        } as any);

        expect(mockState.extractWithMetaCalls).toHaveLength(1);
        expect(mockState.extractWithMetaCalls[0].pageRange).toEqual({
            startIndex: 0,
            maxPages: 5,
        });
    });

    it('does NOT reject a max_pages-bounded request as too_many_pages on a huge PDF (regression)', async () => {
        // PDF cached with page_count=10000, maxPageCount pref typically=1000.
        // With only `max_pages: 5`, the request really extracts 5 pages, so
        // the maxPageCount guard must not fire. Pre-fix the handler bailed
        // with too_many_pages before ever calling the worker.
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({
                is_encrypted: false,
                is_invalid: false,
                needs_ocr: false,
                page_count: 10000,
                page_labels: null,
            }),
            getContentRange: vi.fn().mockResolvedValue(null),
            setMetadata: vi.fn().mockResolvedValue(undefined),
            setContentPages: vi.fn().mockResolvedValue(undefined),
        };
        const resolvedPdfItem = {
            id: 42,
            key: 'ABCD1234',
            libraryID: 1,
            attachmentContentType: 'application/pdf',
            getFilePathAsync: vi.fn().mockResolvedValue('/storage/ABCD1234/test.pdf'),
        };
        const requestItem = { loadAllData: vi.fn().mockResolvedValue(undefined) };
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(requestItem),
        };
        // `!skip_local_limits` exercises the file-size and page-count gates.
        // Mock getTotalFileSize to a small value so the file-size gate doesn't
        // bail before we get to the page-count branch we care about.
        (globalThis as any).Zotero.Attachments = {
            getTotalFileSize: vi.fn().mockResolvedValue(1024),
        };
        (globalThis as any).Zotero.Beaver = {
            data: { env: 'test' },
            attachmentFileCache: cache,
        };
        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: true,
            item: resolvedPdfItem,
            key: '1-ABCD1234',
        } as any);
        mockIOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

        const response = await handleZoteroAttachmentPagesRequest({
            event: 'zotero_attachment_pages_request',
            request_id: 'req-bounded-huge',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            max_pages: 5,
            // skip_local_limits intentionally NOT set (defaults to false) —
            // this is the load-bearing condition for the regression.
        } as any);

        // Must NOT short-circuit as too_many_pages; the worker should be
        // called with a clamped pageRange.
        expect(response).not.toMatchObject({ error_code: 'too_many_pages' });
        expect(mockState.extractWithMetaCalls).toHaveLength(1);
        expect(mockState.extractWithMetaCalls[0].pageRange).toEqual({
            startIndex: 0,
            maxPages: 5,
        });
    });

    it('returns invalid_page_value for an unparseable string start_page (resolvePageValue throws on main thread)', async () => {
        setupRequestScenario({ cachedPageCount: 3 });

        const response = await handleZoteroAttachmentPagesRequest({
            event: 'zotero_attachment_pages_request',
            request_id: 'req-invalid',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            start_page: 'not-a-page' as any,
            end_page: 2,
            skip_local_limits: true,
            prefer_page_labels: false,
        } as any);

        expect(response).toMatchObject({
            type: 'zotero_attachment_pages',
            error_code: 'invalid_page_value',
            total_pages: 3,
        });
        // The worker should not have been called.
        expect(mockState.extractWithMetaCalls).toHaveLength(0);
    });
});
