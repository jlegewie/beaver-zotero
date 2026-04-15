/**
 * Unit tests for the sentence-bbox prototype.
 *
 * These tests run the pure logic of `SentenceMapper.ts` against synthetic
 * `RawPageDataDetailed` fixtures (with made-up quads) — no MuPDF WASM
 * required. They cover the splitter, text flattening, source map, and
 * sentence → bbox resolution, including the multi-line case that is the
 * whole point of the design.
 */

import { describe, it, expect } from 'vitest';
import {
    simpleRegexSentenceSplit,
    flattenPageText,
    sentenceToBoxes,
    extractSentenceBBoxes,
    buildFeasibilityReport,
} from '../src/services/pdf/SentenceMapper';
import type {
    RawBBox,
    RawChar,
    RawLineDetailed,
    RawPageDataDetailed,
    QuadPoint,
} from '../src/services/pdf/types';

// ---------------------------------------------------------------------------
// Synthetic page builder
// ---------------------------------------------------------------------------

/**
 * Build a line of fake chars laid out on a single baseline.
 * Every char is a 10×12 box, advancing by 10 points on x.
 */
function makeLine(text: string, yTop: number, xStart = 50): RawLineDetailed {
    const chars: RawChar[] = [];
    const lineY = yTop;
    const charH = 12;
    for (let i = 0; i < text.length; i++) {
        const x = xStart + i * 10;
        const quad: QuadPoint = [
            x, lineY,                // ul
            x + 10, lineY,           // ur
            x, lineY + charH,        // ll
            x + 10, lineY + charH,   // lr
        ];
        chars.push({
            c: text[i],
            quad,
            bbox: { x, y: lineY, w: 10, h: charH },
        });
    }
    const bbox: RawBBox = {
        x: xStart,
        y: lineY,
        w: text.length * 10,
        h: charH,
    };
    return {
        wmode: 0,
        bbox,
        font: { name: '', family: '', weight: 'normal', style: 'normal', size: 12 },
        x: xStart,
        y: lineY,
        text,
        chars,
    };
}

function makePage(lines: RawLineDetailed[]): RawPageDataDetailed {
    // Union the line bboxes so the page is at least large enough to contain
    // everything; pad a bit for safety.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of lines) {
        if (l.bbox.x < minX) minX = l.bbox.x;
        if (l.bbox.y < minY) minY = l.bbox.y;
        if (l.bbox.x + l.bbox.w > maxX) maxX = l.bbox.x + l.bbox.w;
        if (l.bbox.y + l.bbox.h > maxY) maxY = l.bbox.y + l.bbox.h;
    }
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: maxX + 50,
        height: maxY + 50,
        blocks: [
            {
                type: 'text',
                bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
                lines,
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// simpleRegexSentenceSplit
// ---------------------------------------------------------------------------

describe('simpleRegexSentenceSplit', () => {
    it('splits basic sentences on punctuation + whitespace', () => {
        const text = 'One. Two! Three? Four.';
        const ranges = simpleRegexSentenceSplit(text);
        const strs = ranges.map((r) => text.slice(r.start, r.end));
        expect(strs).toEqual(['One.', 'Two!', 'Three?', 'Four.']);
    });

    it('returns a single range for text without terminal punctuation', () => {
        const text = 'no terminator here';
        const ranges = simpleRegexSentenceSplit(text);
        expect(ranges).toHaveLength(1);
        expect(text.slice(ranges[0].start, ranges[0].end)).toBe(text);
    });

    it('skips leading whitespace between sentences', () => {
        const text = '   First.    Second.';
        const ranges = simpleRegexSentenceSplit(text);
        const strs = ranges.map((r) => text.slice(r.start, r.end));
        expect(strs).toEqual(['First.', 'Second.']);
    });

    it('handles an empty string', () => {
        expect(simpleRegexSentenceSplit('')).toEqual([]);
    });

    it('does not end a sentence on a decimal-looking dot', () => {
        // "3.14" — the dot is followed by '1', not whitespace, so the whole
        // thing stays as one sentence. That matches the spec of the simple
        // splitter (no sophistication expected).
        const text = 'Pi is 3.14 approximately.';
        const ranges = simpleRegexSentenceSplit(text);
        expect(ranges).toHaveLength(1);
        expect(text.slice(ranges[0].start, ranges[0].end)).toBe(text);
    });
});

// ---------------------------------------------------------------------------
// flattenPageText / source map
// ---------------------------------------------------------------------------

describe('flattenPageText', () => {
    it('concatenates lines and builds a source map with line-break fillers', () => {
        const page = makePage([
            makeLine('Alpha.', 100),
            makeLine('Beta gamma.', 120),
        ]);
        const pt = flattenPageText(page);
        expect(pt.text).toBe('Alpha. Beta gamma.');
        // source.length === text.length
        expect(pt.source.length).toBe(pt.text.length);
        // The injected space between lines should be null
        const spaceIdx = pt.text.indexOf(' ');
        expect(pt.source[spaceIdx]).toBeNull();
        // Real chars should point back to their original line/char positions
        expect(pt.source[0]).toEqual({ lineIndex: 0, charIndex: 0 });
        expect(pt.source[5]).toEqual({ lineIndex: 0, charIndex: 5 }); // '.'
        // "Beta" starts after "Alpha. " — that's index 7
        expect(pt.source[7]).toEqual({ lineIndex: 1, charIndex: 0 });
    });

    it('throws loudly if a line violates the text/chars invariant', () => {
        const line = makeLine('Oops.', 100);
        // Deliberately break the invariant — drop a char but leave text
        line.chars = line.chars.slice(0, -1);
        const page = makePage([line]);
        expect(() => flattenPageText(page)).toThrow(/text\/chars length mismatch/);
    });
});

// ---------------------------------------------------------------------------
// sentenceToBoxes / extractSentenceBBoxes
// ---------------------------------------------------------------------------

describe('sentenceToBoxes', () => {
    it('resolves a single-line sentence to one bbox', () => {
        const page = makePage([makeLine('Hello world.', 100)]);
        const sentences = extractSentenceBBoxes(page);
        expect(sentences).toHaveLength(1);
        const s = sentences[0];
        expect(s.text).toBe('Hello world.');
        expect(s.bboxes).toHaveLength(1);
        expect(s.bboxes[0]).toEqual({ x: 50, y: 100, w: 120, h: 12 });
    });

    it('resolves a multi-line sentence to one bbox per line-fragment', () => {
        // Sentence splits the period across lines; no terminator on line 1,
        // so the splitter treats both lines as one sentence.
        const page = makePage([
            makeLine('This sentence spans', 100),
            makeLine('two distinct lines.', 120),
        ]);
        const sentences = extractSentenceBBoxes(page);
        expect(sentences).toHaveLength(1);
        const s = sentences[0];
        expect(s.bboxes).toHaveLength(2);
        expect(s.fragments).toBeDefined();
        expect(s.fragments![0].text).toBe('This sentence spans');
        expect(s.fragments![1].text).toBe('two distinct lines.');
        // Each fragment bbox should be at the respective baseline
        expect(s.bboxes[0].y).toBe(100);
        expect(s.bboxes[1].y).toBe(120);
    });

    it('produces short-last-line bboxes, not full-width rectangles', () => {
        // Line 1 is long, line 2 is short — the sentence bbox for the last
        // line should be tight on the actual characters, not the full line.
        const page = makePage([
            makeLine('This is a long first line that wraps', 100),
            makeLine('here.', 120),
        ]);
        const sentences = extractSentenceBBoxes(page);
        expect(sentences).toHaveLength(1);
        const lastFrag = sentences[0].fragments![1];
        expect(lastFrag.text).toBe('here.');
        // 5 chars × 10 wide = 50
        expect(lastFrag.bbox.w).toBe(50);
        expect(lastFrag.bbox.x).toBe(50);
    });

    it('splits a line into two fragments when a sentence ends mid-line', () => {
        // One physical line, two sentences — each should get its own tight
        // bbox covering only the characters belonging to that sentence.
        const page = makePage([makeLine('First. Second.', 100)]);
        const sentences = extractSentenceBBoxes(page);
        expect(sentences).toHaveLength(2);
        expect(sentences[0].text).toBe('First.');
        expect(sentences[1].text).toBe('Second.');
        // First sentence = 6 chars wide
        expect(sentences[0].bboxes[0].w).toBe(60);
        // Second sentence = 7 chars wide ('Second.'), starts after 'First. '
        expect(sentences[1].bboxes[0].w).toBe(70);
        expect(sentences[1].bboxes[0].x).toBe(50 + 7 * 10);
    });
});

// ---------------------------------------------------------------------------
// buildFeasibilityReport
// ---------------------------------------------------------------------------

describe('buildFeasibilityReport', () => {
    it('summarises a well-formed page', () => {
        const page = makePage([
            makeLine('First sentence.', 100),
            makeLine('Second sentence that wraps', 120),
            makeLine('across two lines.', 140),
        ]);
        const report = buildFeasibilityReport(page);
        expect(report.invariantHolds).toBe(true);
        expect(report.allBBoxesInPage).toBe(true);
        expect(report.totalLines).toBe(3);
        expect(report.totalSentences).toBe(2);
        expect(report.multiFragmentSentences).toBe(1);
        expect(report.sentences.length).toBe(2);
        expect(report.sentences[1].numBBoxes).toBe(2);
    });
});
