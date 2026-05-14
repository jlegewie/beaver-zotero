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
    buildItemOverlayFromPage,
    buildLineOverlayFromPage,
    buildParagraphOverlayFromPage,
    buildSentenceOverlayFromPage,
    OVERLAY_COLORS,
} from '../../../src/services/pdf/debug/overlayBuilders';
import { bboxFromXYWH } from '../../../src/services/pdf/types';
import type { ProcessedPage } from '../../../src/services/pdf/types';

const bbox = (x: number, y: number, w: number, h: number) =>
    bboxFromXYWH(x, y, w, h, "top-left");

function basePage(): ProcessedPage {
    return {
        index: 0,
        width: 600,
        height: 800,
        content: '',
        columns: [],
        items: [],
    };
}

describe('debug/overlayBuilders', () => {
    describe('buildColumnOverlayFromPage', () => {
        it('emits one rect per column with C{n} labels', () => {
            const page: ProcessedPage = {
                ...basePage(),
                columns: [
                    bbox(50, 50, 240, 700),
                    bbox(310, 50, 240, 700),
                ],
            };
            const out = buildColumnOverlayFromPage(page);
            expect(out.level).toBe('columns');
            expect(out.rects).toHaveLength(2);
            expect(out.rects[0]).toMatchObject({
                rect: bbox(50, 50, 240, 700),
                label: 'C1',
                color: OVERLAY_COLORS.column,
                group: 0,
            });
            expect(out.rects[1].label).toBe('C2');
            expect(out.stats.columns).toBe(2);
        });

        it('handles an empty columns array (markdown-mode page)', () => {
            const out = buildColumnOverlayFromPage(basePage());
            expect(out.rects).toHaveLength(0);
            expect(out.stats.columns).toBe(0);
        });
    });

    describe('buildLineOverlayFromPage', () => {
        it('emits one rect per line and counts distinct columns', () => {
            const page: ProcessedPage = {
                ...basePage(),
                items: [
                    {
                        kind: "text",
                        id: "p0:i0",
                        pageIndex: 0,
                        index: 0,
                        bbox: bbox(50, 100, 240, 50),
                        columnIndex: 0,
                        text: "a b",
                        lines: [
                            { bbox: bbox(50, 100, 240, 20), text: 'a' },
                            { bbox: bbox(50, 130, 240, 20), text: 'b' },
                        ],
                        sentences: [],
                    },
                    {
                        kind: "text",
                        id: "p0:i1",
                        pageIndex: 0,
                        index: 1,
                        bbox: bbox(310, 100, 240, 20),
                        columnIndex: 1,
                        text: "c",
                        lines: [
                            { bbox: bbox(310, 100, 240, 20), text: 'c' },
                        ],
                        sentences: [],
                    },
                ],
            };
            const out = buildLineOverlayFromPage(page);
            expect(out.rects).toHaveLength(3);
            expect(out.rects.every((r) => r.color === OVERLAY_COLORS.line)).toBe(true);
            expect(out.stats.lines).toBe(3);
            expect(out.stats.columns).toBe(2);
        });
    });

    describe('buildItemOverlayFromPage', () => {
        it('uses the header color for section headers', () => {
            const page: ProcessedPage = {
                ...basePage(),
                items: [
                    {
                        kind: "section_header",
                        id: "p0:i0",
                        pageIndex: 0,
                        index: 0,
                        bbox: bbox(50, 50, 200, 30),
                        columnIndex: 0,
                        text: "Title",
                        lines: [{ bbox: bbox(50, 50, 200, 30), text: "Title" }],
                        level: 1,
                    },
                    {
                        kind: "text",
                        id: "p0:i1",
                        pageIndex: 0,
                        index: 1,
                        bbox: bbox(50, 100, 500, 50),
                        columnIndex: 0,
                        text: "Body",
                        lines: [{ bbox: bbox(50, 100, 500, 50), text: "Body" }],
                        sentences: [],
                    },
                ],
            };
            const out = buildItemOverlayFromPage(page);
            expect(out.rects).toHaveLength(2);
            expect(out.rects[0].color).toBe(OVERLAY_COLORS.header);
            expect(out.rects[0].label).toBe('H1');
            expect(out.rects[1].color).toBe(OVERLAY_COLORS.paragraph);
            expect(out.rects[1].label).toBe('P2');
            expect(out.stats.headers).toBe(1);
            expect(out.stats.paragraphs).toBe(1);
        });

        it('paragraph overlay includes text items only', () => {
            const page: ProcessedPage = {
                ...basePage(),
                items: [
                    {
                        kind: "section_header",
                        id: "p0:i0",
                        pageIndex: 0,
                        index: 0,
                        bbox: bbox(50, 50, 200, 30),
                        columnIndex: 0,
                        text: "Title",
                        lines: [{ bbox: bbox(50, 50, 200, 30), text: "Title" }],
                        level: 1,
                    },
                    {
                        kind: "text",
                        id: "p0:i1",
                        pageIndex: 0,
                        index: 1,
                        bbox: bbox(50, 100, 500, 50),
                        columnIndex: 0,
                        text: "Body",
                        lines: [{ bbox: bbox(50, 100, 500, 50), text: "Body" }],
                        sentences: [],
                    },
                ],
            };
            const out = buildParagraphOverlayFromPage(page);
            expect(out.level).toBe("paragraphs");
            expect(out.rects).toHaveLength(1);
            expect(out.rects[0].label).toBe("P2");
        });
    });

    describe('buildSentenceOverlayFromPage', () => {
        it('alternates body sentence colors and labels them sequentially', () => {
            const page: ProcessedPage = {
                ...basePage(),
                items: [
                    {
                        kind: "text",
                        id: "p0:i0",
                        pageIndex: 0,
                        index: 0,
                        bbox: bbox(0, 0, 110, 12),
                        columnIndex: 0,
                        text: "A. B.",
                        lines: [{ bbox: bbox(0, 0, 110, 12), text: "A. B." }],
                        sentences: [],
                    },
                ],
                sentences: [
                    {
                        parentId: "p0:i0",
                        index: 0,
                        text: 'A.',
                        bboxes: [bbox(0, 0, 50, 12)],
                    },
                    {
                        parentId: "p0:i0",
                        index: 1,
                        text: 'B.',
                        bboxes: [bbox(60, 0, 50, 12)],
                    },
                ],
            };
            const out = buildSentenceOverlayFromPage(page);
            expect(out.rects).toHaveLength(2);
            expect(out.rects[0].color).toBe(OVERLAY_COLORS.sentence[0]);
            expect(out.rects[1].color).toBe(OVERLAY_COLORS.sentence[1]);
            expect(out.rects[0].label).toBe('S1');
            expect(out.rects[1].label).toBe('S2');
            expect(out.stats.sentences).toBe(2);
        });

        it('keeps section headers out of the sentence overlay', () => {
            const page: ProcessedPage = {
                ...basePage(),
                items: [
                    {
                        kind: "section_header",
                        id: "p0:i0",
                        pageIndex: 0,
                        index: 0,
                        bbox: bbox(0, 0, 100, 20),
                        columnIndex: 0,
                        text: "Title",
                        lines: [{ bbox: bbox(0, 0, 100, 20), text: "Title" }],
                        level: 1,
                    },
                ],
                sentences: [],
            };
            const out = buildSentenceOverlayFromPage(page);
            expect(out.rects).toHaveLength(0);
            expect(out.stats.headings).toBe(1);
        });
    });
});
