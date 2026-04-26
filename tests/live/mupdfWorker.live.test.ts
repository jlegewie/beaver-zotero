/**
 * Live tests for MuPDF worker plumbing (PR #1 + PR #2).
 *
 * Asserts parity between the main-thread MuPDF path (pref off) and the
 * module-worker path (pref on) via the dev-only `/beaver/test/pdf-*`
 * endpoints. The pref is toggled via `/beaver/test/set-pref` so the test is
 * self-contained — no manual pref flip required between runs.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (SMALL_PDF, NORMAL_PDF, ENCRYPTED_PDF).
 *
 * Run with: `npm run test:live -- mupdfWorker`
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    isZoteroAvailable,
    skipIfNoZotero,
} from '../helpers/zoteroAvailability';
import {
    pdfPageCount,
    pdfPageCountFromBytes,
    pdfPageLabels,
    pdfRenderPages,
    pdfExtractRaw,
    pdfExtractRawDetailed,
    pdfSearch,
    setPref,
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

describe('mupdf.useWorker pref parity', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        // Baseline every test: pref off.
        await setPref('mupdf.useWorker', false);
    });

    afterEach(async () => {
        if (available) {
            // Restore so subsequent tests / manual runs aren't affected.
            await setPref('mupdf.useWorker', false);
        }
    });

    it('returns the same page count for a healthy PDF on both paths', async () => {
        const offRes = await pdfPageCount(SMALL_PDF);
        expect(offRes.ok).toBe(true);
        expect(typeof offRes.count).toBe('number');

        await setPref('mupdf.useWorker', true);
        const onRes = await pdfPageCount(SMALL_PDF);
        expect(onRes.ok).toBe(true);
        expect(onRes.count).toBe(offRes.count);
    });

    it('returns ENCRYPTED for an encrypted PDF on both paths', async () => {
        const offRes = await pdfPageCount(ENCRYPTED_PDF);
        expect(offRes.ok).toBe(false);
        expect(offRes.error?.code).toBe('ENCRYPTED');

        await setPref('mupdf.useWorker', true);
        const onRes = await pdfPageCount(ENCRYPTED_PDF);
        expect(onRes.ok).toBe(false);
        expect(onRes.error?.code).toBe('ENCRYPTED');
    });

    it('returns INVALID_PDF for raw garbage bytes on both paths', async () => {
        const garbage = new TextEncoder().encode('not a pdf');

        const offRes = await pdfPageCountFromBytes(garbage);
        expect(offRes.ok).toBe(false);
        expect(offRes.error?.code).toBe('INVALID_PDF');

        await setPref('mupdf.useWorker', true);
        const onRes = await pdfPageCountFromBytes(garbage);
        expect(onRes.ok).toBe(false);
        expect(onRes.error?.code).toBe('INVALID_PDF');
    });

    it('returns INVALID_PDF for a corrupt attachment fixture on both paths', async () => {
        const fixture = INVALID_PDF_FIXTURE;
        const offRes = await pdfPageCount(fixture);
        expect(offRes.ok).toBe(false);
        expect(offRes.error?.code).toBe('INVALID_PDF');

        await setPref('mupdf.useWorker', true);
        const onRes = await pdfPageCount(fixture);
        expect(onRes.ok).toBe(false);
        expect(onRes.error?.code).toBe('INVALID_PDF');
    });
});

// ---------------------------------------------------------------------------
// PR #2 — broaden the worker surface
//
// Each describe below toggles the pref between off and on inside the test
// and asserts parity. JSON-shape parity (`extractRawPages`,
// `extractRawPageDetailed`) relies on both paths going through MuPDF's
// `stext.asJSON()` — a future MuPDF upgrade changes both paths together,
// so these tests are not a regression net for MuPDF correctness.
//
// Render parity is structural + ±5% byte-length tolerance — PNG / JPEG
// encoder allocator state can shift compression details across MuPDF
// instances, so byte-identical hashes flake. Width/height/scale/dpi are
// always exact.
// ---------------------------------------------------------------------------

describe('mupdf.useWorker pref parity — PR #2 ops', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        await setPref('mupdf.useWorker', false);
    });

    afterEach(async () => {
        if (available) {
            await setPref('mupdf.useWorker', false);
        }
    });

    it('getPageCountAndLabels: count + labels match across paths', async () => {
        const off = await pdfPageLabels(SMALL_PDF);
        expect(off.ok).toBe(true);

        await setPref('mupdf.useWorker', true);
        const on = await pdfPageLabels(SMALL_PDF);
        expect(on.ok).toBe(true);

        expect(on.count).toBe(off.count);
        expect(on.labels).toEqual(off.labels);
    });

    it('extractRawPages: pageCount + per-page block parity', async () => {
        const off = await pdfExtractRaw(NORMAL_PDF);
        expect(off.ok).toBe(true);
        const offDoc = off.result!;

        await setPref('mupdf.useWorker', true);
        const on = await pdfExtractRaw(NORMAL_PDF);
        expect(on.ok).toBe(true);
        const onDoc = on.result!;

        expect(onDoc.pageCount).toBe(offDoc.pageCount);
        expect(onDoc.pages.length).toBe(offDoc.pages.length);
        for (let i = 0; i < offDoc.pages.length; i++) {
            const a = offDoc.pages[i];
            const b = onDoc.pages[i];
            expect(b.pageIndex).toBe(a.pageIndex);
            expect(b.width).toBe(a.width);
            expect(b.height).toBe(a.height);
            // Both paths derive from `stext.asJSON()` — JSON.stringify parity
            // is the cheapest deep-equal check.
            expect(JSON.stringify(b.blocks)).toBe(JSON.stringify(a.blocks));
        }
    });

    it('extractRawPages: silently filters invalid indices on both paths', async () => {
        const off = await pdfExtractRaw(SMALL_PDF, { page_indices: [0, 99999] });
        expect(off.ok).toBe(true);
        const offPages = off.result!.pages;
        expect(offPages.length).toBe(1);
        expect(offPages[0].pageIndex).toBe(0);

        await setPref('mupdf.useWorker', true);
        const on = await pdfExtractRaw(SMALL_PDF, { page_indices: [0, 99999] });
        expect(on.ok).toBe(true);
        const onPages = on.result!.pages;
        expect(onPages.length).toBe(1);
        expect(onPages[0].pageIndex).toBe(0);
    });

    it('renderPagesToImages: structural parity + ±5% byte-length tolerance', async () => {
        const off = await pdfRenderPages(SMALL_PDF, { page_indices: [0] });
        expect(off.ok).toBe(true);
        const offPage = off.pages![0];

        await setPref('mupdf.useWorker', true);
        const on = await pdfRenderPages(SMALL_PDF, { page_indices: [0] });
        expect(on.ok).toBe(true);
        const onPage = on.pages![0];

        expect(onPage.pageIndex).toBe(offPage.pageIndex);
        expect(onPage.format).toBe(offPage.format);
        expect(onPage.width).toBe(offPage.width);
        expect(onPage.height).toBe(offPage.height);
        expect(onPage.scale).toBe(offPage.scale);
        expect(onPage.dpi).toBe(offPage.dpi);

        // ±5% byte-length tolerance — PNG/JPEG encoders aren't byte-deterministic
        // across MuPDF instances.
        const ratio = onPage.data_byte_length / offPage.data_byte_length;
        expect(ratio).toBeGreaterThan(0.95);
        expect(ratio).toBeLessThan(1.05);
    });

    it('extractRawPageDetailed: per-page parity', async () => {
        const off = await pdfExtractRawDetailed(SMALL_PDF, { page_index: 0 });
        expect(off.ok).toBe(true);
        const offPage = off.result!;

        await setPref('mupdf.useWorker', true);
        const on = await pdfExtractRawDetailed(SMALL_PDF, { page_index: 0 });
        expect(on.ok).toBe(true);
        const onPage = on.result!;

        expect(onPage.pageIndex).toBe(offPage.pageIndex);
        expect(onPage.width).toBe(offPage.width);
        expect(onPage.height).toBe(offPage.height);
        expect(JSON.stringify(onPage.blocks)).toBe(
            JSON.stringify(offPage.blocks),
        );
    });

    it('extractRawPageDetailed: PAGE_OUT_OF_RANGE parity', async () => {
        const off = await pdfExtractRawDetailed(SMALL_PDF, {
            page_index: 99999,
        });
        expect(off.ok).toBe(false);
        expect(off.error?.code).toBe('PAGE_OUT_OF_RANGE');

        await setPref('mupdf.useWorker', true);
        const on = await pdfExtractRawDetailed(SMALL_PDF, {
            page_index: 99999,
        });
        expect(on.ok).toBe(false);
        expect(on.error?.code).toBe('PAGE_OUT_OF_RANGE');
    });

    it('searchPages: per-page hit parity (within float tolerance)', async () => {
        // Use a query likely to match common terms in a paper.
        const QUERY = 'the';
        const off = await pdfSearch(NORMAL_PDF, { query: QUERY });
        expect(off.ok).toBe(true);

        await setPref('mupdf.useWorker', true);
        const on = await pdfSearch(NORMAL_PDF, { query: QUERY });
        expect(on.ok).toBe(true);

        expect(on.pages!.length).toBe(off.pages!.length);

        const TOL = 0.01;
        for (let i = 0; i < off.pages!.length; i++) {
            const a = off.pages![i];
            const b = on.pages![i];
            expect(b.pageIndex).toBe(a.pageIndex);
            expect(b.matchCount).toBe(a.matchCount);
            expect(b.width).toBe(a.width);
            expect(b.height).toBe(a.height);
            expect(b.label).toBe(a.label);
            expect(b.hits.length).toBe(a.hits.length);
            for (let h = 0; h < a.hits.length; h++) {
                const aHit = a.hits[h];
                const bHit = b.hits[h];
                expect(bHit.quads.length).toBe(aHit.quads.length);
                for (let q = 0; q < aHit.quads.length; q++) {
                    const aq = aHit.quads[q];
                    const bq = bHit.quads[q];
                    expect(bq.length).toBe(aq.length);
                    for (let c = 0; c < aq.length; c++) {
                        expect(Math.abs(bq[c] - aq[c])).toBeLessThanOrEqual(
                            TOL,
                        );
                    }
                }
            }
        }
    });
});

const FLOAT_TOL = 0.001;

describe('orchestration parity (mupdf.useWorker)', () => {
    beforeEach(async (ctx) => {
        skipIfNoZotero(ctx, available);
        await setPref('mupdf.useWorker', false);
    });

    afterEach(async () => {
        if (available) {
            await setPref('mupdf.useWorker', false);
        }
    });

    describe('extract', () => {
        it('returns parity for page-level extraction on a healthy PDF', async () => {
            const settings = { styleSampleSize: 0 };
            const offRes = await pdfExtract(SMALL_PDF, { settings });
            expect(offRes.ok).toBe(true);

            await setPref('mupdf.useWorker', true);
            const onRes = await pdfExtract(SMALL_PDF, { settings });
            expect(onRes.ok).toBe(true);

            const off = offRes.result;
            const on = onRes.result;
            expect(on.pages.length).toBe(off.pages.length);
            for (let i = 0; i < off.pages.length; i++) {
                expect(on.pages[i].index).toBe(off.pages[i].index);
                expect(on.pages[i].width).toBe(off.pages[i].width);
                expect(on.pages[i].height).toBe(off.pages[i].height);
                expect(on.pages[i].content).toBe(off.pages[i].content);
                expect(on.pages[i].blocks.length).toBe(off.pages[i].blocks.length);
            }
            expect(on.fullText).toBe(off.fullText);
            expect(on.analysis.pageCount).toBe(off.analysis.pageCount);
            expect(on.analysis.styleProfile.primaryBodyStyle).toEqual(
                off.analysis.styleProfile.primaryBodyStyle,
            );
            // Timestamps differ; version is constant — cover the latter only.
            expect(on.metadata.version).toBe(off.metadata.version);
        });

        it('returns NO_TEXT_LAYER with full payload on both paths', async () => {
            const offRes = await pdfExtract(NO_TEXT_PDF);
            expect(offRes.ok).toBe(false);
            expect(offRes.error?.code).toBe('NO_TEXT_LAYER');
            expect(offRes.error?.payload?.ocrAnalysis).toBeDefined();
            expect(typeof offRes.error?.payload?.pageCount).toBe('number');

            await setPref('mupdf.useWorker', true);
            const onRes = await pdfExtract(NO_TEXT_PDF);
            expect(onRes.ok).toBe(false);
            expect(onRes.error?.code).toBe('NO_TEXT_LAYER');
            expect(onRes.error?.payload?.ocrAnalysis).toBeDefined();

            // Parity on the OCR analysis — the load-bearing case for
            // payload-passing through rehydrateError.
            const offOcr = offRes.error!.payload!.ocrAnalysis as any;
            const onOcr = onRes.error!.payload!.ocrAnalysis as any;
            expect(onOcr.needsOCR).toBe(offOcr.needsOCR);
            expect(onOcr.primaryReason).toBe(offOcr.primaryReason);
            expect(onRes.error!.payload!.pageCount).toBe(
                offRes.error!.payload!.pageCount,
            );
        });
    });

    describe('extractByLines', () => {
        it('returns parity for line-based extraction', async () => {
            const settings = { styleSampleSize: 0, useLineDetection: true };
            const offRes = await pdfExtractByLines(SMALL_PDF, { settings });
            expect(offRes.ok).toBe(true);

            await setPref('mupdf.useWorker', true);
            const onRes = await pdfExtractByLines(SMALL_PDF, { settings });
            expect(onRes.ok).toBe(true);

            const off = offRes.result;
            const on = onRes.result;
            expect(on.pages.length).toBe(off.pages.length);
            expect(on.fullText).toBe(off.fullText);
            for (let i = 0; i < off.pages.length; i++) {
                expect(on.pages[i].lines?.length).toBe(off.pages[i].lines?.length);
            }
        });
    });

    describe('hasTextLayer', () => {
        it('returns true on both paths for a healthy PDF', async () => {
            const offRes = await pdfHasTextLayer(SMALL_PDF);
            expect(offRes.ok).toBe(true);
            expect(offRes.hasTextLayer).toBe(true);

            await setPref('mupdf.useWorker', true);
            const onRes = await pdfHasTextLayer(SMALL_PDF);
            expect(onRes.ok).toBe(true);
            expect(onRes.hasTextLayer).toBe(offRes.hasTextLayer);
        });

        it('returns parity on a no-text-layer PDF', async () => {
            const offRes = await pdfHasTextLayer(NO_TEXT_PDF);
            await setPref('mupdf.useWorker', true);
            const onRes = await pdfHasTextLayer(NO_TEXT_PDF);
            expect(onRes.hasTextLayer).toBe(offRes.hasTextLayer);
        });
    });

    describe('analyzeOCRNeeds', () => {
        it('returns parity on a healthy PDF', async () => {
            const offRes = await pdfAnalyzeOcr(SMALL_PDF);
            expect(offRes.ok).toBe(true);
            await setPref('mupdf.useWorker', true);
            const onRes = await pdfAnalyzeOcr(SMALL_PDF);
            expect(onRes.ok).toBe(true);

            const off = offRes.result;
            const on = onRes.result;
            expect(on.needsOCR).toBe(off.needsOCR);
            expect(on.primaryReason).toBe(off.primaryReason);
            expect(Math.abs(on.issueRatio - off.issueRatio)).toBeLessThanOrEqual(
                FLOAT_TOL,
            );
            expect(on.issueBreakdown).toEqual(off.issueBreakdown);
            expect(on.sampledPages).toBe(off.sampledPages);
            expect(on.totalPages).toBe(off.totalPages);
        });

        it('returns parity on a no-text-layer PDF', async () => {
            const offRes = await pdfAnalyzeOcr(NO_TEXT_PDF);
            expect(offRes.ok).toBe(true);
            await setPref('mupdf.useWorker', true);
            const onRes = await pdfAnalyzeOcr(NO_TEXT_PDF);
            expect(onRes.ok).toBe(true);
            expect(onRes.result.needsOCR).toBe(offRes.result.needsOCR);
            expect(onRes.result.primaryReason).toBe(
                offRes.result.primaryReason,
            );
        });
    });

    describe('search (scored)', () => {
        it('returns the same totalMatches and per-page scores', async () => {
            const offRes = await pdfSearchScored(SMALL_PDF, {
                query: 'the',
            });
            expect(offRes.ok).toBe(true);
            await setPref('mupdf.useWorker', true);
            const onRes = await pdfSearchScored(SMALL_PDF, {
                query: 'the',
            });
            expect(onRes.ok).toBe(true);

            const off = offRes.result;
            const on = onRes.result;
            expect(on.totalMatches).toBe(off.totalMatches);
            expect(on.pages.length).toBe(off.pages.length);
            for (let i = 0; i < off.pages.length; i++) {
                expect(on.pages[i].pageIndex).toBe(off.pages[i].pageIndex);
                expect(on.pages[i].matchCount).toBe(off.pages[i].matchCount);
                expect(
                    Math.abs(on.pages[i].score - off.pages[i].score),
                ).toBeLessThanOrEqual(FLOAT_TOL);
            }
        });

        it('returns no-match early-return parity', async () => {
            // Known-absent query: hits the `pageResults.length === 0`
            // early-return branch on both paths.
            const offRes = await pdfSearchScored(SMALL_PDF, {
                query: 'zzzz_nonexistent_xyzzy',
            });
            expect(offRes.ok).toBe(true);
            expect(offRes.result.totalMatches).toBe(0);
            expect(offRes.result.pages).toEqual([]);

            await setPref('mupdf.useWorker', true);
            const onRes = await pdfSearchScored(SMALL_PDF, {
                query: 'zzzz_nonexistent_xyzzy',
            });
            expect(onRes.ok).toBe(true);
            expect(onRes.result.totalMatches).toBe(0);
            expect(onRes.result.pages).toEqual([]);
        });
    });

    describe('extractSentenceBBoxes', () => {
        it('returns parity for the full mapper pipeline (one round-trip)', async () => {
            const offRes = await pdfSentenceBBoxes(SMALL_PDF, { page_index: 0 });
            expect(offRes.ok).toBe(true);
            await setPref('mupdf.useWorker', true);
            const onRes = await pdfSentenceBBoxes(SMALL_PDF, { page_index: 0 });
            expect(onRes.ok).toBe(true);

            const off = offRes.result;
            const on = onRes.result;
            expect(on.paragraphs.length).toBe(off.paragraphs.length);
            expect(on.sentences.length).toBe(off.sentences.length);
            expect(on.unmappedParagraphs).toBe(off.unmappedParagraphs);
            expect(on.degradedParagraphs).toBe(off.degradedParagraphs);
            for (let i = 0; i < off.sentences.length; i++) {
                expect(on.sentences[i].text).toBe(off.sentences[i].text);
                expect(on.sentences[i].bboxes.length).toBe(
                    off.sentences[i].bboxes.length,
                );
            }
        });

        it('returns PAGE_OUT_OF_RANGE on both paths for an invalid index', async () => {
            const offRes = await pdfSentenceBBoxes(SMALL_PDF, {
                page_index: 99999,
            });
            expect(offRes.ok).toBe(false);
            expect(offRes.error?.code).toBe('PAGE_OUT_OF_RANGE');

            await setPref('mupdf.useWorker', true);
            const onRes = await pdfSentenceBBoxes(SMALL_PDF, {
                page_index: 99999,
            });
            expect(onRes.ok).toBe(false);
            expect(onRes.error?.code).toBe('PAGE_OUT_OF_RANGE');
        });
    });

    describe('renderPageToImage (carry-forward)', () => {
        it('returns parity for a single-page render', async () => {
            const offRes = await pdfRenderPage(SMALL_PDF, { page_index: 0 });
            expect(offRes.ok).toBe(true);
            await setPref('mupdf.useWorker', true);
            const onRes = await pdfRenderPage(SMALL_PDF, { page_index: 0 });
            expect(onRes.ok).toBe(true);

            const off = offRes.result!;
            const on = onRes.result!;
            expect(on.pageIndex).toBe(off.pageIndex);
            expect(on.format).toBe(off.format);
            expect(on.width).toBe(off.width);
            expect(on.height).toBe(off.height);
            expect(on.scale).toBe(off.scale);
            expect(on.dpi).toBe(off.dpi);
            // Encoder allocator state can shift compression details across
            // MuPDF instances — byte-identical hashes flake. ±5% tolerance
            // is the PR #2 rationale carried forward.
            const tol = Math.max(off.data_byte_length * 0.05, 16);
            expect(
                Math.abs(on.data_byte_length - off.data_byte_length),
            ).toBeLessThanOrEqual(tol);
        });

        it('worker path returns PAGE_OUT_OF_RANGE for an invalid index', async () => {
            // Intentional behavioral divergence (documented in PR #1/#2/#3):
            // - Pref-on: worker validates pageIndex in `opRenderPageToImage`
            //   and throws `ExtractionError(PAGE_OUT_OF_RANGE)`. Better
            //   structured error for downstream callers.
            // - Pref-off: main-thread `MuPDFService.renderPageToImage` calls
            //   `loadPage` directly with no range check, throwing a generic
            //   `Error("Failed to load page N")`. This bubbles through the
            //   dev endpoint as a 500.
            // Asserting parity here is wrong because the divergence is by
            // design; the worker-side behavior is verified in isolation by
            // the unit test in `tests/unit/services/mupdfWorkerClient.test.ts`
            // (`renderPageToImage > rehydrates PAGE_OUT_OF_RANGE`). The live
            // assertion below covers only the worker path.
            //
            // TODO(post-PR#3): close the divergence by adding the same
            // `pageIndex` range check to `MuPDFService.renderPageToImage`
            // and throwing `ExtractionError(PAGE_OUT_OF_RANGE)` instead of
            // the generic loadPage error. Then promote this back to a
            // both-paths parity assertion.
            await setPref('mupdf.useWorker', true);
            const onRes = await pdfRenderPage(SMALL_PDF, {
                page_index: 99999,
            });
            expect(onRes.ok).toBe(false);
            expect(onRes.error?.code).toBe('PAGE_OUT_OF_RANGE');
        });
    });
});
