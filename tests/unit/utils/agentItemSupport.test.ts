import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => false),
}));

vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(() => false),
    isAttachmentAvailableRemotely: vi.fn(() => false),
}));

import {
    isAgentSupportedItem,
    agentItemFilter,
    agentItemFilterAsync,
    hasAgentSupportedAttachment,
} from '../../../src/utils/agentItemSupport';
import { getPref } from '../../../src/utils/prefs';
import { isAttachmentOnServer, isAttachmentAvailableRemotely } from '../../../src/utils/webAPI';
import { createMockItem, createMockAttachment } from '../../helpers/factories';

type MockItem = ReturnType<typeof createMockItem>;

function withTrash(item: MockItem, inTrash: boolean | 'throws' = false) {
    return {
        ...item,
        isInTrash: vi.fn(() => {
            if (inTrash === 'throws') throw new Error('no trash state');
            return inTrash;
        }),
    } as unknown as Zotero.Item;
}

function regularItem(inTrash: boolean | 'throws' = false) {
    return withTrash(createMockItem({}), inTrash);
}

function pdfAttachment(opts: Parameters<typeof createMockAttachment>[0] = {}) {
    return withTrash(createMockAttachment({ contentType: 'application/pdf', ...opts }));
}

function epubAttachment(opts: Parameters<typeof createMockAttachment>[0] = {}) {
    return withTrash(createMockAttachment({ contentType: 'application/epub+zip', ...opts }));
}

describe('agentItemSupport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getPref).mockReturnValue(false);
        vi.mocked(isAttachmentOnServer).mockReturnValue(false);
        vi.mocked(isAttachmentAvailableRemotely).mockReturnValue(false);
        (globalThis as any).Zotero.Attachments = { LINK_MODE_LINKED_URL: 2 };
    });

    describe('isAgentSupportedItem', () => {
        it('accepts regular items', () => {
            expect(isAgentSupportedItem(regularItem())).toBe(true);
        });

        it('accepts PDF attachments', () => {
            expect(isAgentSupportedItem(pdfAttachment())).toBe(true);
        });

        it('accepts EPUB attachments via isEPUBAttachment()', () => {
            const item = withTrash(createMockAttachment({ contentType: '', isEPUB: true }));
            expect(isAgentSupportedItem(item)).toBe(true);
        });

        it('accepts EPUB attachments via content type when isEPUBAttachment is unavailable', () => {
            const item = epubAttachment();
            delete (item as any).isEPUBAttachment;
            expect(isAgentSupportedItem(item)).toBe(true);
        });

        it('rejects other readable kinds and unsupported types', () => {
            const text = withTrash(createMockAttachment({ contentType: 'text/plain' }));
            const image = withTrash(createMockAttachment({ contentType: 'image/png', isImage: true }));
            const word = withTrash(createMockAttachment({ contentType: 'application/msword' }));
            const note = withTrash(createMockItem({ isNote: true }));
            expect(isAgentSupportedItem(text)).toBe(false);
            expect(isAgentSupportedItem(image)).toBe(false);
            expect(isAgentSupportedItem(word)).toBe(false);
            expect(isAgentSupportedItem(note)).toBe(false);
            expect(isAgentSupportedItem(false)).toBe(false);
        });
    });

    describe('agentItemFilter', () => {
        it('rejects items in trash', () => {
            expect(agentItemFilter(regularItem(true))).toBe(false);
            expect(agentItemFilter(epubAttachment())).toBe(true);
        });

        it('rejects items with unknown trash state', () => {
            expect(agentItemFilter(regularItem('throws'))).toBe(false);
        });

        it('applies collection membership when collectionIds are given', () => {
            const item = regularItem();
            (item.getCollections as any) = vi.fn(() => [5, 7]);
            expect(agentItemFilter(item, [7])).toBe(true);
            expect(agentItemFilter(item, [9])).toBe(false);
        });
    });

    describe('agentItemFilterAsync', () => {
        it('passes attachments with a local file', async () => {
            await expect(agentItemFilterAsync(epubAttachment({ fileExists: true }))).resolves.toBe(true);
        });

        it('passes PDF attachments on the server with a synced hash', async () => {
            vi.mocked(isAttachmentOnServer).mockReturnValue(true);
            await expect(agentItemFilterAsync(pdfAttachment({ fileExists: false }))).resolves.toBe(true);
        });

        it('rejects server-only EPUBs when remote access is disabled', async () => {
            // EPUB extraction needs a local file and nothing downloads it
            // without the remote-access pref — a server copy alone is unusable.
            vi.mocked(isAttachmentOnServer).mockReturnValue(true);
            await expect(agentItemFilterAsync(epubAttachment({ fileExists: false }))).resolves.toBe(false);
        });

        it('passes server-only EPUBs when remote access is enabled', async () => {
            vi.mocked(getPref).mockImplementation((key: string) => key === 'accessRemoteFiles');
            vi.mocked(isAttachmentAvailableRemotely).mockReturnValue(true);
            await expect(agentItemFilterAsync(epubAttachment({ fileExists: false }))).resolves.toBe(true);
        });

        it('passes hashless remote attachments when remote access is enabled', async () => {
            vi.mocked(getPref).mockImplementation((key: string) => key === 'accessRemoteFiles');
            vi.mocked(isAttachmentAvailableRemotely).mockReturnValue(true);
            await expect(agentItemFilterAsync(pdfAttachment({ fileExists: false }))).resolves.toBe(true);
        });

        it('rejects hashless remote attachments when remote access is disabled', async () => {
            vi.mocked(isAttachmentAvailableRemotely).mockReturnValue(true);
            await expect(agentItemFilterAsync(pdfAttachment({ fileExists: false }))).resolves.toBe(false);
        });

        it('rejects attachments with no file anywhere', async () => {
            await expect(agentItemFilterAsync(epubAttachment({ fileExists: false }))).resolves.toBe(false);
        });

        it('passes regular items without checking files', async () => {
            await expect(agentItemFilterAsync(regularItem())).resolves.toBe(true);
        });
    });

    describe('hasAgentSupportedAttachment', () => {
        it('returns true when a regular item has an EPUB child', async () => {
            const epub = epubAttachment();
            (epub as any).deleted = false;
            const parent = regularItem();
            (parent.getAttachments as any) = vi.fn(() => [11]);
            (globalThis as any).Zotero.Items = {
                getAsync: vi.fn(async () => [epub]),
            };
            await expect(hasAgentSupportedAttachment(parent as any)).resolves.toBe(true);
        });

        it('returns false when children are unsupported or deleted', async () => {
            const text = withTrash(createMockAttachment({ contentType: 'text/plain' }));
            const deletedEpub = epubAttachment();
            (deletedEpub as any).deleted = true;
            const parent = regularItem();
            (parent.getAttachments as any) = vi.fn(() => [11, 12]);
            (globalThis as any).Zotero.Items = {
                getAsync: vi.fn(async () => [text, deletedEpub]),
            };
            await expect(hasAgentSupportedAttachment(parent as any)).resolves.toBe(false);
        });
    });
});
