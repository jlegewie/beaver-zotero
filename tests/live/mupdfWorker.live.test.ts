/**
 * Live test for MuPDF worker plumbing (PR #1).
 *
 * Asserts parity between the main-thread MuPDF path (pref off) and the
 * module-worker path (pref on) via the dev-only `/beaver/test/pdf-page-count`
 * endpoint. The pref is toggled via `/beaver/test/set-pref` so the test is
 * self-contained — no manual pref flip required between runs.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (SMALL_PDF, ENCRYPTED_PDF).
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
    setPref,
} from '../helpers/cacheInspector';
import {
    SMALL_PDF,
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
