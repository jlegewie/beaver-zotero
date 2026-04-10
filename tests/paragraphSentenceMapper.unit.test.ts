/**
 * Unit tests for the paragraph-scoped sentence mapper.
 *
 * These tests run the full `ParagraphSentenceMapper` pipeline against
 * synthetic `RawPageDataDetailed` pages — no MuPDF, no Zotero. They
 * confirm that:
 *
 *   1. `buildParagraphText` preserves text/chars lockstep inside one
 *      paragraph and builds a correct source map.
 *   2. `extractPageSentenceBBoxes` wires the real detectors
 *      (`detectColumns`, `detectLinesOnPage`, `detectParagraphs`) up to
 *      the sentence mapper and produces one `ParagraphWithSentences` per
 *      detected paragraph.
 *   3. Splitting is scoped: a sentence that does not terminate at a
 *      paragraph break does not bleed across the break.
 *   4. The page-wide `SentenceMapper` and the paragraph-scoped mapper
 *      coexist and agree on the sentence count for simple inputs.
 */

import { describe, it, expect } from 'vitest';
import {
    buildParagraphText,
    tryBuildParagraphText,
    extractPageSentenceBBoxes,
    buildDetailedLineLookup,
    buildParagraphFeasibilityReport,
} from '../src/services/pdf/ParagraphSentenceMapper';
import { extractSentenceBBoxes } from '../src/services/pdf/SentenceMapper';
import { detectColumns } from '../src/services/pdf/ColumnDetector';
import { detectLinesOnPage } from '../src/services/pdf/LineDetector';
import { detectParagraphs } from '../src/services/pdf/ParagraphDetector';
import type {
    RawChar,
    RawLineDetailed,
    RawBlockDetailed,
    RawPageDataDetailed,
    QuadPoint,
} from '../src/services/pdf/types';

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
            bbox: { x, y: yTop, w: 10, h: charH },
        });
    }
    return {
        wmode: 0,
        bbox: { x: xStart, y: yTop, w: text.length * 10, h: charH },
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
            if (l.bbox.x < bminX) bminX = l.bbox.x;
            if (l.bbox.y < bminY) bminY = l.bbox.y;
            if (l.bbox.x + l.bbox.w > bmaxX) bmaxX = l.bbox.x + l.bbox.w;
            if (l.bbox.y + l.bbox.h > bmaxY) bmaxY = l.bbox.y + l.bbox.h;
        }
        if (bminX < minX) minX = bminX;
        if (bminY < minY) minY = bminY;
        if (bmaxX > maxX) maxX = bmaxX;
        if (bmaxY > maxY) maxY = bmaxY;
        rawBlocks.push({
            type: 'text',
            bbox: { x: bminX, y: bminY, w: bmaxX - bminX, h: bmaxY - bminY },
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
                const key = `${line.bbox.x.toFixed(3)}|${line.bbox.y.toFixed(3)}|${line.bbox.w.toFixed(3)}|${line.bbox.h.toFixed(3)}`;
                expect(lookup.get(key)).toBe(line);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// extractPageSentenceBBoxes — full pipeline
// ---------------------------------------------------------------------------

describe('extractPageSentenceBBoxes', () => {
    it('runs the full column + line + paragraph pipeline on a one-paragraph page', () => {
        const page = makeMultiBlockPage([
            [
                makeLine('This is sentence one.', 100),
                makeLine('This is sentence two.', 115),
            ],
        ]);
        const result = extractPageSentenceBBoxes(page);
        expect(result.pageIndex).toBe(0);
        expect(result.unmappedParagraphs).toBe(0);
        expect(result.paragraphs.length).toBeGreaterThanOrEqual(1);
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
        const result = extractPageSentenceBBoxes(page);
        // Expect at least two paragraphs — one per block.
        expect(result.paragraphs.length).toBeGreaterThanOrEqual(2);
        // First paragraph's only sentence should be the period-terminated one.
        const firstPara = result.paragraphs[0];
        expect(firstPara.sentences.length).toBe(1);
        expect(firstPara.sentences[0].text.trim()).toMatch(/ends here\.$/);
        // Second paragraph's sentence (no terminator) still gets produced
        // but covers only its own text — not the first paragraph's text.
        const secondPara = result.paragraphs[1];
        expect(secondPara.sentences.length).toBe(1);
        expect(secondPara.sentences[0].text).not.toContain('First paragraph');
    });

    it('supports precomputed paragraph results', () => {
        // We don't want to re-run detection; the caller may have already
        // done it. Call detectParagraphs directly with trackItemLines.
        // This mirrors the production flow where extractByLines already
        // runs the line detector.
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
        const result = extractPageSentenceBBoxes(page, {
            precomputed: { paragraphResult: paraResult },
        });
        expect(result.unmappedParagraphs).toBe(0);
        expect(result.sentences.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects precomputed paragraph results missing itemLines', () => {
        const page = makeMultiBlockPage([[makeLine('Hello world.', 100)]]);
        const cols = detectColumns(page);
        const lines = detectLinesOnPage(page, cols.columns);
        const paraResult = detectParagraphs(lines, null, {}); // no trackItemLines
        expect(() =>
            extractPageSentenceBBoxes(page, {
                precomputed: { paragraphResult: paraResult },
            }),
        ).toThrow(/trackItemLines/);
    });

    it('degrades gracefully on a text/chars invariant violation', () => {
        // Corrupt ONE line in a multi-line paragraph: drop its last char.
        // The pipeline should NOT throw; it should return a fallback
        // sentence for that paragraph and mark it in degradationNotes.
        const lineA = makeLine('First line of a paragraph', 100);
        const lineB = makeLine('Second line broken.', 115);
        lineB.chars = lineB.chars.slice(0, -1); // invariant violated
        const page = makeMultiBlockPage([[lineA, lineB]]);

        const result = extractPageSentenceBBoxes(page);

        // Pipeline did not throw.
        expect(result.paragraphs.length).toBeGreaterThanOrEqual(1);
        expect(result.sentences.length).toBeGreaterThanOrEqual(1);
        // Degradation is counted and reported.
        expect(result.degradedParagraphs).toBeGreaterThanOrEqual(1);
        expect(result.degradationNotes.length).toBeGreaterThanOrEqual(1);
        const note = result.degradationNotes[0];
        expect(note.reason).toBe('invariant_violation');
        expect(note.message).toMatch(/text\/chars length mismatch/);
    });

    it('degrades gracefully when paragraph cannot be mapped to detailed lines', () => {
        // Build a page whose detailed blocks are totally disjoint from the
        // line bboxes the existing detectors see. We fake this by passing
        // the detectors lines with different bboxes via a precomputed
        // paragraph result whose span bboxes don't match anything in the
        // detailed lookup. The mapper should emit fallback sentences and
        // increment unmappedParagraphs rather than crash.
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
                        x: span.bbox.x + 99999,
                        y: span.bbox.y + 99999,
                        w: span.bbox.w,
                        h: span.bbox.h,
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

        const result = extractPageSentenceBBoxes(page, {
            precomputed: { paragraphResult: paraResult },
        });

        // At least one unmapped paragraph with a fallback sentence.
        expect(result.unmappedParagraphs).toBeGreaterThanOrEqual(1);
        expect(result.sentences.length).toBeGreaterThanOrEqual(1);
        // First degradation note has reason 'unmapped'.
        expect(
            result.degradationNotes.some((n) => n.reason === 'unmapped'),
        ).toBe(true);
        // Every paragraph in the output has at least one sentence — even
        // the degraded ones, because fallbacks are emitted.
        for (const p of result.paragraphs) {
            expect(p.sentences.length).toBeGreaterThanOrEqual(1);
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
        const result = extractPageSentenceBBoxes(page);

        // All broken lines become degraded paragraphs, but the notes
        // array is capped.
        expect(result.degradedParagraphs).toBeGreaterThanOrEqual(NUM);
        expect(result.degradationNotes.length).toBeLessThanOrEqual(50);
        // Every paragraph still has a fallback sentence.
        for (const p of result.paragraphs) {
            expect(p.sentences.length).toBe(1);
        }
    });
});

// ---------------------------------------------------------------------------
// buildParagraphFeasibilityReport
// ---------------------------------------------------------------------------

describe('buildParagraphFeasibilityReport', () => {
    it('summarizes a multi-paragraph page', () => {
        const page = makeMultiBlockPage([
            [
                makeLine('First paragraph sentence one.', 100),
                makeLine('First paragraph sentence two.', 115),
            ],
            [makeLine('Second paragraph only sentence.', 160)],
        ]);
        const report = buildParagraphFeasibilityReport(page);
        expect(report.invariantHolds).toBe(true);
        expect(report.allBBoxesInPage).toBe(true);
        expect(report.unmappedParagraphs).toBe(0);
        expect(report.mappedParagraphs).toBeGreaterThanOrEqual(2);
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
        const pageWide = extractSentenceBBoxes(page);
        const paragraphScoped = extractPageSentenceBBoxes(page);
        expect(paragraphScoped.sentences.length).toBe(pageWide.length);
        expect(paragraphScoped.sentences.map((s) => s.text.trim())).toEqual(
            pageWide.map((s) => s.text.trim()),
        );
    });
});
