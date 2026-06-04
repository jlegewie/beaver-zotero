import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    getReadableContentKind,
    hasReadableAttachment,
    isReadableAttachment,
    isReadableItem,
} from '../../../src/services/documentExtraction/readableAttachments';
import {
    createMockAttachment,
    createMockItem,
    createMockNote,
} from '../../helpers/factories';

describe('readable attachment classification', () => {
    let itemsById: Map<number, Zotero.Item>;

    beforeEach(() => {
        vi.clearAllMocks();
        itemsById = new Map();
        (globalThis as any).Zotero.Items = {
            loadDataTypes: vi.fn(async () => undefined),
            getAsync: vi.fn(async (ids: number[]) =>
                ids.map((id) => itemsById.get(id)).filter(Boolean),
            ),
        };
    });

    it.each([
        ['application/pdf', 'paper.pdf', 'pdf'],
        ['application/epub+zip', 'book.epub', 'epub'],
        ['text/html', 'snapshot.html', 'snapshot'],
        ['text/plain', 'notes.txt', 'text'],
        ['text/markdown', 'notes.md', 'text'],
        ['image/png', 'figure.png', 'image'],
    ] as const)('classifies %s as %s', (contentType, filename, expectedKind) => {
        const attachment = createMockAttachment({ contentType, filename }) as Zotero.Item;

        expect(getReadableContentKind(attachment)).toBe(expectedKind);
        expect(isReadableAttachment(attachment)).toBe(true);
        expect(isReadableItem(attachment)).toBe(true);
    });

    it('rejects linked URL attachments', () => {
        const attachment = createMockAttachment({
            contentType: 'text/html',
            linkMode: Zotero.Attachments.LINK_MODE_LINKED_URL,
        }) as Zotero.Item;

        expect(getReadableContentKind(attachment)).toBeNull();
        expect(isReadableItem(attachment)).toBe(false);
    });

    it('admits linked file PDFs', () => {
        const attachment = createMockAttachment({
            contentType: 'application/pdf',
            linkMode: Zotero.Attachments.LINK_MODE_LINKED_FILE,
        }) as Zotero.Item;

        expect(getReadableContentKind(attachment)).toBe('pdf');
    });

    it('rejects unsupported MIME types', () => {
        const attachment = createMockAttachment({
            contentType: 'application/zip',
            filename: 'archive.zip',
        }) as Zotero.Item;

        expect(getReadableContentKind(attachment)).toBeNull();
        expect(isReadableAttachment(attachment)).toBe(false);
    });

    it.each([
        Zotero.Attachments.LINK_MODE_IMPORTED_URL,
        Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
        Zotero.Attachments.LINK_MODE_LINKED_FILE,
    ])('classifies text/html link mode %s as snapshot', (linkMode) => {
        const attachment = createMockAttachment({
            contentType: 'text/html',
            linkMode,
            filename: 'page.html',
        }) as Zotero.Item;

        expect(getReadableContentKind(attachment)).toBe('snapshot');
    });

    it('does not classify linked URL text/html as a snapshot', () => {
        const attachment = createMockAttachment({
            contentType: 'text/html',
            linkMode: Zotero.Attachments.LINK_MODE_LINKED_URL,
        }) as Zotero.Item;

        expect(getReadableContentKind(attachment)).toBeNull();
    });

    it('classifies embedded image attachments as images', () => {
        const attachment = createMockAttachment({
            contentType: 'image/png',
            linkMode: Zotero.Attachments.LINK_MODE_EMBEDDED_IMAGE,
        }) as Zotero.Item;

        expect(getReadableContentKind(attachment)).toBe('image');
    });

    it('handles non-attachment item kinds', () => {
        const regular = createMockItem() as Zotero.Item;
        const note = createMockNote() as Zotero.Item;
        const annotation = createMockItem({
            itemType: 'annotation',
            isAnnotation: true,
        }) as Zotero.Item;

        expect(getReadableContentKind(regular)).toBeNull();
        expect(getReadableContentKind(note)).toBeNull();
        expect(getReadableContentKind(annotation)).toBeNull();
        expect(isReadableItem(regular)).toBe(true);
        expect(isReadableAttachment(regular)).toBe(false);
    });

    it('returns true when a regular item has a readable child attachment', async () => {
        const attachment = createMockAttachment({
            id: 10,
            contentType: 'application/epub+zip',
        }) as Zotero.Item;
        const item = createMockItem({ attachmentIDs: [10] }) as Zotero.Item;
        itemsById.set(10, attachment);

        await expect(hasReadableAttachment(item)).resolves.toBe(true);
        expect(Zotero.Items.loadDataTypes).toHaveBeenCalledWith([item], ['childItems']);
        expect(Zotero.Items.loadDataTypes).toHaveBeenCalledWith([attachment], ['itemData']);
    });

    it('returns false when children are trashed or unsupported', async () => {
        const trashedPdf = createMockAttachment({
            id: 10,
            contentType: 'application/pdf',
            deleted: true,
        }) as Zotero.Item;
        const unsupported = createMockAttachment({
            id: 11,
            contentType: 'application/zip',
        }) as Zotero.Item;
        const item = createMockItem({ attachmentIDs: [10, 11] }) as Zotero.Item;
        itemsById.set(10, trashedPdf);
        itemsById.set(11, unsupported);

        await expect(hasReadableAttachment(item)).resolves.toBe(false);
    });
});
