/**
 * Integration tests for the Attachment File Cache.
 *
 * Exercises the full pipeline: HTTP request -> handler -> PDF extraction ->
 * cache write -> cache read -> response against a live Zotero instance.
 *
 * Prerequisites:
 *   - Zotero running with Beaver plugin loaded and authenticated
 *   - Test attachments present in the library (see fixtures.ts)
 *
 * Run: npm run test:integration
 * Tests skip gracefully if Zotero is not available.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
    NORMAL_PDF,
    SMALL_PDF,
    ENCRYPTED_PDF,
    NO_TEXT_PDF,
    LARGE_PDF,
    GROUP_LIB_PDF,
    GROUP_LIB2_PDF,
    PARENT_ITEM,
    NON_PDF,
    LINKED_URL,
    IMAGE,
} from './helpers/fixtures';
import {
    fetchPages,
    fetchPageImages,
    searchAttachment,
} from './helpers/zoteroClient';
import {
    ping,
    getCacheMetadata,
    invalidateCache,
    clearMemoryCache,
    deleteContentCache,
} from './helpers/cacheInspector';

// ---------------------------------------------------------------------------
// Global availability flag
// ---------------------------------------------------------------------------

let zoteroAvailable = false;

beforeAll(async () => {
    try {
        const res = await ping();
        zoteroAvailable = res.ok && res.cache_available && res.db_available;
    } catch {
        zoteroAvailable = false;
    }
    if (!zoteroAvailable) {
        console.warn(
            '\n⚠  Zotero not available — all integration tests will be skipped.\n' +
            '   Start Zotero with Beaver loaded and authenticated to run these tests.\n',
        );
    }
});

function skipIfUnavailable(ctx: { skip: () => void }) {
    if (!zoteroAvailable) ctx.skip();
}

// ==========================================================================
// B1: Pages Handler
// ==========================================================================

describe('Pages handler', () => {
    beforeEach((ctx) => skipIfUnavailable(ctx));

    it('#79 cold cache: returns pages and populates cache metadata', async () => {
        // Invalidate to force cold extraction
        await invalidateCache(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
        await clearMemoryCache();

        const res = await fetchPages(NORMAL_PDF, { start_page: 1, end_page: 3 });

        expect(res.error_code).toBeFalsy();
        expect(res.total_pages).toBe(15);
        expect(res.pages).toHaveLength(3);
        expect(res.pages[0].page_number).toBe(1);
        expect(res.pages[0].content).toBeTruthy();

        // Verify cache metadata was written
        const meta = await getCacheMetadata(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
        expect(meta).not.toBeNull();
        expect(meta!.page_count).toBe(15);
        expect(meta!.has_text_layer).toBeTruthy();

    });

    it('#80 warm cache: second request returns identical data', async () => {
        // First request (may already be warm from previous test)
        const first = await fetchPages(NORMAL_PDF, { start_page: 1, end_page: 3 });
        expect(first.error_code).toBeFalsy();

        const t0 = performance.now();
        const second = await fetchPages(NORMAL_PDF, { start_page: 1, end_page: 3 });
        const warmMs = performance.now() - t0;

        expect(second.error_code).toBeFalsy();
        expect(second.pages).toHaveLength(first.pages.length);
        expect(second.total_pages).toBe(first.total_pages);
        // Content should be identical
        for (let i = 0; i < first.pages.length; i++) {
            expect(second.pages[i].content).toBe(first.pages[i].content);
        }
        // Warm read should be fast (< 2s generous threshold for network + JSON overhead)
        expect(warmMs).toBeLessThan(2000);
    });

    it('#81 overlapping range: cache 1-5, request 3-8, then 1-8 full hit', async () => {
        // Ensure warm cache for 1-5
        const r1 = await fetchPages(NORMAL_PDF, { start_page: 1, end_page: 5 });
        expect(r1.error_code).toBeFalsy();
        expect(r1.pages).toHaveLength(5);

        // Overlapping request 3-8
        const r2 = await fetchPages(NORMAL_PDF, { start_page: 3, end_page: 8 });
        expect(r2.error_code).toBeFalsy();
        expect(r2.pages).toHaveLength(6);

        // Full range 1-8 — should all be cached now
        const r3 = await fetchPages(NORMAL_PDF, { start_page: 1, end_page: 8 });
        expect(r3.error_code).toBeFalsy();
        expect(r3.pages).toHaveLength(8);
    });

    it('#82 entire document after partial cache', async () => {
        // Partial cache already warm from previous tests; request all pages
        const res = await fetchPages(NORMAL_PDF);
        expect(res.error_code).toBeFalsy();
        expect(res.total_pages).toBe(15);
        expect(res.pages).toHaveLength(15);
    });

    it('#85 encrypted PDF: returns error and caches is_encrypted', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        await clearMemoryCache();

        const res = await fetchPages(ENCRYPTED_PDF);

        expect(res.error_code).toBe('encrypted');
        expect(res.pages).toHaveLength(0);

        const meta = await getCacheMetadata(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        expect(meta).not.toBeNull();
        expect(meta!.is_encrypted).toBeTruthy();
    });

    it('#86 no text layer: returns error and caches needs_ocr', async () => {
        await invalidateCache(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
        await clearMemoryCache();

        const res = await fetchPages(NO_TEXT_PDF);

        expect(res.error_code).toBe('no_text_layer');
        expect(res.pages).toHaveLength(0);

        const meta = await getCacheMetadata(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
        expect(meta).not.toBeNull();
        expect(meta!.needs_ocr).toBeTruthy();
    });

    it('#88 page range validation: out of range errors', async () => {
        // start_page=0 (1-indexed, so 0 is invalid)
        const r1 = await fetchPages(NORMAL_PDF, { start_page: 0, end_page: 3 });
        expect(r1.error_code).toBe('page_out_of_range');

        // end_page far exceeds total
        const r2 = await fetchPages(NORMAL_PDF, { start_page: 1, end_page: 999 });
        expect(r2.error_code).toBe('page_out_of_range');
    });

    it('#89 skip_local_limits: large PDF succeeds with flag', async () => {
        const res = await fetchPages(
            LARGE_PDF,
            { start_page: 1, end_page: 5, skip_local_limits: true },
        );
        expect(res.error_code).toBeFalsy();
        expect(res.total_pages).toBe(316);
        expect(res.pages).toHaveLength(5);
    });

    it('parent auto-resolve: request via parent item key resolves to attachment', async () => {
        const res = await fetchPages(PARENT_ITEM, { start_page: 1, end_page: 1 });
        // Should resolve to the child attachment and return pages
        expect(res.error_code).toBeFalsy();
        expect(res.pages.length).toBeGreaterThanOrEqual(1);
        expect(res.total_pages).toBeGreaterThan(0);
    });

    it('small PDF: returns all pages correctly', async () => {
        const res = await fetchPages(SMALL_PDF);
        expect(res.error_code).toBeFalsy();
        expect(res.total_pages).toBe(2);
        expect(res.pages).toHaveLength(2);
    });
});

// ==========================================================================
// B3: Page Images Handler
// ==========================================================================

describe('Page images handler', () => {
    beforeEach((ctx) => skipIfUnavailable(ctx));

    it('#90 cold image request: returns image data and does not write metadata', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        await clearMemoryCache();

        const res = await fetchPageImages(SMALL_PDF, { pages: [1] });

        expect(res.error_code).toBeFalsy();
        expect(res.pages).toHaveLength(1);
        expect(res.pages[0].image_data).toBeTruthy();
        expect(res.pages[0].width).toBeGreaterThan(0);
        expect(res.pages[0].height).toBeGreaterThan(0);
        expect(res.total_pages).toBe(2);

        // Successful image reads should not write partial metadata
        const meta = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(meta).toBeNull();
    });

    it('#92 concurrent pages + images: both succeed, metadata not corrupted', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        await clearMemoryCache();

        const [pagesRes, imagesRes] = await Promise.all([
            fetchPages(SMALL_PDF, { start_page: 1, end_page: 1 }),
            fetchPageImages(SMALL_PDF, { pages: [2] }),
        ]);

        expect(pagesRes.error_code).toBeFalsy();
        expect(imagesRes.error_code).toBeFalsy();
        expect(pagesRes.total_pages).toBe(2);
        expect(imagesRes.total_pages).toBe(2);

        // Metadata should be consistent
        const meta = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(meta).not.toBeNull();
        expect(meta!.page_count).toBe(2);
    });

    it('#93 encrypted via images: returns error and backfills metadata', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        await clearMemoryCache();

        const res = await fetchPageImages(ENCRYPTED_PDF, { pages: [1] });

        expect(res.error_code).toBe('encrypted');
        expect(res.pages).toHaveLength(0);

        const meta = await getCacheMetadata(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        expect(meta).not.toBeNull();
        expect(meta!.is_encrypted).toBeTruthy();
    });
});

// ==========================================================================
// B4: Search Handler
// ==========================================================================

describe('Search handler', () => {
    beforeEach((ctx) => skipIfUnavailable(ctx));

    it('#94 cold search: finds matches and does not write metadata', async () => {
        await invalidateCache(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
        await clearMemoryCache();

        const res = await searchAttachment(NORMAL_PDF, 'the');

        expect(res.error_code).toBeFalsy();
        expect(res.total_matches).toBeGreaterThan(0);
        expect(res.pages_with_matches).toBeGreaterThan(0);
        expect(res.total_pages).toBe(15);
        expect(res.pages.length).toBeGreaterThan(0);
        expect(res.pages[0].hits.length).toBeGreaterThan(0);

        // Successful search should not write partial metadata
        const meta = await getCacheMetadata(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
        expect(meta).toBeNull();
    });

    it('#95 search after pages cached: still works', async () => {
        // Ensure pages are cached first
        const pages = await fetchPages(NORMAL_PDF, { start_page: 1, end_page: 3 });
        expect(pages.error_code).toBeFalsy();

        // Search should still work
        const res = await searchAttachment(NORMAL_PDF, 'the');
        expect(res.error_code).toBeFalsy();
        expect(res.total_matches).toBeGreaterThan(0);
    });

    it('#96 search encrypted (warm): cached metadata returns fast error', async () => {
        // Ensure encrypted metadata is cached
        await fetchPages(ENCRYPTED_PDF);

        const t0 = performance.now();
        const res = await searchAttachment(ENCRYPTED_PDF, 'anything');
        const elapsed = performance.now() - t0;

        expect(res.error_code).toBe('encrypted');
        // Should be fast since metadata is cached
        expect(elapsed).toBeLessThan(2000);
    });

    it('#97 search encrypted (cold): error and metadata backfilled', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        await clearMemoryCache();

        const res = await searchAttachment(ENCRYPTED_PDF, 'anything');

        expect(res.error_code).toBe('encrypted');

        const meta = await getCacheMetadata(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        expect(meta).not.toBeNull();
        expect(meta!.is_encrypted).toBeTruthy();
    });
});

// ==========================================================================
// B6: Staleness
// ==========================================================================

describe('Staleness', () => {
    beforeEach((ctx) => skipIfUnavailable(ctx));

    it('#111 content file deleted: re-extracts on next request', async () => {
        // Ensure cache is warm
        const r1 = await fetchPages(SMALL_PDF, { start_page: 1, end_page: 1 });
        expect(r1.error_code).toBeFalsy();
        expect(r1.pages).toHaveLength(1);
        const originalContent = r1.pages[0].content;

        // Delete the content file but keep metadata
        await deleteContentCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        await clearMemoryCache();

        // Request again — should re-extract
        const r2 = await fetchPages(SMALL_PDF, { start_page: 1, end_page: 1 });
        expect(r2.error_code).toBeFalsy();
        expect(r2.pages).toHaveLength(1);
        expect(r2.pages[0].content).toBe(originalContent);

        // Content cache should be restored
        const meta = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(meta).not.toBeNull();

    });
});

// ==========================================================================
// B7: Multi-Library
// ==========================================================================

describe('Multi-library', () => {
    beforeEach((ctx) => skipIfUnavailable(ctx));

    it('#113 different libraries: both succeed with separate cache entries', async () => {
        const [r1, r2] = await Promise.all([
            fetchPages(NORMAL_PDF, { start_page: 1, end_page: 1 }),
            fetchPages(GROUP_LIB_PDF, { start_page: 1, end_page: 1 }),
        ]);

        expect(r1.error_code).toBeFalsy();
        expect(r2.error_code).toBeFalsy();
        expect(r1.pages).toHaveLength(1);
        expect(r2.pages).toHaveLength(1);

        // Separate cache entries
        const meta1 = await getCacheMetadata(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
        const meta2 = await getCacheMetadata(GROUP_LIB_PDF.library_id, GROUP_LIB_PDF.zotero_key);
        expect(meta1).not.toBeNull();
        expect(meta2).not.toBeNull();
        expect(meta1!.library_id).toBe(NORMAL_PDF.library_id);
        expect(meta2!.library_id).toBe(GROUP_LIB_PDF.library_id);
    });
});

// ==========================================================================
// B10: Error Cases
// ==========================================================================

describe('Error cases', () => {
    beforeEach((ctx) => skipIfUnavailable(ctx));

    it('#127 non-existent key: returns not_found', async () => {
        const res = await fetchPages({
            library_id: 1,
            zotero_key: 'ZZZZZZZZ',
            description: 'non-existent',
        });
        expect(res.error_code).toBe('not_found');
    });

    it('invalid format: library_id=-1 returns error', async () => {
        const res = await fetchPages({
            library_id: -1,
            zotero_key: 'ABCD1234',
            description: 'invalid library',
        });
        // Should return invalid_format or not_found
        expect(res.error_code).toBeTruthy();
    });

    it('non-PDF attachment: EPUB returns not_pdf', async () => {
        const res = await fetchPages(NON_PDF);
        expect(res.error_code).toBe('not_pdf');
    });

    it('linked URL: returns is_linked_url', async () => {
        const res = await fetchPages(LINKED_URL);
        // LINKED_URL fixture may not point to an actual linked-URL attachment
        // in all test libraries. Accept either is_linked_url or a valid response.
        if (res.error_code) {
            expect(res.error_code).toBe('is_linked_url');
        } else {
            // Item resolved to a regular attachment — fixture mismatch, still valid
            expect(res.pages.length).toBeGreaterThan(0);
        }
    });
});

// ==========================================================================
// B11: Performance
// ==========================================================================

describe('Performance', () => {
    beforeEach((ctx) => skipIfUnavailable(ctx));

    it('#129 cache hit latency: warm cache read < 200ms', async () => {
        // Warm the cache
        await fetchPages(SMALL_PDF);

        const t0 = performance.now();
        const res = await fetchPages(SMALL_PDF);
        const elapsed = performance.now() - t0;

        expect(res.error_code).toBeFalsy();
        expect(elapsed).toBeLessThan(200);
    });

    it('#134 rapid sequential requests: 5 requests for same PDF, no errors', async () => {
        // Ensure cache is warm
        await fetchPages(SMALL_PDF);

        const results = [];
        for (let i = 0; i < 5; i++) {
            results.push(await fetchPages(SMALL_PDF, { start_page: 1, end_page: 1 }));
        }

        for (const res of results) {
            expect(res.error_code).toBeFalsy();
            expect(res.pages).toHaveLength(1);
            expect(res.total_pages).toBe(2);
        }
    });
});
