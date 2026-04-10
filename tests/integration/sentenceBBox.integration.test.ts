/**
 * Integration tests for sentence-level bbox feasibility.
 *
 * Exercises both sentence-bbox prototypes via the dev-only
 * `/beaver/test/sentence-bboxes` HTTP endpoint, against a live Zotero
 * instance with the Beaver plugin loaded. The two pipelines coexist:
 *
 *   - Page-wide (`src/services/pdf/SentenceMapper.ts`): splits once over
 *     the whole flattened page text. Cheapest path.
 *   - Paragraph-scoped (`src/services/pdf/ParagraphSentenceMapper.ts`):
 *     runs column + line + paragraph detection first, then splits per
 *     paragraph. More expensive, but sentence bounds respect paragraph
 *     structure and column gutters.
 *
 * Both are validated here against the correctness invariants listed in
 * the research note (`docs-zotero/research-sentence-level-bbox.md`
 * § "Correctness traps"):
 *   - text/chars length lockstep on every line
 *   - sentence bboxes stay within the page CropBox
 *   - multi-line sentences produce multiple bboxes
 *
 * Run: npm run test:integration
 * Tests skip gracefully if Zotero is not available.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { NORMAL_PDF, SMALL_PDF } from './helpers/fixtures';
import { ping, getSentenceBBoxReport } from './helpers/cacheInspector';

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
            '\n⚠  Zotero not available — sentence-bbox integration tests will be skipped.\n',
        );
    }
});

function skipIfUnavailable(ctx: { skip: () => void }) {
    if (!zoteroAvailable) ctx.skip();
}

describe('Sentence-level bbox feasibility (page-wide mapper)', () => {
    beforeEach((ctx) => skipIfUnavailable(ctx));

    it('walks a page and maintains the text/chars invariant', async () => {
        const res = await getSentenceBBoxReport(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            0,
        );
        expect(res.error).toBeUndefined();
        expect(res.ok).toBe(true);
        expect(res.report).toBeDefined();

        const report = res.report!;
        expect(report.totalLines).toBeGreaterThan(0);
        expect(report.totalChars).toBeGreaterThan(0);
        // This is the single most important invariant from the research doc.
        expect(report.invariantHolds).toBe(true);
    });

    it('produces sentences whose bboxes lie inside the page CropBox', async () => {
        const res = await getSentenceBBoxReport(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            0,
        );
        expect(res.ok).toBe(true);
        const report = res.report!;
        expect(report.totalSentences).toBeGreaterThan(0);
        expect(report.allBBoxesInPage).toBe(true);

        // Every previewed sentence should have at least one bbox and non-empty text.
        for (const s of report.sentences) {
            expect(s.numBBoxes).toBeGreaterThanOrEqual(1);
            expect(s.text.length).toBeGreaterThan(0);
            expect(s.unionBBox.w).toBeGreaterThan(0);
            expect(s.unionBBox.h).toBeGreaterThan(0);
        }
    });

    it('recovers multi-line sentences as multi-bbox results', async () => {
        // Any real academic page usually has at least one sentence wrapping
        // across lines. If this ever fails, the splitter is collapsing all
        // sentences into a single line, which would make the design useless.
        const res = await getSentenceBBoxReport(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            0,
        );
        expect(res.ok).toBe(true);
        const report = res.report!;
        expect(report.multiFragmentSentences).toBeGreaterThan(0);
    });

    it('works on a second, smaller PDF fixture', async () => {
        const res = await getSentenceBBoxReport(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
            0,
        );
        expect(res.error).toBeUndefined();
        expect(res.ok).toBe(true);
        const report = res.report!;
        expect(report.invariantHolds).toBe(true);
        expect(report.allBBoxesInPage).toBe(true);
        expect(report.totalSentences).toBeGreaterThan(0);
    });
});

describe('Sentence-level bbox feasibility (paragraph-scoped mapper)', () => {
    beforeEach((ctx) => skipIfUnavailable(ctx));

    it('runs the full paragraph pipeline and produces paragraph-scoped sentences', async () => {
        const res = await getSentenceBBoxReport(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            0,
        );
        expect(res.error).toBeUndefined();
        expect(res.ok).toBe(true);
        expect(res.paragraph_report).toBeDefined();

        const report = res.paragraph_report!;
        // text/chars lockstep is asserted globally across all paragraphs.
        expect(report.invariantHolds).toBe(true);
        // Every sentence must land inside the page CropBox.
        expect(report.allBBoxesInPage).toBe(true);
        // No detected paragraph should fail to map back to detailed lines.
        // If this trips, the bbox-key lookup in buildDetailedLineLookup is
        // drifting between the JSON pass and the walker pass.
        expect(report.unmappedParagraphs).toBe(0);
        // The page should have at least a couple paragraphs — otherwise
        // the detector is mis-fitting and the test is not useful.
        expect(report.mappedParagraphs).toBeGreaterThan(0);
        // We expect at least one multi-line (multi-fragment) sentence on
        // an academic page.
        expect(report.multiFragmentSentences).toBeGreaterThan(0);
    });

    it('every previewed paragraph has at least one sentence with positive area', async () => {
        const res = await getSentenceBBoxReport(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            0,
        );
        expect(res.ok).toBe(true);
        const report = res.paragraph_report!;

        // At least one body paragraph (not a header) should have sentences.
        const bodyParas = report.paragraphs.filter((p) => p.itemType === 'paragraph');
        expect(bodyParas.length).toBeGreaterThan(0);

        for (const p of report.paragraphs) {
            if (p.numSentences === 0) continue; // headers may yield 0
            for (const s of p.sentences) {
                expect(s.numBBoxes).toBeGreaterThanOrEqual(1);
                expect(s.text.length).toBeGreaterThan(0);
                expect(s.unionBBox.w).toBeGreaterThan(0);
                expect(s.unionBBox.h).toBeGreaterThan(0);
            }
        }
    });

    it('reports per-pipeline timings so cost can be tracked over time', async () => {
        const res = await getSentenceBBoxReport(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
            0,
        );
        expect(res.ok).toBe(true);
        expect(res.timings_ms).toBeDefined();
        const t = res.timings_ms!;
        // All three should be non-negative. The paragraph mapper is
        // expected to be the slowest (extra detection work).
        expect(t.walk).toBeGreaterThanOrEqual(0);
        expect(t.page_mapper).toBeGreaterThanOrEqual(0);
        expect(t.paragraph_mapper).toBeGreaterThanOrEqual(0);
    });

    it('also works on a smaller PDF (both modes in one call)', async () => {
        const res = await getSentenceBBoxReport(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
            0,
        );
        expect(res.ok).toBe(true);
        // Both reports should be populated in 'both' mode (the default).
        expect(res.report).toBeDefined();
        expect(res.paragraph_report).toBeDefined();
        expect(res.report!.invariantHolds).toBe(true);
        expect(res.paragraph_report!.invariantHolds).toBe(true);
        expect(res.paragraph_report!.allBBoxesInPage).toBe(true);
    });
});
