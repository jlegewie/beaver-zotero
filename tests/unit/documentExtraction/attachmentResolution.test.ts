import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveToReadableAttachment } from '../../../src/services/documentExtraction/attachmentResolution';
import {
    createMockAttachment,
    createMockItem,
    createMockNote,
} from '../../helpers/factories';

describe('resolveToReadableAttachment', () => {
    let itemsById: Map<number, Zotero.Item>;
    let itemsByLibraryAndKey: Map<string, Zotero.Item>;

    beforeEach(() => {
        vi.clearAllMocks();
        itemsById = new Map();
        itemsByLibraryAndKey = new Map();
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

    it('returns a readable attachment with its content kind and type', async () => {
        const attachment = createMockAttachment({
            key: 'EPUB0001',
            contentType: 'application/epub+zip',
        }) as Zotero.Item;

        await expect(resolveToReadableAttachment(attachment, '1-EPUB0001')).resolves.toEqual({
            resolved: true,
            item: attachment,
            key: '1-EPUB0001',
            contentKind: 'epub',
            contentType: 'application/epub+zip',
        });
    });

    it('rejects linked URL attachments before the generic readability check', async () => {
        const attachment = createMockAttachment({
            key: 'LINK0001',
            contentType: 'text/html',
            linkMode: Zotero.Attachments.LINK_MODE_LINKED_URL,
        }) as Zotero.Item;

        const result = await resolveToReadableAttachment(attachment, '1-LINK0001');

        expect(result).toMatchObject({
            resolved: false,
            error_code: 'is_linked_url',
        });
    });

    it('rejects unreadable attachments', async () => {
        const attachment = createMockAttachment({
            key: 'ZIP00001',
            contentType: 'application/zip',
        }) as Zotero.Item;

        const result = await resolveToReadableAttachment(attachment, '1-ZIP00001');

        expect(result).toEqual({
            resolved: false,
            error: 'Attachment 1-ZIP00001 is not a readable document (type: application/zip)',
            error_code: 'not_readable',
        });
    });

    it.each([
        [createMockNote({ key: 'NOTE0001' }), 'note'],
        [createMockItem({ key: 'ANN00001', itemType: 'annotation', isAnnotation: true }), 'annotation'],
    ])('rejects %s items', async (item, kind) => {
        const result = await resolveToReadableAttachment(item as Zotero.Item, `1-${item.key}`);

        expect(result).toEqual({
            resolved: false,
            error: `The id '1-${item.key}' is a ${kind}, not an attachment.`,
            error_code: 'not_attachment',
        });
    });

    it('auto-resolves a regular item with one readable child', async () => {
        const attachment = createMockAttachment({
            id: 10,
            key: 'HTML0001',
            contentType: 'text/html',
            filename: 'page.html',
        }) as Zotero.Item;
        const regular = createMockItem({
            key: 'REG00001',
            attachmentIDs: [10],
            bestAttachment: attachment,
        }) as Zotero.Item;
        itemsById.set(10, attachment);
        itemsByLibraryAndKey.set('1-HTML0001', attachment);

        const result = await resolveToReadableAttachment(regular, '1-REG00001');

        expect(result).toEqual({
            resolved: true,
            item: attachment,
            key: '1-HTML0001',
            contentKind: 'snapshot',
            contentType: 'text/html',
        });
        expect(Zotero.Items.loadDataTypes).toHaveBeenCalledWith([regular], ['childItems']);
        expect(Zotero.Items.loadDataTypes).toHaveBeenCalledWith([attachment], ['itemData']);
        expect(attachment.loadAllData).toHaveBeenCalledOnce();
    });

    it('resolves a regular item with multiple readable children to the best readable child', async () => {
        const pdf = createMockAttachment({
            id: 10,
            key: 'PDF00001',
            contentType: 'application/pdf',
            filename: 'paper.pdf',
        }) as Zotero.Item;
        const snapshot = createMockAttachment({
            id: 11,
            key: 'HTML0001',
            contentType: 'text/html',
            filename: 'page.html',
        }) as Zotero.Item;
        const regular = createMockItem({
            key: 'REG00001',
            attachmentIDs: [10, 11],
            bestAttachment: pdf,
        }) as Zotero.Item;
        itemsById.set(10, pdf);
        itemsById.set(11, snapshot);
        itemsByLibraryAndKey.set('1-PDF00001', pdf);

        const result = await resolveToReadableAttachment(regular, '1-REG00001');

        expect(result).toEqual({
            resolved: true,
            item: pdf,
            key: '1-PDF00001',
            contentKind: 'pdf',
            contentType: 'application/pdf',
        });
    });

    it('does not auto-resolve a regular item whose only readable child is trashed', async () => {
        const trashed = createMockAttachment({
            id: 10,
            key: 'PDF00001',
            contentType: 'application/pdf',
            deleted: true,
        }) as Zotero.Item;
        const regular = createMockItem({
            key: 'REG00001',
            attachmentIDs: [10],
            bestAttachment: trashed,
        }) as Zotero.Item;
        itemsById.set(10, trashed);
        itemsByLibraryAndKey.set('1-PDF00001', trashed);

        const result = await resolveToReadableAttachment(regular, '1-REG00001');

        expect(result).toEqual({
            resolved: false,
            error: "The id '1-REG00001' is a regular item, not an attachment. The item has no readable attachments.",
            error_code: 'not_attachment',
        });
    });

    it('rejects a regular item with no readable children', async () => {
        const unsupported = createMockAttachment({
            id: 10,
            key: 'ZIP00001',
            contentType: 'application/zip',
        }) as Zotero.Item;
        const regular = createMockItem({
            key: 'REG00001',
            attachmentIDs: [10],
            bestAttachment: unsupported,
        }) as Zotero.Item;
        itemsById.set(10, unsupported);

        const result = await resolveToReadableAttachment(regular, '1-REG00001');

        expect(result).toEqual({
            resolved: false,
            error: "The id '1-REG00001' is a regular item, not an attachment. The item has no readable attachments.",
            error_code: 'not_attachment',
        });
    });
});
