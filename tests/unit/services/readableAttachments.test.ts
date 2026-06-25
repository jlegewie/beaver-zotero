import { describe, expect, it } from 'vitest';
import { createMockAttachment, createMockItem, type MockAttachmentOptions, type MockItemOptions } from '../../helpers/factories';
import {
    getReadableContentKind,
    isAgentReadableAttachment,
    isLocallyReadableAttachment,
    liveAttachmentContentKind,
    resolveToReadableAttachment,
} from '../../../src/services/documentExtraction/attachmentResolution';
import { hasSnapshotContentType } from '../../../src/utils/attachmentFiles';

type ReadableItem = Parameters<typeof getReadableContentKind>[0];
const LINK_MODE_LINKED_URL = 3;

function asReadableAttachment(opts: MockAttachmentOptions = {}): ReadableItem {
    return createMockAttachment(opts) as unknown as ReadableItem;
}

function asReadableItem(opts: MockItemOptions = {}): ReadableItem {
    return createMockItem(opts) as unknown as ReadableItem;
}

describe('readable attachment predicates', () => {
    describe('getReadableContentKind', () => {
        it('detects PDFs from the native attachment predicate', () => {
            const item = asReadableAttachment({
                contentType: 'application/octet-stream',
                isPDF: true,
            });

            expect(getReadableContentKind(item)).toBe('pdf');
        });

        it('detects EPUBs from the native predicate and MIME fallback', () => {
            const native = asReadableAttachment({
                contentType: 'application/octet-stream',
                isEPUB: true,
            });
            const mime = asReadableAttachment({
                contentType: 'application/epub+zip',
                isEPUB: false,
            });

            expect(getReadableContentKind(native)).toBe('epub');
            expect(getReadableContentKind(mime)).toBe('epub');
        });

        it('detects images from the native predicate and MIME fallback', () => {
            const native = asReadableAttachment({
                contentType: 'application/octet-stream',
                isImage: true,
            });
            const mime = asReadableAttachment({
                contentType: 'image/png',
                isImage: false,
            });

            expect(getReadableContentKind(native)).toBe('image');
            expect(getReadableContentKind(mime)).toBe('image');
        });

        it('detects snapshots and text attachments from content type', () => {
            expect(getReadableContentKind(
                asReadableAttachment({ contentType: 'text/html' }),
            )).toBe('snapshot');
            expect(getReadableContentKind(
                asReadableAttachment({ contentType: 'application/xhtml+xml' }),
            )).toBe('snapshot');
            expect(getReadableContentKind(
                asReadableAttachment({ contentType: 'text/plain' }),
            )).toBe('text');
            expect(getReadableContentKind(
                asReadableAttachment({ contentType: 'text/markdown' }),
            )).toBe('text');
        });

        it('returns null for unknown types and non-attachments', () => {
            expect(getReadableContentKind(
                asReadableAttachment({ contentType: 'application/octet-stream' }),
            )).toBeNull();
            expect(getReadableContentKind(asReadableItem())).toBeNull();
        });

        it('does not call the native image predicate when content type is missing', () => {
            const item = {
                ...asReadableAttachment({ contentType: '' }),
                attachmentContentType: null,
                isImageAttachment: () => {
                    throw new Error('native image predicate requires a MIME type');
                },
            };

            expect(getReadableContentKind(item)).toBeNull();
        });
    });

    it('preserves live attachment content kind parity for extractor-supported types', () => {
        expect(liveAttachmentContentKind(
            asReadableAttachment({ contentType: 'application/pdf' }),
        )).toBe('pdf');
        expect(liveAttachmentContentKind(
            asReadableAttachment({ contentType: 'application/epub+zip' }),
        )).toBe('epub');
        expect(liveAttachmentContentKind(
            asReadableAttachment({ contentType: 'text/html' }),
        )).toBe('snapshot');
        expect(liveAttachmentContentKind(
            asReadableAttachment({ contentType: 'text/plain' }),
        )).toBe('text');
        expect(liveAttachmentContentKind(
            asReadableAttachment({ contentType: 'image/png' }),
        )).toBeNull();
    });

    it('requires an attachment to be readable and not a linked URL for agent readability', () => {
        expect(isAgentReadableAttachment(
            asReadableAttachment({ contentType: 'application/pdf' }),
        )).toBe(true);
        expect(isAgentReadableAttachment(
            asReadableAttachment({ contentType: 'application/epub+zip' }),
        )).toBe(true);
        expect(isAgentReadableAttachment(
            asReadableAttachment({ contentType: 'image/png' }),
        )).toBe(true);
        expect(isAgentReadableAttachment(
            asReadableAttachment({ contentType: 'text/html' }),
        )).toBe(true);
        expect(isAgentReadableAttachment(
            asReadableAttachment({ contentType: 'text/plain' }),
        )).toBe(true);

        expect(isAgentReadableAttachment(
            asReadableAttachment({
                contentType: 'text/html',
                linkMode: LINK_MODE_LINKED_URL,
            }),
        )).toBe(false);
        expect(isAgentReadableAttachment(
            asReadableAttachment({ contentType: 'application/octet-stream' }),
        )).toBe(false);
    });

    it('requires agent readability and a local file for local readability', async () => {
        expect(await isLocallyReadableAttachment(
            asReadableAttachment({ contentType: 'application/pdf', fileExists: true }),
        )).toBe(true);
        expect(await isLocallyReadableAttachment(
            asReadableAttachment({ contentType: 'application/pdf', fileExists: false }),
        )).toBe(false);
        expect(await isLocallyReadableAttachment(
            asReadableAttachment({
                contentType: 'text/html',
                linkMode: LINK_MODE_LINKED_URL,
                fileExists: true,
            }),
        )).toBe(false);
    });

    it('recognizes snapshot content types only on attachments', () => {
        expect(hasSnapshotContentType(
            asReadableAttachment({ contentType: 'text/html' }),
        )).toBe(true);
        expect(hasSnapshotContentType(
            asReadableAttachment({ contentType: 'application/xhtml+xml' }),
        )).toBe(true);
        expect(hasSnapshotContentType(
            asReadableAttachment({ contentType: 'text/plain' }),
        )).toBe(false);
        expect(hasSnapshotContentType(asReadableItem({
            isAttachment: false,
            attachmentContentType: 'text/html',
        }))).toBe(false);
    });
});

describe('resolveToReadableAttachment', () => {
    function makeRegularItem(attachments: Array<ReadableItem>, bestAttachment: ReadableItem | null = null): ReadableItem {
        return {
            ...createMockItem({
                id: 100,
                key: 'REG00001',
                isRegularItem: true,
                isAttachment: false,
                isNote: false,
                attachmentIDs: attachments.map((attachment: any) => attachment.id),
            }),
            getBestAttachment: async () => bestAttachment,
        } as unknown as ReadableItem;
    }

    function installItemLookups(attachments: Array<ReadableItem>) {
        const byId = new Map<number, ReadableItem>();
        const byKey = new Map<string, ReadableItem>();
        for (const attachment of attachments as any[]) {
            byId.set(attachment.id, attachment);
            byKey.set(`${attachment.libraryID}-${attachment.key}`, attachment);
        }
        (globalThis as any).Zotero.Items = {
            loadDataTypes: async () => undefined,
            getAsync: async (ids: number[]) => ids.map((id) => byId.get(id)).filter(Boolean),
            getByLibraryAndKeyAsync: async (libraryID: number, key: string) =>
                byKey.get(`${libraryID}-${key}`) ?? false,
        };
    }

    it('returns a direct readable attachment with its kind and content type', async () => {
        const attachment = asReadableAttachment({
            key: 'TEXT1234',
            contentType: 'text/plain',
        });

        await expect(resolveToReadableAttachment(attachment, '1-TEXT1234')).resolves.toMatchObject({
            resolved: true,
            item: attachment,
            key: '1-TEXT1234',
            contentKind: 'text',
            contentType: 'text/plain',
        });
    });

    it('rejects linked URLs and unsupported attachment types', async () => {
        await expect(resolveToReadableAttachment(
            asReadableAttachment({
                key: 'LINK1234',
                contentType: 'text/html',
                linkMode: LINK_MODE_LINKED_URL,
            }),
            '1-LINK1234',
        )).resolves.toMatchObject({
            resolved: false,
            error_code: 'is_linked_url',
        });

        await expect(resolveToReadableAttachment(
            asReadableAttachment({
                key: 'BIN12345',
                contentType: 'application/octet-stream',
            }),
            '1-BIN12345',
        )).resolves.toMatchObject({
            resolved: false,
            error_code: 'not_readable',
        });
    });

    it('resolves a regular item to its only readable child', async () => {
        const text = asReadableAttachment({
            id: 10,
            key: 'TEXT1234',
            contentType: 'text/plain',
        });
        const regular = makeRegularItem([text], text);
        installItemLookups([text]);

        const result = await resolveToReadableAttachment(regular, '1-REG00001');

        expect(result).toMatchObject({
            resolved: true,
            item: text,
            key: '1-TEXT1234',
            contentKind: 'text',
        });
    });

    it('prefers a single PDF child over other readable children', async () => {
        const pdf = asReadableAttachment({
            id: 10,
            key: 'PDF12345',
            contentType: 'application/pdf',
            isPDF: true,
        });
        const text = asReadableAttachment({
            id: 11,
            key: 'TEXT1234',
            contentType: 'text/plain',
        });
        const regular = makeRegularItem([pdf, text], text);
        installItemLookups([pdf, text]);

        const result = await resolveToReadableAttachment(regular, '1-REG00001');

        expect(result).toMatchObject({
            resolved: true,
            item: pdf,
            key: '1-PDF12345',
            contentKind: 'pdf',
        });
    });

    it('uses Zotero best attachment when multiple readable non-PDF children exist', async () => {
        const text = asReadableAttachment({
            id: 10,
            key: 'TEXT1234',
            contentType: 'text/plain',
        });
        const epub = asReadableAttachment({
            id: 11,
            key: 'EPUB1234',
            contentType: 'application/epub+zip',
        });
        const regular = makeRegularItem([text, epub], epub);
        installItemLookups([text, epub]);

        const result = await resolveToReadableAttachment(regular, '1-REG00001');

        expect(result).toMatchObject({
            resolved: true,
            item: epub,
            key: '1-EPUB1234',
            contentKind: 'epub',
        });
    });

    it('ignores linked URL children when resolving a regular item', async () => {
        const linkedSnapshot = asReadableAttachment({
            id: 10,
            key: 'LINK1234',
            contentType: 'text/html',
            linkMode: LINK_MODE_LINKED_URL,
        });
        const text = asReadableAttachment({
            id: 11,
            key: 'TEXT1234',
            contentType: 'text/plain',
        });
        const regular = makeRegularItem([linkedSnapshot, text], linkedSnapshot);
        installItemLookups([linkedSnapshot, text]);

        const result = await resolveToReadableAttachment(regular, '1-REG00001');

        expect(result).toMatchObject({
            resolved: true,
            item: text,
            key: '1-TEXT1234',
            contentKind: 'text',
        });
    });
});
