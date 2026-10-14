import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(),
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn().mockResolvedValue(undefined),
    checkLibraryExcluded: vi.fn(() => null),
}));

vi.mock('../../../src/utils/zoteroDataLoading', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/utils/zoteroDataLoading')>()),
    ensureLibraryItemsLoaded: vi.fn().mockResolvedValue(undefined),
}));

import { checkLibraryExcluded, getAttachmentFileStatus } from '../../../src/services/agentDataProvider/utils';
import { ensureCitedLibrariesLoaded, preloadNotePageLabels, preloadPageLabelsForNewCitations } from '../../../src/utils/noteCitationExpand';
import { ensureLibraryItemsLoaded } from '../../../src/utils/zoteroDataLoading';

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

function makeRemoteOnlyAttachment(id: number, key: string) {
    return {
        ...makeAttachment(id, key),
        getFilePathAsync: vi.fn().mockResolvedValue(null),
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
        // Left unresolvable so item ids keep their legacy numeric form; the
        // link-citation tests opt in through `makeLinkCitation`.
        delete (globalThis as any).Zotero.Libraries.userLibraryID;
        (globalThis as any).Zotero.Items = {
            // Cited items live in a library that is not loaded yet: only the
            // async lookups can reach them.
            getByLibraryAndKey: vi.fn(() => {
                throw new Error('UnloadedDataException: Item not yet loaded');
            }),
            getByLibraryAndKeyAsync: vi.fn(),
            getAsync: vi.fn(),
            loadDataTypes: vi.fn().mockResolvedValue(undefined),
        };
    });

    /**
     * A saved standalone-attachment citation. Its library comes from the
     * `zotero://` scope, so the user library has to be resolvable.
     */
    function makeLinkCitation(key: string, suffix = ', p. 3'): string {
        (globalThis as any).Zotero.Libraries.userLibraryID = 1;
        return `<p>Source (<a href="zotero://open/library/items/${key}?page=5"`
            + ` rel="noopener noreferrer nofollow">Report.pdf</a>${suffix})</p>`;
    }

    function makeMetaCitation(key: string, beaver: Record<string, unknown>, locator = '100'): string {
        const data = { citationItems: [{ uris: [`http://zotero.org/users/1/items/${key}`], locator, beaver }] };
        return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(data))}">(A, p. ${locator})</span>`;
    }

    it('skips labels for a citation that reads back with the locator Beaver recorded', async () => {
        const attachment = makeAttachment(42, 'ATTACH01');
        const cache = { getMetadata: vi.fn() };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (_lib: number, key: string) =>
            key === 'ATTACH01' ? attachment : null);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const html = makeMetaCitation('PARENT01', { v: 1, loc: 's5', att: 'ATTACH01' });
        expect(await preloadNotePageLabels(html, 1)).toEqual({});
        expect(cache.getMetadata).not.toHaveBeenCalled();
    });

    it('skips labels for an annotation citation, which reads back without a locator', async () => {
        const cache = { getMetadata: vi.fn() };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (_lib: number, key: string) =>
            key === 'ANNOT001' ? { key } : null);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const html = makeMetaCitation('PARENT01', { v: 1, ann: 'ANNOT001' }, '7');
        expect(await preloadNotePageLabels(html, 1)).toEqual({});
        expect(cache.getMetadata).not.toHaveBeenCalled();
    });

    it('keys labels to the cited attachment when the metadata records no locator', async () => {
        const attachment = makeAttachment(42, 'ATTACH01');
        const cache = { getMetadata: vi.fn().mockResolvedValue({ pageLabels: { 1: '100' } }) };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (_lib: number, key: string) =>
            key === 'ATTACH01' ? attachment : null);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const html = makeMetaCitation('PARENT01', { v: 1, att: 'ATTACH01' });
        expect(await preloadNotePageLabels(html, 1)).toEqual({ '1-ATTACH01': { 1: '100' } });
    });

    it('loads the parent item\'s labels when the recorded attachment is gone', async () => {
        const attachment = makeAttachment(42, 'ATTACH02');
        const parent = makeParent(41, 'PARENT01', 42);
        const cache = { getMetadata: vi.fn().mockResolvedValue({ pageLabels: { 1: '100' } }) };
        // Zotero answers an unknown key with a plain `false`, not a promise.
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn((_lib: number, key: string) =>
            key === 'PARENT01' ? Promise.resolve(parent) : false);
        (globalThis as any).Zotero.Items.getAsync = vi.fn(async () => [attachment]);
        (globalThis as any).Zotero.Items.get = vi.fn(() => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const html = makeMetaCitation('PARENT01', { v: 1, loc: 's5', att: 'GONE0001' });
        expect(await preloadNotePageLabels(html, 1)).toEqual({ '1-PARENT01': { 1: '100' } });
    });

    it('seeds labels from a standalone attachment link, which carries no data-citation', async () => {
        const attachment = makeAttachment(42, 'ABCD1234');
        const cache = { getMetadata: vi.fn().mockResolvedValue({ pageLabels: { 4: '3' } }) };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeLinkCitation('ABCD1234'), 1);

        expect(labels).toEqual({ 'u-ABCD1234': { 4: '3' } });
    });

    it.each([
        ['a link with no locator', ''],
        ['a locator that is not a page', ', section 2'],
    ])('skips %s', async (_label, suffix) => {
        const cache = { getMetadata: vi.fn() };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => makeAttachment(42, 'ABCD1234'));
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        expect(await preloadNotePageLabels(makeLinkCitation('ABCD1234', suffix), 1)).toEqual({});
        expect(cache.getMetadata).not.toHaveBeenCalled();
    });

    it('does not read an excluded library\'s cached extraction', async () => {
        vi.mocked(checkLibraryExcluded).mockReturnValue({ message: 'Library excluded' } as any);
        const cache = { getMetadata: vi.fn() };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => makeAttachment(42, 'ABCD1234'));
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        expect(await preloadNotePageLabels(makeLinkCitation('ABCD1234'), 1)).toEqual({});
        expect(cache.getMetadata).not.toHaveBeenCalled();
        vi.mocked(checkLibraryExcluded).mockReturnValue(null);
    });

    /** A native citation of a group item, as written into a My Library note. */
    function makeGroupCitation(key: string): string {
        (globalThis as any).Zotero.Libraries.userLibraryID = 1;
        (globalThis as any).Zotero.Groups = {
            getGroupIDFromLibraryID: vi.fn((libraryID: number) => libraryID === 7 ? 6073928 : false),
        };
        (globalThis as any).Zotero.URI = {
            getURIItemLibraryKey: vi.fn((uri: string) => {
                const m = uri.match(/\/groups\/6073928\/items\/([A-Z0-9]+)$/);
                return m ? { libraryID: 7, key: m[1] } : false;
            }),
        };
        const citationData = {
            citationItems: [{ uris: [`http://zotero.org/groups/6073928/items/${key}`], locator: '341' }],
        };
        return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(citationData))}">`
            + '<span class="citation-item">Author, p. 341</span></span>';
    }

    /** Item lookups that only find `item` in `libraryID`, through either API. */
    function mockItemLookups(libraryID: number, item: any): void {
        const lookup = (lib: number, key: string) => (lib === libraryID && key === item.key ? item : null);
        (globalThis as any).Zotero.Items.getByLibraryAndKey = vi.fn(lookup);
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async (lib: number, key: string) => lookup(lib, key));
    }

    it('loads a cited group item\'s labels from its own library, not the note\'s', async () => {
        const attachment = { ...makeAttachment(42, 'GROUPKEY'), libraryID: 7 };
        const cache = { getMetadata: vi.fn().mockResolvedValue({ pageLabels: { 0: '341' } }) };
        mockItemLookups(7, attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeGroupCitation('GROUPKEY'), 1);

        expect(labels).toEqual({ 'g6073928-GROUPKEY': { 0: '341' } });
    });

    it('does not read labels for a citation into an excluded library', async () => {
        vi.mocked(checkLibraryExcluded).mockImplementation(
            (libraryID: number) => (libraryID === 7 ? { message: 'Library excluded' } : null) as any,
        );
        const cache = { getMetadata: vi.fn() };
        mockItemLookups(7, { ...makeAttachment(42, 'GROUPKEY'), libraryID: 7 });
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        expect(await preloadNotePageLabels(makeGroupCitation('GROUPKEY'), 1)).toEqual({});
        expect(cache.getMetadata).not.toHaveBeenCalled();
        vi.mocked(checkLibraryExcluded).mockReturnValue(null);
    });

    it('returns cached labels without extracting on a cache hit', async () => {
        const attachment = makeAttachment(42, 'ABCD1234');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ pageLabels: { 0: '341' } }),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeRawCitation('ABCD1234'), 1, { extractOnCacheMiss: true });

        expect(labels).toEqual({ '1-ABCD1234': { 0: '341' } });
        expect(cache.getMetadata).toHaveBeenCalledWith(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            '/storage/ABCD1234/test.pdf',
        );
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('returns the labels the PDF declares, not printed labels, as note locators', async () => {
        const attachment = makeAttachment(42, 'ABCD1234');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({
                pageLabels: { 0: '1' },
                derivedPageLabels: { 0: '1201' },
            }),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeRawCitation('ABCD1234'), 1);

        expect(labels).toEqual({ '1-ABCD1234': { 0: '1' } });
    });

    it('keeps the default cold-cache path read-only', async () => {
        const attachment = makeAttachment(43, 'EFGH5678');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
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
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeRawCitation('IJKL9012'), 1, { extractOnCacheMiss: true });

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(attachment, false);
        expect(cache.getMetadata).toHaveBeenCalledTimes(2);
        expect(labels).toEqual({ '1-IJKL9012': { 0: '341' } });
    });

    it('uses cached remote-only labels without downloading by default', async () => {
        const attachment = makeRemoteOnlyAttachment(47, 'REMOTE01');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ pageLabels: { 0: 'i' } }),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeRawCitation('REMOTE01'), 1, { extractOnCacheMiss: true });

        expect(labels).toEqual({ '1-REMOTE01': { 0: 'i' } });
        expect(cache.getMetadata).toHaveBeenCalledWith(
            { libraryId: 1, zoteroKey: 'REMOTE01' },
            'remote:k:1-REMOTE01-v0',
        );
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('does not download remote-only attachments on a cold miss by default', async () => {
        const attachment = makeRemoteOnlyAttachment(48, 'REMOTE02');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(makeRawCitation('REMOTE02'), 1, { extractOnCacheMiss: true });

        expect(labels).toEqual({});
        expect(cache.getMetadata).toHaveBeenCalledTimes(1);
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('downloads remote-only attachments on a cold miss when explicitly allowed', async () => {
        const attachment = makeRemoteOnlyAttachment(49, 'REMOTE03');
        const cache = {
            getMetadata: vi.fn()
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ pageLabels: { 0: 'iii' } }),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
        (globalThis as any).Zotero.Beaver = { documentCache: cache };

        const labels = await preloadNotePageLabels(
            makeRawCitation('REMOTE03'),
            1,
            { extractOnCacheMiss: true, allowRemoteDownloads: true },
        );

        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(attachment, false);
        expect(cache.getMetadata).toHaveBeenCalledTimes(2);
        expect(labels).toEqual({ '1-REMOTE03': { 0: 'iii' } });
    });

    it('skips citations without page locators before cache lookup or extraction', async () => {
        const attachment = makeAttachment(45, 'NOLOC123');
        const cache = {
            getMetadata: vi.fn().mockResolvedValue(null),
        };
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
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
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => attachment);
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
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi.fn(async () => parent);
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

describe('preloadPageLabelsForNewCitations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Libraries.userLibraryID = 1;
    });

    function useAttachment(attachment: any, cache: any) {
        (globalThis as any).Zotero.Items = { getByLibraryAndKeyAsync: vi.fn(async () => attachment) };
        (globalThis as any).Zotero.Beaver = { documentCache: cache };
    }

    it('uses cached labels of a remote-only attachment through its remote cache key', async () => {
        const cache = { getMetadata: vi.fn().mockResolvedValue({ pageLabels: { 4: 'iii' } }) };
        useAttachment(makeRemoteOnlyAttachment(47, 'REMOTE01'), cache);

        const labels = await preloadPageLabelsForNewCitations('<citation id="1-REMOTE01" loc="page5"/>');

        expect(labels).toEqual({ 47: { 4: 'iii' } });
        expect(cache.getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'REMOTE01' }, 'remote:k:1-REMOTE01-v0');
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('writes the labels the PDF declares, not printed labels, into new note citations', async () => {
        const cache = {
            getMetadata: vi.fn().mockResolvedValue({ pageLabels: { 4: '5' }, derivedPageLabels: { 4: '1205' } }),
        };
        useAttachment(makeAttachment(50, 'LOCAL002'), cache);

        expect(await preloadPageLabelsForNewCitations('<citation id="1-LOCAL002" loc="page5"/>'))
            .toEqual({ 50: { 4: '5' } });
    });

    it('does not extract (and so download) a remote-only attachment on a cache miss', async () => {
        const cache = { getMetadata: vi.fn().mockResolvedValue(null) };
        useAttachment(makeRemoteOnlyAttachment(48, 'REMOTE02'), cache);

        expect(await preloadPageLabelsForNewCitations('<citation id="1-REMOTE02" loc="page5"/>')).toEqual({});
        expect(mockGetAttachmentFileStatus).not.toHaveBeenCalled();
    });

    it('still extracts a local attachment on a cache miss', async () => {
        const cache = { getMetadata: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ pageLabels: { 0: 'i' } }) };
        const attachment = makeAttachment(49, 'LOCAL001');
        useAttachment(attachment, cache);

        expect(await preloadPageLabelsForNewCitations('<citation id="1-LOCAL001" loc="page1"/>')).toEqual({ 49: { 0: 'i' } });
        expect(mockGetAttachmentFileStatus).toHaveBeenCalledWith(attachment, false);
    });
});

describe('ensureCitedLibrariesLoaded', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Libraries.userLibraryID = 1;
        (globalThis as any).Zotero.URI = {
            getURIItemLibraryKey: vi.fn(() => ({ libraryID: 7, key: 'URIKEY01' })),
        };
    });

    function loadedLibraryIds(): number[] {
        const [ids] = vi.mocked(ensureLibraryItemsLoaded).mock.calls[0];
        return [...ids].sort((a, b) => (a as number) - (b as number)) as number[];
    }

    it('loads the libraries of simplified tags, data-citation URIs, link citations and extra ids', async () => {
        const text = '<citation id="5-ABCD1234"/> '
            + makeRawCitation('URIKEY01', 7)
            + '<p>(<a href="zotero://open/library/items/LINKKEY1?page=2">Report.pdf</a>, p. 2)</p>';

        await ensureCitedLibrariesLoaded([text], [3]);

        expect(loadedLibraryIds()).toEqual([1, 3, 5, 7]);
    });

    it('skips excluded libraries', async () => {
        vi.mocked(checkLibraryExcluded).mockImplementation((id: number) =>
            (id === 5 ? { message: 'Library excluded' } : null) as any);

        await ensureCitedLibrariesLoaded(['<citation id="5-ABCD1234"/> <citation id="6-ABCD1234"/>']);

        expect(loadedLibraryIds()).toEqual([6]);
        vi.mocked(checkLibraryExcluded).mockReturnValue(null);
    });

    it('loads the items of compound tags and ignores malformed citation payloads', async () => {
        await ensureCitedLibrariesLoaded([
            '<citation items="3-AAAA1111:page=2, 4-BBBB2222"/>'
            + '<span class="citation" data-citation="%E0%A4%A">()</span>',
        ]);

        expect(loadedLibraryIds()).toEqual([3, 4]);
    });

    it('loads the library an external reference maps to', async () => {
        await ensureCitedLibrariesLoaded(['<citation external_id="W1"/> <citation external_id="W2"/>'], [], {
            externalItemMapping: { W1: { library_id: 8, zotero_key: 'MAPPED01' }, W2: null },
        });

        expect(loadedLibraryIds()).toEqual([8]);
    });

    it('skips an excluded library an external reference maps to', async () => {
        vi.mocked(checkLibraryExcluded).mockImplementation((id: number) =>
            (id === 8 ? { message: 'Library excluded' } : null) as any);

        await ensureCitedLibrariesLoaded(['<citation external_id="W1"/>'], [], {
            externalItemMapping: { W1: { library_id: 8, zotero_key: 'MAPPED01' } },
        });

        expect(loadedLibraryIds()).toEqual([]);
        vi.mocked(checkLibraryExcluded).mockReturnValue(null);
    });

    it('includes excluded libraries for render paths', async () => {
        vi.mocked(checkLibraryExcluded).mockReturnValue({ message: 'Library excluded' } as any);

        await ensureCitedLibrariesLoaded(['<citation id="5-ABCD1234"/>'], [], { includeExcluded: true });

        expect(loadedLibraryIds()).toEqual([5]);
        vi.mocked(checkLibraryExcluded).mockReturnValue(null);
    });

    it('warms cited libraries before resolving page labels', async () => {
        (globalThis as any).Zotero.Beaver = { documentCache: { getMetadata: vi.fn() } };

        await preloadNotePageLabels(makeRawCitation('URIKEY01', 7), 2);

        expect(loadedLibraryIds()).toEqual([2, 7]);
        (globalThis as any).Zotero.Beaver = undefined;
    });
});
