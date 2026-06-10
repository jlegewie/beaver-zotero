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
                getMetadata: vi.fn(async () => ({ contentKind: 'pdf', errorCode: 'encrypted', pageCount: null })),
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
                getMetadata: vi.fn(async () => ({ contentKind: 'pdf', errorCode: 'no_text_layer', pageCount: 7 })),
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

    it('reports EPUB attachments as readable without nonPdfReadableEnabled', async () => {
        const info = await getAttachmentInfo(
            makeAttachment({ contentType: 'application/epub+zip', filePath: '/tmp/book.epub' }),
        );

        expect(info).toMatchObject({
            content_kind: 'epub',
            status: 'readable',
            page_count: null,
        });
        expect(info.status_code).toBeUndefined();
    });

    it('reports the cached EPUB section count as page_count', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn(async () => ({
                    contentKind: 'epub',
                    errorCode: null,
                    documentMetadata: { content_kind: 'epub', sectionCount: 12, sections: [] },
                })),
            },
        };

        const info = await getAttachmentInfo(
            makeAttachment({ contentType: 'application/epub+zip', filePath: '/tmp/book.epub' }),
        );

        expect(info).toMatchObject({
            content_kind: 'epub',
            status: 'readable',
            page_count: 12,
        });
    });

    it('reports a cached section-less EPUB as unreadable', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn(async () => ({
                    contentKind: 'epub',
                    errorCode: null,
                    documentMetadata: { content_kind: 'epub', sectionCount: 0, sections: [] },
                })),
            },
        };

        const info = await getAttachmentInfo(
            makeAttachment({ contentType: 'application/epub+zip', filePath: '/tmp/book.epub' }),
        );

        expect(info).toMatchObject({
            content_kind: 'epub',
            status: 'unreadable',
            status_code: 'epub_invalid',
            page_count: 0,
        });
    });

    it('reports a remote-only EPUB as unreadable even with remote access enabled', async () => {
        vi.mocked(getPref).mockImplementation((pref: string) => pref === 'accessRemoteFiles');
        vi.mocked(isAttachmentAvailableRemotely).mockReturnValue(true);

        const info = await getAttachmentInfo(
            makeAttachment({ contentType: 'application/epub+zip', filePath: null }),
        );

        expect(info).toMatchObject({
            content_kind: 'epub',
            status: 'unreadable',
            status_code: 'file_not_local_remote',
        });
    });

    it('maps a cached EPUB error row to epub_invalid', async () => {
        (globalThis as any).Zotero.Beaver = {
            documentCache: {
                getMetadata: vi.fn(async () => ({
                    contentKind: 'epub',
                    errorCode: 'extraction_failed',
                    documentMetadata: null,
                })),
            },
        };

        const info = await getAttachmentInfo(
            makeAttachment({ contentType: 'application/epub+zip', filePath: '/tmp/book.epub' }),
        );

        expect(info).toMatchObject({
            content_kind: 'epub',
            status: 'unreadable',
            status_code: 'epub_invalid',
        });
    });

    it('reports a missing local EPUB file as unreadable', async () => {
        const info = await getAttachmentInfo(
            makeAttachment({ contentType: 'application/epub+zip', filePath: null }),
        );

        expect(info).toMatchObject({
            content_kind: 'epub',
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
