/**
 * Live parity check for `/beaver/test/pdf-extract-trace`.
 *
 * `/beaver/test/pdf-extract-trace` uses the worker trace op and
 * `/beaver/test/pdf-sentence-bboxes` uses the production worker op. Both
 * share the same worker-side sentence extraction helper, so for the same
 * item/page they MUST produce the same sentence output. If this test
 * fails, the trace endpoint has drifted from production.
 *
 * Run with: `npm run test:live -- pdfExtractTrace`
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
    raw_lines?: Array<{ id?: string }>;
    columns?: number[][];
    paragraphs?: Array<{ id: string; kind: string }>;
    sentences?: TraceSentence[];
    lines_dropped_by_columns?: string[];
    sentence_stats?: {
        count: number;
        degraded: number;
        fragments: number;
    };
    page?: { counts: { items: number; sentences: number; columns?: number; lines?: number } };
    error?: { name: string; code?: string; message: string };
}

async function pdfExtractTrace(
    attachment: { library_id: number; zotero_key: string },
    body: Record<string, unknown>,
): Promise<TraceResponse> {
    return post<TraceResponse>('/beaver/test/pdf-extract-trace', {
        library_id: attachment.library_id,
        zotero_key: attachment.zotero_key,
        ...body,
    });
}

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

describe('pdf-extract-trace ↔ pdf-sentence-bboxes parity', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    for (const fixture of [SMALL_PDF, NORMAL_PDF]) {
        it(`emits the same sentences as pdf-sentence-bboxes (${fixture.description})`, async () => {
            const pageIndex = 0;
            const [traceRes, prodRes] = await Promise.all([
                pdfExtractTrace(fixture, { page_index: pageIndex }),
                pdfSentenceBBoxes(fixture, { page_index: pageIndex }),
            ]);

            expect(traceRes.ok).toBe(true);
            expect(prodRes.ok).toBe(true);

            const traceSentences = traceRes.sentences ?? [];
            const prodSentences = prodRes.result.sentences as Array<{
                text: string;
                bboxes: Array<{ l: number; t: number; r: number; b: number; origin: string }>;
            }>;

            // Sentence count must match — both call the same helper.
            expect(traceSentences.length).toBe(prodSentences.length);

            // Per-sentence text and bboxes must match.
            for (let i = 0; i < traceSentences.length; i++) {
                expect(traceSentences[i].text).toBe(prodSentences[i].text);
                expect(traceSentences[i].bboxes).toEqual(prodSentences[i].bboxes);
            }

            // Trace still exposes the legacy `paragraphs` key for canonical
            // items, including margin items just like production does.
            const tracePCount = (traceRes.paragraphs ?? []).length;
            const prodPCount = (prodRes.result.items as Array<{ kind: string }>).length;
            expect(tracePCount).toBe(prodPCount);
        });

        it(`full debug projection has internally consistent counts (${fixture.description})`, async () => {
            const res = await pdfExtractTrace(fixture, { page_index: 0, mode: 'full' });
            expect(res.ok).toBe(true);

            const lineIds = (res.raw_lines ?? []).map((line) => line.id);
            expect(lineIds.every((id): id is string => typeof id === 'string')).toBe(true);
            expect(new Set(lineIds).size).toBe(lineIds.length);
            expect(res.raw_lines).toHaveLength(res.page?.counts.lines ?? 0);
            expect(res.columns).toHaveLength(res.page?.counts.columns ?? 0);
            expect(res.paragraphs).toHaveLength(res.page?.counts.items ?? 0);
            expect(res.sentences).toHaveLength(res.page?.counts.sentences ?? 0);
            expect(res.sentence_stats?.count).toBe(res.sentences?.length ?? 0);
        });
    }

    it('returns ok:false with a structured error for an out-of-range page', async () => {
        const res = await pdfExtractTrace(SMALL_PDF, { page_index: 99999 });
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
        // RangeError from resolveAnalysisPageIndices → name:'Error'.
        expect(res.error?.name).toBe('Error');
    });
});
