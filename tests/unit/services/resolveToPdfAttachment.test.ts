import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveToPdfAttachment } from '../../../src/services/documentExtraction/attachmentResolution';

type MockItem = Zotero.Item & {
    loadAllData?: ReturnType<typeof vi.fn>;
};

function makeAttachment(opts: {
    id?: number;
    key: string;
    libraryID?: number;
    isPdf?: boolean;
    contentType?: string;
    filename?: string;
    linkMode?: number;
}): MockItem {
    const {
        id = 1,
        key,
        libraryID = 1,
        isPdf = true,
        contentType = isPdf ? 'application/pdf' : 'text/html',
        filename = `${key}.pdf`,
        linkMode,
    } = opts;

    return {
        id,
        key,
        libraryID,
        attachmentContentType: contentType,
        attachmentFilename: filename,
        attachmentLinkMode: linkMode,
        isAttachment: vi.fn(() => true),
        isPDFAttachment: vi.fn(() => isPdf),
        isRegularItem: vi.fn(() => false),
        isNote: vi.fn(() => false),
        isAnnotation: vi.fn(() => false),
        loadAllData: vi.fn(async () => undefined),
    } as unknown as MockItem;
}

function makeRegularItem(opts: {
    key?: string;
    libraryID?: number;
    attachmentIds: number[];
    bestAttachment?: MockItem | null;
}): MockItem {
    const {
        key = 'REG00001',
        libraryID = 1,
        attachmentIds,
        bestAttachment = null,
    } = opts;

    return {
        id: 100,
        key,
        libraryID,
        isAttachment: vi.fn(() => false),
        isPDFAttachment: vi.fn(() => false),
        isRegularItem: vi.fn(() => true),
        isNote: vi.fn(() => false),
        isAnnotation: vi.fn(() => false),
        getAttachments: vi.fn(() => attachmentIds),
        getBestAttachment: vi.fn(async () => bestAttachment),
        loadAllData: vi.fn(async () => undefined),
    } as unknown as MockItem;
}

describe('resolveToPdfAttachment', () => {
    let itemsById: Map<number, MockItem>;
    let itemsByLibraryAndKey: Map<string, MockItem>;

    beforeEach(() => {
        vi.clearAllMocks();
        itemsById = new Map();
        itemsByLibraryAndKey = new Map();

        (globalThis as any).Zotero.Attachments = {
            LINK_MODE_IMPORTED_FILE: 0,
            LINK_MODE_IMPORTED_URL: 1,
            LINK_MODE_LINKED_FILE: 2,
            LINK_MODE_LINKED_URL: 3,
            LINK_MODE_EMBEDDED_IMAGE: 4,
        };
        (globalThis as any).Zotero.Items = {
            loadDataTypes: vi.fn(async () => undefined),
            getAsync: vi.fn(async (ids: number[]) =>
                ids.map((id) => itemsById.get(id)).filter(Boolean),
            ),
            getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) =>
                itemsByLibraryAndKey.get(`${libraryID}-${key}`) ?? false,
            ),
        };
    });

    it('returns a direct PDF attachment unchanged', async () => {
        const pdf = makeAttachment({ key: 'PDF00001' });

        await expect(resolveToPdfAttachment(pdf, '1-PDF00001')).resolves.toEqual({
            resolved: true,
            item: pdf,
            key: '1-PDF00001',
        });
    });

    it('rejects linked URL attachments', async () => {
        const linkedUrl = makeAttachment({
            key: 'LINK0001',
            isPdf: false,
            contentType: 'text/html',
            linkMode: 3,
        });

        const result = await resolveToPdfAttachment(linkedUrl, '1-LINK0001');

        expect(result).toMatchObject({
            resolved: false,
            error_code: 'is_linked_url',
        });
    });

    it('rejects non-PDF attachments with the content type', async () => {
        const epub = makeAttachment({
            key: 'EPUB0001',
            isPdf: false,
            contentType: 'application/epub+zip',
        });

        const result = await resolveToPdfAttachment(epub, '1-EPUB0001');

        expect(result).toMatchObject({
            resolved: false,
            error_code: 'not_pdf',
            error: 'Attachment 1-EPUB0001 is not a PDF (type: application/epub+zip)',
        });
    });

    it('auto-resolves a regular item with exactly one PDF attachment', async () => {
        const pdf = makeAttachment({
            id: 10,
            key: 'PDF00001',
            filename: 'paper.pdf',
        });
        const epub = makeAttachment({
            id: 11,
            key: 'EPUB0001',
            isPdf: false,
            contentType: 'application/epub+zip',
            filename: 'paper.epub',
        });
        const regular = makeRegularItem({
            attachmentIds: [10, 11],
            bestAttachment: pdf,
        });
        itemsById.set(10, pdf);
        itemsById.set(11, epub);
        itemsByLibraryAndKey.set('1-PDF00001', pdf);

        const result = await resolveToPdfAttachment(regular, '1-REG00001');

        expect(result).toEqual({
            resolved: true,
            item: pdf,
            key: '1-PDF00001',
        });
        expect(Zotero.Items.loadDataTypes).toHaveBeenCalledWith(
            [regular],
            ['childItems'],
        );
        expect(Zotero.Items.loadDataTypes).toHaveBeenCalledWith(
            [pdf],
            ['itemData'],
        );
        expect(pdf.loadAllData).toHaveBeenCalledOnce();
    });

    it('rejects a regular item with multiple PDF attachments', async () => {
        const primaryPdf = makeAttachment({
            id: 10,
            key: 'PDF00001',
            filename: 'primary.pdf',
        });
        const otherPdf = makeAttachment({
            id: 11,
            key: 'PDF00002',
            filename: 'other.pdf',
        });
        const regular = makeRegularItem({
            attachmentIds: [10, 11],
            bestAttachment: primaryPdf,
        });
        itemsById.set(10, primaryPdf);
        itemsById.set(11, otherPdf);

        const result = await resolveToPdfAttachment(regular, '1-REG00001');

        expect(result).toMatchObject({
            resolved: false,
            error_code: 'not_attachment',
        });
        if (result.resolved) {
            expect.fail('expected unresolved result');
        }
        expect(result.error).toContain('The item has 2 attachments');
        expect(result.error).toContain("'primary.pdf' (1-PDF00001, primary)");
        expect(result.error).toContain("'other.pdf' (1-PDF00002)");
    });

    it('rejects a regular item with no PDF attachments', async () => {
        const epub = makeAttachment({
            id: 11,
            key: 'EPUB0001',
            isPdf: false,
            contentType: 'application/epub+zip',
        });
        const regular = makeRegularItem({
            attachmentIds: [11],
            bestAttachment: epub,
        });
        itemsById.set(11, epub);

        const result = await resolveToPdfAttachment(regular, '1-REG00001');

        expect(result).toEqual({
            resolved: false,
            error: "The id '1-REG00001' is a regular item, not an attachment. The item has no attachments.",
            error_code: 'not_attachment',
        });
    });

    it('returns a resolution error when the single PDF attachment disappears', async () => {
        const pdf = makeAttachment({
            id: 10,
            key: 'PDF00001',
            filename: 'paper.pdf',
        });
        const regular = makeRegularItem({
            attachmentIds: [10],
            bestAttachment: pdf,
        });
        itemsById.set(10, pdf);

        const result = await resolveToPdfAttachment(regular, '1-REG00001');

        expect(result).toMatchObject({
            resolved: false,
            error_code: 'not_attachment',
            error: "The id '1-REG00001' is a regular item with one attachment ('paper.pdf' (1-PDF00001, primary)) but it could not be resolved.",
        });
    });
});
