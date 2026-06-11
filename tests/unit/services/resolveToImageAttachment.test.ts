import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveToImageAttachment } from '../../../src/services/documentExtraction/attachmentResolution';

type MockItem = Zotero.Item & {
    loadAllData?: ReturnType<typeof vi.fn>;
};

function makeAttachment(opts: {
    id?: number;
    key: string;
    libraryID?: number;
    contentType?: string;
    filename?: string;
    linkMode?: number;
    deleted?: boolean;
}): MockItem {
    const {
        id = 1,
        key,
        libraryID = 1,
        contentType = 'image/png',
        filename = `${key}.png`,
        linkMode,
        deleted = false,
    } = opts;

    return {
        id,
        key,
        libraryID,
        deleted,
        attachmentContentType: contentType,
        attachmentFilename: filename,
        attachmentLinkMode: linkMode,
        isAttachment: vi.fn(() => true),
        isPDFAttachment: vi.fn(() => contentType === 'application/pdf'),
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
}): MockItem {
    const {
        key = 'REG00001',
        libraryID = 1,
        attachmentIds,
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
        loadAllData: vi.fn(async () => undefined),
    } as unknown as MockItem;
}

describe('resolveToImageAttachment', () => {
    let itemsById: Map<number, MockItem>;
    let itemsByLibraryAndKey: Map<string, MockItem>;

    beforeEach(() => {
        vi.clearAllMocks();
        itemsById = new Map();
        itemsByLibraryAndKey = new Map();

        (globalThis as any).Zotero.Attachments = {
            LINK_MODE_LINKED_URL: 2,
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

    it('returns a direct image attachment unchanged', async () => {
        const image = makeAttachment({ key: 'IMG00001' });

        await expect(resolveToImageAttachment(image, '1-IMG00001')).resolves.toEqual({
            resolved: true,
            item: image,
            key: '1-IMG00001',
        });
    });

    it('resolves an embedded image attachment', async () => {
        const embedded = makeAttachment({
            key: 'IMG00001',
            contentType: 'image/jpeg',
            linkMode: 1,
        });

        const result = await resolveToImageAttachment(embedded, '1-IMG00001');

        expect(result).toMatchObject({ resolved: true, key: '1-IMG00001' });
    });

    it('rejects an image-typed linked URL attachment before image detection', async () => {
        const linkedUrl = makeAttachment({
            key: 'LINK0001',
            contentType: 'image/png',
            linkMode: 2,
        });

        const result = await resolveToImageAttachment(linkedUrl, '1-LINK0001');

        expect(result).toMatchObject({
            resolved: false,
            error_code: 'is_linked_url',
        });
    });

    it('rejects non-image attachments with the content type', async () => {
        const pdf = makeAttachment({
            key: 'PDF00001',
            contentType: 'application/pdf',
            filename: 'paper.pdf',
        });

        const result = await resolveToImageAttachment(pdf, '1-PDF00001');

        expect(result).toMatchObject({
            resolved: false,
            error_code: 'not_image',
            error: 'Attachment 1-PDF00001 is not an image (type: application/pdf)',
        });
    });

    it('auto-resolves a regular item with exactly one image attachment', async () => {
        const image = makeAttachment({
            id: 10,
            key: 'IMG00001',
            filename: 'figure.png',
        });
        const pdf = makeAttachment({
            id: 11,
            key: 'PDF00001',
            contentType: 'application/pdf',
            filename: 'paper.pdf',
        });
        const regular = makeRegularItem({ attachmentIds: [10, 11] });
        itemsById.set(10, image);
        itemsById.set(11, pdf);
        itemsByLibraryAndKey.set('1-IMG00001', image);

        const result = await resolveToImageAttachment(regular, '1-REG00001');

        expect(result).toEqual({
            resolved: true,
            item: image,
            key: '1-IMG00001',
        });
        expect(Zotero.Items.loadDataTypes).toHaveBeenCalledWith(
            [regular],
            ['childItems'],
        );
        expect(image.loadAllData).toHaveBeenCalledOnce();
    });

    it('excludes deleted and linked-URL image children from auto-resolution', async () => {
        const live = makeAttachment({ id: 10, key: 'IMG00001', filename: 'live.png' });
        const trashed = makeAttachment({
            id: 11,
            key: 'IMG00002',
            filename: 'trashed.png',
            deleted: true,
        });
        const linked = makeAttachment({
            id: 12,
            key: 'IMG00003',
            filename: 'linked.png',
            linkMode: 2,
        });
        const regular = makeRegularItem({ attachmentIds: [10, 11, 12] });
        itemsById.set(10, live);
        itemsById.set(11, trashed);
        itemsById.set(12, linked);
        itemsByLibraryAndKey.set('1-IMG00001', live);

        const result = await resolveToImageAttachment(regular, '1-REG00001');

        expect(result).toEqual({
            resolved: true,
            item: live,
            key: '1-IMG00001',
        });
    });

    it('rejects a regular item with multiple image attachments and lists them', async () => {
        const first = makeAttachment({ id: 10, key: 'IMG00001', filename: 'first.png' });
        const second = makeAttachment({
            id: 11,
            key: 'IMG00002',
            contentType: 'image/jpeg',
            filename: 'second.jpg',
        });
        const regular = makeRegularItem({ attachmentIds: [10, 11] });
        itemsById.set(10, first);
        itemsById.set(11, second);

        const result = await resolveToImageAttachment(regular, '1-REG00001');

        expect(result).toMatchObject({
            resolved: false,
            error_code: 'not_attachment',
        });
        if (result.resolved) {
            expect.fail('expected unresolved result');
        }
        expect(result.error).toContain('The item has 2 image attachments');
        expect(result.error).toContain("'first.png' (1-IMG00001)");
        expect(result.error).toContain("'second.jpg' (1-IMG00002)");
    });

    it('rejects a regular item with no image attachments', async () => {
        const pdf = makeAttachment({
            id: 11,
            key: 'PDF00001',
            contentType: 'application/pdf',
        });
        const regular = makeRegularItem({ attachmentIds: [11] });
        itemsById.set(11, pdf);

        const result = await resolveToImageAttachment(regular, '1-REG00001');

        expect(result).toEqual({
            resolved: false,
            error: "The id '1-REG00001' is a regular item, not an attachment. The item has no image attachments.",
            error_code: 'not_attachment',
        });
    });

    it('returns a resolution error when the single image attachment disappears', async () => {
        const image = makeAttachment({ id: 10, key: 'IMG00001', filename: 'figure.png' });
        const regular = makeRegularItem({ attachmentIds: [10] });
        itemsById.set(10, image);

        const result = await resolveToImageAttachment(regular, '1-REG00001');

        expect(result).toMatchObject({
            resolved: false,
            error_code: 'not_attachment',
            error: "The id '1-REG00001' is a regular item with one image attachment ('figure.png' (1-IMG00001)) but it could not be resolved.",
        });
    });

    it('rejects notes', async () => {
        const note = {
            isAttachment: vi.fn(() => false),
            isRegularItem: vi.fn(() => false),
            isNote: vi.fn(() => true),
            isAnnotation: vi.fn(() => false),
        } as unknown as MockItem;

        const result = await resolveToImageAttachment(note, '1-NOTE0001');

        expect(result).toEqual({
            resolved: false,
            error: "The id '1-NOTE0001' is a note, not an attachment.",
            error_code: 'not_attachment',
        });
    });
});
