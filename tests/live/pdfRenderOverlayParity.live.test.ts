/**
 * Live parity check for `/beaver/test/pdf-render-overlay` (sentences).
 *
 * The render-overlay endpoint uses the worker trace op and
 * `/beaver/test/pdf-sentence-bboxes` uses the production worker op. Both
 * share the same worker-side sentence extraction helper, so for the same
 * item/page the overlay rects MUST match production sentence bboxes —
 * fragment by fragment, in order. If this test fails, the overlay endpoint
 * has drifted from production.
 *
 * Rects are compared *as ordered fragment arrays per group*, not as a
 * geometric union — collapsing two adjacent fragments into one bbox would
 * be invisible to a union test but would silently change what an agent
 * sees on the rendered PNG.
 *
 * Run with: `npm run test:live -- pdfRenderOverlayParity`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    isZoteroAvailable,
    skipIfNoZotero,
} from '../helpers/zoteroAvailability';
import {
    pdfRenderOverlay,
    pdfSentenceBBoxes,
    type PdfRenderOverlayRect,
} from '../helpers/cacheInspector';
import { SMALL_PDF, NORMAL_PDF } from '../helpers/fixtures';

interface ProdSentence {
    text: string;
    bboxes: Array<{ l: number; t: number; r: number; b: number; origin: string }>;
}

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

describe('pdf-render-overlay (sentences) ↔ pdf-sentence-bboxes parity', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    for (const fixture of [SMALL_PDF, NORMAL_PDF]) {
        it(`emits the same sentence rects as pdf-sentence-bboxes (${fixture.description})`, async () => {
            const pageIndex = 0;
            const [overlayRes, prodRes] = await Promise.all([
                pdfRenderOverlay(fixture, { page_index: pageIndex, level: 'sentences' }),
                pdfSentenceBBoxes(fixture, { page_index: pageIndex }),
            ]);

            expect(overlayRes.ok).toBe(true);
            expect(prodRes.ok).toBe(true);

            const prodSentences = prodRes.result.sentences as ProdSentence[];
            const rects = overlayRes.rects ?? [];

            // Group rects by `group` index, preserving insertion order
            // within each group. This mirrors how the overlay endpoint
            // emits rects (sentence-then-fragment).
            const groups = new Map<number, PdfRenderOverlayRect[]>();
            for (const r of rects) {
                const list = groups.get(r.group);
                if (list) list.push(r);
                else groups.set(r.group, [r]);
            }

            // Production emits one entry per sentence. The overlay also
            // includes fallback item boxes for headers/reserved unsplit
            // kinds, so filter to groups whose first rect has an S label.
            const prodWithBboxes = prodSentences.filter((s) => s.bboxes.length > 0);
            const sentenceGroups = new Map(
                Array.from(groups.entries()).filter(([, groupRects]) =>
                    groupRects[0]?.label?.startsWith("S"),
                ),
            );
            expect(sentenceGroups.size).toBe(prodWithBboxes.length);

            // Walk groups in ascending order — that's the order the
            // overlay endpoint assigns (`group: sentenceIdx`), matching
            // the flat `prodRes.result.sentences` order.
            const sortedGroupIndices = Array.from(sentenceGroups.keys()).sort(
                (a, b) => a - b,
            );
            sortedGroupIndices.forEach((groupIdx, i) => {
                const overlayFrags = sentenceGroups.get(groupIdx)!.map((r) => r.rect);
                const prodFrags = prodWithBboxes[i].bboxes;
                expect(overlayFrags).toEqual(prodFrags);
            });

            // Smoke check: the canvas overlay actually ran.
            expect(typeof overlayRes.image_base64).toBe('string');
            expect(overlayRes.image_base64!.length).toBeGreaterThan(0);
        });
    }

    it('returns ok:false with a structured error for an out-of-range page', async () => {
        const res = await pdfRenderOverlay(SMALL_PDF, {
            page_index: 99999,
            level: 'sentences',
        });
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
        // RangeError from resolveAnalysisPageIndices → name:'Error'.
        expect(res.error?.name).toBe('Error');
    });
});
