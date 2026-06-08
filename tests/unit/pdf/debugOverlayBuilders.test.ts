/**
 * Pure rect-builder tests. Verifies the moved overlay builders match
 * the original `react/utils/extractionOverlay.ts` contract using
 * synthetic `InternalProcessedPage` data.
 *
 * No PDF / WASM / sharp.
 */
import { describe, expect, it } from 'vitest';

import {
    buildColumnOverlayFromPage,
    buildColumnOverlayFromDebugPage,
    buildItemOverlayFromPage,
    buildLineOverlayFromDebugPage,
    buildLineOverlayFromPage,
    buildSentenceOverlayFromDebugPage,
    buildSentenceOverlayFromPage,
    OVERLAY_COLORS,
} from '../../../src/beaver-extract/debug/overlayBuilders';
import { bboxFromXYWH } from '../../../src/beaver-extract/types';
import type { InternalProcessedPage } from '../../../src/beaver-extract/types';
import type { PageDebugData } from '../../../src/beaver-extract/schema';

const bbox = (x: number, y: number, w: number, h: number) =>
    bboxFromXYWH(x, y, w, h, "top-left");

function basePage(): InternalProcessedPage {
    return {
        index: 0,
        width: 600,
        height: 800,
        viewBox: [0, 0, 600, 800],
        rotation: 0,
        content: '',
        columns: [],
        items: [],
    };
}

describe('debug/overlayBuilders', () => {
    describe('buildColumnOverlayFromPage', () => {
        it('emits one rect per column with C{n} labels', () => {
            const page: InternalProcessedPage = {
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
            const page: InternalProcessedPage = {
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
        it('uses kind-specific colors for every supported item kind', () => {
            const page: InternalProcessedPage = {
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
                    {
                        kind: "footnote",
                        id: "p0:i2",
                        pageIndex: 0,
                        index: 2,
                        bbox: bbox(50, 160, 300, 20),
                        columnIndex: 0,
                        text: "Footnote",
                        lines: [{ bbox: bbox(50, 160, 300, 20), text: "Footnote" }],
                        sentences: [],
                    },
                    {
                        kind: "caption",
                        id: "p0:i3",
                        pageIndex: 0,
                        index: 3,
                        bbox: bbox(50, 190, 300, 20),
                        columnIndex: 0,
                        text: "Caption",
                        lines: [{ bbox: bbox(50, 190, 300, 20), text: "Caption" }],
                        sentences: [],
                    },
                    {
                        kind: "list_item",
                        id: "p0:i4",
                        pageIndex: 0,
                        index: 4,
                        bbox: bbox(50, 220, 300, 20),
                        columnIndex: 0,
                        text: "List item",
                        lines: [{ bbox: bbox(50, 220, 300, 20), text: "List item" }],
                        sentences: [],
                    },
                    {
                        kind: "formula",
                        id: "p0:i5",
                        pageIndex: 0,
                        index: 5,
                        bbox: bbox(50, 250, 300, 20),
                        columnIndex: 0,
                        text: "E = mc^2",
                        lines: [{ bbox: bbox(50, 250, 300, 20), text: "E = mc^2" }],
                    },
                    {
                        kind: "margin",
                        id: "p0:i6",
                        pageIndex: 0,
                        index: 6,
                        bbox: bbox(50, 280, 300, 20),
                        columnIndex: 0,
                        text: "Running head",
                        lines: [{ bbox: bbox(50, 280, 300, 20), text: "Running head" }],
                    },
                    {
                        kind: "table",
                        id: "p0:i7",
                        pageIndex: 0,
                        index: 7,
                        bbox: bbox(50, 310, 300, 40),
                        columnIndex: 0,
                    },
                    {
                        kind: "picture",
                        id: "p0:i8",
                        pageIndex: 0,
                        index: 8,
                        bbox: bbox(50, 360, 300, 80),
                        columnIndex: 0,
                    },
                ],
            };
            const out = buildItemOverlayFromPage(page);
            expect(out.rects).toHaveLength(9);
            expect(out.rects[0].color).toBe(OVERLAY_COLORS.itemSectionHeader);
            expect(out.rects[0].label).toBe('H1');
            expect(out.rects[1].color).toBe(OVERLAY_COLORS.itemText);
            expect(out.rects[1].label).toBe('P2');
            expect(out.rects[2]).toMatchObject({ color: OVERLAY_COLORS.itemFootnote, label: "F3" });
            expect(out.rects[3]).toMatchObject({ color: OVERLAY_COLORS.itemCaption, label: "C4" });
            expect(out.rects[4]).toMatchObject({ color: OVERLAY_COLORS.itemList, label: "L5" });
            expect(out.rects[5]).toMatchObject({ color: OVERLAY_COLORS.itemFormula, label: "M6" });
            expect(out.rects[6]).toMatchObject({ color: OVERLAY_COLORS.itemMargin, label: "G7" });
            expect(out.rects[7]).toMatchObject({ color: OVERLAY_COLORS.itemTable, label: "T8" });
            expect(out.rects[8]).toMatchObject({ color: OVERLAY_COLORS.itemPicture, label: "I9" });
            expect(out.stats.headers).toBe(1);
            expect(out.stats.paragraphs).toBe(1);
            expect(out.stats.footnotes).toBe(1);
            expect(out.stats.captions).toBe(1);
            expect(out.stats.listItems).toBe(1);
            expect(out.stats.marginItems).toBe(1);
            expect(out.stats.formulas).toBe(1);
            expect(out.stats.tables).toBe(1);
            expect(out.stats.pictures).toBe(1);
        });

    });

    describe('buildSentenceOverlayFromPage', () => {
        it('alternates body sentence colors and labels them sequentially', () => {
            const page: InternalProcessedPage = {
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

        it('shows section headers directly in the sentence overlay', () => {
            const page: InternalProcessedPage = {
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
            expect(out.rects).toHaveLength(1);
            expect(out.rects[0]).toMatchObject({
                rect: bbox(0, 0, 100, 20),
                color: OVERLAY_COLORS.itemSectionHeader,
                label: "H1",
                group: 0,
            });
            expect(out.stats.headings).toBe(1);
            expect(out.stats.fallbackItems).toBe(1);
        });

        it('interleaves item fallbacks with sentence bboxes in reading order', () => {
            const page: InternalProcessedPage = {
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
                    {
                        kind: "text",
                        id: "p0:i1",
                        pageIndex: 0,
                        index: 1,
                        bbox: bbox(0, 40, 110, 12),
                        columnIndex: 0,
                        text: "A.",
                        lines: [{ bbox: bbox(0, 40, 110, 12), text: "A." }],
                        sentences: [
                            {
                                parentId: "p0:i1",
                                index: 0,
                                text: "A.",
                                bboxes: [bbox(0, 40, 50, 12)],
                            },
                        ],
                    },
                    {
                        kind: "formula",
                        id: "p0:i2",
                        pageIndex: 0,
                        index: 2,
                        bbox: bbox(0, 80, 100, 20),
                        columnIndex: 0,
                        text: "E = mc^2",
                        lines: [{ bbox: bbox(0, 80, 100, 20), text: "E = mc^2" }],
                    },
                ],
                sentences: [
                    {
                        parentId: "p0:i1",
                        index: 0,
                        text: "A.",
                        bboxes: [bbox(0, 40, 50, 12)],
                    },
                ],
            };
            const out = buildSentenceOverlayFromPage(page);
            expect(out.rects.map((rect) => rect.label)).toEqual(["H1", "S1", "M3"]);
            expect(out.rects.map((rect) => rect.group)).toEqual([0, 1, 2]);
        });
    });

    describe('debug-page builders', () => {
        it('preserves column and line geometry from the debug projection', () => {
            const page: PageDebugData = {
                pageIndex: 0,
                width: 600,
                height: 800,
                counts: { items: 1, sentences: 0, columns: 2, lines: 2 },
                columns: [
                    [50, 50, 290, 750],
                    [310, 50, 550, 750],
                ],
                lines: [
                    { id: 'p1:l0', bbox: [50, 100, 290, 120], text: 'A', columnIndex: 0 },
                    { id: 'p2:l0', bbox: [310, 100, 550, 120], text: 'B', columnIndex: 1 },
                ],
            };

            const columns = buildColumnOverlayFromDebugPage(page);
            expect(columns.rects).toHaveLength(2);
            expect(columns.rects[0].rect).toEqual(bbox(50, 50, 240, 700));

            const lines = buildLineOverlayFromDebugPage(page);
            expect(lines.rects).toHaveLength(2);
            expect(lines.stats.columns).toBe(2);
            expect(lines.rects[1].rect).toEqual(bbox(310, 100, 240, 20));
        });

        it('keeps item fallbacks in sentence overlays', () => {
            const page: PageDebugData = {
                pageIndex: 0,
                width: 600,
                height: 800,
                counts: { items: 3, sentences: 1 },
                items: [
                    {
                        id: 'heading1',
                        kind: 'section_header',
                        pageIndex: 0,
                        order: 0,
                        bbox: [0, 0, 100, 20],
                        text: 'Title',
                        level: 1,
                    },
                    {
                        id: 'p1',
                        kind: 'text',
                        pageIndex: 0,
                        order: 1,
                        bbox: [0, 40, 110, 52],
                        text: 'A.',
                        sentences: [
                            {
                                id: 's1',
                                order: 0,
                                text: 'A.',
                                bboxes: [[0, 40, 50, 52]],
                            },
                        ],
                    },
                    {
                        id: 'formula1',
                        kind: 'formula',
                        pageIndex: 0,
                        order: 2,
                        bbox: [0, 80, 100, 100],
                        text: 'E = mc^2',
                    },
                ],
                sentences: [
                    {
                        id: 's1',
                        itemId: 'p1',
                        order: 0,
                        text: 'A.',
                        bboxes: [[0, 40, 50, 52]],
                    },
                ],
            };

            const out = buildSentenceOverlayFromDebugPage(page);
            expect(out.rects.map((rect) => rect.label)).toEqual(['H1', 'S1', 'M3']);
            expect(out.rects.map((rect) => rect.group)).toEqual([0, 1, 2]);
            expect(out.stats.fallbackItems).toBe(2);
        });

        it('marks degraded canonical items in sentence overlays', () => {
            const page: PageDebugData = {
                pageIndex: 0,
                width: 600,
                height: 800,
                counts: { items: 1, sentences: 1 },
                items: [
                    {
                        id: 'p1',
                        kind: 'text',
                        pageIndex: 0,
                        order: 0,
                        bbox: [0, 0, 110, 12],
                        text: 'A.',
                        sentences: [
                            {
                                id: 's1',
                                order: 0,
                                text: 'A.',
                                bboxes: [[0, 0, 50, 12]],
                            },
                        ],
                    },
                ],
                sentences: [
                    {
                        id: 's1',
                        itemId: 'p1',
                        order: 0,
                        text: 'A.',
                        bboxes: [[0, 0, 50, 12]],
                    },
                ],
                degradation: {
                    count: 1,
                    notes: [
                        {
                            itemId: 'p1',
                            itemKind: 'text',
                            reason: 'unmapped',
                        },
                    ],
                },
            };

            const out = buildSentenceOverlayFromDebugPage(page);
            expect(out.rects).toHaveLength(1);
            expect(out.rects[0]).toMatchObject({
                color: OVERLAY_COLORS.sentenceDegraded,
                degraded: true,
            });
        });
    });
});
