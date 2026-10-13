import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    buildBeaverCitationMeta,
    locatorToken,
    readBeaverCitationMeta,
} from '../../../src/utils/noteCitationMeta';
import { extractDataCitationItems, rebuildDataCitationItems } from '../../../src/utils/noteWrapper';

describe('readBeaverCitationMeta', () => {
    it('reads well-formed metadata of the current version', () => {
        expect(readBeaverCitationMeta({ uris: [], beaver: { v: 1, loc: 's5.6', att: 'ABCD2345' } }))
            .toEqual({ v: 1, loc: 's5.6', att: 'ABCD2345' });
    });

    it('treats absent, malformed or other-version metadata as none', () => {
        expect(readBeaverCitationMeta({ uris: [] })).toBeUndefined();
        expect(readBeaverCitationMeta({ beaver: 'x' })).toBeUndefined();
        expect(readBeaverCitationMeta({ beaver: { v: 2, loc: 's5' } })).toBeUndefined();
        expect(readBeaverCitationMeta({ beaver: { v: 1 } })).toBeUndefined();
        expect(readBeaverCitationMeta(null)).toBeUndefined();
    });

    it('drops malformed item keys and unknown fields', () => {
        expect(readBeaverCitationMeta({ beaver: { v: 1, loc: 'page3', att: 'not a key!', extra: true } }))
            .toEqual({ v: 1, loc: 'page3' });
    });
});

describe('buildBeaverCitationMeta', () => {
    it('returns undefined when there is nothing to record', () => {
        expect(buildBeaverCitationMeta({})).toBeUndefined();
    });

    it('keeps the CSL data only together with an external id', () => {
        expect(buildBeaverCitationMeta({ csl: { title: 'T' } })).toBeUndefined();
        expect(readBeaverCitationMeta({ beaver: { v: 1, ext: 'W1', csl: { title: 'T' } } }))
            .toEqual({ v: 1, ext: 'W1', csl: { title: 'T' } });
        expect(readBeaverCitationMeta({ beaver: { v: 1, ext: 'W1', csl: ['bad'] } })).toEqual({ v: 1, ext: 'W1' });
    });

    it('keeps a source only together with an external id', () => {
        expect(buildBeaverCitationMeta({ src: 'openalex' })).toBeUndefined();
        expect(buildBeaverCitationMeta({ ext: 'W1', src: 'openalex' })).toEqual({ v: 1, ext: 'W1', src: 'openalex' });
    });
});

describe('locatorToken', () => {
    it('spells a legacy page attribute as a page token', () => {
        expect(locatorToken({ kind: 'page', value: '12', raw: '12' })).toBe('page12');
        expect(locatorToken({ kind: 'page', value: '12', raw: 'page12' })).toBe('page12');
        expect(locatorToken({ kind: 'sentence', value: '5.6', raw: 's5.6' })).toBe('s5.6');
        expect(locatorToken(undefined)).toBeUndefined();
    });
});

describe('rebuildDataCitationItems with embedded works', () => {
    beforeEach(() => {
        (globalThis as any).Zotero.URI = {
            ...(globalThis as any).Zotero.URI,
            getURIItemLibraryKey: vi.fn((uri: string) => {
                if (!uri.startsWith('http://zotero.org/')) throw new Error(`Could not parse object URI ${uri}`);
                return false;
            }),
        };
    });

    function citationSpan(item: Record<string, unknown>): string {
        const data = encodeURIComponent(JSON.stringify({ citationItems: [item], properties: {} }));
        return `<span class="citation" data-citation="${data}">(X)</span>`;
    }

    it('caches the inline data of a work that is not a Zotero item', () => {
        const html = `<div data-schema-version="9"><p>${citationSpan({
            uris: ['https://doi.org/10.1/inline'],
            itemData: { title: 'Inline Work' },
        })}</p></div>`;
        expect(extractDataCitationItems(rebuildDataCitationItems(html))).toEqual([
            { uris: ['https://doi.org/10.1/inline'], itemData: { title: 'Inline Work' } },
        ]);
    });

    it('caches the data an embedded work carries in its Beaver metadata', () => {
        const html = `<div data-schema-version="9"><p>${citationSpan({
            uris: ['https://openalex.org/W9'],
            beaver: { v: 1, ext: 'W9', csl: { title: 'Embedded Work' } },
        })}</p></div>`;
        expect(extractDataCitationItems(rebuildDataCitationItems(html, []))).toEqual([
            { uris: ['https://openalex.org/W9'], itemData: { title: 'Embedded Work' } },
        ]);
    });

    it('caches an embedded work whose URI ends like a Zotero item URI', () => {
        const uri = 'https://doi.org/10.1234/items/ABCD1234';
        const html = `<div data-schema-version="9"><p>${citationSpan({
            uris: [uri],
            beaver: { v: 1, ext: 'W7', csl: { title: 'DOI Work' } },
        })}</p></div>`;
        expect(extractDataCitationItems(rebuildDataCitationItems(html, []))).toEqual([
            { uris: [uri], itemData: { title: 'DOI Work' } },
        ]);
    });

    it('still caches the other items of a citation when one lookup fails', () => {
        const zotero = (globalThis as any).Zotero;
        zotero.URI.getURIItemLibraryKey = vi.fn((uri: string) => {
            if (uri.endsWith('/BROKEN01')) throw new Error(`Could not parse object URI ${uri}`);
            return { libraryID: 1, key: uri.slice(-8) };
        });
        zotero.Items = { ...zotero.Items, getByLibraryAndKey: vi.fn((_lib: number, key: string) => ({ key })) };
        zotero.Utilities = { ...zotero.Utilities, Item: { itemToCSLJSON: vi.fn((item: any) => ({ title: item.key })) } };
        const data = encodeURIComponent(JSON.stringify({
            citationItems: [
                { uris: ['http://zotero.org/users/1/items/BROKEN01'] },
                { uris: ['http://zotero.org/users/1/items/GOODITEM'] },
            ],
            properties: {},
        }));
        const html = `<div data-schema-version="9"><p><span class="citation" data-citation="${data}">(X)</span></p></div>`;

        expect(extractDataCitationItems(rebuildDataCitationItems(html, []))).toEqual([
            { uris: ['http://zotero.org/users/1/items/GOODITEM'], itemData: { title: 'GOODITEM' } },
        ]);
    });

    it('skips a work it has no data for instead of failing', () => {
        const html = `<div data-schema-version="9"><p>${citationSpan({ uris: ['https://doi.org/10.1/none'] })}</p></div>`;
        expect(extractDataCitationItems(rebuildDataCitationItems(html))).toBeNull();
    });
});
