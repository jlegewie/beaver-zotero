import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: vi.fn(),
    resolveToPdfAttachment: vi.fn(),
    resolveToImageAttachment: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    validateZoteroItemReference: vi.fn(() => null),
    checkLibraryExcluded: vi.fn(() => null),
    preflightZoteroAttachmentRequest: vi.fn((attachment: any) => ({
        ok: true,
        responseAttachment: attachment,
        requestKey: `${attachment.library_id}-${attachment.zotero_key}`,
        resolvedLibraryId: attachment.library_id,
    })),
}));

vi.mock(
    '../../../src/services/agentDataProvider/handleZoteroAttachmentPageImagesRequest',
    () => ({ handleZoteroAttachmentPageImagesRequest: vi.fn() }),
);
vi.mock(
    '../../../src/services/agentDataProvider/handleZoteroAttachmentImageRequest',
    () => ({ handleZoteroAttachmentImageRequest: vi.fn() }),
);
vi.mock('../../../src/services/agentDataProvider/handleZoteroDocumentRequest', () => ({
    externalFileMissingMessage: vi.fn((key: string) => `External file ${key} is missing.`),
    getResolvedAttachmentParentStub: vi.fn().mockResolvedValue(null),
    buildServedAttachmentStub: vi.fn((item: any, kind: string) => ({
        attachment_id: `${item.libraryID}-${item.key}`,
        title: null,
        filename: null,
        content_kind: kind,
    })),
}));

import { handleZoteroViewImagesRequest } from '../../../src/services/agentDataProvider/handleZoteroViewImagesRequest';
import {
    getReadableContentKind,
    resolveToPdfAttachment,
    resolveToImageAttachment,
} from '../../../src/services/documentExtraction/attachmentResolution';
import { validateZoteroItemReference } from '../../../src/services/agentDataProvider/utils';
import { handleZoteroAttachmentPageImagesRequest } from '../../../src/services/agentDataProvider/handleZoteroAttachmentPageImagesRequest';
import { handleZoteroAttachmentImageRequest } from '../../../src/services/agentDataProvider/handleZoteroAttachmentImageRequest';

type FakeItemOptions = {
    libraryID?: number;
    key?: string;
    isAttachment?: boolean;
    isRegularItem?: boolean;
    isNote?: boolean;
    isAnnotation?: boolean;
    isPdf?: boolean;
    deleted?: boolean;
    attachmentContentType?: string;
    attachmentLinkMode?: number;
    childIds?: number[];
};

function makeItem(opts: FakeItemOptions = {}) {
    return {
        libraryID: opts.libraryID ?? 1,
        key: opts.key ?? 'ATTACH01',
        deleted: opts.deleted ?? false,
        attachmentContentType: opts.attachmentContentType ?? '',
        attachmentLinkMode: opts.attachmentLinkMode ?? 0,
        isAttachment: vi.fn(() => opts.isAttachment ?? false),
        isRegularItem: vi.fn(() => opts.isRegularItem ?? false),
        isNote: vi.fn(() => opts.isNote ?? false),
        isAnnotation: vi.fn(() => opts.isAnnotation ?? false),
        isPDFAttachment: vi.fn(() => opts.isPdf ?? false),
        loadAllData: vi.fn().mockResolvedValue(undefined),
        getAttachments: vi.fn(() => opts.childIds ?? []),
    };
}

function setupZotero(requestItem: unknown, children: unknown[] = []) {
    (globalThis as any).Zotero = {
        Items: {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(requestItem),
            getAsync: vi.fn().mockResolvedValue(children),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        },
        Attachments: { LINK_MODE_LINKED_URL: 99 },
    };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
    return {
        event: 'zotero_view_images_request' as const,
        request_id: 'req-1',
        attachment: { library_id: 1, zotero_key: 'PARENT01' },
        ...overrides,
    };
}

function pdfPageResponse(pages: number[], totalPages = 30) {
    return {
        type: 'zotero_attachment_page_images' as const,
        request_id: 'req-1',
        attachment: { library_id: 1, zotero_key: 'PDFCHILD' },
        pages: pages.map((p) => ({
            page_number: p,
            page_label: p === 4 ? 'iv' : undefined,
            image_data: 'aGVsbG8=',
            format: 'png' as const,
            width: 100,
            height: 140,
        })),
        total_pages: totalPages,
    };
}

function imageResponse() {
    return {
        type: 'zotero_attachment_image' as const,
        request_id: 'req-1',
        attachment: { library_id: 1, zotero_key: 'IMGCHILD' },
        resolved_attachment: null,
        image: {
            image_data: 'aW1n',
            format: 'jpeg' as const,
            width: 800,
            height: 600,
            original_width: 1600,
            original_height: 1200,
            original_format: 'image/webp',
            resized: true,
            converted: true,
        },
    };
}

describe('handleZoteroViewImagesRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(validateZoteroItemReference).mockReturnValue(null as any);
    });

    it('renders a page range for a direct PDF attachment', async () => {
        const pdfItem = makeItem({ isAttachment: true, isPdf: true, key: 'PARENT01' });
        setupZotero(pdfItem);
        vi.mocked(getReadableContentKind).mockReturnValue('pdf');
        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: true,
            item: pdfItem,
            key: '1-PARENT01',
        } as any);
        vi.mocked(handleZoteroAttachmentPageImagesRequest).mockResolvedValue(
            pdfPageResponse([2, 3, 4]) as any,
        );

        const response = await handleZoteroViewImagesRequest(
            baseRequest({ start_page: 2, end_page: 4, dpi: 150 }) as any,
        );

        const subRequest = vi.mocked(handleZoteroAttachmentPageImagesRequest).mock.calls[0][0];
        expect(subRequest.pages).toEqual([2, 3, 4]);
        expect(subRequest.dpi).toBe(150);
        expect(subRequest.format).toBe('png');

        expect(response.kind).toBe('pdf');
        expect(response.total_pages).toBe(30);
        expect(response.resolved_attachment).toBeNull();
        expect(response.images).toHaveLength(3);
        expect(response.images[0].page_number).toBe(2);
        expect(response.images[2].page_label).toBe('iv');
    });

    it('defaults to the first page when no range is given', async () => {
        const pdfItem = makeItem({ isAttachment: true, isPdf: true, key: 'PARENT01' });
        setupZotero(pdfItem);
        vi.mocked(getReadableContentKind).mockReturnValue('pdf');
        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: true,
            item: pdfItem,
            key: '1-PARENT01',
        } as any);
        vi.mocked(handleZoteroAttachmentPageImagesRequest).mockResolvedValue(
            pdfPageResponse([1]) as any,
        );

        await handleZoteroViewImagesRequest(baseRequest() as any);

        const subRequest = vi.mocked(handleZoteroAttachmentPageImagesRequest).mock.calls[0][0];
        expect(subRequest.pages).toEqual([1]);
    });

    it('serves a direct image attachment as a single image', async () => {
        const imageItem = makeItem({
            isAttachment: true,
            key: 'PARENT01',
            attachmentContentType: 'image/webp',
        });
        setupZotero(imageItem);
        vi.mocked(getReadableContentKind).mockReturnValue('image');
        vi.mocked(resolveToImageAttachment).mockResolvedValue({
            resolved: true,
            item: imageItem,
            key: '1-PARENT01',
        } as any);
        vi.mocked(handleZoteroAttachmentImageRequest).mockResolvedValue(imageResponse() as any);

        const response = await handleZoteroViewImagesRequest(baseRequest() as any);

        expect(response.kind).toBe('image');
        expect(response.total_pages).toBeNull();
        expect(response.images).toHaveLength(1);
        expect(response.images[0].page_number).toBeUndefined();
        expect(response.images[0].format).toBe('jpeg');
    });

    it('resolves a parent item to its PDF child and reports resolved_attachment', async () => {
        const pdfChild = makeItem({ isAttachment: true, isPdf: true, key: 'PDFCHILD' });
        const parent = makeItem({ isRegularItem: true, key: 'PARENT01', childIds: [11] });
        setupZotero(parent, [pdfChild]);
        vi.mocked(getReadableContentKind).mockReturnValue(null);
        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: true,
            item: pdfChild,
            key: '1-PDFCHILD',
        } as any);
        vi.mocked(handleZoteroAttachmentPageImagesRequest).mockResolvedValue(
            pdfPageResponse([1]) as any,
        );

        const response = await handleZoteroViewImagesRequest(baseRequest() as any);

        expect(response.kind).toBe('pdf');
        expect(response.resolved_attachment).toEqual({ library_id: 1, zotero_key: 'PDFCHILD' });
        // The sub-handler must target the resolved child, not the parent.
        const subRequest = vi.mocked(handleZoteroAttachmentPageImagesRequest).mock.calls[0][0];
        expect(subRequest.attachment).toEqual({ library_id: 1, zotero_key: 'PDFCHILD' });
    });

    it('preserves the actionable multi-PDF error instead of falling through to images', async () => {
        const pdfChildA = makeItem({ isAttachment: true, isPdf: true, key: 'PDFAAAA1' });
        const pdfChildB = makeItem({ isAttachment: true, isPdf: true, key: 'PDFBBBB1' });
        const parent = makeItem({ isRegularItem: true, key: 'PARENT01', childIds: [11, 12] });
        setupZotero(parent, [pdfChildA, pdfChildB]);
        vi.mocked(getReadableContentKind).mockReturnValue(null);
        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: false,
            error: "The id '1-PARENT01' is a regular item, not an attachment. The item has 2 attachments: 'a.pdf' (1-PDFAAAA1), 'b.pdf' (1-PDFBBBB1)",
            error_code: 'not_attachment',
        } as any);

        const response = await handleZoteroViewImagesRequest(baseRequest() as any);

        expect(response.error_code).toBe('not_attachment');
        expect(response.error).toContain('2 attachments');
        expect(resolveToImageAttachment).not.toHaveBeenCalled();
        expect(handleZoteroAttachmentImageRequest).not.toHaveBeenCalled();
    });

    it('falls through to the image resolver when the parent has no PDFs', async () => {
        const imageChild = makeItem({
            isAttachment: true,
            key: 'IMGCHILD',
            attachmentContentType: 'image/png',
        });
        const parent = makeItem({ isRegularItem: true, key: 'PARENT01', childIds: [21] });
        setupZotero(parent, [imageChild]);
        // Parent itself has no readable kind; the image child reports 'image'.
        vi.mocked(getReadableContentKind).mockImplementation(
            (item: any) => (item === imageChild ? 'image' : null),
        );
        vi.mocked(resolveToImageAttachment).mockResolvedValue({
            resolved: true,
            item: imageChild,
            key: '1-IMGCHILD',
        } as any);
        vi.mocked(handleZoteroAttachmentImageRequest).mockResolvedValue(imageResponse() as any);

        const response = await handleZoteroViewImagesRequest(baseRequest() as any);

        expect(response.kind).toBe('image');
        expect(response.resolved_attachment).toEqual({ library_id: 1, zotero_key: 'IMGCHILD' });
        expect(resolveToPdfAttachment).not.toHaveBeenCalled();
    });

    it('does not count a linked-URL image child in the pre-scan', async () => {
        // isLinkedUrlAttachment checks attachmentLinkMode against
        // Zotero.Attachments.LINK_MODE_LINKED_URL (99 in the fake env).
        const linkedImageChild = makeItem({
            isAttachment: true,
            key: 'URLCHILD',
            attachmentContentType: 'image/png',
            attachmentLinkMode: 99,
        });
        const parent = makeItem({ isRegularItem: true, key: 'PARENT01', childIds: [41] });
        setupZotero(parent, [linkedImageChild]);
        vi.mocked(getReadableContentKind).mockImplementation(
            (item: any) => (item === linkedImageChild ? 'image' : null),
        );

        const response = await handleZoteroViewImagesRequest(baseRequest() as any);

        // The pre-scan mirrors the image resolver's linked-URL filter, so the
        // request fails fast with unsupported_type instead of reaching the
        // resolver's "no image attachments" error.
        expect(response.error_code).toBe('unsupported_type');
        expect(resolveToImageAttachment).not.toHaveBeenCalled();
    });

    it('returns unsupported_type for a parent with no PDF or image attachments', async () => {
        const textChild = makeItem({
            isAttachment: true,
            key: 'TXTCHILD',
            attachmentContentType: 'text/plain',
        });
        const parent = makeItem({ isRegularItem: true, key: 'PARENT01', childIds: [31] });
        setupZotero(parent, [textChild]);
        vi.mocked(getReadableContentKind).mockImplementation(
            (item: any) => (item === textChild ? 'text' : null),
        );

        const response = await handleZoteroViewImagesRequest(baseRequest() as any);

        expect(response.error_code).toBe('unsupported_type');
        expect(response.images).toEqual([]);
    });

    it('returns unsupported_type for a non-PDF non-image attachment', async () => {
        const epubItem = makeItem({
            isAttachment: true,
            key: 'PARENT01',
            attachmentContentType: 'application/epub+zip',
        });
        setupZotero(epubItem);
        vi.mocked(getReadableContentKind).mockReturnValue('epub');

        const response = await handleZoteroViewImagesRequest(baseRequest() as any);

        expect(response.error_code).toBe('unsupported_type');
        expect(response.error).toContain('neither a PDF nor an image');
    });

    it('passes through sub-handler errors with total_pages', async () => {
        const pdfItem = makeItem({ isAttachment: true, isPdf: true, key: 'PARENT01' });
        setupZotero(pdfItem);
        vi.mocked(getReadableContentKind).mockReturnValue('pdf');
        vi.mocked(resolveToPdfAttachment).mockResolvedValue({
            resolved: true,
            item: pdfItem,
            key: '1-PARENT01',
        } as any);
        vi.mocked(handleZoteroAttachmentPageImagesRequest).mockResolvedValue({
            type: 'zotero_attachment_page_images',
            request_id: 'req-1',
            attachment: { library_id: 1, zotero_key: 'PARENT01' },
            pages: [],
            total_pages: 12,
            error: 'All requested pages are out of range (document has 12 pages)',
            error_code: 'page_out_of_range',
        } as any);

        const response = await handleZoteroViewImagesRequest(
            baseRequest({ start_page: 20, end_page: 22 }) as any,
        );

        expect(response.error_code).toBe('page_out_of_range');
        expect(response.total_pages).toBe(12);
        expect(response.kind).toBe('pdf');
    });

    it('returns not_found when the item does not exist', async () => {
        setupZotero(false);

        const response = await handleZoteroViewImagesRequest(baseRequest() as any);

        expect(response.error_code).toBe('not_found');
    });

    it('rejects an inverted page range without touching Zotero', async () => {
        setupZotero(false);

        const response = await handleZoteroViewImagesRequest(
            baseRequest({ start_page: 5, end_page: 2 }) as any,
        );

        expect(response.error_code).toBe('invalid_page_value');
        expect(response.error).toContain('end_page');
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
    });

    it('rejects an oversized page range before expanding it', async () => {
        setupZotero(false);

        const response = await handleZoteroViewImagesRequest(
            baseRequest({ start_page: 1, end_page: 100_000_000 }) as any,
        );

        expect(response.error_code).toBe('invalid_page_value');
        expect(response.error).toContain('exceeds');
        expect((globalThis as any).Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        expect(handleZoteroAttachmentPageImagesRequest).not.toHaveBeenCalled();
    });

    it('rejects an oversized range when start_page is omitted', async () => {
        setupZotero(false);

        const response = await handleZoteroViewImagesRequest(
            baseRequest({ end_page: 100_000_000 }) as any,
        );

        expect(response.error_code).toBe('invalid_page_value');
        expect(handleZoteroAttachmentPageImagesRequest).not.toHaveBeenCalled();
    });
});
