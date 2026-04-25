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
} from '../helpers/cacheInspector';
import {
    SMALL_PDF,
    NORMAL_PDF,
    ENCRYPTED_PDF,
    INVALID_PDF_FIXTURE,
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
