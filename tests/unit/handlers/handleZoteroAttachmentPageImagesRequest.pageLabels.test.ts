import { beforeEach, describe, expect, it, vi } from 'vitest';

// Test-controlled mock state — reset in beforeEach.
const mockState = {
    renderImpl: null as ((args: any) => Promise<any>) | null,
    renderCalls: [] as any[],
    cannedPageCount: 3,
    cannedPageLabels: { 0: 'i', 1: '1', 2: '2' } as Record<number, string>,
};

vi.mock('../../../src/beaver-extract', () => {
    class MockPDFExtractor {
        async getPageCount(): Promise<number> {
            return mockState.cannedPageCount;
        }

        async getMetadata(): Promise<{ pageCount: number; pageLabels: Record<number, string> }> {
            return {
                pageCount: mockState.cannedPageCount,
                pageLabels: mockState.cannedPageLabels,
            };
        }

        async renderPages(
            _pdfData: Uint8Array | ArrayBuffer,
            args: any,
        ): Promise<{ pageCount: number; pageLabels: Record<number, string>; pages: any[] }> {
            mockState.renderCalls.push(args);
            if (mockState.renderImpl) {
                return mockState.renderImpl(args);
            }
            const indices: number[] | undefined = args?.pageIndices;
            const resolved = indices ?? Array.from({ length: mockState.cannedPageCount }, (_, i) => i);
            return {
                pageCount: mockState.cannedPageCount,
                pageLabels: mockState.cannedPageLabels,
                pages: resolved.map((pageIndex) => ({
                    pageIndex,
                    data: new Uint8Array([1, 2, 3]),
                    format: 'png' as const,
                    width: 100,
                    height: 200,
                    scale: 1,
                    dpi: 72,
                })),
            };
        }
    }

    class MockExtractionError extends Error {
        code: string;
        pageCount?: number;

        constructor(code: string, message: string, _details?: unknown, _pageLabels?: Record<number, string>, pageCount?: number) {
            super(message);
            this.code = code;
            this.pageCount = pageCount;
        }
    }

    return {
        BeaverExtractor: MockPDFExtractor,
        ExtractionError: MockExtractionError,
        ExtractionErrorCode: {
            ENCRYPTED: 'encrypted',
            INVALID_PDF: 'invalid_pdf',
            PAGE_OUT_OF_RANGE: 'page_out_of_range',
        },
    };
});

// Mock heavy transitive deps so we can `importActual` utils.ts and use the
// real `preflightCachedPdfMeta` (the handler delegates to it — pure logic,
// exercising it is preferable to stubbing).
vi.mock('../../../src/services/supabaseClient', () => ({
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
        resolveToPdfAttachment: vi.fn(),
        validateZoteroItemReference: vi.fn(() => null),
        backfillMetadataForError: vi.fn(),
        loadPdfData: vi.fn(async () => new Uint8Array([1, 2, 3])),
        checkRemotePdfSize: vi.fn(() => null),
        isRemoteAccessAvailable: vi.fn(() => false),
    };
});

import { handleZoteroAttachmentPageImagesRequest } from '../../../src/services/agentDataProvider/handleZoteroAttachmentPageImagesRequest';
import { resolveToPdfAttachment } from '../../../src/services/agentDataProvider/utils';

describe('handleZoteroAttachmentPageImagesRequest page labels', () => {
    const mockIOUtils = (globalThis as any).IOUtils as {
        read: ReturnType<typeof vi.fn>;
        stat: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockState.renderImpl = null;
        mockState.renderCalls = [];
        mockState.cannedPageCount = 3;
        mockState.cannedPageLabels = { 0: 'i', 1: '1', 2: '2' };
    });

    function setupRequestScenario(opts: {
        cachedPageCount: number | null;
        cachedPageLabels?: Record<number, string> | null;
    }) {
        return setupRequestScenarioWithFullCache({
            cachedPageCount: opts.cachedPageCount,
            cachedPageLabels: opts.cachedPageLabels,
            // Default to a complete, non-OCR record for tests that just need
            // a plausible cache hit and don't exercise OCR-state branches.
            needs_ocr: false,
            has_text_layer: true,
        });
    }

    function setupRequestScenarioWithFullCache(opts: {
        cachedPageCount: number | null;
        cachedPageLabels?: Record<number, string> | null;
        needs_ocr?: boolean | null | undefined;
        has_text_layer?: boolean | null | undefined;
    }) {
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(
                opts.cachedPageCount == null && opts.needs_ocr === undefined
                    ? null
                    : {
                          is_encrypted: false,
                          is_invalid: false,
                          page_count: opts.cachedPageCount,
                          page_labels: opts.cachedPageLabels ?? null,
                          needs_ocr: opts.needs_ocr,
                          has_text_layer: opts.has_text_layer,
                      },
            ),
            setMetadata: vi.fn().mockResolvedValue(undefined),
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

        mockIOUtils.read?.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mockIOUtils.stat?.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

        return { cache };
    }

    it('hydrates page_label on cold caches even when prefer_page_labels is false', async () => {
        // Cached page_count present, labels: null → handler should call render
        // (with-meta) and read pageLabels back from the result.
        setupRequestScenario({ cachedPageCount: 3, cachedPageLabels: null });

        const response = await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1],
            skip_local_limits: true,
            prefer_page_labels: false,
        });

        expect(response.pages).toEqual([
            expect.objectContaining({
                page_number: 1,
                page_label: 'i',
            }),
        ]);
        // Exactly one render call (no separate getPageCount or label hydration).
        expect(mockState.renderCalls).toHaveLength(1);
    });

    it('does NOT write metadata after a successful render even when a prior writer confirmed text-layer status', async () => {
        // The image-render path never writes metadata. Rendering proves the
        // PDF opens but never inspects the text layer, so metadata is owned
        // exclusively by writers that run an authoritative text-layer check
        // (file status, text extraction) — even when a prior record exists.
        const { cache } = setupRequestScenarioWithFullCache({
            cachedPageCount: 3,
            cachedPageLabels: null,
            needs_ocr: false,
            has_text_layer: true,
        });

        await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-meta',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1, 2],
            skip_local_limits: true,
        });

        expect(cache.setMetadata).not.toHaveBeenCalled();
    });

    it('does NOT seed cache from image render when no prior writer (regression)', async () => {
        // First-time render with no cachedMeta. Writing `needs_ocr: null`
        // would let `fileStatusFromCache` treat a scanned PDF as "available"
        // and skip the later OCR analysis. Skip the write entirely.
        const { cache } = setupRequestScenarioWithFullCache({
            cachedPageCount: null,
            cachedPageLabels: null,
            needs_ocr: undefined,
            has_text_layer: undefined,
        });

        await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-no-seed',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1],
            skip_local_limits: true,
        });

        expect(cache.setMetadata).not.toHaveBeenCalled();
    });

    it('does NOT overwrite cache from image render when needs_ocr is unknown (null)', async () => {
        // cachedMeta exists but with needs_ocr: null (unknown). Same risk:
        // re-writing would still leave needs_ocr null. Skip.
        const { cache } = setupRequestScenarioWithFullCache({
            cachedPageCount: 3,
            cachedPageLabels: null,
            needs_ocr: null,
            has_text_layer: null,
        });

        await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-no-overwrite',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1],
            skip_local_limits: true,
        });

        expect(cache.setMetadata).not.toHaveBeenCalled();
    });

    it('passes pageIndices: undefined for all-pages requests', async () => {
        setupRequestScenario({ cachedPageCount: 3, cachedPageLabels: { 0: 'i' } });

        await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-all',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            // pages omitted → all-pages request
            skip_local_limits: true,
        });

        expect(mockState.renderCalls).toHaveLength(1);
        expect(mockState.renderCalls[0].pageIndices).toBeUndefined();
    });

    it('does NOT overwrite cache from image render when prior cachedMeta says needs_ocr: true (regression)', async () => {
        // A PDF previously cached with needs_ocr: true must keep that flag
        // after an image render — otherwise later text requests lose the
        // fast-fail and `fileStatusFromCache` flips to "available". Stronger
        // guarantee: skip the write entirely (prior writer is authoritative).
        const { cache } = setupRequestScenarioWithFullCache({
            cachedPageCount: 3,
            cachedPageLabels: null,
            needs_ocr: true,
            has_text_layer: false,
        });

        await handleZoteroAttachmentPageImagesRequest({
            event: 'zotero_attachment_page_images_request',
            request_id: 'req-ocr-preserve',
            attachment: { library_id: 1, zotero_key: 'ABCD1234' },
            pages: [1],
            skip_local_limits: true,
        });

        expect(cache.setMetadata).not.toHaveBeenCalled();
    });
});
