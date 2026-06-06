import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => false),
}));

vi.mock('../../../../src/utils/webAPI', () => ({
    isAttachmentAvailableRemotely: vi.fn(() => false),
}));

vi.mock('../../../../src/services/attachmentLimits', () => ({
    effectiveMaxFileSizeMB: vi.fn(() => 50),
}));

import { getAttachmentInfo } from '../../../../src/services/documentExtraction/attachmentInfo';
import { getPref } from '../../../../src/utils/prefs';
import { isAttachmentAvailableRemotely } from '../../../../src/utils/webAPI';

type MockAttachmentOptions = {
    key?: string;
    contentType?: string;
    filePath?: string | null;
    linkMode?: number;
};

function makeAttachment(options: MockAttachmentOptions = {}): Zotero.Item {
    const contentType = options.contentType ?? 'application/pdf';
    const filePath = Object.prototype.hasOwnProperty.call(options, 'filePath')
        ? options.filePath
        : '/tmp/paper.pdf';
    return {
        libraryID: 1,
        key: options.key ?? 'ATTACH1',
        parentKey: 'PARENT1',
        attachmentFilename: 'paper.pdf',
        attachmentContentType: contentType,
        attachmentLinkMode: options.linkMode ?? 0,
        isAttachment: vi.fn(() => true),
        isPDFAttachment: vi.fn(() => contentType === 'application/pdf'),
        isFileAttachment: vi.fn(() => true),
        getAnnotations: vi.fn(() => [{ id: 1 }]),
        getDisplayTitle: vi.fn(() => 'Attachment title'),
        getField: vi.fn(() => 'Attachment title'),
        getFilePathAsync: vi.fn(async () => filePath),
    } as unknown as Zotero.Item;
}

describe('getAttachmentInfo', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Beaver = {};
        vi.mocked(getPref).mockReturnValue(false);
        vi.mocked(isAttachmentAvailableRemotely).mockReturnValue(false);
    });

    it('maps cached encrypted PDF metadata to an unreadable status code', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn(async () => ({ errorCode: 'encrypted', pageCount: null })),
            },
        };

        const info = await getAttachmentInfo(makeAttachment(), { includeAnnotationsCount: true });

        expect(info).toMatchObject({
            attachment_id: '1-ATTACH1',
            parent_item_id: '1-PARENT1',
            content_kind: 'pdf',
            status: 'unreadable',
            status_code: 'pdf_encrypted',
            page_count: null,
            annotations_count: 1,
        });
    });

    it('maps cached no-text-layer PDF metadata to pdf_needs_ocr with page count', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn(async () => ({ errorCode: 'no_text_layer', pageCount: 7 })),
            },
        };

        const info = await getAttachmentInfo(makeAttachment());

        expect(info.status).toBe('unreadable');
        expect(info.status_code).toBe('pdf_needs_ocr');
        expect(info.page_count).toBe(7);
    });

    it('reports a local-only missing file as unreadable', async () => {
        const info = await getAttachmentInfo(makeAttachment({ filePath: null }));

        expect(info).toMatchObject({
            content_kind: 'pdf',
            status: 'unreadable',
            status_code: 'file_not_local',
        });
    });

    it('allows remote readable text attachments when remote access is enabled', async () => {
        vi.mocked(getPref).mockImplementation((pref: string) => pref === 'accessRemoteFiles');
        vi.mocked(isAttachmentAvailableRemotely).mockReturnValue(true);

        const info = await getAttachmentInfo(
            makeAttachment({ contentType: 'text/plain', filePath: null }),
            { nonPdfReadableEnabled: true },
        );

        expect(info).toMatchObject({
            content_kind: 'text',
            status: 'readable',
        });
        expect(info.status_code).toBeUndefined();
    });
});
