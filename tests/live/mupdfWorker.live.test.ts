/**
 * MuPDF worker smoke suite.
 *
 * Exercises the production worker path against real PDFs in a live Zotero
 * process. Pre-PR #4 this file was a parity suite (main-thread vs worker);
 * after PR #4 the main-thread path is gone, so the suite collapses to a
 * single-path regression net. The unit tests in
 * `tests/unit/services/mupdfWorkerClient.test.ts` cover client-wrapper
 * correctness; this file's load-bearing value is the `NO_TEXT_LAYER`
 * payload round-trip against `NO_TEXT_PDF`.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (SMALL_PDF, NORMAL_PDF, ENCRYPTED_PDF,
 *     NO_TEXT_PDF, INVALID_PDF_FIXTURE).
 *
 * Run with: `npm run test:live -- mupdfWorker`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    isZoteroAvailable,
    skipIfNoZotero,
} from '../helpers/zoteroAvailability';
import {
    pdfPageCount,
    pdfPageCountFromBytes,
    pdfPageLabels,
    pdfRenderPages,
    pdfRenderPagesWithMeta,
    pdfExtractRaw,
    pdfExtractRawDetailed,
    pdfSearch,
    pdfExtract,
    pdfExtractByLines,
    pdfHasTextLayer,
    pdfAnalyzeOcr,
    pdfSearchScored,
    pdfSentenceBBoxes,
    pdfRenderPage,
} from '../helpers/cacheInspector';
import {
    SMALL_PDF,
    NORMAL_PDF,
    ENCRYPTED_PDF,
    INVALID_PDF_FIXTURE,
    NO_TEXT_PDF,
} from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const SMALL_PDF_PAGE_COUNT = 2;
const NORMAL_PDF_PAGE_COUNT = 15;

describe('MuPDF worker smoke — PR #1 ops', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('returns the expected page count for a healthy PDF', async () => {
        const res = await pdfPageCount(SMALL_PDF);
        expect(res.ok).toBe(true);
        expect(res.count).toBe(SMALL_PDF_PAGE_COUNT);
    });

    it('returns ENCRYPTED for an encrypted PDF', async () => {
        const res = await pdfPageCount(ENCRYPTED_PDF);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe('ENCRYPTED');
    });

    it('returns INVALID_PDF for raw garbage bytes', async () => {
        const garbage = new TextEncoder().encode('not a pdf');
        const res = await pdfPageCountFromBytes(garbage);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe('INVALID_PDF');
    });

    it('returns INVALID_PDF for a corrupt attachment fixture', async () => {
        const res = await pdfPageCount(INVALID_PDF_FIXTURE);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe('INVALID_PDF');
    });
});

// ---------------------------------------------------------------------------
// PR #2 — worker primitives
//
// These endpoints call worker primitives directly (no PDFExtractor /
// SearchScorer). They prove the WS-driven worker path runs end-to-end
// against real PDFs.
// ---------------------------------------------------------------------------

describe('MuPDF worker smoke — PR #2 ops', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('getPageCountAndLabels returns count + labels', async () => {
        const res = await pdfPageLabels(SMALL_PDF);
        expect(res.ok).toBe(true);
        expect(res.count).toBe(SMALL_PDF_PAGE_COUNT);
        expect(res.labels).toBeDefined();
    });

    it('extractRawPages returns blocks for every page', async () => {
        const res = await pdfExtractRaw(NORMAL_PDF);
        expect(res.ok).toBe(true);
        const doc = res.result!;
        expect(doc.pageCount).toBe(NORMAL_PDF_PAGE_COUNT);
        expect(doc.pages.length).toBe(NORMAL_PDF_PAGE_COUNT);
        for (const page of doc.pages) {
            expect(typeof page.pageIndex).toBe('number');
            expect(page.width).toBeGreaterThan(0);
            expect(page.height).toBeGreaterThan(0);
            expect(Array.isArray(page.blocks)).toBe(true);
        }
    });

    it('extractRawPages silently filters invalid indices', async () => {
        const res = await pdfExtractRaw(SMALL_PDF, { page_indices: [0, 99999] });
        expect(res.ok).toBe(true);
        const pages = res.result!.pages;
        expect(pages.length).toBe(1);
        expect(pages[0].pageIndex).toBe(0);
    });

    it('renderPagesToImages produces a non-empty image', async () => {
        const res = await pdfRenderPages(SMALL_PDF, { page_indices: [0] });
        expect(res.ok).toBe(true);
        const page = res.pages![0];
        expect(page.pageIndex).toBe(0);
        expect(page.width).toBeGreaterThan(0);
        expect(page.height).toBeGreaterThan(0);
        expect(page.data_byte_length).toBeGreaterThan(0);
    });

    it('renderPagesToImagesWithMeta returns { pageCount, pageLabels, pages } in one round-trip', async () => {
        const res = await pdfRenderPagesWithMeta(SMALL_PDF, { page_indices: [0] });
        expect(res.ok).toBe(true);
        expect(res.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(res.pageLabels).toBeDefined();
        expect(res.pages?.length).toBe(1);
        const page = res.pages![0];
        expect(page.pageIndex).toBe(0);
        expect(page.data_byte_length).toBeGreaterThan(0);
    });

    it('renderPagesToImagesWithMeta enumerates all pages when no pageIndices/pageRange given', async () => {
        const res = await pdfRenderPagesWithMeta(SMALL_PDF);
        expect(res.ok).toBe(true);
        expect(res.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(res.pages?.length).toBe(SMALL_PDF_PAGE_COUNT);
    });

    it('renderPagesToImagesWithMeta resolves an open-ended pageRange against pageCount', async () => {
        // startIndex=0, no endIndex → worker uses pageCount-1.
        const res = await pdfRenderPagesWithMeta(SMALL_PDF, {
            page_range: { startIndex: 0, maxPages: 10 },
        });
        expect(res.ok).toBe(true);
        expect(res.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(res.pages?.length).toBe(SMALL_PDF_PAGE_COUNT);
    });

    it('renderPagesToImagesWithMeta throws PAGE_OUT_OF_RANGE for all-invalid explicit indices and carries pageCount in the payload', async () => {
        const res = await pdfRenderPagesWithMeta(SMALL_PDF, { page_indices: [99999] });
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe('PAGE_OUT_OF_RANGE');
        expect(res.error?.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
    });

    it('extractRawPageDetailed returns blocks for the requested page', async () => {
        const res = await pdfExtractRawDetailed(SMALL_PDF, { page_index: 0 });
        expect(res.ok).toBe(true);
        const page = res.result!;
        expect(page.pageIndex).toBe(0);
        expect(page.width).toBeGreaterThan(0);
        expect(page.height).toBeGreaterThan(0);
        expect(Array.isArray(page.blocks)).toBe(true);
    });

    it('extractRawPageDetailed throws PAGE_OUT_OF_RANGE for an invalid index', async () => {
        const res = await pdfExtractRawDetailed(SMALL_PDF, { page_index: 99999 });
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe('PAGE_OUT_OF_RANGE');
    });

    it('searchPages returns hits with quad coordinates', async () => {
        const res = await pdfSearch(NORMAL_PDF, { query: 'the' });
        expect(res.ok).toBe(true);
        expect(Array.isArray(res.pages)).toBe(true);
        // Most papers contain "the" — guard with a >= check to avoid flake.
        expect(res.pages!.length).toBeGreaterThan(0);
        for (const page of res.pages!) {
            expect(typeof page.pageIndex).toBe('number');
            expect(page.matchCount).toBeGreaterThan(0);
            expect(page.hits.length).toBe(page.matchCount);
        }
    });
});

describe('MuPDF worker smoke — orchestration ops', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    describe('extract', () => {
        it('returns page-level extraction for a healthy PDF', async () => {
            const settings = { styleSampleSize: 0 };
            const res = await pdfExtract(SMALL_PDF, { settings });
            expect(res.ok).toBe(true);

            const result = res.result;
            expect(result.pages.length).toBe(SMALL_PDF_PAGE_COUNT);
            for (const page of result.pages) {
                expect(typeof page.index).toBe('number');
                expect(page.width).toBeGreaterThan(0);
                expect(page.height).toBeGreaterThan(0);
                expect(typeof page.content).toBe('string');
            }
            expect(typeof result.fullText).toBe('string');
            expect(result.fullText.length).toBeGreaterThan(0);
            expect(result.analysis.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
            expect(result.analysis.styleProfile).toBeDefined();
            expect(result.metadata.version).toBeDefined();
        });

        it('returns NO_TEXT_LAYER with full payload', async () => {
            const res = await pdfExtract(NO_TEXT_PDF);
            expect(res.ok).toBe(false);
            expect(res.error?.code).toBe('NO_TEXT_LAYER');
            // Payload-passing through rehydrateError — the load-bearing
            // case for the structured-error contract.
            expect(res.error?.payload?.ocrAnalysis).toBeDefined();
            const ocr = res.error!.payload!.ocrAnalysis as any;
            expect(ocr.needsOCR).toBe(true);
            expect(typeof ocr.primaryReason).toBe('string');
            expect(typeof res.error!.payload!.pageCount).toBe('number');
            expect(res.error!.payload!.pageLabels).toBeDefined();
        });
    });

    describe('extractByLines', () => {
        it('returns line-based extraction for a healthy PDF', async () => {
            const settings = { styleSampleSize: 0, useLineDetection: true };
            const res = await pdfExtractByLines(SMALL_PDF, { settings });
            expect(res.ok).toBe(true);

            const result = res.result;
            expect(result.pages.length).toBe(SMALL_PDF_PAGE_COUNT);
            expect(typeof result.fullText).toBe('string');
            for (const page of result.pages) {
                expect(Array.isArray(page.lines)).toBe(true);
            }
        });
    });

    describe('hasTextLayer', () => {
        it('returns true for a healthy PDF', async () => {
            const res = await pdfHasTextLayer(SMALL_PDF);
            expect(res.ok).toBe(true);
            expect(res.hasTextLayer).toBe(true);
        });

        it('returns false for a no-text-layer PDF', async () => {
            const res = await pdfHasTextLayer(NO_TEXT_PDF);
            expect(res.ok).toBe(true);
            expect(res.hasTextLayer).toBe(false);
        });
    });

    describe('analyzeOCRNeeds', () => {
        it('returns needsOCR=false for a healthy PDF', async () => {
            const res = await pdfAnalyzeOcr(SMALL_PDF);
            expect(res.ok).toBe(true);

            const result = res.result;
            expect(result.needsOCR).toBe(false);
            expect(typeof result.primaryReason).toBe('string');
            expect(typeof result.issueRatio).toBe('number');
            expect(result.issueBreakdown).toBeDefined();
            expect(typeof result.sampledPages).toBe('number');
            expect(typeof result.totalPages).toBe('number');
        });

        it('returns needsOCR=true for a no-text-layer PDF', async () => {
            const res = await pdfAnalyzeOcr(NO_TEXT_PDF);
            expect(res.ok).toBe(true);
            expect(res.result.needsOCR).toBe(true);
            expect(typeof res.result.primaryReason).toBe('string');
        });
    });

    describe('search (scored)', () => {
        it('returns scored matches for a common term', async () => {
            const res = await pdfSearchScored(SMALL_PDF, { query: 'the' });
            expect(res.ok).toBe(true);

            const result = res.result;
            expect(typeof result.totalMatches).toBe('number');
            for (const page of result.pages) {
                expect(typeof page.pageIndex).toBe('number');
                expect(page.matchCount).toBeGreaterThan(0);
                expect(typeof page.score).toBe('number');
            }
        });

        it('returns no-match early-return for an absent term', async () => {
            const res = await pdfSearchScored(SMALL_PDF, {
                query: 'zzzz_nonexistent_xyzzy',
            });
            expect(res.ok).toBe(true);
            expect(res.result.totalMatches).toBe(0);
            expect(res.result.pages).toEqual([]);
        });
    });

    describe('extractSentenceBBoxes', () => {
        it('returns sentences with bboxes for a healthy PDF page', async () => {
            const res = await pdfSentenceBBoxes(SMALL_PDF, { page_index: 0 });
            expect(res.ok).toBe(true);

            const result = res.result;
            expect(Array.isArray(result.paragraphs)).toBe(true);
            expect(Array.isArray(result.sentences)).toBe(true);
            expect(typeof result.unmappedParagraphs).toBe('number');
            expect(typeof result.degradedParagraphs).toBe('number');
            for (const sentence of result.sentences) {
                expect(typeof sentence.text).toBe('string');
                expect(Array.isArray(sentence.bboxes)).toBe(true);
            }
        });

        it('returns PAGE_OUT_OF_RANGE for an invalid index', async () => {
            const res = await pdfSentenceBBoxes(SMALL_PDF, { page_index: 99999 });
            expect(res.ok).toBe(false);
            expect(res.error?.code).toBe('PAGE_OUT_OF_RANGE');
        });
    });

    describe('renderPageToImage', () => {
        it('renders a single page', async () => {
            const res = await pdfRenderPage(SMALL_PDF, { page_index: 0 });
            expect(res.ok).toBe(true);

            const result = res.result!;
            expect(result.pageIndex).toBe(0);
            expect(result.width).toBeGreaterThan(0);
            expect(result.height).toBeGreaterThan(0);
            expect(result.data_byte_length).toBeGreaterThan(0);
        });

        it('throws PAGE_OUT_OF_RANGE for an invalid index', async () => {
            const res = await pdfRenderPage(SMALL_PDF, { page_index: 99999 });
            expect(res.ok).toBe(false);
            expect(res.error?.code).toBe('PAGE_OUT_OF_RANGE');
        });
    });
});
