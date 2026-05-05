/**
 * Unit tests for the smart-filter overlay collectors.
 *
 * Verifies that columns / lines / paragraphs overlays drop a repeating
 * margin element via the same smart cross-page filter the production
 * sentence pipeline uses, while raw-lines still surfaces that element
 * (its purpose is to expose pre-filter state).
 *
 * Hermetic — synthetic RawPageData, no MuPDF, no Zotero.
 */

import { describe, it, expect } from "vitest";
import {
    getColumnOverlay,
    getLineOverlay,
    getParagraphOverlay,
    getRawLinesOverlay,
} from "../../../react/utils/extractionOverlay";
import {
    type RawBlock,
    type RawLine,
    type RawPageData,
} from "../../../src/services/pdf/types";

const PAGE_W = 612;
const PAGE_H = 792;
const BODY_SIZE = 12;

function makeLine(
    text: string,
    yTop: number,
    xStart = 80,
    size: number = BODY_SIZE,
    fontName: string = "Body",
): RawLine {
    return {
        wmode: 0,
        bbox: { x: xStart, y: yTop, w: text.length * 6, h: size },
        font: {
            name: fontName,
            family: fontName,
            weight: "normal",
            style: "normal",
            size,
        },
        x: xStart,
        y: yTop,
        text,
    };
}

function makePage(pageIndex: number, lines: RawLine[]): RawPageData {
    const blocks: RawBlock[] = lines.length
        ? [
              {
                  type: "text",
                  bbox: {
                      x: Math.min(...lines.map((l) => l.bbox.x)),
                      y: Math.min(...lines.map((l) => l.bbox.y)),
                      w: PAGE_W,
                      h: PAGE_H,
                  },
                  lines,
              },
          ]
        : [];
    return {
        pageIndex,
        pageNumber: pageIndex + 1,
        width: PAGE_W,
        height: PAGE_H,
        blocks,
    };
}

/**
 * 4-page synthetic window where the same short header appears in the
 * top smart-margin zone of every page (will trip smart-removal as a
 * "repeat") plus a body paragraph that varies per page.
 *
 * Header placement matches `FilteredParagraphPipeline.test.ts:141` —
 * y=50, h=8 → outside the simple top margin (40pt) but inside the
 * smart top zone (80pt), so the simple filter keeps it and the smart
 * filter is the one doing the work.
 */
function buildRepeatingHeaderWindow(pageCount: number): RawPageData[] {
    return Array.from({ length: pageCount }, (_, idx) =>
        makePage(idx, [
            {
                wmode: 0,
                bbox: { x: 80, y: 50, w: 200, h: 8 },
                font: {
                    name: "H",
                    family: "H",
                    weight: "normal",
                    style: "normal",
                    size: 8,
                },
                x: 80,
                y: 50,
                text: "Repeating Journal Header",
            },
            makeLine(`Body of page ${idx + 1} goes here.`, 200),
            makeLine("Second line of body text.", 220),
        ]),
    );
}

describe("smart-filter overlays drop cross-page repeat text", () => {
    const pages = buildRepeatingHeaderWindow(4);

    it("getRawLinesOverlay still surfaces the repeating header (pre-filter view)", () => {
        const overlay = getRawLinesOverlay(pages[0]);
        // Header sits at y=50, h=8 → outside the simple top margin (40pt)
        // but inside the wider smart top zone. raw-lines reports the
        // simple-filter classification, so it's `null` (content area)
        // here — but crucially the rect IS present at y=50, unlike in
        // the smart-filtered overlays below. 3 raw lines per page.
        expect(overlay.groupCount).toBe(3);
        expect(overlay.rects.some((r) => r.rect.y === 50)).toBe(true);
    });

    it("getLineOverlay drops the repeating header line", () => {
        const overlay = getLineOverlay(pages, 0);
        // Lines come from `lineResult.allLines` after the smart filter:
        // body text (y≥200) survives, header (y=50) is gone.
        expect(overlay.groupCount).toBeGreaterThan(0);
        expect(overlay.stats.analysisPagesScanned).toBe(4);
        for (const r of overlay.rects) {
            expect(r.rect.y).toBeGreaterThanOrEqual(200);
        }
    });

    it("getParagraphOverlay drops the repeating header and keeps the body", () => {
        const overlay = getParagraphOverlay(pages, 0);
        expect(overlay.groupCount).toBeGreaterThan(0);
        expect(overlay.stats.analysisPagesScanned).toBe(4);
        // Body paragraph survived (one paragraph or one paragraph+header).
        expect(Number(overlay.stats.paragraphs)).toBeGreaterThan(0);
        // No paragraph rect should sit at the header's y=50 row — every
        // paragraph rect's top should be at or below the body region (y≥200).
        for (const r of overlay.rects) {
            expect(r.rect.y).toBeGreaterThanOrEqual(200);
        }
    });

    it("getColumnOverlay reports analysisPagesScanned", () => {
        const overlay = getColumnOverlay(pages, 0);
        expect(overlay.stats.analysisPagesScanned).toBe(4);
    });
});

describe("single-page document edge case", () => {
    it("collectors produce a well-formed result on a single-page window", () => {
        const pages = [
            makePage(0, [
                makeLine("First line of body text.", 200),
                makeLine("Second line of body text.", 220),
            ]),
        ];
        // No cross-page repeats possible; smart filter is a no-op.
        const cols = getColumnOverlay(pages, 0);
        const lines = getLineOverlay(pages, 0);
        const paras = getParagraphOverlay(pages, 0);

        expect(cols.stats.analysisPagesScanned).toBe(1);
        expect(lines.stats.analysisPagesScanned).toBe(1);
        expect(paras.stats.analysisPagesScanned).toBe(1);
        // Body content should still produce at least one rect at each level.
        expect(cols.groupCount).toBeGreaterThan(0);
        expect(lines.groupCount).toBeGreaterThan(0);
        expect(paras.groupCount).toBeGreaterThan(0);
    });
});
