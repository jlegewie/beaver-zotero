/**
 * Pure rect-builder tests. Verifies the moved overlay builders match
 * the original `react/utils/extractionOverlay.ts` contract using
 * synthetic `ProcessedPage` data.
 *
 * No PDF / WASM / sharp.
 */
import { describe, expect, it } from 'vitest';

import {
    buildColumnOverlayFromPage,
    buildLineOverlayFromPage,
    buildParagraphOverlayFromPage,
    buildSentenceOverlayFromPage,
    OVERLAY_COLORS,
} from '../../../src/services/pdf/debug/overlayBuilders';
import type { ProcessedPage } from '../../../src/services/pdf/types';

function basePage(): ProcessedPage {
    return {
        index: 0,
        width: 600,
        height: 800,
        blocks: [],
        content: '',
    };
}

describe('debug/overlayBuilders', () => {
    describe('buildColumnOverlayFromPage', () => {
        it('emits one rect per column with C{n} labels', () => {
            const page: ProcessedPage = {
                ...basePage(),
                columns: [
                    { l: 50, t: 50, r: 290, b: 750 },
                    { l: 310, t: 50, r: 550, b: 750 },
                ],
            };
            const out = buildColumnOverlayFromPage(page);
            expect(out.level).toBe('columns');
            expect(out.rects).toHaveLength(2);
            expect(out.rects[0]).toMatchObject({
                rect: { x: 50, y: 50, w: 240, h: 700 },
                label: 'C1',
                color: OVERLAY_COLORS.column,
                group: 0,
            });
            expect(out.rects[1].label).toBe('C2');
            expect(out.stats.columns).toBe(2);
        });

        it('handles a missing columns array (markdown-mode page)', () => {
            const out = buildColumnOverlayFromPage(basePage());
            expect(out.rects).toHaveLength(0);
            expect(out.stats.columns).toBe(0);
        });
    });

    describe('buildLineOverlayFromPage', () => {
        it('emits one rect per line and counts distinct columns', () => {
            const page: ProcessedPage = {
                ...basePage(),
                lines: [
                    { bbox: { l: 50, t: 100, r: 290, b: 120 }, columnIndex: 0, text: 'a' },
                    { bbox: { l: 50, t: 130, r: 290, b: 150 }, columnIndex: 0, text: 'b' },
                    { bbox: { l: 310, t: 100, r: 550, b: 120 }, columnIndex: 1, text: 'c' },
                ] as ProcessedPage['lines'],
            };
            const out = buildLineOverlayFromPage(page);
            expect(out.rects).toHaveLength(3);
            expect(out.rects.every((r) => r.color === OVERLAY_COLORS.line)).toBe(true);
            expect(out.stats.lines).toBe(3);
            expect(out.stats.columns).toBe(2);
        });
    });

    describe('buildParagraphOverlayFromPage', () => {
        it('uses the header color for paragraphs of type "header"', () => {
            const page: ProcessedPage = {
                ...basePage(),
                paragraphs: [
                    {
                        item: {
                            type: 'header',
                            idx: 0,
                            bbox: { l: 50, t: 50, width: 200, height: 30 },
                        },
                        paragraphText: 'Title',
                        sentences: [],
                    },
                    {
                        item: {
                            type: 'paragraph',
                            idx: 1,
                            bbox: { l: 50, t: 100, width: 500, height: 50 },
                        },
                        paragraphText: 'Body',
                        sentences: [],
                    },
                ] as unknown as ProcessedPage['paragraphs'],
            };
            const out = buildParagraphOverlayFromPage(page);
            expect(out.rects).toHaveLength(2);
            expect(out.rects[0].color).toBe(OVERLAY_COLORS.header);
            expect(out.rects[0].label).toBe('H1');
            expect(out.rects[1].color).toBe(OVERLAY_COLORS.paragraph);
            expect(out.rects[1].label).toBe('P2');
            expect(out.stats.headers).toBe(1);
            expect(out.stats.paragraphs).toBe(1);
        });
    });

    describe('buildSentenceOverlayFromPage', () => {
        it('alternates body sentence colors and labels them sequentially', () => {
            const page: ProcessedPage = {
                ...basePage(),
                paragraphs: [
                    {
                        item: { type: 'paragraph', idx: 0, text: 'A. B.' },
                        paragraphText: 'A. B.',
                        sentences: [],
                    },
                ] as unknown as ProcessedPage['paragraphs'],
                sentences: [
                    {
                        pageIndex: 0,
                        paragraphIndex: 0,
                        sentenceIndex: 0,
                        text: 'A.',
                        bboxes: [{ x: 0, y: 0, w: 50, h: 12 }],
                    },
                    {
                        pageIndex: 0,
                        paragraphIndex: 0,
                        sentenceIndex: 1,
                        text: 'B.',
                        bboxes: [{ x: 60, y: 0, w: 50, h: 12 }],
                    },
                ] as ProcessedPage['sentences'],
            };
            const out = buildSentenceOverlayFromPage(page);
            expect(out.rects).toHaveLength(2);
            expect(out.rects[0].color).toBe(OVERLAY_COLORS.sentence[0]);
            expect(out.rects[1].color).toBe(OVERLAY_COLORS.sentence[1]);
            expect(out.rects[0].label).toBe('S1');
            expect(out.rects[1].label).toBe('S2');
            expect(out.stats.sentences).toBe(2);
        });

        it('marks heading-kind sentences with the header color and H labels', () => {
            const page: ProcessedPage = {
                ...basePage(),
                paragraphs: [
                    {
                        item: { type: 'header', idx: 0, text: 'Title' },
                        paragraphText: 'Title',
                        sentences: [],
                    },
                ] as unknown as ProcessedPage['paragraphs'],
                sentences: [
                    {
                        pageIndex: 0,
                        paragraphIndex: 0,
                        sentenceIndex: 0,
                        text: 'Title',
                        kind: 'heading',
                        bboxes: [{ x: 0, y: 0, w: 100, h: 20 }],
                    },
                ] as ProcessedPage['sentences'],
            };
            const out = buildSentenceOverlayFromPage(page);
            expect(out.rects[0].color).toBe(OVERLAY_COLORS.header);
            expect(out.rects[0].label).toBe('H1');
            expect(out.stats.headings).toBe(1);
        });
    });
});
