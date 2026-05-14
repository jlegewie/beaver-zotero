/**
 * Unit tests for the paragraph-scoped sentence mapper.
 *
 * These tests run the full `ParagraphSentenceMapper` pipeline against
 * synthetic `RawPageDataDetailed` pages — no MuPDF, no Zotero. They
 * confirm that:
 *
 *   1. `buildParagraphText` preserves text/chars lockstep inside one
 *      paragraph and builds a correct source map.
 *   2. `extractPageSentences` wires the real detectors
 *      (`detectColumns`, `detectLinesOnPage`, `detectParagraphs`) up to
 *      the sentence mapper and produces one `DocItem` per detected item.
 *   3. Splitting is scoped: a sentence that does not terminate at a
 *      paragraph break does not bleed across the break.
 *   4. The page-wide `SentenceMapper` and the paragraph-scoped mapper
 *      coexist and agree on the sentence count for simple inputs.
 */

import { describe, it, expect } from 'vitest';
import {
    buildParagraphText,
    tryBuildParagraphText,
    extractPageSentences,
    buildDetailedLineLookup,
    buildPageSentenceFeasibilityReport,
} from '../src/beaver-extract/ParagraphSentenceMapper';
import { extractPageWideSentences } from '../src/beaver-extract/SentenceMapper';
import { detectColumns } from '../src/beaver-extract/ColumnDetector';
import { detectLinesOnPage } from '../src/beaver-extract/LineDetector';
import { detectParagraphs } from '../src/beaver-extract/ParagraphDetector';
import {
    bboxFromXYWH,
    bboxHeight,
    bboxWidth,
    type RawChar,
    type RawLineDetailed,
    type RawBlockDetailed,
    type RawPageDataDetailed,
    type QuadPoint,
} from '../src/beaver-extract/types';

// ---------------------------------------------------------------------------
// Synthetic page builder (same grid as sentenceMapper.unit.test.ts)
// ---------------------------------------------------------------------------

function makeLine(text: string, yTop: number, xStart = 50): RawLineDetailed {
    const chars: RawChar[] = [];
    const charH = 12;
    for (let i = 0; i < text.length; i++) {
        const x = xStart + i * 10;
        const quad: QuadPoint = [
            x, yTop,
            x + 10, yTop,
            x, yTop + charH,
            x + 10, yTop + charH,
        ];
        chars.push({
            c: text[i],
            quad,
            bbox: bboxFromXYWH(x, yTop, 10, charH, "top-left"),
        });
    }
    return {
        wmode: 0,
        bbox: bboxFromXYWH(xStart, yTop, text.length * 10, charH, "top-left"),
        font: { name: 'Body', family: 'Body', weight: 'normal', style: 'normal', size: 12 },
        x: xStart,
        y: yTop,
        text,
        chars,
    };
}

/** Pack an array of line arrays into one multi-block page. */
function makeMultiBlockPage(blocks: RawLineDetailed[][]): RawPageDataDetailed {
    const rawBlocks: RawBlockDetailed[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const lines of blocks) {
        if (lines.length === 0) continue;
        let bminX = Infinity, bminY = Infinity, bmaxX = -Infinity, bmaxY = -Infinity;
        for (const l of lines) {
            if (l.bbox.l < bminX) bminX = l.bbox.l;
            if (l.bbox.t < bminY) bminY = l.bbox.t;
            if (l.bbox.r > bmaxX) bmaxX = l.bbox.r;
            if (l.bbox.b > bmaxY) bmaxY = l.bbox.b;
        }
        if (bminX < minX) minX = bminX;
        if (bminY < minY) minY = bminY;
        if (bmaxX > maxX) maxX = bmaxX;
        if (bmaxY > maxY) maxY = bmaxY;
        rawBlocks.push({
            type: 'text',
            bbox: bboxFromXYWH(bminX, bminY, bmaxX - bminX, bmaxY - bminY, "top-left"),
            lines,
        });
    }
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: maxX + 50,
        height: maxY + 50,
        blocks: rawBlocks,
    };
}

// ---------------------------------------------------------------------------
// buildParagraphText
// ---------------------------------------------------------------------------

describe('buildParagraphText', () => {
    it('concatenates paragraph lines with space fillers and tracks sources', () => {
        const lines = [makeLine('Alpha beta.', 100), makeLine('Gamma delta.', 120)];
        const pt = buildParagraphText(lines);
        expect(pt.text).toBe('Alpha beta. Gamma delta.');
        expect(pt.source.length).toBe(pt.text.length);
        // The injected separator space is null
        expect(pt.source[11]).toBeNull();
        // Real chars map to paragraph-local (lineIndex, charIndex)
        expect(pt.source[0]).toEqual({ lineIndex: 0, charIndex: 0 });
        expect(pt.source[12]).toEqual({ lineIndex: 1, charIndex: 0 });
        expect(pt.lines).toBe(lines);
    });

    it('throws loudly on a text/chars length mismatch', () => {
        const line = makeLine('Oops.', 100);
        line.chars = line.chars.slice(0, -1);
        expect(() => buildParagraphText([line])).toThrow(/text\/chars length mismatch/);
    });
});

describe('tryBuildParagraphText', () => {
    it('returns ok: true on a well-formed paragraph', () => {
        const result = tryBuildParagraphText([makeLine('Hello.', 100)]);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.paragraphText.text).toBe('Hello.');
        }
    });

    it('returns ok: false with the error message on an invariant violation', () => {
        const line = makeLine('Oops.', 100);
        line.chars = line.chars.slice(0, -1);
        const result = tryBuildParagraphText([line]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toMatch(/text\/chars length mismatch/);
        }
    });
});

// ---------------------------------------------------------------------------
// buildDetailedLineLookup
// ---------------------------------------------------------------------------

describe('buildDetailedLineLookup', () => {
    it('builds a bbox-keyed map that hits every detailed line', () => {
        const page = makeMultiBlockPage([
            [makeLine('One.', 100), makeLine('Two.', 120)],
            [makeLine('Three.', 160)],
        ]);
        const lookup = buildDetailedLineLookup(page);
        expect(lookup.size).toBe(3);
        // The page's own lines should be the values returned by the lookup.
        for (const block of page.blocks) {
            if (block.type !== 'text' || !block.lines) continue;
            for (const line of block.lines) {
                const key = `${line.bbox.l.toFixed(3)}|${line.bbox.t.toFixed(3)}|${line.bbox.r.toFixed(3)}|${line.bbox.b.toFixed(3)}|${line.bbox.origin}`;
                expect(lookup.get(key)).toBe(line);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// extractPageSentences — full pipeline
// ---------------------------------------------------------------------------

describe('extractPageSentences', () => {
    it('runs the full column + line + paragraph pipeline on a one-paragraph page', () => {
        const page = makeMultiBlockPage([
            [
                makeLine('This is sentence one.', 100),
                makeLine('This is sentence two.', 115),
            ],
        ]);
        const result = extractPageSentences(page);
        expect(result.pageIndex).toBe(0);
        expect(result.degradation).toBeUndefined();
        expect(result.items.length).toBeGreaterThanOrEqual(1);
        const totalSentences = result.sentences.length;
        expect(totalSentences).toBeGreaterThanOrEqual(2);
        // Every sentence must have at least one bbox.
        for (const s of result.sentences) {
            expect(s.bboxes.length).toBeGreaterThanOrEqual(1);
        }
    });

    it('scopes splitting inside paragraphs (no cross-block bleeding)', () => {
        // Two blocks vertically separated by a wide gap so the paragraph
        // detector recognizes them as distinct items. Only block 1 ends
        // with a period; block 2 ends without one. A PAGE-wide splitter
        // would concatenate them first and still produce 2 sentences, but
        // a paragraph-scoped splitter emits each block as its own sentence.
        const page = makeMultiBlockPage([
            [makeLine('First paragraph ends here.', 100)],
            [makeLine('Second paragraph trailing', 200)],
        ]);
        const result = extractPageSentences(page);
        // Expect at least two paragraphs — one per block.
        const textItems = result.items.filter((item) => item.kind === "text");
        expect(textItems.length).toBeGreaterThanOrEqual(2);
        // First paragraph's only sentence should be the period-terminated one.
        const firstPara = textItems[0];
        expect(firstPara.sentences.length).toBe(1);
        expect(firstPara.sentences[0].text.trim()).toMatch(/ends here\.$/);
        // Second paragraph's sentence (no terminator) still gets produced
        // but covers only its own text — not the first paragraph's text.
        const secondPara = textItems[1];
        expect(secondPara.sentences.length).toBe(1);
        expect(secondPara.sentences[0].text).not.toContain('First paragraph');
    });

    it('supports precomputed paragraph results', () => {
        // We don't want to re-run detection; the caller may have already
        // done it. Call detectParagraphs directly with trackItemLines.
        // This mirrors the production flow where the structured engine
        // already runs the line detector.
        const page = makeMultiBlockPage([
            [makeLine('Sentence one.', 100), makeLine('Sentence two.', 115)],
        ]);
        const cols = detectColumns(page);
        const lines = detectLinesOnPage(page, cols.columns);
        const paraResult = detectParagraphs(
            lines,
            null,
            {},
            { paragraph: 0, header: 0 },
            { trackItemLines: true },
        );
        const result = extractPageSentences(page, {
            precomputed: { paragraphResult: paraResult },
        });
        expect(result.degradation).toBeUndefined();
        expect(result.sentences.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects precomputed paragraph results missing itemLines', () => {
        const page = makeMultiBlockPage([[makeLine('Hello world.', 100)]]);
        const cols = detectColumns(page);
        const lines = detectLinesOnPage(page, cols.columns);
        const paraResult = detectParagraphs(lines, null, {}); // no trackItemLines
        expect(() =>
            extractPageSentences(page, {
                precomputed: { paragraphResult: paraResult },
            }),
        ).toThrow(/trackItemLines/);
    });

    it('degrades gracefully on a text/chars invariant violation', () => {
        // Corrupt ONE line in a multi-line paragraph: drop its last char.
        // The pipeline should NOT throw; it should return a fallback
        // sentence for that paragraph and mark it in degradation.notes.
        const lineA = makeLine('First line of a paragraph', 100);
        const lineB = makeLine('Second line broken.', 115);
        lineB.chars = lineB.chars.slice(0, -1); // invariant violated
        const page = makeMultiBlockPage([[lineA, lineB]]);

        const result = extractPageSentences(page);

        // Pipeline did not throw.
        expect(result.items.length).toBeGreaterThanOrEqual(1);
        expect(result.sentences.length).toBeGreaterThanOrEqual(1);
        // Degradation is counted and reported.
        expect(result.degradation?.count ?? 0).toBeGreaterThanOrEqual(1);
        expect(result.degradation?.notes.length ?? 0).toBeGreaterThanOrEqual(1);
        const note = result.degradation!.notes[0];
        expect(note.reason).toBe('invariant_violation');
        expect(note.message).toMatch(/text\/chars length mismatch/);
    });

    it('degrades gracefully when paragraph cannot be mapped to detailed lines', () => {
        // Build a page whose detailed blocks are totally disjoint from the
        // line bboxes the existing detectors see. We fake this by passing
        // the detectors lines with different bboxes via a precomputed
        // paragraph result whose span bboxes don't match anything in the
        // detailed lookup. The mapper should emit fallback sentences and
        // tag the items as `unmapped` in degradation.notes rather than crash.
        const realLines = [makeLine('Real content here.', 100)];
        const page = makeMultiBlockPage([realLines]);

        // Detect on the real page, then swap in a PageLine whose spans
        // have bboxes that don't exist in the detailed lookup.
        const cols = detectColumns(page);
        const lineRes = detectLinesOnPage(page, cols.columns);
        // Mutate: shift every span bbox by a huge offset so bbox lookup misses.
        for (const colResult of lineRes.columnResults) {
            for (const pageLine of colResult.lines) {
                for (const span of pageLine.spans) {
                    span.bbox = {
                        ...bboxFromXYWH(
                            span.bbox.l + 99999,
                            span.bbox.t + 99999,
                            bboxWidth(span.bbox),
                            bboxHeight(span.bbox),
                            span.bbox.origin,
                        ),
                    };
                }
            }
        }
        const paraResult = detectParagraphs(
            lineRes,
            null,
            {},
            { paragraph: 0, header: 0 },
            { trackItemLines: true },
        );

        const result = extractPageSentences(page, {
            precomputed: { paragraphResult: paraResult },
        });

        // At least one unmapped paragraph with a fallback sentence.
        expect(result.degradation?.count ?? 0).toBeGreaterThanOrEqual(1);
        expect(result.sentences.length).toBeGreaterThanOrEqual(1);
        // At least one degradation note has reason 'unmapped'.
        expect(
            (result.degradation?.notes ?? []).some((n) => n.reason === 'unmapped'),
        ).toBe(true);
        // Every text item in the output has at least one sentence — even
        // the degraded ones, because fallbacks are emitted.
        for (const item of result.items.filter((item) => item.kind === "text")) {
            expect(item.sentences.length).toBeGreaterThanOrEqual(1);
        }
    });

    it('caps the degradation notes array so pathological PDFs do not blow memory', () => {
        // Manufacture a page with many invariant-violating lines.
        // Gap of 100pt per step forces the paragraph detector to split
        // every line into its own paragraph (the break threshold lives
        // around a few pt; 100pt is well above it), so each broken line
        // is its own degraded paragraph and generates a note.
        const NUM = 60; // > MAX_DEGRADATION_NOTES (50)
        const blocks: ReturnType<typeof makeLine>[][] = [];
        for (let i = 0; i < NUM; i++) {
            const line = makeLine('Broken line.', 100 + i * 100);
            line.chars = line.chars.slice(0, -1);
            blocks.push([line]);
        }
        const page = makeMultiBlockPage(blocks);
        const result = extractPageSentences(page);

        // All broken lines become degraded paragraphs, but the notes
        // array is capped.
        expect(result.degradation?.count ?? 0).toBeGreaterThanOrEqual(NUM);
        expect(result.degradation?.notes.length ?? 0).toBeLessThanOrEqual(50);
        // Every text item still has a fallback sentence.
        for (const item of result.items.filter((item) => item.kind === "text")) {
            expect(item.sentences.length).toBe(1);
        }
    });
});

// ---------------------------------------------------------------------------
// buildParagraphFeasibilityReport
// ---------------------------------------------------------------------------

describe('buildPageSentenceFeasibilityReport', () => {
    it('summarizes a multi-paragraph page', () => {
        const page = makeMultiBlockPage([
            [
                makeLine('First paragraph sentence one.', 100),
                makeLine('First paragraph sentence two.', 115),
            ],
            [makeLine('Second paragraph only sentence.', 160)],
        ]);
        const report = buildPageSentenceFeasibilityReport(page);
        expect(report.invariantHolds).toBe(true);
        expect(report.allBBoxesInPage).toBe(true);
        expect(report.degradation).toBeUndefined();
        expect(report.itemCount).toBeGreaterThanOrEqual(2);
        expect(report.itemsByKind.text).toBeGreaterThanOrEqual(2);
        expect(report.totalSentences).toBeGreaterThanOrEqual(3);
    });
});

// ---------------------------------------------------------------------------
// Coexistence — both mappers produce compatible output
// ---------------------------------------------------------------------------

describe('page-wide vs paragraph-scoped coexistence', () => {
    it('both pipelines produce the same sentences on a single-paragraph page', () => {
        // With only one paragraph, paragraph-scoped output should match
        // page-wide output exactly in sentence count and text content.
        const page = makeMultiBlockPage([
            [
                makeLine('Hello. World.', 100),
                makeLine('How are you?', 115),
            ],
        ]);
        const pageWide = extractPageWideSentences(page);
        const paragraphScoped = extractPageSentences(page);
        expect(paragraphScoped.sentences.length).toBe(pageWide.length);
        expect(paragraphScoped.sentences.map((s) => s.text.trim())).toEqual(
            pageWide.map((s) => s.text.trim()),
        );
    });
});
