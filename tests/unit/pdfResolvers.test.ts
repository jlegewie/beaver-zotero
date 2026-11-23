import { beforeEach, describe, expect, it } from 'vitest';

import { buildPdfResolvers, isDeadEndPdfLink, toUrlResolver } from '../../react/utils/pdfResolvers';

/** Whatever `getFileResolvers` should return for the item under test. */
let zoteroResolvers: any[];

const item = {} as Zotero.Item;

beforeEach(() => {
    zoteroResolvers = [
        { pageURL: 'https://doi.org/10.1234/x', accessMethod: 'doi' },
        { pageURL: 'https://publisher.example/article', accessMethod: 'url' },
    ];
    (globalThis as any).Zotero = {
        Attachments: { getFileResolvers: () => zoteroResolvers },
    };
});

describe('toUrlResolver', () => {
    it('maps a direct PDF candidate onto Zotero resolver fields', () => {
        expect(
            toUrlResolver({
                url: 'https://repo.example/1.pdf',
                version: 'acceptedVersion',
                access_method: 'openalex',
            }),
        ).toEqual({
            url: 'https://repo.example/1.pdf',
            pageURL: undefined,
            accessMethod: 'openalex',
            articleVersion: 'acceptedVersion',
        });
    });

    it('maps a landing page onto pageURL so a translator walks it', () => {
        // The distinction matters: `url` is downloaded directly and rejected if
        // it is not a PDF, `pageURL` gets translated first.
        expect(toUrlResolver({ page_url: 'https://repo.example/record/1' })).toEqual({
            url: undefined,
            pageURL: 'https://repo.example/record/1',
            accessMethod: 'openalex',
            articleVersion: undefined,
        });
    });

    it("is distinguishable from Zotero's own open-access resolver, which also reports 'oa'", () => {
        expect(toUrlResolver({ url: 'https://repo.example/1.pdf' })).toMatchObject({
            accessMethod: 'openalex',
        });
    });

    it('drops a candidate with neither url nor page_url', () => {
        expect(toUrlResolver({ version: 'publishedVersion' })).toBeNull();
    });

    it('treats explicit nulls as absent', () => {
        expect(toUrlResolver({ url: null, page_url: null })).toBeNull();
    });
});

describe('buildPdfResolvers', () => {
    it('puts our ranked candidates ahead of Zotero own resolvers', () => {
        const resolvers = buildPdfResolvers(item, {
            pdfCandidates: [
                { url: 'https://repo.example/1.pdf' },
                { page_url: 'https://repo.example/record/2' },
            ],
        });

        expect(resolvers).toHaveLength(4);
        expect(resolvers[0]).toMatchObject({ url: 'https://repo.example/1.pdf' });
        expect(resolvers[1]).toMatchObject({ pageURL: 'https://repo.example/record/2' });
        expect(resolvers[2]).toMatchObject({ accessMethod: 'doi' });
        expect(resolvers[3]).toMatchObject({ accessMethod: 'url' });
    });

    it("keeps Zotero's resolvers, which is how a user's custom resolver still applies", () => {
        zoteroResolvers = [{ pageURL: 'https://libkey.example/{doi}', accessMethod: 'custom' }];

        const resolvers = buildPdfResolvers(item, {
            pdfCandidates: [{ url: 'https://repo.example/1.pdf' }],
        });

        expect(resolvers.at(-1)).toMatchObject({ accessMethod: 'custom' });
    });

    it('preserves backend ranking rather than re-sorting', () => {
        const resolvers = buildPdfResolvers(item, {
            pdfCandidates: [
                { url: 'https://a.example/1.pdf', version: 'submittedVersion' },
                { url: 'https://b.example/2.pdf', version: 'publishedVersion' },
            ],
        });

        expect(resolvers.slice(0, 2).map((r: any) => r.url)).toEqual([
            'https://a.example/1.pdf',
            'https://b.example/2.pdf',
        ]);
    });

    it('skips unusable candidates without dropping the ones after them', () => {
        const resolvers = buildPdfResolvers(item, {
            pdfCandidates: [{}, { url: 'https://repo.example/1.pdf' }],
        });

        expect(resolvers[0]).toMatchObject({ url: 'https://repo.example/1.pdf' });
    });

    describe('without candidates (client has not declared the feature)', () => {
        it('falls back to the open-access URL as a direct download', () => {
            const resolvers = buildPdfResolvers(item, {
                openAccessUrl: 'https://repo.example/oa.pdf',
            });

            expect(resolvers[0]).toMatchObject({
                url: 'https://repo.example/oa.pdf',
                accessMethod: 'openalex',
            });
        });

        it('adds the article URL only when the item is flagged open access', () => {
            // The article page is not a known file, so it is only worth a
            // translator walk when the item claims to have one.
            const withoutFlag = buildPdfResolvers(item, {
                openAccessUrl: 'https://repo.example/oa.pdf',
                fallbackUrl: 'https://doi.org/10.1234/y',
            });
            const withFlag = buildPdfResolvers(item, {
                openAccessUrl: 'https://repo.example/oa.pdf',
                fallbackUrl: 'https://doi.org/10.1234/y',
                fileAvailable: true,
            });

            expect(withoutFlag.filter((r: any) => r.pageURL === 'https://doi.org/10.1234/y')).toHaveLength(0);
            expect(withFlag[1]).toMatchObject({ pageURL: 'https://doi.org/10.1234/y' });
        });

        it('does not repeat the open-access URL as the fallback', () => {
            const resolvers = buildPdfResolvers(item, {
                openAccessUrl: 'https://repo.example/oa.pdf',
                fallbackUrl: 'https://repo.example/oa.pdf',
                fileAvailable: true,
            });

            expect(resolvers.filter((r: any) => r.url || r.pageURL === 'https://repo.example/oa.pdf'))
                .toHaveLength(1);
        });

        it("still returns Zotero's own resolvers when we have nothing", () => {
            const resolvers = buildPdfResolvers(item, {});

            expect(resolvers).toEqual(zoteroResolvers);
        });
    });

    it('survives a Zotero build that returns nothing from getFileResolvers', () => {
        (globalThis as any).Zotero.Attachments.getFileResolvers = () => undefined;

        const resolvers = buildPdfResolvers(item, {
            pdfCandidates: [{ url: 'https://repo.example/1.pdf' }],
        });

        expect(resolvers).toHaveLength(1);
    });
});

describe('isDeadEndPdfLink', () => {
    it.each([
        ['https://pubmed.ncbi.nlm.nih.gov/21119607', true],
        ['https://doaj.org/article/abc', true],
        ['http://hdl.handle.net/2123/9947', false],
        ['https://papers.ssrn.com/sol3/Delivery.cfm?abstractid=1', false],
        ['https://web.archive.org/web/2020/https://repo.example/a.pdf', false],
        ['https://europepmc.org/article/MED/1', true],
    ])('treats %s as a dead end', (url, landingPage) => {
        expect(isDeadEndPdfLink(url, landingPage)).toBe(true);
    });

    it.each([
        ['https://europepmc.org/articles/pmc6217926?pdf=render', false],
        ['https://www.sciencedirect.com/science/article/pii/S1/pdf', false],
        ['https://notdoaj.org/article/1', true],
        ['not a url', true],
    ])('keeps %s', (url, landingPage) => {
        expect(isDeadEndPdfLink(url, landingPage)).toBe(false);
    });
});

describe('dead-end links', () => {
    it('are dropped from our candidates and from Zotero static resolvers', () => {
        zoteroResolvers = [
            { pageURL: 'https://doi.org/10.1234/x', accessMethod: 'doi' },
            { pageURL: 'https://pubmed.ncbi.nlm.nih.gov/1', accessMethod: 'url' },
        ];

        const resolvers = buildPdfResolvers(item, {
            pdfCandidates: [{ page_url: 'https://doaj.org/article/abc' }, { url: 'https://repo.example/1.pdf' }],
        });

        expect(resolvers.map((r: any) => r.url ?? r.pageURL)).toEqual([
            'https://repo.example/1.pdf',
            'https://doi.org/10.1234/x',
        ]);
    });

    it('are pruned from what Zotero open-access lookup returns when Zotero calls it', async () => {
        const lookup = async () => [
            { url: 'https://papers.ssrn.com/sol3/Delivery.cfm?abstractid=1', accessMethod: 'oa' },
            { pageURL: 'https://doaj.org/article/abc', accessMethod: 'oa' },
            { url: 'https://repo.example/oa.pdf', pageURL: 'https://hdl.handle.net/1/2', accessMethod: 'oa' },
        ];
        zoteroResolvers = [lookup];

        const [wrapped] = buildPdfResolvers(item, {}) as unknown as Array<() => Promise<any[]>>;
        const results = await wrapped();

        expect(results).toEqual([{ url: 'https://repo.example/oa.pdf', pageURL: undefined, accessMethod: 'oa' }]);
    });

    it('leave a resolver whose lookup throws to Zotero, which logs and skips it', async () => {
        zoteroResolvers = [async () => { throw new Error('lookup failed'); }];

        const [wrapped] = buildPdfResolvers(item, {}) as unknown as Array<() => Promise<any[]>>;

        await expect(wrapped()).rejects.toThrow('lookup failed');
    });

    it('keep the direct link of an entry whose landing page is a dead end', () => {
        const resolvers = buildPdfResolvers(item, {
            pdfCandidates: [{ url: 'https://europepmc.org/articles/pmc1?pdf=render' }],
        });

        expect(resolvers[0]).toMatchObject({ url: 'https://europepmc.org/articles/pmc1?pdf=render' });
    });
});
