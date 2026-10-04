import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const apis = vi.hoisted(() => ({
    isApiAvailable: vi.fn(() => true),
    markApiUnavailable: vi.fn(),
    looksLikeApiDrift: vi.fn((error: unknown) => error instanceof TypeError),
    // Pass-through: the real timeout helper, but with an immediate rejection hook.
    withTimeout: vi.fn(async (work: Promise<unknown>) => work),
}));
vi.mock('../../../src/services/itemImport/zoteroApis', () => apis);

import { translateIdentifier, translatorAttachments } from '../../../src/services/itemImport/resolveIdentifier';

const Z = Zotero as any;

interface SearchBehavior {
    translators?: any[];
    items?: any[] | (() => Promise<any[]>);
    getTranslatorsError?: unknown;
}

let lastSearch: any;

function installSearch(behavior: SearchBehavior) {
    Z.Translate = {
        Search: class {
            translator: any[] | undefined;
            identifier: unknown;
            handlers: Record<string, (...args: any[]) => void> = {};
            setIdentifier = vi.fn((identifier: unknown) => { this.identifier = identifier; });
            setTranslator = vi.fn((translators: any[]) => { this.translator = translators; });
            setHandler = vi.fn((name: string, fn: (...args: any[]) => void) => { this.handlers[name] = fn; });
            async getTranslators() {
                if (behavior.getTranslatorsError) throw behavior.getTranslatorsError;
                return behavior.translators ?? [{ label: 'CrossRef' }];
            }
            translate = vi.fn(async () => {
                const items = behavior.items;
                return typeof items === 'function' ? items() : (items ?? [{ itemType: 'journalArticle', title: 'T' }]);
            });
            constructor() { lastSearch = this as unknown; }
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    apis.isApiAvailable.mockReturnValue(true);
    apis.withTimeout.mockImplementation(async (work: Promise<unknown>) => work);
    Z.Utilities.cleanISBN = vi.fn((value: string) => {
        const digits = String(value).replace(/[^0-9Xx]/g, '').toUpperCase();
        return digits.length === 10 || digits.length === 13 ? digits : null;
    });
    delete Z.Utilities.toISBN13;
});

describe('translateIdentifier', () => {
    it('returns the translated item, translator label and attachment urls', async () => {
        installSearch({
            translators: [{ label: 'CrossRef' }],
            items: [{ itemType: 'journalArticle', title: 'Deep learning', attachments: [{ url: 'https://x.org/a.pdf', mimeType: 'application/pdf', title: 'PDF' }] }],
        });
        const result = await translateIdentifier({ type: 'doi', value: '10.1038/nature14539' }, 5000);
        expect(result).toEqual({
            ok: true,
            json: expect.objectContaining({ title: 'Deep learning' }),
            translator: 'CrossRef',
            attachments: [{ url: 'https://x.org/a.pdf', mime_type: 'application/pdf', title: 'PDF' }],
        });
        expect(lastSearch.identifier).toEqual({ DOI: '10.1038/nature14539' });
        expect(lastSearch.translate).toHaveBeenCalledWith({ libraryID: false, saveAttachments: false });
    });

    it.each([
        ['isbn', 'ISBN'], ['arxiv', 'arXiv'], ['pmid', 'PMID'],
    ] as const)('maps %s to the Zotero identifier key %s', async (type, key) => {
        installSearch({ items: [{ itemType: 'book', title: 'T' }] });
        await translateIdentifier({ type, value: '123' }, 5000);
        expect(lastSearch.identifier).toEqual({ [key]: '123' });
    });

    it('answers no_translator for identifier types Zotero cannot look up (PMCID)', async () => {
        installSearch({});
        lastSearch = undefined;
        const result = await translateIdentifier({ type: 'pmcid', value: 'PMC123' }, 5000);
        expect(result).toMatchObject({ ok: false, code: 'no_translator' });
        expect(lastSearch).toBeUndefined();
    });

    it('answers no_translator when the Translate.Search API is unavailable', async () => {
        apis.isApiAvailable.mockReturnValue(false);
        installSearch({});
        lastSearch = undefined;
        const result = await translateIdentifier({ type: 'doi', value: '10.1/x' }, 5000);
        expect(result).toMatchObject({ ok: false, code: 'no_translator' });
        expect(lastSearch).toBeUndefined();
    });

    it('answers no_translator when no translator can handle the identifier', async () => {
        installSearch({ translators: [] });
        const result = await translateIdentifier({ type: 'doi', value: '10.1/x' }, 5000);
        expect(result).toMatchObject({ ok: false, code: 'no_translator' });
        expect((result as any).message).toContain('DOI 10.1/x');
    });

    it('answers not_found when the translator returns no items', async () => {
        installSearch({ items: [] });
        expect(await translateIdentifier({ type: 'doi', value: '10.1/x' }, 5000)).toMatchObject({ ok: false, code: 'not_found' });
    });

    it('answers not_found for Zotero\'s "No items returned from any translator" error', async () => {
        installSearch({
            items: async () => { throw new Error('No items returned from any translator'); },
        });
        expect(await translateIdentifier({ type: 'arxiv', value: '1234.5678' }, 5000)).toMatchObject({ ok: false, code: 'not_found' });
    });

    it('rejects an ISBN lookup that returns a different book', async () => {
        installSearch({ items: [{ itemType: 'book', title: 'Other', ISBN: '9780000000002' }] });
        const result = await translateIdentifier({ type: 'isbn', value: '9780262035613' }, 5000);
        expect(result).toMatchObject({ ok: false, code: 'not_found' });
        expect((result as any).message).toContain('different book');
    });

    it('accepts an ISBN lookup that lists the requested ISBN among several', async () => {
        installSearch({ items: [{ itemType: 'book', title: 'T', ISBN: '0262035618 9780262035613' }] });
        expect((await translateIdentifier({ type: 'isbn', value: '9780262035613' }, 5000)).ok).toBe(true);
    });

    it('accepts an ISBN lookup that carries no ISBN at all', async () => {
        installSearch({ items: [{ itemType: 'book', title: 'T' }] });
        expect((await translateIdentifier({ type: 'isbn', value: '9780262035613' }, 5000)).ok).toBe(true);
    });

    it('answers timeout when a lookup exceeds its budget', async () => {
        installSearch({});
        apis.withTimeout.mockRejectedValueOnce(Object.assign(new Error('Looking up DOI x timed out'), { code: 'timeout' }));
        expect(await translateIdentifier({ type: 'doi', value: '10.1/x' }, 5000)).toMatchObject({ ok: false, code: 'timeout' });
    });

    it('answers translation_failed with the underlying message', async () => {
        installSearch({ getTranslatorsError: new Error('network down') });
        const result = await translateIdentifier({ type: 'doi', value: '10.1/x' }, 5000);
        expect(result).toMatchObject({ ok: false, code: 'translation_failed' });
        expect((result as any).message).toContain('network down');
        expect(apis.markApiUnavailable).not.toHaveBeenCalled();
    });

    it('marks the API unavailable when the failure looks like API drift', async () => {
        const error = new TypeError('translate.setTranslator is not a function');
        installSearch({ getTranslatorsError: error });
        const result = await translateIdentifier({ type: 'doi', value: '10.1/x' }, 5000);
        expect(result).toMatchObject({ ok: false, code: 'translation_failed' });
        expect(apis.markApiUnavailable).toHaveBeenCalledWith('translateSearch', error);
    });

    it('auto-selects the first record when a search returns several', async () => {
        installSearch({});
        await translateIdentifier({ type: 'doi', value: '10.1/x' }, 5000);
        const callback = vi.fn();
        lastSearch.handlers.select(null, { a: 'First', b: 'Second' }, callback);
        expect(callback).toHaveBeenCalledWith({ a: 'First' });
        const empty = vi.fn();
        lastSearch.handlers.select(null, {}, empty);
        expect(empty).toHaveBeenCalledWith({});
    });
});

describe('translatorAttachments', () => {
    it('keeps http(s) attachments with their metadata', () => {
        expect(translatorAttachments({
            attachments: [
                { url: 'https://x.org/a.pdf', mimeType: 'application/pdf', title: 'Full Text', snapshot: false },
                { url: 'http://x.org/page', snapshot: true },
            ],
        })).toEqual([
            { url: 'https://x.org/a.pdf', mime_type: 'application/pdf', title: 'Full Text', snapshot: false },
            { url: 'http://x.org/page', snapshot: true },
        ]);
    });

    it('drops entries without an http(s) url and tolerates a missing list', () => {
        expect(translatorAttachments({ attachments: [{ url: 'file:///a.pdf' }, { document: {} }, null, { url: 5 }] })).toEqual([]);
        expect(translatorAttachments({})).toEqual([]);
        expect(translatorAttachments({ attachments: 'x' })).toEqual([]);
    });
});
