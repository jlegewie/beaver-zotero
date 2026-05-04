/**
 * Live parity check for `/beaver/test/pdf-pipeline-trace`.
 *
 * Both `/beaver/test/pdf-pipeline-trace` and `/beaver/test/pdf-sentence-bboxes`
 * route through `runSentenceExtractionPipeline`, so for the same item/page
 * they MUST produce the same sentence output. If this test fails, the
 * trace endpoint has drifted from production.
 *
 * Run with: `npm run test:live -- pdfPipelineTrace`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    isZoteroAvailable,
    skipIfNoZotero,
} from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';
import { pdfSentenceBBoxes } from '../helpers/cacheInspector';
import { SMALL_PDF, NORMAL_PDF } from '../helpers/fixtures';

interface TraceSentence {
    idx: number;
    text: string;
    paragraphId: string | null;
    bboxes: Array<{ x: number; y: number; w: number; h: number }>;
    degraded: boolean;
}

interface TraceResponse {
    ok: boolean;
    page_index?: number;
    raw_lines?: Array<{ id: string; marginFilter: { finalKept: boolean } }>;
    columns?: Array<{ idx: number; lineIds: string[] }>;
    paragraphs?: Array<{ id: string; lineIds: string[] }>;
    sentences?: TraceSentence[];
    lines_dropped_by_columns?: string[];
    sentence_stats?: {
        sentences: number;
        paragraphs: number;
    };
    error?: { name: string; code?: string; message: string };
}

async function pdfPipelineTrace(
    attachment: { library_id: number; zotero_key: string },
    body: Record<string, unknown>,
): Promise<TraceResponse> {
    return post<TraceResponse>('/beaver/test/pdf-pipeline-trace', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

describe('pdf-pipeline-trace ↔ pdf-sentence-bboxes parity', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    for (const fixture of [SMALL_PDF, NORMAL_PDF]) {
        it(`emits the same sentences as pdf-sentence-bboxes (${fixture.description})`, async () => {
            const pageIndex = 0;
            const [traceRes, prodRes] = await Promise.all([
                pdfPipelineTrace(fixture, { page_index: pageIndex }),
                pdfSentenceBBoxes(fixture, { page_index: pageIndex }),
            ]);

            expect(traceRes.ok).toBe(true);
            expect(prodRes.ok).toBe(true);

            const traceSentences = traceRes.sentences ?? [];
            const prodSentences = prodRes.result.sentences as Array<{
                text: string;
                bboxes: Array<{ x: number; y: number; w: number; h: number }>;
            }>;

            // Sentence count must match — both call the same helper.
            expect(traceSentences.length).toBe(prodSentences.length);

            // Per-sentence text and bboxes must match.
            for (let i = 0; i < traceSentences.length; i++) {
                expect(traceSentences[i].text).toBe(prodSentences[i].text);
                expect(traceSentences[i].bboxes).toEqual(prodSentences[i].bboxes);
            }

            // Paragraph count: trace flattens to `{ id, lineIds, … }` while
            // production returns `ParagraphWithSentences[]` — different
            // shapes, same count.
            const tracePCount = (traceRes.paragraphs ?? []).length;
            const prodPCount = (prodRes.result.paragraphs as unknown[]).length;
            expect(tracePCount).toBe(prodPCount);
        });

        it(`cross-stage links are well-formed (${fixture.description})`, async () => {
            const res = await pdfPipelineTrace(fixture, { page_index: 0 });
            expect(res.ok).toBe(true);

            const rawLineIds = new Set(
                (res.raw_lines ?? []).map((r) => r.id),
            );
            const droppedIds = new Set(res.lines_dropped_by_columns ?? []);

            // Every paragraph line ID resolves to a raw line.
            for (const p of res.paragraphs ?? []) {
                for (const id of p.lineIds) {
                    expect(rawLineIds.has(id)).toBe(true);
                }
            }

            // Every column line ID resolves to a raw line.
            for (const c of res.columns ?? []) {
                for (const id of c.lineIds) {
                    expect(rawLineIds.has(id)).toBe(true);
                }
            }

            // finalKept raw lines = (lines used by columns) ∪ (lines dropped
            // by columns), after de-dup. If the spine were built from the
            // wrong page (e.g. `rawDoc.pages` instead of `pagesForFilter`),
            // bbox identity would not match and many finalKept lines would
            // appear in neither set.
            const usedByColumns = new Set<string>();
            for (const c of res.columns ?? []) {
                for (const id of c.lineIds) usedByColumns.add(id);
            }
            const finalKept = (res.raw_lines ?? [])
                .filter((r) => r.marginFilter.finalKept)
                .map((r) => r.id);
            for (const id of finalKept) {
                expect(usedByColumns.has(id) || droppedIds.has(id)).toBe(true);
            }
        });
    }

    it('returns ok:false with a structured error for an out-of-range page', async () => {
        const res = await pdfPipelineTrace(SMALL_PDF, { page_index: 99999 });
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
        // RangeError from resolveAnalysisPageIndices → name:'Error'.
        expect(res.error?.name).toBe('Error');
    });
});
