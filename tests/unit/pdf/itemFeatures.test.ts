/**
 * Unit tests for the item-classifier feature module.
 *
 * Inputs are synthetic `ContentItem` / `PageLine` structures so the tests
 * exercise the feature definitions directly, without MuPDF.
 */

import { describe, it, expect } from 'vitest';

import {
    FEATURE_NAMES,
    FEATURE_VERSION,
    computeItemFeatures,
    type ItemFeatureInput,
} from '../../../src/beaver-extract/classify/itemFeatures';
import {
    createDocContext,
    looksLikeReferenceHeader,
    updateDocContext,
} from '../../../src/beaver-extract/classify/docContext';
import { detectParagraphs } from '../../../src/beaver-extract/ParagraphDetector';
import type {
    ColumnThresholds,
    ContentItem,
    PageThresholds,
} from '../../../src/beaver-extract/ParagraphDetector';
import type {
    DetectedSpan,
    PageLine,
    PageLineResult,
} from '../../../src/beaver-extract/LineDetector';
import type { BoundingBox, StyleProfile } from '@beaver/agent-core/extract/types';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const FONT = 'Times';
const FONT_SIZE = 10;
const LINE_HEIGHT = 12;
const COLUMN_LEFT = 50;
const COLUMN_RIGHT = 350;

function bbox(l: number, t: number, r: number, b: number): BoundingBox {
    return { l, t, r, b, origin: 'top-left' };
}

function makeLine(
    text: string,
    left: number,
    right: number,
    top: number,
    style: { italic?: boolean; bold?: boolean; font?: string } = {},
): PageLine {
    const box = bbox(left, top, right, top + LINE_HEIGHT);
    const span: DetectedSpan = {
        text,
        bbox: box,
        lineBBox: box,
        size: FONT_SIZE,
        fontName: style.font ?? FONT,
        fontWeight: style.bold ? 'bold' : 'normal',
        fontStyle: style.italic ? 'italic' : 'normal',
    };
    return { spans: [span], bboxes: [box], bbox: box, text, fontSize: FONT_SIZE };
}

/**
 * Build an item from per-line `{ text, left, right }` specs stacked from
 * `top` with a one-point inter-line gap.
 */
function makeItem(
    spec: {
        index: number;
        top: number;
        type?: 'paragraph' | 'header';
        columnIndex?: number;
        lines: { text: string; left: number; right: number }[];
    },
): { item: ContentItem; lines: PageLine[] } {
    const lines: PageLine[] = [];
    let top = spec.top;
    for (const line of spec.lines) {
        lines.push(makeLine(line.text, line.left, line.right, top));
        top += LINE_HEIGHT + 1;
    }
    const text = spec.lines.map((line) => line.text).join(' ');
    const item: ContentItem = {
        type: spec.type ?? 'paragraph',
        idx: spec.index,
        docIdx: spec.index,
        start: 0,
        end: text.length,
        text,
        id: `p0:i${spec.index}`,
        bbox: bbox(
            Math.min(...lines.map((l) => l.bbox.l)),
            lines[0].bbox.t,
            Math.max(...lines.map((l) => l.bbox.r)),
            lines[lines.length - 1].bbox.b,
        ),
        columnIndex: spec.columnIndex ?? 0,
    };
    return { item, lines };
}

const PAGE_THRESHOLDS: PageThresholds = {
    medianHeight: LINE_HEIGHT,
    medianGap: 1,
    gapExcessThreshold: 5,
    binPx: 2,
};

const COLUMN_THRESHOLDS: ColumnThresholds = {
    leftEdgeMode: COLUMN_LEFT,
    rightEdgeMode: COLUMN_RIGHT,
    leftEdgeMad: 2,
    rightEdgeMad: 4,
    maxRightEdge: COLUMN_RIGHT,
    indentExcessThreshold: 5,
    earlyEndExcessThreshold: 6,
    gapExcessThreshold: 5,
};

const STYLE_PROFILE: StyleProfile = {
    primaryBodyStyle: { size: FONT_SIZE, font: FONT, bold: false, italic: false },
    bodyStyles: [{ size: FONT_SIZE, font: FONT, bold: false, italic: false }],
    styleCounts: new Map(),
};

const REFERENCE_TEXT_LINES = [
    { text: 'Smith, J. Q., & Doe, A. B. (2004). Title of the paper', left: COLUMN_LEFT, right: COLUMN_RIGHT },
    { text: 'about things. Journal of Things, 12(3), 231-245.', left: COLUMN_LEFT + 12, right: COLUMN_RIGHT },
    { text: 'doi:10.1000/xyz123', left: COLUMN_LEFT + 12, right: COLUMN_LEFT + 120 },
];

const BODY_TEXT_LINES = [
    { text: '    The results indicate that the intervention produced', left: COLUMN_LEFT + 14, right: COLUMN_RIGHT },
    { text: 'a measurable change in outcomes across all treatment', left: COLUMN_LEFT, right: COLUMN_RIGHT },
    { text: 'groups, though the magnitude varied between sites.', left: COLUMN_LEFT, right: COLUMN_LEFT + 260 },
];

function buildInput(
    parts: { item: ContentItem; lines: PageLine[] }[],
    overrides: Partial<ItemFeatureInput> = {},
): ItemFeatureInput {
    return {
        pageIndex: 10,
        pageCount: 12,
        pageWidth: 400,
        pageHeight: 700,
        items: parts.map((p) => p.item),
        itemLines: parts.map((p) => p.lines),
        pageThresholds: PAGE_THRESHOLDS,
        columnThresholds: { 0: COLUMN_THRESHOLDS },
        styleProfile: STYLE_PROFILE,
        ...overrides,
    };
}

function featureOf(row: { features: number[] }, name: string): number {
    const index = FEATURE_NAMES.indexOf(name);
    expect(index, `unknown feature ${name}`).toBeGreaterThanOrEqual(0);
    return row.features[index];
}

function referenceItem(index: number, top: number) {
    return makeItem({ index, top, lines: REFERENCE_TEXT_LINES });
}

function bodyItem(index: number, top: number) {
    return makeItem({ index, top, lines: BODY_TEXT_LINES });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FEATURE_NAMES', () => {
    it('has a stable, unique, non-empty name per vector slot', () => {
        expect(FEATURE_NAMES.length).toBeGreaterThan(0);
        expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_NAMES.length);
        expect(FEATURE_NAMES.every((name) => name.length > 0)).toBe(true);
        expect(FEATURE_VERSION).toBe(1);
    });
});

describe('computeItemFeatures', () => {
    it('emits one finite vector per item, sized to FEATURE_NAMES', () => {
        const input = buildInput([referenceItem(0, 60), bodyItem(1, 200)]);
        const { rows } = computeItemFeatures(input);

        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.features).toHaveLength(FEATURE_NAMES.length);
            expect(row.features.every((value) => Number.isFinite(value))).toBe(true);
        }
        expect(rows[0].itemId).toBe('p0:i0');
    });

    it('scores a hanging-indent reference entry on geometry and text', () => {
        const { rows } = computeItemFeatures(buildInput([referenceItem(0, 60)]));
        const row = rows[0];

        expect(featureOf(row, 'hasHangingIndent')).toBe(1);
        expect(featureOf(row, 'hangingIndentFontUnits')).toBeCloseTo(1.2, 5);
        expect(featureOf(row, 'isReferenceParagraph')).toBe(1);
        expect(featureOf(row, 'hasReferenceStart')).toBe(1);
        expect(featureOf(row, 'hasReferenceTail')).toBe(1);
        expect(featureOf(row, 'hasDoiOrUrl')).toBe(1);
        expect(featureOf(row, 'hasPageRange')).toBe(1);
        expect(featureOf(row, 'hasYearToken')).toBe(1);
        expect(featureOf(row, 'initialsPatternCountLog')).toBeGreaterThan(0);
        // Last line stops well short of the column's right margin.
        expect(featureOf(row, 'raggedEndFontUnits')).toBeGreaterThan(5);
    });

    it('scores a body paragraph low on the reference signals', () => {
        const { rows } = computeItemFeatures(buildInput([bodyItem(0, 60)]));
        const row = rows[0];

        expect(featureOf(row, 'isReferenceParagraph')).toBe(0);
        expect(featureOf(row, 'hasReferenceStart')).toBe(0);
        expect(featureOf(row, 'hasReferenceTail')).toBe(0);
        expect(featureOf(row, 'hasDoiOrUrl')).toBe(0);
        expect(featureOf(row, 'hasYearToken')).toBe(0);
        // First line is indented, continuations are not: no hanging indent.
        expect(featureOf(row, 'hasHangingIndent')).toBe(0);
        expect(featureOf(row, 'hangingIndentFontUnits')).toBeLessThan(0);
        expect(featureOf(row, 'matchesPrimaryBodyStyle')).toBe(1);
    });

    it('reflects neighbors and the hanging-indent run in the context features', () => {
        const isolated = computeItemFeatures(
            buildInput([bodyItem(0, 60), referenceItem(1, 200), bodyItem(2, 340)]),
        ).rows[1];
        const inList = computeItemFeatures(
            buildInput([
                referenceItem(0, 60),
                referenceItem(1, 120),
                referenceItem(2, 180),
                referenceItem(3, 240),
            ]),
        ).rows[1];

        expect(featureOf(isolated, 'prevItemRefScore')).toBe(0);
        expect(featureOf(isolated, 'nextItemRefScore')).toBe(0);
        expect(featureOf(inList, 'prevItemRefScore')).toBe(1);
        expect(featureOf(inList, 'nextItemRefScore')).toBe(1);
        expect(featureOf(inList, 'nextItem2RefScore')).toBe(1);

        expect(featureOf(isolated, 'hangingRunLengthLog')).toBeCloseTo(Math.log1p(1), 5);
        expect(featureOf(inList, 'hangingRunLengthLog')).toBeCloseTo(Math.log1p(4), 5);
        expect(featureOf(inList, 'hangingRunFraction')).toBeCloseTo(1, 5);
        expect(featureOf(inList, 'pageRefLikeFraction')).toBeCloseTo(1, 5);
        expect(featureOf(isolated, 'pageRefLikeFraction')).toBeCloseTo(1 / 3, 5);
    });

    it('records neighbor ids used for the context features', () => {
        const { rows } = computeItemFeatures(
            buildInput([
                referenceItem(0, 60),
                referenceItem(1, 120),
                referenceItem(2, 180),
                referenceItem(3, 240),
            ]),
        );
        expect(rows[2].neighborIds).toEqual({
            prev: ['p0:i1', 'p0:i0'],
            next: ['p0:i3'],
        });
        expect(rows[0].neighborIds).toEqual({
            prev: [],
            next: ['p0:i1', 'p0:i2'],
        });
    });

    it('sets the reference-header flag after the header and keeps it on later pages', () => {
        const header = makeItem({
            index: 0,
            top: 40,
            type: 'header',
            lines: [{ text: 'References', left: COLUMN_LEFT, right: COLUMN_LEFT + 60 }],
        });
        const firstPage = computeItemFeatures(
            buildInput([bodyItem(0, 60), header, referenceItem(2, 200)], {
                pageIndex: 9,
            }),
        );

        expect(featureOf(firstPage.rows[0], 'refHeaderSeenBefore')).toBe(0);
        // The header item itself is still "before the header" in reading order.
        expect(featureOf(firstPage.rows[1], 'refHeaderSeenBefore')).toBe(0);
        expect(featureOf(firstPage.rows[2], 'refHeaderSeenBefore')).toBe(1);
        expect(firstPage.docContext.referenceHeaderSeen).toBe(true);

        const secondPage = computeItemFeatures(
            buildInput([referenceItem(0, 60)], {
                pageIndex: 10,
                docContext: firstPage.docContext,
            }),
        );
        expect(featureOf(secondPage.rows[0], 'refHeaderSeenBefore')).toBe(1);
        expect(featureOf(secondPage.rows[0], 'docRefLikeFraction')).toBeGreaterThan(0);
    });

    it('does not let a body-text "Notes:" line set the sticky header flag', () => {
        const tableNote = makeItem({
            index: 1,
            top: 120,
            lines: [{ text: 'Notes:', left: COLUMN_LEFT, right: COLUMN_LEFT + 40 }],
        });
        const page = computeItemFeatures(
            buildInput([bodyItem(0, 60), tableNote, bodyItem(2, 200)]),
        );
        expect(featureOf(page.rows[2], 'refHeaderSeenBefore')).toBe(0);
        expect(page.docContext.referenceHeaderSeen).toBe(false);

        const notesHeading = makeItem({
            index: 1,
            top: 120,
            type: 'header',
            lines: [{ text: 'Notes', left: COLUMN_LEFT, right: COLUMN_LEFT + 40 }],
        });
        const headed = computeItemFeatures(
            buildInput([bodyItem(0, 60), notesHeading, bodyItem(2, 200)]),
        );
        expect(featureOf(headed.rows[2], 'refHeaderSeenBefore')).toBe(1);

        // An unambiguous heading counts even when the detector missed it.
        const missedHeading = makeItem({
            index: 1,
            top: 120,
            lines: [{ text: 'References', left: COLUMN_LEFT, right: COLUMN_LEFT + 60 }],
        });
        const missed = computeItemFeatures(
            buildInput([bodyItem(0, 60), missedHeading, bodyItem(2, 200)]),
        );
        expect(featureOf(missed.rows[2], 'refHeaderSeenBefore')).toBe(1);
    });

    it('reads heading-classified items without the detector\'s markdown marker', () => {
        const promotedEntry = makeItem({
            index: 0,
            top: 60,
            type: 'header',
            lines: [
                { text: '## Smith, J. Q., & Doe, A. B. (2004). Title of the paper', left: COLUMN_LEFT, right: COLUMN_RIGHT },
                { text: 'about things. Journal of Things, 12(3), 231-245.', left: COLUMN_LEFT + 12, right: COLUMN_RIGHT },
            ],
        });
        const { rows } = computeItemFeatures(buildInput([promotedEntry]));
        expect(rows[0].text.startsWith('Smith, J. Q.')).toBe(true);
        expect(featureOf(rows[0], 'isHeaderItem')).toBe(1);
        expect(featureOf(rows[0], 'hasReferenceStart')).toBe(1);
        expect(featureOf(rows[0], 'isReferenceParagraph')).toBe(1);
        expect(featureOf(rows[0], 'pageRefLikeFraction')).toBe(1);

        const leader = makeItem({
            index: 0,
            top: 60,
            type: 'header',
            lines: [{ text: '## [12] Smith, J. (2004). A paper.', left: COLUMN_LEFT, right: COLUMN_RIGHT }],
        });
        expect(featureOf(computeItemFeatures(buildInput([leader])).rows[0], 'hasLeaderMarker')).toBe(1);

        // A body paragraph that merely starts with hashes keeps them.
        const hashes = makeItem({
            index: 0,
            top: 60,
            lines: [{ text: '## not a heading', left: COLUMN_LEFT, right: COLUMN_RIGHT }],
        });
        expect(featureOf(computeItemFeatures(buildInput([hashes])).rows[0], 'startsLowercase')).toBe(0);
    });

    it('scopes gaps, thresholds and hanging runs to the item\'s own column', () => {
        const rightColumn: ColumnThresholds = {
            ...COLUMN_THRESHOLDS,
            leftEdgeMode: COLUMN_LEFT + 300,
            rightEdgeMode: COLUMN_RIGHT + 300,
            maxRightEdge: COLUMN_RIGHT + 300,
            gapExcessThreshold: 50,
        };
        const shift = (lines: typeof REFERENCE_TEXT_LINES) =>
            lines.map((line) => ({ ...line, left: line.left + 300, right: line.right + 300 }));
        // Column 0: two hanging-indent entries. Column 1: a body paragraph
        // near the top, then another entry further down.
        const leftA = makeItem({ index: 0, top: 60, lines: REFERENCE_TEXT_LINES });
        const leftB = makeItem({ index: 1, top: 200, lines: REFERENCE_TEXT_LINES });
        const right = makeItem({ index: 2, top: 30, columnIndex: 1, lines: shift(BODY_TEXT_LINES) });
        const rightRef = makeItem({ index: 3, top: 300, columnIndex: 1, lines: shift(REFERENCE_TEXT_LINES) });

        const { rows } = computeItemFeatures(
            buildInput([leftA, leftB, right, rightRef], {
                columnThresholds: { 0: COLUMN_THRESHOLDS, 1: rightColumn },
            }),
        );

        // Last item in column 0 has no successor in its column: neutral gap,
        // not the (negative) distance to the first item of column 1.
        expect(featureOf(rows[1], 'gapBelowOverMedianGap')).toBeCloseTo(1);
        // First item in column 1 has no predecessor in its column.
        expect(featureOf(rows[2], 'gapAboveOverMedianGap')).toBeCloseTo(1);
        // Column 1 gaps are normalized by column 1's own threshold.
        const gap = rightRef.item.bbox.t - right.item.bbox.b;
        expect(featureOf(rows[3], 'gapAboveOverColumnThreshold')).toBeCloseTo(gap / 50);
        expect(featureOf(rows[2], 'gapBelowOverColumnThreshold')).toBeCloseTo(gap / 50);
        // Geometry is measured against the item's own column edge.
        expect(featureOf(rows[2], 'firstLineLeftOffsetFontUnits')).toBeCloseTo(
            (BODY_TEXT_LINES[0].left - COLUMN_LEFT) / FONT_SIZE,
        );
        // The hanging run in column 0 is two long and stops at the column
        // boundary; column 1's single hanging entry is a run of one.
        expect(featureOf(rows[0], 'hangingRunLengthLog')).toBeCloseTo(Math.log1p(2));
        expect(featureOf(rows[1], 'hangingRunFraction')).toBeCloseTo(1);
        expect(featureOf(rows[3], 'hangingRunLengthLog')).toBeCloseTo(Math.log1p(1));
        expect(featureOf(rows[3], 'hangingRunFraction')).toBeCloseTo(0.5);
        // Neighbour scores still follow page reading order across columns.
        expect(featureOf(rows[2], 'prevItemRefScore')).toBeGreaterThan(0);
    });

    it('measures gaps and vertical position in the stated direction', () => {
        // Items stacked at top 60 and top 200: the first ends at 60 + 3 lines.
        const upper = bodyItem(0, 60);
        const lower = bodyItem(1, 200);
        const { rows } = computeItemFeatures(buildInput([upper, lower]));
        const expectedGap = lower.item.bbox.t - upper.item.bbox.b;
        expect(expectedGap).toBeGreaterThan(0);
        expect(featureOf(rows[0], 'gapBelowOverMedianGap')).toBeCloseTo(
            expectedGap / PAGE_THRESHOLDS.medianGap,
        );
        expect(featureOf(rows[1], 'gapAboveOverMedianGap')).toBeCloseTo(
            expectedGap / PAGE_THRESHOLDS.medianGap,
        );
        expect(featureOf(rows[0], 'gapBelowOverColumnThreshold')).toBeCloseTo(
            expectedGap / COLUMN_THRESHOLDS.gapExcessThreshold,
        );
        // No neighbour above the first item: reads as the neutral median gap.
        expect(featureOf(rows[0], 'gapAboveOverMedianGap')).toBeCloseTo(1);
        // Inter-line leading inside the item is the one-point stacking gap.
        expect(featureOf(rows[0], 'internalLeadingOverMedianGap')).toBeCloseTo(1);
        // Lower on the page means a larger normalized y.
        expect(featureOf(rows[1], 'yCenterOnPage')).toBeGreaterThan(
            featureOf(rows[0], 'yCenterOnPage'),
        );
        expect(featureOf(rows[0], 'yCenterOnPage')).toBeCloseTo(
            (upper.item.bbox.t + upper.item.bbox.b) / 2 / 700,
        );
    });

    it('degrades to zero document-context features with an empty context', () => {
        const { rows } = computeItemFeatures(buildInput([referenceItem(0, 60)]));
        expect(featureOf(rows[0], 'refHeaderSeenBefore')).toBe(0);
        expect(featureOf(rows[0], 'docRefLikeFraction')).toBe(0);
    });

    it('is deterministic for identical input', () => {
        const build = () =>
            computeItemFeatures(
                buildInput([referenceItem(0, 60), bodyItem(1, 200)], {
                    docContext: updateDocContext(createDocContext(), {
                        itemCount: 20,
                        referenceLikeCount: 4,
                        referenceHeaderSeen: true,
                    }),
                }),
            );
        expect(build().rows).toEqual(build().rows);
    });

    it('stays finite on degenerate input: zero thresholds, no lines, no page size', () => {
        const bare: ContentItem = {
            type: 'paragraph',
            idx: 0,
            docIdx: 0,
            start: 0,
            end: 4,
            text: 'text',
            id: 'p0:i0',
            bbox: bbox(0, 0, 0, 0),
            columnIndex: 3,
        };
        const { rows } = computeItemFeatures({
            pageIndex: 0,
            pageCount: 1,
            pageWidth: 0,
            pageHeight: 0,
            items: [bare],
            itemLines: [],
            pageThresholds: { medianHeight: 0, medianGap: 0, gapExcessThreshold: 0, binPx: 0 },
            columnThresholds: {},
            styleProfile: { primaryBodyStyle: null as never, bodyStyles: [], styleCounts: new Map() },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].features).toHaveLength(FEATURE_NAMES.length);
        for (const value of rows[0].features) expect(Number.isFinite(value)).toBe(true);
    });

    it('returns no rows and an unchanged context for an empty page', () => {
        const context = createDocContext();
        const result = computeItemFeatures(buildInput([], { docContext: context }));
        expect(result.rows).toEqual([]);
        expect(result.docContext).toEqual(context);
    });
});

describe('looksLikeReferenceHeader', () => {
    it('matches reference-section headings across languages and numbering', () => {
        for (const text of [
            'References',
            'REFERENCES',
            '## References',
            '5. References',
            'References and Notes',
            'REFERENCES AND NOTES',
            'Bibliography',
            'Works Cited',
            'Literature Cited',
            'Endnotes',
            'Bibliographie',
            'Références',
            'Bibliografía',
        ]) {
            expect(looksLikeReferenceHeader(text), text).toBe(true);
        }
    });

    it('accepts the ambiguous vocabulary only on detected headings', () => {
        for (const text of ['Notes', 'Notes:', 'Sources', 'Literature', 'Literatur', 'Quellen']) {
            expect(looksLikeReferenceHeader(text, { isHeading: true }), text).toBe(true);
            expect(looksLikeReferenceHeader(text), text).toBe(false);
        }
        // A lone "Reference" is a table column header as often as a section.
        expect(looksLikeReferenceHeader('Reference')).toBe(false);
        expect(looksLikeReferenceHeader('Reference', { isHeading: true })).toBe(true);
        // Singular forms label a single table note or source line, never a section.
        for (const text of ['Note.', 'Note:', 'Source:']) {
            expect(looksLikeReferenceHeader(text, { isHeading: true }), text).toBe(false);
        }
    });

    it('rejects other headings and prose that merely mentions references', () => {
        for (const text of [
            'Introduction',
            'Discussion',
            '3. Data and Methods',
            'References to earlier work are collected in the appendix, where the ' +
                'full bibliography of the project is reproduced for convenience.',
        ]) {
            expect(looksLikeReferenceHeader(text), text).toBe(false);
        }
    });
});

describe('detectParagraphs thresholds', () => {
    function lineResult(): PageLineResult {
        // Three evenly spaced lines in one column: heights 12, gaps 3.
        const lines = [
            makeLine('First line of the paragraph', 50, 300, 100),
            makeLine('Second line of the paragraph', 50, 300, 115),
            makeLine('Third line of the paragraph', 50, 280, 130),
        ];
        return {
            pageIndex: 0,
            width: 400,
            height: 700,
            columnResults: [{ column: { x: 40, y: 90, w: 300, h: 200 }, columnIndex: 0, lines }],
            allLines: lines,
        };
    }

    it('omits thresholds unless they are requested', () => {
        const result = detectParagraphs(lineResult(), STYLE_PROFILE.bodyStyles);
        expect(result.pageThresholds).toBeUndefined();
        expect(result.columnThresholds).toBeUndefined();
    });

    it('echoes the page and column thresholds that drove detection', () => {
        const result = detectParagraphs(
            lineResult(),
            STYLE_PROFILE.bodyStyles,
            {},
            { paragraph: 0, header: 0 },
            { trackItemLines: true, trackThresholds: true },
        );

        expect(result.pageThresholds).toBeDefined();
        expect(result.pageThresholds!.medianHeight).toBe(12);
        expect(result.pageThresholds!.medianGap).toBe(3);
        // binPx = max(2, 0.15 * medianHeight)
        expect(result.pageThresholds!.binPx).toBeCloseTo(2, 5);

        const column = result.columnThresholds![0];
        expect(column).toBeDefined();
        expect(column.leftEdgeMode).toBe(50);
        expect(column.maxRightEdge).toBe(300);
        // Detection is unchanged by the flag.
        expect(result.items.map((item) => item.text)).toEqual(
            detectParagraphs(lineResult(), STYLE_PROFILE.bodyStyles).items.map(
                (item) => item.text,
            ),
        );
    });
});
