import { beforeEach, describe, expect, it } from 'vitest';

import { buildPdfResolvers, toUrlResolver } from '../../react/utils/pdfResolvers';

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
