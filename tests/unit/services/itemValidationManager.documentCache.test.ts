import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentInfo } from '../../../src/services/documentExtraction/shared/contentKinds';

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

const {
    getAttachmentInfoMock,
    prepareAttachmentInfoBatchDataMock,
    processAttachmentInfoBatchMock,
} = vi.hoisted(() => ({
    getAttachmentInfoMock: vi.fn(),
    prepareAttachmentInfoBatchDataMock: vi.fn(),
    processAttachmentInfoBatchMock: vi.fn(),
}));

vi.mock('../../../src/services/documentExtraction/attachmentInfo', () => ({
    getAttachmentInfo: getAttachmentInfoMock,
}));

vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    prepareAttachmentInfoBatchData: prepareAttachmentInfoBatchDataMock,
    processAttachmentInfoBatch: processAttachmentInfoBatchMock,
}));

import { itemValidationManager } from '../../../src/services/itemValidationManager';
import { HARD_ATTACHMENT_LIMITS } from '../../../src/services/attachmentLimits';

type ValidationItem = Parameters<typeof itemValidationManager.validateItem>[0];

function makeAttachment(overrides: Partial<ValidationItem> = {}): ValidationItem {
    return {
        id: 10,
        libraryID: 1,
        key: '2YWA8DTZ',
        attachmentContentType: 'application/pdf',
        attachmentFilename: 'paper.pdf',
        attachmentLinkMode: (globalThis as any).Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
        isAttachment: () => true,
        isRegularItem: () => false,
        isAnnotation: () => false,
        isNote: () => false,
        isInTrash: () => false,
        ...overrides,
    } as unknown as ValidationItem;
}

function makeRegularItem(overrides: Partial<ValidationItem> = {}): ValidationItem {
    return {
        id: 20,
        libraryID: 1,
        key: 'REGITEM1',
        isAttachment: () => false,
        isRegularItem: () => true,
        isAnnotation: () => false,
        isNote: () => false,
        isInTrash: () => false,
        getAttachments: () => [10, 11],
        ...overrides,
    } as unknown as ValidationItem;
}

function attachmentInfo(overrides: Partial<AttachmentInfo> = {}): AttachmentInfo {
    return {
        attachment_id: '1-2YWA8DTZ',
        parent_item_id: null,
        title: 'Paper',
        filename: 'paper.pdf',
        content_kind: 'pdf',
        status: 'readable',
        page_count: 12,
        line_count: null,
        is_primary: false,
        ...overrides,
    };
}

describe('ItemValidationManager unified attachment-info validation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        itemValidationManager.clearCache();
        (globalThis as any).Zotero.Libraries.get = vi.fn(() => ({ name: 'Library' }));
        getAttachmentInfoMock.mockResolvedValue(attachmentInfo());
        prepareAttachmentInfoBatchDataMock.mockResolvedValue({ bestAttachmentMap: new Map([[20, 10]]) });
        processAttachmentInfoBatchMock.mockResolvedValue([attachmentInfo()]);
    });

    it('validates standalone attachments through getAttachmentInfo', async () => {
        const item = makeAttachment();

        const result = await itemValidationManager.validateItem(item, {
            searchableLibraryIds: [1],
        });

        expect(result).toMatchObject({
            state: 'readable',
            contentKind: 'pdf',
            pageCount: 12,
        });
        expect(getAttachmentInfoMock).toHaveBeenCalledWith(item, {
            nonPdfReadableEnabled: true,
        });
    });

    it('maps unreadable attachment info to an unreadable validation state', async () => {
        getAttachmentInfoMock.mockResolvedValueOnce(attachmentInfo({
            status: 'unreadable',
            status_code: 'pdf_needs_ocr',
            page_count: 8,
        }));

        const result = await itemValidationManager.validateItem(makeAttachment(), {
            searchableLibraryIds: [1],
            forceRefresh: true,
        });

        expect(result).toMatchObject({
            state: 'unreadable',
            statusCode: 'pdf_needs_ocr',
            contentKind: 'pdf',
            pageCount: 8,
        });
        expect(result.reason).toContain('PDF requires OCR');
    });

    it('admits OCR-only PDFs when the selected setup can handle OCR locally', async () => {
        getAttachmentInfoMock.mockResolvedValueOnce(attachmentInfo({
            status: 'unreadable',
            status_code: 'pdf_needs_ocr',
            page_count: 8,
        }));

        const result = await itemValidationManager.validateItem(makeAttachment(), {
            searchableLibraryIds: [1],
            canHandleOCRLocally: true,
            forceRefresh: true,
        });

        expect(result).toMatchObject({
            state: 'readable',
            statusCode: 'pdf_needs_ocr',
            contentKind: 'pdf',
            pageCount: 8,
        });
    });

    it('rejects PDFs over the effective page-count limit', async () => {
        getAttachmentInfoMock.mockResolvedValueOnce(attachmentInfo({
            status: 'readable',
            page_count: HARD_ATTACHMENT_LIMITS.maxPageCount + 1,
        }));

        const result = await itemValidationManager.validateItem(makeAttachment(), {
            searchableLibraryIds: [1],
            canHandleOCRLocally: true,
            forceRefresh: true,
        });

        expect(result).toMatchObject({
            state: 'unreadable',
            contentKind: 'pdf',
            pageCount: HARD_ATTACHMENT_LIMITS.maxPageCount + 1,
        });
        expect(result.reason).toContain(`exceeds the ${HARD_ATTACHMENT_LIMITS.maxPageCount}-page limit`);
    });

    it('blocks excluded libraries before reading attachment info', async () => {
        const result = await itemValidationManager.validateItem(makeAttachment(), {
            searchableLibraryIds: [2],
            forceRefresh: true,
        });

        expect(result).toMatchObject({
            state: 'blocked',
        });
        expect(result.reason).toContain('excluded from Beaver');
        expect(getAttachmentInfoMock).not.toHaveBeenCalled();
    });

    it('validates regular item attachments through processAttachmentInfoBatch', async () => {
        const item = makeRegularItem();
        const unreadable = attachmentInfo({
            attachment_id: '1-UNREAD1',
            status: 'unreadable',
            status_code: 'epub_no_text',
            content_kind: 'epub',
            page_count: 4,
        });
        processAttachmentInfoBatchMock.mockResolvedValueOnce([
            attachmentInfo(),
            unreadable,
        ]);

        const result = await itemValidationManager.validateRegularItem(item, {
            searchableLibraryIds: [1],
        });

        expect(result).toMatchObject({
            state: 'readable',
        });
        expect(prepareAttachmentInfoBatchDataMock).toHaveBeenCalledWith([item]);
        expect(processAttachmentInfoBatchMock).toHaveBeenCalledWith(item, { bestAttachmentMap: new Map([[20, 10]]) }, {
            nonPdfReadableEnabled: true,
        });
        expect(result.attachmentResults.get('1-2YWA8DTZ')).toMatchObject({
            state: 'readable',
        });
        expect(result.attachmentResults.get('1-UNREAD1')).toMatchObject({
            state: 'unreadable',
            statusCode: 'epub_no_text',
        });
    });

    it('keeps regular items valid when they have no attachments', async () => {
        const result = await itemValidationManager.validateRegularItem(
            makeRegularItem({ getAttachments: () => [] } as Partial<ValidationItem>),
            { searchableLibraryIds: [1] },
        );

        expect(result).toMatchObject({
            state: 'readable',
        });
        expect(result.attachmentResults.size).toBe(0);
        expect(processAttachmentInfoBatchMock).not.toHaveBeenCalled();
    });
});
