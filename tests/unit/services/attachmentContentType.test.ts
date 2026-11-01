import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import {
    canUseReaderContentType,
    ensureReaderContentType,
} from '../../../src/services/attachmentContentType';
import { canonicalContentTypeCorrection } from '../../../src/utils/attachmentFiles';

type Item = Parameters<typeof ensureReaderContentType>[0];

function makeAttachment(contentType: string, filename: string, linkMode = 0) {
    return {
        libraryID: 1,
        libraryKey: '1/ATTACH01',
        attachmentContentType: contentType,
        attachmentFilename: filename,
        attachmentLinkMode: linkMode,
        isAttachment: () => true,
        getFilePathAsync: vi.fn(async () => `/storage/ATTACH01/${filename}`),
        saveTx: vi.fn(async () => {}),
    };
}

describe('attachment content type correction', () => {
    let sniffed: string | false;
    let editable: boolean;

    beforeEach(() => {
        sniffed = 'application/pdf';
        editable = true;
        (globalThis as any).Zotero.Attachments = { LINK_MODE_LINKED_URL: 3 };
        (globalThis as any).Zotero.Libraries = { get: vi.fn(() => ({ editable })) };
        (globalThis as any).Zotero.File = { getSample: vi.fn(async () => '%PDF-1.7 sample') };
        (globalThis as any).Zotero.MIME = { sniffForMIMEType: vi.fn(() => sniffed) };
    });

    it('reports which canonical type a mislabelled document needs', () => {
        expect(canonicalContentTypeCorrection(makeAttachment('application/octet-stream', 'a.pdf') as unknown as Item))
            .toBe('application/pdf');
        expect(canonicalContentTypeCorrection(makeAttachment('application/epub', 'b.epub') as unknown as Item))
            .toBe('application/epub+zip');
        expect(canonicalContentTypeCorrection(makeAttachment('application/pdf', 'c.pdf') as unknown as Item))
            .toBeNull();
        expect(canonicalContentTypeCorrection(makeAttachment('application/msword', 'd.pdf') as unknown as Item))
            .toBeNull();
    });

    it('leaves a correctly typed attachment untouched', async () => {
        const item = makeAttachment('application/pdf', 'paper.pdf');

        await expect(ensureReaderContentType(item as unknown as Item)).resolves.toBe(true);
        expect(Zotero.File.getSample).not.toHaveBeenCalled();
        expect(item.saveTx).not.toHaveBeenCalled();
    });

    it('rewrites a mislabelled PDF once its leading bytes confirm it', async () => {
        const item = makeAttachment('application/octet-stream', 'paper.pdf');

        await expect(ensureReaderContentType(item as unknown as Item)).resolves.toBe(true);
        expect(Zotero.File.getSample).toHaveBeenCalledWith('/storage/ATTACH01/paper.pdf');
        expect(item.attachmentContentType).toBe('application/pdf');
        expect(item.saveTx).toHaveBeenCalledOnce();
    });

    it('rewrites the incorrect application/epub type to application/epub+zip', async () => {
        sniffed = 'application/epub+zip';
        const item = makeAttachment('application/epub', 'book.epub');

        await expect(ensureReaderContentType(item as unknown as Item)).resolves.toBe(true);
        expect(item.attachmentContentType).toBe('application/epub+zip');
        expect(item.saveTx).toHaveBeenCalledOnce();
    });

    it('does not rewrite a file whose bytes do not match its extension', async () => {
        sniffed = false;
        const item = makeAttachment('', 'not-really.pdf');

        await expect(ensureReaderContentType(item as unknown as Item)).resolves.toBe(false);
        expect(item.attachmentContentType).toBe('');
        expect(item.saveTx).not.toHaveBeenCalled();
    });

    it('does not write to a read-only library', async () => {
        editable = false;
        const item = makeAttachment('application/octet-stream', 'paper.pdf');

        await expect(ensureReaderContentType(item as unknown as Item)).resolves.toBe(false);
        expect(Zotero.File.getSample).not.toHaveBeenCalled();
        expect(item.saveTx).not.toHaveBeenCalled();
    });


    it('treats a missing local file as unconfirmed', async () => {
        const item = makeAttachment('application/octet-stream', 'paper.pdf');
        item.getFilePathAsync.mockResolvedValue(false as any);

        await expect(ensureReaderContentType(item as unknown as Item)).resolves.toBe(false);
        expect(item.saveTx).not.toHaveBeenCalled();
    });

    it('checks whether a correction would succeed without writing', async () => {
        const item = makeAttachment('application/octet-stream', 'paper.pdf');

        await expect(canUseReaderContentType(item as unknown as Item)).resolves.toBe(true);
        expect(item.attachmentContentType).toBe('application/octet-stream');
        expect(item.saveTx).not.toHaveBeenCalled();

        sniffed = false;
        await expect(canUseReaderContentType(item as unknown as Item)).resolves.toBe(false);
    });
});
