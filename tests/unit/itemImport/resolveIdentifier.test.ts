import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const apis = vi.hoisted(() => ({
    isApiAvailable: vi.fn(() => true),
    markApiUnavailable: vi.fn(),
    looksLikeApiDrift: vi.fn((error: unknown) => error instanceof TypeError),
    // Pass-through: the real timeout helper, but with an immediate rejection hook.
    withTimeout: vi.fn(async (work: Promise<unknown>) => work),
}));
vi.mock('../../../src/services/itemImport/zoteroApis', () => apis);
const timers = vi.hoisted(() => ({ systemDelay: vi.fn(async (_ms: number) => undefined) }));
vi.mock('../../../src/utils/systemTimers', () => timers);

import { translateIdentifier, translatorAttachments } from '../../../src/services/itemImport/resolveIdentifier';

const Z = Zotero as any;

interface SearchBehavior {
    translators?: any[];
    items?: any[] | ((translator: unknown) => Promise<any[]>);
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
                return typeof items === 'function' ? items(this.translator) : (items ?? [{ itemType: 'journalArticle', title: 'T' }]);
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

    describe('a DOI lookup that returns the record containing the DOI', () => {
        const CHAPTER = '10.4324/9780429265365-1';
        const book = { itemType: 'book', title: 'Predictive Policing', DOI: '10.4324/9780429265365' };
        const chapter = { itemType: 'bookSection', title: 'Introduction', DOI: CHAPTER, pages: '1-38' };
        const REST = '0a61e167-de9a-4f93-a68a-628b48855909';
        const crossrefRest = (json: unknown) => async (translator: unknown) =>
            translator === REST ? [json] : [book];

        it('retries with Crossref REST and returns its record', async () => {
            installSearch({ translators: [{ label: 'DOI Content Negotiation' }], items: crossrefRest(chapter) });
            const result = await translateIdentifier({ type: 'doi', value: CHAPTER }, 5000);
            expect(result).toMatchObject({ ok: true, json: chapter, translator: 'Crossref REST' });
        });

        it('fails the lookup when Crossref REST does not return the DOI either', async () => {
            installSearch({ items: crossrefRest(book) });
            const result = await translateIdentifier({ type: 'doi', value: CHAPTER }, 5000);
            expect(result).toMatchObject({ ok: false, code: 'not_found' });
            expect((result as any).message).toContain('different record');
        });

        it('fails the lookup when Crossref REST fails twice', async () => {
            installSearch({
                items: async (translator) => {
                    if (translator === REST) throw new Error('No items returned from any translator');
                    return [book];
                },
            });
            expect(await translateIdentifier({ type: 'doi', value: CHAPTER }, 5000)).toMatchObject({ ok: false, code: 'not_found' });
            expect(timers.systemDelay).toHaveBeenCalledWith(2000);
        });

        it('tries Crossref REST once more after a pause, as a rate-limited request looks like no result', async () => {
            let restCalls = 0;
            installSearch({
                items: async (translator) => {
                    if (translator !== REST) return [book];
                    restCalls += 1;
                    if (restCalls === 1) throw new Error('No items returned from any translator');
                    return [chapter];
                },
            });
            expect(await translateIdentifier({ type: 'doi', value: CHAPTER }, 5000)).toMatchObject({ ok: true, json: chapter });
            expect(restCalls).toBe(2);
        });

        it('does not pause for a second try the deadline leaves no room for', async () => {
            installSearch({
                items: async (translator) => {
                    if (translator === REST) throw new Error('No items returned from any translator');
                    return [book];
                },
            });
            await translateIdentifier({ type: 'doi', value: CHAPTER }, 1000);
            expect(timers.systemDelay).not.toHaveBeenCalledWith(2000);
        });

        it('runs Crossref REST lookups one at a time', async () => {
            let running = 0;
            let peak = 0;
            installSearch({
                items: async (translator) => {
                    if (translator !== REST) return [book];
                    running += 1;
                    peak = Math.max(peak, running);
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    running -= 1;
                    return [chapter];
                },
            });
            const results = await Promise.all(
                [1, 2, 3].map(() => translateIdentifier({ type: 'doi', value: CHAPTER }, 5000)),
            );
            expect(results.every((r) => r.ok)).toBe(true);
            expect(peak).toBe(1);
        });

        describe('with real timeouts', () => {
            // The real timeout helper's contract, and a short stand-in for the gaps.
            const realTimeout = async (work: Promise<unknown>, ms: number) => {
                let handle: ReturnType<typeof setTimeout> | undefined;
                const timeout = new Promise((_, reject) => {
                    handle = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'timeout' })), Math.max(0, ms));
                });
                try { return await Promise.race([work, timeout]); } finally { clearTimeout(handle); }
            };
            const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
            let running = 0;
            let peak = 0;
            let restStarts: number[] = [];
            let settled: Promise<unknown>[] = [];

            // Crossref REST answers after `restMs`; the first translator returns the book.
            function slowRest(restMs: number) {
                installSearch({
                    items: async (translator) => {
                        if (translator !== REST) return [book];
                        restStarts.push(Date.now());
                        running += 1;
                        peak = Math.max(peak, running);
                        const done = sleep(restMs).then(() => { running -= 1; });
                        settled.push(done);
                        await done;
                        return [chapter];
                    },
                });
            }

            beforeEach(() => {
                running = 0;
                peak = 0;
                restStarts = [];
                settled = [];
                apis.withTimeout.mockImplementation(realTimeout as any);
                timers.systemDelay.mockImplementation((ms: number) => sleep(ms > 1000 ? 30 : 10));
            });

            afterEach(async () => {
                // Let every translation finish so the queue is free for the next test.
                await Promise.all(settled);
                await sleep(20);
            });

            it('reports a Crossref REST lookup that outlasts its budget as a timeout', async () => {
                slowRest(150);
                const result = await translateIdentifier({ type: 'doi', value: CHAPTER }, 50);
                expect(result).toMatchObject({ ok: false, code: 'timeout' });
            });

            it('gives up waiting for its queue turn at the deadline and never starts the lookup', async () => {
                slowRest(150);
                const first = translateIdentifier({ type: 'doi', value: CHAPTER }, 1000);
                const startedAt = Date.now();
                const second = await translateIdentifier({ type: 'doi', value: CHAPTER }, 50);
                expect(second).toMatchObject({ ok: false, code: 'timeout' });
                expect(Date.now() - startedAt).toBeLessThan(140);
                expect((await first).ok).toBe(true);
                expect(restStarts).toHaveLength(1);
            });

            it('holds the queue until a timed-out translation settles', async () => {
                slowRest(120);
                const abandoned = await translateIdentifier({ type: 'doi', value: CHAPTER }, 30);
                expect(abandoned).toMatchObject({ ok: false, code: 'timeout' });
                const next = await translateIdentifier({ type: 'doi', value: CHAPTER }, 2000);
                expect(next.ok).toBe(true);
                expect(peak).toBe(1);
                expect(restStarts[1] - restStarts[0]).toBeGreaterThanOrEqual(120);
            });
        });

        it('files the chapter authors Crossref REST returns as bookAuthor as authors', async () => {
            const withBookAuthors = {
                ...chapter,
                creators: [
                    { creatorType: 'bookAuthor', firstName: 'Ana', lastName: 'Ruiz' },
                    { creatorType: 'editor', firstName: 'Ken', lastName: 'Pease' },
                ],
            };
            installSearch({ items: crossrefRest(withBookAuthors) });
            const result = await translateIdentifier({ type: 'doi', value: CHAPTER }, 5000);
            expect((result as any).json.creators).toEqual([
                { creatorType: 'author', firstName: 'Ana', lastName: 'Ruiz' },
                { creatorType: 'editor', firstName: 'Ken', lastName: 'Pease' },
            ]);
        });

        it('keeps bookAuthor when the chapter already has authors', async () => {
            const creators = [
                { creatorType: 'author', firstName: 'Ana', lastName: 'Ruiz' },
                { creatorType: 'bookAuthor', firstName: 'Bo', lastName: 'Lee' },
            ];
            installSearch({ items: crossrefRest({ ...chapter, creators }) });
            expect(((await translateIdentifier({ type: 'doi', value: CHAPTER }, 5000)) as any).json.creators).toEqual(creators);
        });

        it('accepts the DOI in another case or form', async () => {
            installSearch({ items: [{ ...chapter, DOI: 'https://doi.org/10.4324/9780429265365-1'.toUpperCase() }] });
            expect((await translateIdentifier({ type: 'doi', value: CHAPTER }, 5000)).ok).toBe(true);
        });
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
