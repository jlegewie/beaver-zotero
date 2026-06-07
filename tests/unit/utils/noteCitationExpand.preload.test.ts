import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn().mockResolvedValue(undefined),
}));

import { getAttachmentFileStatus } from '../../../src/services/agentDataProvider/utils';
import { preloadNotePageLabels } from '../../../src/utils/noteCitationExpand';

const mockGetAttachmentFileStatus = vi.mocked(getAttachmentFileStatus);

function makeRawCitation(
    key: string,
    libraryID = 1,
    { locator = '341', label }: { locator?: string; label?: string } = {},
): string {
    const citationItem: any = {
        uris: [`http://zotero.org/users/${libraryID}/items/${key}`],
    };
    if (locator !== '') citationItem.locator = locator;
    if (label !== undefined) citationItem.label = label;
    const citationData = {
        citationItems: [citationItem],
    };
    return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citationData))}">`
        + '<span class="citation-item">Author, p. 341</span></span>';
}

function makeAttachment(id: number, key: string) {
    return {
        id,
        key,
        libraryID: 1,
        attachmentContentType: 'application/pdf',
        isAttachment: () => true,
        isPDFAttachment: () => true,
        getFilePathAsync: vi.fn().mockResolvedValue(`/storage/${key}/test.pdf`),
    };
}

function makeParent(id: number, key: string, attachmentID: number) {
    return {
        id,
        key,
        libraryID: 1,
        isAttachment: () => false,
        isRegularItem: () => true,
        getAttachments: vi.fn(() => [attachmentID]),
    };
}

describe('preloadNotePageLabels', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Beaver = undefined;
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(),
            getAsync: vi.fn(),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
    });

    it('returns cached labels without extracting on a cache hit', async () => {
        const attachment = makeAttachment(42, 'ABCD1234');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ pageLabels: { 0: '341' } }),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(() => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeRawCitation('ABCD1234'), 1, { extractOnCacheMiss: true });

        expect(labels).toEqual({ '1-ABCD1234': { 0: '341' } });
        expect(cache.getMetadata).toHaveBeenCalledWith(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            '/storage/ABCD1234/test.pdf',
        );
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('keeps the default cold-cache path read-only', async () => {
        const attachment = makeAttachment(43, 'EFGH5678');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(() => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeRawCitation('EFGH5678'), 1);

        expect(labels).toEqual({});
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
        expect(cache.getMetadata).toHaveBeenCalledTimes(1);
    });

    it('extracts on an opted-in cold miss and returns the seeded labels', async () => {
        const attachment = makeAttachment(44, 'IJKL9012');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ pageLabels: { 0: '341' } }),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(() => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeRawCitation('IJKL9012'), 1, { extractOnCacheMiss: true });

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(attachment, false);
        expect(cache.getMetadata).toHaveBeenCalledTimes(2);
        expect(labels).toEqual({ '1-IJKL9012': { 0: '341' } });
    });

    it('skips citations without page locators before cache lookup or extraction', async () => {
        const attachment = makeAttachment(45, 'NOLOC123');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(() => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(
            makeRawCitation('NOLOC123', 1, { locator: '' }),
            1,
            { extractOnCacheMiss: true },
        );

        expect(labels).toEqual({});
        expect((globalThis as any).Zotero.Items.getByLibraryAndKey).not.toHaveBeenCalled();
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('skips non-page CSL locators before cache lookup or extraction', async () => {
        const attachment = makeAttachment(46, 'CHAPTER1');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(() => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(
            makeRawCitation('CHAPTER1', 1, { locator: 'xiv', label: 'chapter' }),
            1,
            { extractOnCacheMiss: true },
        );

        expect(labels).toEqual({});
        expect((globalThis as any).Zotero.Items.getByLibraryAndKey).not.toHaveBeenCalled();
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('resolves parent-item citations through the selected PDF attachment', async () => {
        const parent = makeParent(50, 'PARENT01', 77);
        const attachment = makeAttachment(77, 'ATTACH01');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ pageLabels: { 2: '343' } }),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(() => parent);
        (globalThis as any).Zotero.Items.getAsync = vi.fn(async () => [attachment]);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeRawCitation('PARENT01'), 1, { extractOnCacheMiss: true });

        expect((globalThis as any).Zotero.Items.loadDataTypes).toHaveBeenCalledWith([parent], ['childItems']);
        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(attachment, false);
        expect(labels).toEqual({ '1-PARENT01': { 2: '343' } });
    });

    it('skips malformed citation metadata without throwing', async () => {
        const cache = {
            getMetadata: vi.fn(),
        };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };
        const rawHtml = '<span class="citation" data-citation="%E0%A4%A">broken</span>';

        await expect(preloadNotePageLabels(rawHtml, 1, { extractOnCacheMiss: true })).resolves.toEqual({});
        expect(cache.getMetadata).not.toHaveBeenCalled();
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });
});
