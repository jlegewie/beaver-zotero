import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAttachment, createMockItem } from '../../helpers/factories';
import type {
    AnnotationAttachment,
    ItemMetadataAttachment,
    MessageAttachment,
    NoteAttachment,
    SourceAttachment,
} from '../../../react/types/attachments/apiTypes';

vi.mock('../../../src/utils/zoteroSerializers', () => ({
    safeStub: vi.fn((build: () => unknown) => {
        try {
            return build();
        } catch {
            return undefined;
        }
    }),
    serializeItemStub: vi.fn((item: any) => ({
        item_id: `${item.libraryID}-${item.key}`,
        item_type: item.itemType,
        title: item.getField?.('title') || null,
        creators: null,
        year: null,
    })),
    serializeAttachmentStub: vi.fn((item: any) => ({
        attachment_id: `${item.libraryID}-${item.key}`,
        parent_item_id: item.parentKey ? `${item.libraryID}-${item.parentKey}` : null,
        title: item.getField?.('title') || null,
        filename: item.attachmentFilename || null,
        content_kind: item.attachmentContentType === 'application/epub+zip' ? 'epub' : 'pdf',
    })),
}));

import { enrichMessageAttachmentStub } from '../../../react/types/attachments/converters';
import { serializeAttachmentStub, serializeItemStub } from '../../../src/utils/zoteroSerializers';

type MockZoteroItem = Parameters<typeof enrichMessageAttachmentStub>[1];

describe('enrichMessageAttachmentStub', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('adds an item stub to legacy item attachments', () => {
        const item = createMockItem({
            key: 'ITEM1234',
            fields: { title: 'Display Title' },
            itemType: 'book',
        }) as unknown as MockZoteroItem;
        const attachment: ItemMetadataAttachment = {
            type: 'item',
            library_id: 1,
            zotero_key: 'ITEM1234',
        };

        enrichMessageAttachmentStub(attachment, item);

        expect(attachment.item).toEqual({
            item_id: '1-ITEM1234',
            item_type: 'book',
            title: 'Display Title',
            creators: null,
            year: null,
        });
        expect(serializeItemStub).toHaveBeenCalledWith(item);
    });

    it('adds attachment and parent item stubs to legacy source attachments', () => {
        const parent = createMockItem({
            key: 'PARENT12',
            fields: { title: 'Parent Item' },
            itemType: 'journalArticle',
        });
        const item = createMockAttachment({
            key: 'SOURCE12',
            contentType: 'application/epub+zip',
        }) as any;
        item.parentItem = parent;
        item.parentKey = parent.key;
        const attachment: SourceAttachment = {
            type: 'source',
            library_id: 1,
            zotero_key: 'SOURCE12',
            include: 'fulltext',
        };

        enrichMessageAttachmentStub(attachment, item as MockZoteroItem);

        expect(attachment.attachment).toEqual({
            attachment_id: '1-SOURCE12',
            parent_item_id: '1-PARENT12',
            title: null,
            filename: null,
            content_kind: 'epub',
        });
        expect(attachment.parent_item).toEqual({
            item_id: '1-PARENT12',
            item_type: 'journalArticle',
            title: 'Parent Item',
            creators: null,
            year: null,
        });
        expect(serializeAttachmentStub).toHaveBeenCalledWith(item);
        expect(serializeItemStub).toHaveBeenCalledWith(parent);
    });

    it('leaves already-stubbed attachments unchanged', () => {
        const item = createMockAttachment({ key: 'SOURCE12' }) as unknown as MockZoteroItem;
        const attachment: SourceAttachment = {
            type: 'source',
            library_id: 1,
            zotero_key: 'SOURCE12',
            include: 'fulltext',
            attachment: {
                attachment_id: 'existing-attachment',
                parent_item_id: null,
                title: 'Existing Attachment',
                filename: null,
                content_kind: 'pdf',
            },
            parent_item: {
                item_id: 'existing-parent',
                item_type: 'book',
                title: 'Existing Parent',
                creators: 'Author',
                year: 2024,
            },
        };
        const originalAttachmentStub = attachment.attachment;
        const originalParentStub = attachment.parent_item;

        enrichMessageAttachmentStub(attachment, item);

        expect(attachment.attachment).toBe(originalAttachmentStub);
        expect(attachment.parent_item).toBe(originalParentStub);
        expect(serializeAttachmentStub).not.toHaveBeenCalled();
        expect(serializeItemStub).not.toHaveBeenCalled();
    });

    it('does not modify attachment types that carry inline metadata', () => {
        const item = createMockItem({ key: 'ITEM1234' }) as unknown as MockZoteroItem;
        const annotation: AnnotationAttachment = {
            type: 'annotation',
            library_id: 1,
            zotero_key: 'ANNO1234',
            parent_key: 'SOURCE12',
            annotation_type: 'highlight',
            text: 'Highlighted text',
            color: '#ffd400',
            page_label: '1',
            position: { page_index: 0, rects: [] },
            date_modified: '2024-01-01T00:00:00Z',
        };
        const note: NoteAttachment = {
            type: 'note',
            library_id: 1,
            zotero_key: 'NOTE1234',
            title: 'Note',
        };
        const attachments: MessageAttachment[] = [annotation, note];
        const snapshots = attachments.map((att) => ({ ...att }));

        for (const attachment of attachments) {
            enrichMessageAttachmentStub(attachment, item);
        }

        expect(attachments).toEqual(snapshots);
        expect(serializeAttachmentStub).not.toHaveBeenCalled();
        expect(serializeItemStub).not.toHaveBeenCalled();
    });
});
