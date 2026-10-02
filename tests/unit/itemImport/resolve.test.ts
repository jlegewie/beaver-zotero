import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const mocks = vi.hoisted(() => ({
    translateIdentifier: vi.fn(),
    translateUrl: vi.fn(),
    locateImportFile: vi.fn(),
    recognizeFile: vi.fn(),
    findExistingItems: vi.fn(),
}));

vi.mock('../../../src/services/itemImport/resolveIdentifier', () => ({ translateIdentifier: mocks.translateIdentifier }));
vi.mock('../../../src/services/itemImport/resolveUrl', () => ({ translateUrl: mocks.translateUrl }));
vi.mock('../../../src/services/itemImport/recognizeFile', () => ({
    locateImportFile: mocks.locateImportFile,
    recognizeFile: mocks.recognizeFile,
}));
vi.mock('../../../src/services/itemImport/duplicates', () => ({
    findExistingItems: mocks.findExistingItems,
    WEB_CONTENT_ITEM_TYPES: new Set(['webpage', 'blogPost', 'forumPost', 'newspaperArticle', 'magazineArticle', 'encyclopediaArticle', 'presentation']),
}));

import type { ImportItemSpec } from '@beaver/agent-core/types/itemImport';
import { resolveImportItems } from '../../../src/services/itemImport/resolve';

/** Zotero round trip that keeps every field, which is all these dispatch tests need. */
class PassthroughItem {
    libraryID = 0;
    private json: Record<string, any> = {};
    constructor(public itemType: string) {}
    fromJSON(json: Record<string, any>) { this.json = json; }
    toJSON() { return { ...this.json }; }
}

const base = { libraryID: 1, deadlineMs: 60_000 };
const identifierSource = { kind: 'identifier' as const, input: 'doi:10.1/x' };

const spec = (key: string, rest: Partial<ImportItemSpec> = {}): ImportItemSpec => ({
    key,
    source: identifierSource,
    ...rest,
});

const located = (overrides: Record<string, any> = {}) => ({
    ok: true,
    file: {
        path: '/home/u/papers/a.pdf',
        filename: 'a.pdf',
        mimeType: 'application/pdf',
        size: 100,
        mtimeMs: 1,
        ref: { path: '/home/u/papers/a.pdf', filename: 'a.pdf', mime_type: 'application/pdf', size: 100, mtime_ms: 1, mode: 'import' },
        ...overrides,
    },
});

beforeEach(() => {
    vi.clearAllMocks();
    // The global test schema only knows a few item types; these tests need more.
    Object.assign((globalThis as any).__TEST_TYPE_IDS, { webpage: 101, preprint: 102, report: 103 });
    (Zotero as any).Item = PassthroughItem;
    (Zotero as any).Libraries.userLibraryID = 1;
    mocks.findExistingItems.mockResolvedValue(new Map());
});

describe('resolveImportItems dispatch', () => {
    it('lets model metadata win without any lookup', async () => {
        const [result] = await resolveImportItems([
            spec('a', { item: { itemType: 'book', title: 'Mine' }, identifier: { type: 'doi', value: '10.1/x' }, url: 'https://x.org' }),
        ], base);
        expect(result).toMatchObject({ key: 'a', status: 'resolved', method: 'model_metadata', item: { itemType: 'book', title: 'Mine' } });
        expect(mocks.translateIdentifier).not.toHaveBeenCalled();
        expect(mocks.translateUrl).not.toHaveBeenCalled();
    });

    it('fails model metadata with an invalid item type as invalid_metadata', async () => {
        const [result] = await resolveImportItems([spec('a', { item: { itemType: 'spaceship', title: 'X' } })], base);
        expect(result).toMatchObject({ key: 'a', status: 'failed', error: { code: 'invalid_metadata' } });
    });

    it('translates an identifier and reports translator and attachment urls', async () => {
        mocks.translateIdentifier.mockResolvedValue({
            ok: true,
            json: { itemType: 'journalArticle', title: 'Translated' },
            translator: 'CrossRef',
            attachments: [{ url: 'https://x.org/a.pdf', mime_type: 'application/pdf' }],
        });
        const [result] = await resolveImportItems([spec('a', { identifier: { type: 'doi', value: '10.1/x' } })], base);
        expect(result).toMatchObject({
            status: 'resolved',
            method: 'translator',
            translator: 'CrossRef',
            item: { title: 'Translated' },
            attachment_urls: [{ url: 'https://x.org/a.pdf', mime_type: 'application/pdf' }],
        });
        expect(mocks.translateIdentifier).toHaveBeenCalledWith({ type: 'doi', value: '10.1/x' }, expect.any(Number));
    });

    it('falls back to the search-result metadata with a warning when the identifier fails', async () => {
        mocks.translateIdentifier.mockResolvedValue({ ok: false, code: 'not_found', message: 'DOI 10.1/x was not found.' });
        const [result] = await resolveImportItems([
            spec('a', {
                identifier: { type: 'doi', value: '10.1/x' },
                fallback_item: { itemType: 'journalArticle', title: 'From search' },
            }),
        ], base);
        expect(result).toMatchObject({ status: 'resolved', method: 'fallback_metadata', item: { title: 'From search' } });
        expect(result.warnings?.[0]).toContain('identifier lookup failed (DOI 10.1/x was not found.)');
    });

    it('fails with the lookup error when the identifier fails and there is no fallback', async () => {
        mocks.translateIdentifier.mockResolvedValue({ ok: false, code: 'not_found', message: 'nope' });
        const [result] = await resolveImportItems([spec('a', { identifier: { type: 'doi', value: '10.1/x' } })], base);
        expect(result).toMatchObject({ status: 'failed', error: { code: 'not_found', message: 'nope' } });
    });

    it('fills an empty abstract from the fallback without touching other fields', async () => {
        mocks.translateIdentifier.mockResolvedValue({
            ok: true,
            json: { itemType: 'journalArticle', title: 'Official Title' },
            attachments: [],
        });
        const [result] = await resolveImportItems([
            spec('a', {
                identifier: { type: 'doi', value: '10.1/x' },
                fallback_item: { itemType: 'journalArticle', title: 'Other Title', abstractNote: 'Fallback abstract' },
            }),
        ], base);
        expect(result.item).toMatchObject({ title: 'Official Title', abstractNote: 'Fallback abstract' });
    });

    it('keeps a translator abstract over the fallback abstract', async () => {
        mocks.translateIdentifier.mockResolvedValue({
            ok: true,
            json: { itemType: 'journalArticle', title: 'T', abstractNote: 'Real abstract' },
            attachments: [],
        });
        const [result] = await resolveImportItems([
            spec('a', {
                identifier: { type: 'doi', value: '10.1/x' },
                fallback_item: { itemType: 'journalArticle', title: 'T', abstractNote: 'Fallback abstract' },
            }),
        ], base);
        expect(result.item?.abstractNote).toBe('Real abstract');
    });

    it('web-translates a url and records a snapshot url for web content', async () => {
        mocks.translateUrl.mockResolvedValue({
            ok: true,
            json: { itemType: 'webpage', title: 'Page' },
            translator: 'Embedded Metadata',
            attachments: [],
            pageUrl: 'https://x.org/page',
        });
        const [result] = await resolveImportItems([spec('a', { url: 'https://x.org/page' })], base);
        expect(result).toMatchObject({
            status: 'resolved',
            method: 'web_translator',
            translator: 'Embedded Metadata',
            snapshot_url: 'https://x.org/page',
        });
    });

    it('does not snapshot a scholarly page that has a PDF or a DOI', async () => {
        mocks.translateUrl.mockResolvedValue({
            ok: true,
            json: { itemType: 'journalArticle', title: 'Article', DOI: '10.1/x' },
            attachments: [],
            pageUrl: 'https://journal.org/a',
        });
        const [withDoi] = await resolveImportItems([spec('a', { url: 'https://journal.org/a' })], base);
        expect(withDoi.snapshot_url).toBeUndefined();

        mocks.translateUrl.mockResolvedValue({
            ok: true,
            json: { itemType: 'preprint', title: 'Preprint' },
            attachments: [{ url: 'https://x.org/p.pdf', mime_type: 'application/pdf' }],
            pageUrl: 'https://x.org/p',
        });
        const [withPdf] = await resolveImportItems([spec('b', { url: 'https://x.org/p' })], base);
        expect(withPdf.snapshot_url).toBeUndefined();
    });

    it('snapshots a non-web item type that has neither a PDF nor a DOI', async () => {
        mocks.translateUrl.mockResolvedValue({
            ok: true,
            json: { itemType: 'report', title: 'Report' },
            attachments: [],
            pageUrl: 'https://x.org/r',
        });
        const [result] = await resolveImportItems([spec('a', { url: 'https://x.org/r' })], base);
        expect(result.snapshot_url).toBe('https://x.org/r');
    });

    it('falls back with a warning when the url cannot be translated', async () => {
        mocks.translateUrl.mockResolvedValue({ ok: false, code: 'blocked', message: 'bot check' });
        const [result] = await resolveImportItems([
            spec('a', { url: 'https://x.org', fallback_item: { itemType: 'webpage', title: 'Fallback' } }),
        ], base);
        expect(result).toMatchObject({ status: 'resolved', method: 'fallback_metadata' });
        expect(result.warnings?.[0]).toContain('page lookup failed (bot check)');
    });

    it('fails with the url error code and no fallback', async () => {
        mocks.translateUrl.mockResolvedValue({ ok: false, code: 'url_not_allowed', message: 'private' });
        const [result] = await resolveImportItems([spec('a', { url: 'http://localhost' })], base);
        expect(result).toMatchObject({ status: 'failed', error: { code: 'url_not_allowed' } });
    });

    it('uses only the fallback metadata when nothing else is given', async () => {
        const [result] = await resolveImportItems([spec('a', { fallback_item: { itemType: 'book', title: 'Only fallback' } })], base);
        expect(result).toMatchObject({ status: 'resolved', method: 'fallback_metadata', item: { title: 'Only fallback' } });
        expect(result.warnings).toBeUndefined();
    });

    it('fails a spec with nothing to resolve', async () => {
        const [result] = await resolveImportItems([spec('a')], base);
        expect(result).toMatchObject({ status: 'failed', error: { code: 'invalid_metadata' } });
    });
});

describe('resolveImportItems with files', () => {
    it('fails with the location error when the file cannot be located', async () => {
        mocks.locateImportFile.mockResolvedValue({ ok: false, code: 'path_not_authorized', message: 'not authorized' });
        const [result] = await resolveImportItems([spec('a', { file: { path: '/x/a.pdf' } })], base);
        expect(result).toMatchObject({ status: 'failed', error: { code: 'path_not_authorized', message: 'not authorized' } });
        expect(mocks.recognizeFile).not.toHaveBeenCalled();
    });

    it('passes the thread id to file location', async () => {
        mocks.locateImportFile.mockResolvedValue({ ok: false, code: 'file_not_found', message: 'gone' });
        await resolveImportItems([spec('a', { file: { path: '/x/a.pdf' } })], { ...base, threadId: 'thread-1' });
        expect(mocks.locateImportFile).toHaveBeenCalledWith({ path: '/x/a.pdf' }, { threadId: 'thread-1' });
    });

    it('attaches a file to the chosen reference instead of recognizing it', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        const [result] = await resolveImportItems([spec('a', {
            fallback_item: { itemType: 'report', title: 'The chosen report' },
            file: { path: '/home/u/papers/a.pdf' },
        })], base);
        expect(result).toMatchObject({
            status: 'resolved',
            method: 'fallback_metadata',
            item: { title: 'The chosen report' },
            file: { filename: 'a.pdf' },
        });
        expect(mocks.recognizeFile).not.toHaveBeenCalled();
    });

    it('recognizes a file with no other source and attaches hints and the file reference', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        mocks.recognizeFile.mockResolvedValue({
            kind: 'item',
            json: { itemType: 'journalArticle', title: 'Recognized' },
            translator: 'Zotero recognizer',
            hints: { abstract: 'An abstract', language: 'en' },
        });
        const [result] = await resolveImportItems([spec('a', { file: { path: '/home/u/papers/a.pdf' } })], base);
        expect(result).toMatchObject({
            status: 'resolved',
            method: 'recognizer',
            translator: 'Zotero recognizer',
            item: { title: 'Recognized' },
            recognizer_hints: { abstract: 'An abstract', language: 'en' },
            file: { filename: 'a.pdf', mime_type: 'application/pdf' },
        });
    });

    it('translates recognized identifiers in order, using the first that works', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        mocks.recognizeFile.mockResolvedValue({
            kind: 'identifiers',
            identifiers: [{ type: 'doi', value: '10.1/a' }, { type: 'arxiv', value: '1234.5678' }],
            hints: {},
        });
        mocks.translateIdentifier
            .mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'x' })
            .mockResolvedValueOnce({ ok: true, json: { itemType: 'preprint', title: 'arXiv paper' }, translator: 'arXiv', attachments: [] });
        const [result] = await resolveImportItems([spec('a', { file: { path: '/home/u/papers/a.pdf' } })], base);
        expect(result).toMatchObject({ status: 'resolved', method: 'recognizer', translator: 'arXiv', item: { title: 'arXiv paper' } });
        expect(mocks.translateIdentifier).toHaveBeenCalledTimes(2);
    });

    it('uses the recognizer title item when no identifier translates', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        mocks.recognizeFile.mockResolvedValue({
            kind: 'identifiers',
            identifiers: [{ type: 'doi', value: '10.1/a' }],
            titleItem: { itemType: 'journalArticle', title: 'By title' },
            hints: {},
        });
        mocks.translateIdentifier.mockResolvedValue({ ok: false, code: 'not_found', message: 'x' });
        const [result] = await resolveImportItems([spec('a', { file: { path: '/home/u/papers/a.pdf' } })], base);
        expect(result).toMatchObject({ status: 'resolved', translator: 'Zotero recognizer', item: { title: 'By title' } });
    });

    it('fails with unrecognized_file when identifiers do not translate and there is no title item', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        mocks.recognizeFile.mockResolvedValue({ kind: 'identifiers', identifiers: [{ type: 'doi', value: '10.1/a' }], hints: {} });
        mocks.translateIdentifier.mockResolvedValue({ ok: false, code: 'not_found', message: 'x' });
        const [result] = await resolveImportItems([spec('a', { file: { path: '/home/u/papers/a.pdf' } })], base);
        expect(result).toMatchObject({ status: 'failed', error: { code: 'unrecognized_file' } });
    });

    it('defers recognition to apply time without item metadata', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        mocks.recognizeFile.mockResolvedValue({ kind: 'deferred', reason: 'recognizer unavailable' });
        const [result] = await resolveImportItems([spec('a', { file: { path: '/home/u/papers/a.pdf' } })], base);
        expect(result).toMatchObject({ status: 'resolved', method: 'recognizer_deferred' });
        expect(result.item).toBeUndefined();
        expect(result.warnings?.[0]).toContain('Zotero will identify the file');
    });

    it('fails with the recognizer error', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        mocks.recognizeFile.mockResolvedValue({ kind: 'error', code: 'no_text', message: 'scanned' });
        const [result] = await resolveImportItems([spec('a', { file: { path: '/home/u/papers/a.pdf' } })], base);
        expect(result).toMatchObject({ status: 'failed', error: { code: 'no_text', message: 'scanned' }, file: { filename: 'a.pdf' } });
    });

    it('fails with timeout when recognition times out', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        mocks.recognizeFile.mockRejectedValue(Object.assign(new Error('slow'), { code: 'timeout' }));
        const [result] = await resolveImportItems([spec('a', { file: { path: '/home/u/papers/a.pdf' } })], base);
        expect(result).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
    });

    it('does not recognize the file when another source supplies the metadata, and keeps the file reference', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        const [result] = await resolveImportItems([
            spec('a', { file: { path: '/home/u/papers/a.pdf' }, item: { itemType: 'book', title: 'Mine' } }),
        ], base);
        expect(mocks.recognizeFile).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'resolved', method: 'model_metadata', file: { filename: 'a.pdf' } });
    });

    it('takes no page snapshot for a url item that has a local file', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        mocks.translateUrl.mockResolvedValue({
            ok: true,
            json: { itemType: 'webpage', title: 'Page' },
            attachments: [],
            pageUrl: 'https://x.org/p',
        });
        const [result] = await resolveImportItems([
            spec('a', { url: 'https://x.org/p', file: { path: '/home/u/papers/a.pdf' } }),
        ], base);
        expect(result.snapshot_url).toBeUndefined();
    });
});

describe('resolveImportItems batch behavior', () => {
    it('returns results in input order and isolates a throwing spec', async () => {
        mocks.translateIdentifier.mockImplementation(async (identifier: { value: string }) => {
            if (identifier.value === 'boom') throw new Error('kaput');
            return { ok: true, json: { itemType: 'book', title: identifier.value }, attachments: [] };
        });
        const results = await resolveImportItems([
            spec('a', { identifier: { type: 'doi', value: 'one' } }),
            spec('b', { identifier: { type: 'doi', value: 'boom' } }),
            spec('c', { identifier: { type: 'doi', value: 'three' } }),
        ], base);
        expect(results.map((result) => result.key)).toEqual(['a', 'b', 'c']);
        expect(results.map((result) => result.status)).toEqual(['resolved', 'failed', 'resolved']);
        expect(results[1].error).toMatchObject({ code: 'resolution_failed' });
        expect(results[1].error?.message).toContain('kaput');
    });

    it('fails every spec with timeout when the deadline has already passed', async () => {
        const results = await resolveImportItems([
            spec('a', { identifier: { type: 'doi', value: '1' } }),
            spec('b', { item: { itemType: 'book', title: 'T' } }),
        ], { ...base, deadlineMs: 0 });
        expect(results.map((result) => result.error?.code)).toEqual(['timeout', 'timeout']);
        expect(mocks.translateIdentifier).not.toHaveBeenCalled();
    });

    it('fails remaining specs with timeout once earlier work consumed the deadline', async () => {
        vi.useFakeTimers();
        try {
            mocks.translateIdentifier.mockImplementation(async () => {
                vi.setSystemTime(Date.now() + 5000);
                return { ok: true, json: { itemType: 'book', title: 'T' }, attachments: [] };
            });
            // Concurrency 4 for identifiers: five specs means the fifth waits for a slot.
            const specs = Array.from({ length: 5 }, (_, index) => spec(`k${index}`, { identifier: { type: 'doi', value: String(index) } }));
            const results = await resolveImportItems(specs, { ...base, deadlineMs: 4000 });
            expect(results[4]).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
        } finally {
            vi.useRealTimers();
        }
    });

    it('passes a per-item budget capped by the remaining deadline', async () => {
        mocks.translateIdentifier.mockResolvedValue({ ok: true, json: { itemType: 'book', title: 'T' }, attachments: [] });
        await resolveImportItems([spec('a', { identifier: { type: 'doi', value: '1' } })], { ...base, deadlineMs: 5000 });
        const budget = mocks.translateIdentifier.mock.calls[0][1];
        expect(budget).toBeLessThanOrEqual(5000);
        expect(budget).toBeGreaterThan(0);
    });
});

describe('resolveImportItems duplicate check', () => {
    it('marks a resolved item already_in_library with the existing item reference', async () => {
        mocks.findExistingItems.mockResolvedValue(new Map([
            ['a', { library_id: 1, zotero_key: 'EXIST123', library_ref: 'u' }],
        ]));
        const results = await resolveImportItems([
            spec('a', { item: { itemType: 'book', title: 'Dup' } }),
            spec('b', { item: { itemType: 'book', title: 'New' } }),
        ], base);
        expect(results[0]).toMatchObject({
            status: 'already_in_library',
            existing_item: { library_id: 1, zotero_key: 'EXIST123', library_ref: 'u' },
        });
        expect(results[1].status).toBe('resolved');
        expect(results[1].existing_item).toBeUndefined();
    });

    it('checks only resolved items that have item JSON, in the target library', async () => {
        mocks.locateImportFile.mockResolvedValue(located());
        mocks.recognizeFile.mockResolvedValue({ kind: 'deferred', reason: 'x' });
        await resolveImportItems([
            spec('ok', { item: { itemType: 'book', title: 'T' } }),
            spec('failed', { item: { itemType: 'spaceship' } }),
            spec('deferred', { file: { path: '/home/u/papers/a.pdf' } }),
        ], { ...base, libraryID: 7 });
        expect(mocks.findExistingItems).toHaveBeenCalledTimes(1);
        const [entries, libraryID] = mocks.findExistingItems.mock.calls[0];
        expect(entries.map((entry: any) => entry.key)).toEqual(['ok']);
        expect(libraryID).toBe(7);
    });

    it('skips the duplicate check when asked', async () => {
        await resolveImportItems([spec('a', { item: { itemType: 'book', title: 'T' } })], { ...base, skipDuplicateCheck: true });
        expect(mocks.findExistingItems).not.toHaveBeenCalled();
    });
});
