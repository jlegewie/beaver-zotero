/**
 * Whole-document extraction live suite (`/beaver/attachment/document`).
 *
 * Covers the refactor that routed `handleZoteroDocumentRequest` through the
 * new `DocumentCache` instead of `AttachmentFileCache`:
 *   - markdown / structured extraction happy paths and the result shape
 *   - the document-cache round-trip: cold miss → extraction → metadata +
 *     payload write → warm hit returning an identical result
 *   - the `too_many_pages` reject threshold on both the cold path and the
 *     cached-result path
 *   - extraction-error backfill: encrypted / invalid / no-text PDFs write an
 *     `errorCode` record to the document cache via `putErrorMetadata`
 *   - attachment-type / reference rejections (non-PDF, unresolvable key)
 *   - parent-item auto-resolution and cross (group) library extraction
 *   - the search handler writing `errorCode` on a cold cache
 *   - the page-image render path deliberately NOT writing cache metadata
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (SMALL_PDF, NORMAL_PDF, ENCRYPTED_PDF,
 *     NO_TEXT_PDF, INVALID_PDF_FIXTURE, NON_PDF, PARENT_ITEM, GROUP_LIB_PDF).
 *
 * Run with: `npm run test:live -- documentRequest`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { getCacheMetadata, invalidateCache } from '../helpers/cacheInspector';
import {
    fetchDocument,
    fetchPageImages,
    searchAttachment,
    type DocumentResponse,
} from '../helpers/zoteroHttpClient';
import {
    SMALL_PDF,
    NORMAL_PDF,
    ENCRYPTED_PDF,
    NO_TEXT_PDF,
    INVALID_PDF_FIXTURE,
    NON_PDF,
    PARENT_ITEM,
    GROUP_LIB_PDF,
} from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const SMALL_PDF_PAGE_COUNT = 2;

/** Generous timeout — whole-document extraction is slower than a metadata probe. */
const EXTRACT_OPTS = { timeout: 90_000 } as const;

/** Narrow a document response to a successful result, failing otherwise. */
function expectResult(res: DocumentResponse): NonNullable<DocumentResponse['result']> {
    if (res.error || !res.result) {
        throw new Error(`Expected a document result, got error: ${res.error_code} ${res.error}`);
    }
    return res.result;
}

describe('document request — extraction happy paths', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns a markdown document for a small PDF', async () => {
        const res = await fetchDocument(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        const result = expectResult(res);

        expect(res.content_kind).toBe('pdf');
        expect(result.content_kind).toBe('pdf');
        expect(result.mode).toBe('markdown');
        expect(result.document.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(result.document.pages).toHaveLength(SMALL_PDF_PAGE_COUNT);
        expect(typeof result.document.pages[0]?.markdown).toBe('string');
        expect(res.resolved_attachment).toMatchObject({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
        });
        expect(res.content_type).toBe('application/pdf');
    });

    it('returns a structured document for a small PDF', async () => {
        const res = await fetchDocument(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS);
        const result = expectResult(res);

        expect(res.content_kind).toBe('pdf');
        expect(result.content_kind).toBe('pdf');
        expect(result.mode).toBe('structured');
        expect(result.document.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(result.document.pages).toHaveLength(SMALL_PDF_PAGE_COUNT);
        expect(Array.isArray(result.document.pages[0]?.items)).toBe(true);
    });

    it('defaults to structured mode when mode is omitted', async () => {
        const res = await fetchDocument(SMALL_PDF, {}, EXTRACT_OPTS);
        const result = expectResult(res);
        expect(result.mode).toBe('structured');
    });
});

describe('document cache round-trip', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('writes metadata + payload on a cold miss and serves an identical warm hit', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);

        // Cold miss → full extraction.
        const cold = expectResult(
            await fetchDocument(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS),
        );

        // A clean metadata record must now exist (page count + labels, no error).
        const record = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(record).not.toBeNull();
        expect(record?.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(record?.errorCode).toBeNull();
        expect(record?.contentType).toBe('application/pdf');

        // Warm hit → identical content served from the payload cache.
        const warm = expectResult(
            await fetchDocument(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS),
        );
        expect(warm.document.pageCount).toBe(cold.document.pageCount);
        expect(warm.document.pages[0]?.markdown).toBe(cold.document.pages[0]?.markdown);
        expect(warm.schemaVersion).toBe(cold.schemaVersion);
    });

    it('caches markdown and structured modes independently', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);

        const markdown = expectResult(
            await fetchDocument(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS),
        );
        const structured = expectResult(
            await fetchDocument(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS),
        );

        expect(markdown.mode).toBe('markdown');
        expect(structured.mode).toBe('structured');
        expect(structured.document.pageCount).toBe(markdown.document.pageCount);
    });
});

describe('document request — too_many_pages threshold', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('rejects on the cold path when page count exceeds max_pages', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);

        const res = await fetchDocument(
            SMALL_PDF,
            { mode: 'markdown', max_pages: 1 },
            EXTRACT_OPTS,
        );
        expect(res.error_code).toBe('too_many_pages');
        expect(res.result ?? null).toBeNull();
        expect(res.total_pages).toBe(SMALL_PDF_PAGE_COUNT);
    });

    it('rejects from the cached result when page count exceeds max_pages', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        // Warm the cache with a full extraction first.
        expectResult(await fetchDocument(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS));

        const res = await fetchDocument(
            SMALL_PDF,
            { mode: 'markdown', max_pages: 1 },
            EXTRACT_OPTS,
        );
        expect(res.error_code).toBe('too_many_pages');
        expect(res.total_pages).toBe(SMALL_PDF_PAGE_COUNT);
    });

    it('extracts normally when max_pages is not exceeded', async () => {
        const res = await fetchDocument(
            SMALL_PDF,
            { mode: 'markdown', max_pages: 50 },
            EXTRACT_OPTS,
        );
        expect(res.error_code ?? null).toBeNull();
        expect(expectResult(res).document.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
    });
});

describe('document request — extraction errors backfill the cache', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns "encrypted" and writes errorCode "encrypted" for a password-protected PDF', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);

        const res = await fetchDocument(ENCRYPTED_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(res.error_code).toBe('encrypted');
        expect(res.result ?? null).toBeNull();

        const record = await getCacheMetadata(
            ENCRYPTED_PDF.library_id,
            ENCRYPTED_PDF.zotero_key,
        );
        expect(record?.errorCode).toBe('encrypted');
    });

    it('returns "empty_document" for a corrupt PDF without writing an error record', async () => {
        // `empty_document` is not one of the three backfilled error codes
        // (encrypted / invalid_pdf / no_text_layer), so the document cache
        // must stay empty for this attachment.
        await invalidateCache(
            INVALID_PDF_FIXTURE.library_id,
            INVALID_PDF_FIXTURE.zotero_key,
        );

        const res = await fetchDocument(INVALID_PDF_FIXTURE, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(res.error_code).toBe('empty_document');
        expect(res.result ?? null).toBeNull();

        const record = await getCacheMetadata(
            INVALID_PDF_FIXTURE.library_id,
            INVALID_PDF_FIXTURE.zotero_key,
        );
        expect(record).toBeNull();
    });

    it('returns "no_text_layer" and writes errorCode "no_text_layer" for a scanned PDF', async () => {
        await invalidateCache(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);

        const res = await fetchDocument(NO_TEXT_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(res.error_code).toBe('no_text_layer');
        expect(res.result ?? null).toBeNull();

        const record = await getCacheMetadata(
            NO_TEXT_PDF.library_id,
            NO_TEXT_PDF.zotero_key,
        );
        expect(record?.errorCode).toBe('no_text_layer');
    });

    it('serves the cached error record on a repeat request without re-extracting', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        await fetchDocument(ENCRYPTED_PDF, { mode: 'markdown' }, EXTRACT_OPTS);

        // Second call: the cached `errorCode` short-circuits to the same error.
        const res = await fetchDocument(ENCRYPTED_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(res.error_code).toBe('encrypted');
    });
});

describe('document request — attachment-type rejections', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('rejects a non-PDF (EPUB) attachment', async () => {
        const res = await fetchDocument(NON_PDF, { mode: 'markdown' });
        expect(res.error_code).toBe('not_pdf');
        expect(res.result ?? null).toBeNull();
    });

    it('reports an unresolvable attachment reference', async () => {
        const res = await fetchDocument(
            { library_id: 1, zotero_key: 'ZZZZZZZZ', description: 'missing' },
            { mode: 'markdown' },
        );
        expect(res.error_code).toBeTruthy();
        expect(['not_found', 'invalid_format']).toContain(res.error_code);
    });
});

describe('document request — item resolution', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('auto-resolves a parent item to its PDF attachment', async () => {
        const res = await fetchDocument(PARENT_ITEM, { mode: 'markdown' }, EXTRACT_OPTS);
        const result = expectResult(res);
        expect(result.document.pageCount).toBeGreaterThan(0);
        // The resolved attachment differs from the requested parent key.
        expect(res.resolved_attachment?.zotero_key).not.toBe(PARENT_ITEM.zotero_key);
    });

    it('extracts a PDF from a group library', async () => {
        const res = await fetchDocument(GROUP_LIB_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        const result = expectResult(res);
        expect(result.document.pageCount).toBeGreaterThan(0);
        expect(res.resolved_attachment?.library_id).toBe(GROUP_LIB_PDF.library_id);
    });
});

describe('search handler backfills the document cache on a cold miss', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('writes errorCode "encrypted" when searching an encrypted PDF cold', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);

        const res = await searchAttachment(ENCRYPTED_PDF, 'introduction');
        expect(res.error_code).toBe('encrypted');
        expect(res.pages).toHaveLength(0);

        const record = await getCacheMetadata(
            ENCRYPTED_PDF.library_id,
            ENCRYPTED_PDF.zotero_key,
        );
        expect(record?.errorCode).toBe('encrypted');
    });
});

describe('page-image render path does not write cache metadata', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('leaves the document cache empty after rendering an uncached PDF', async () => {
        // Rendering proves the PDF opens but never inspects the text layer,
        // so it must not seed a metadata record.
        await invalidateCache(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);

        const res = await fetchPageImages(NORMAL_PDF, { pages: [1] }, EXTRACT_OPTS);
        expect(res.pages.length).toBeGreaterThan(0);

        const record = await getCacheMetadata(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
        );
        expect(record).toBeNull();
    });
});
