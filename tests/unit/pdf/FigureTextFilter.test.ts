/**
 * Unit tests for FigureTextFilter — covers the layout shapes the
 * detector is meant to recognize.
 *
 * The detector is dormant: it produces detection metadata
 * (`candidates`, `figurePage`) only. These tests assert what the
 * detector classifies — they do not assert that anything is removed
 * from the input column set, since detection is non-invasive.
 * Pipeline-level non-invasiveness is covered in
 * `FilteredParagraphPipeline.test.ts`.
 */

import { describe, it, expect } from "vitest";
import type { Rect } from "../../../src/services/pdf/ColumnDetector";
import { detectFigureTextColumns } from "../../../src/services/pdf/FigureTextFilter";
import {
    bboxFromXYWH,
    type RawBlock,
    type RawLine,
    type RawPageData,
} from "../../../src/services/pdf/types";

const PAGE_W = 612;
const PAGE_H = 792;
const CONTENT_W = PAGE_W - 50; // mirrors DEFAULT_MARGINS.left + .right

function line(text: string, bbox: { x: number; y: number; w: number; h: number }): RawLine {
    const lineBBox = bboxFromXYWH(bbox.x, bbox.y, bbox.w, bbox.h, "top-left");
    return {
        wmode: 0,
        bbox: lineBBox,
        font: { name: "Body", family: "Body", weight: "normal", style: "normal", size: 10 },
        x: bbox.x,
        y: bbox.y,
        text,
    };
}

function page(lines: RawLine[]): RawPageData {
    const blocks: RawBlock[] = lines.length
        ? [
              {
                  type: "text",
                  bbox: bboxFromXYWH(0, 0, PAGE_W, PAGE_H, "top-left"),
                  lines,
              },
          ]
        : [];
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: PAGE_W,
        height: PAGE_H,
        blocks,
    };
}

/** Build a column rect that snugly encloses the supplied lines. */
function colFromLines(ls: RawLine[]): Rect {
    const x0 = Math.min(...ls.map((l) => l.bbox.l));
    const y0 = Math.min(...ls.map((l) => l.bbox.t));
    const x1 = Math.max(...ls.map((l) => l.bbox.r));
    const y1 = Math.max(...ls.map((l) => l.bbox.b));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

describe("FigureTextFilter (detection-only)", () => {
    it("flags rotated 'Transmittance' label on a figure-heavy page", () => {
        // 1 wide caption + 4 tiny tick columns + 1 rotated label.
        const captionLines = [
            line("Fig. S3. ATR spectra of the used MnO2 (A), CeMn (B) and SnCeMn (C) catalysts.",
                { x: 80, y: 100, w: 450, h: 12 }),
        ];
        const tick1 = [line("4000", { x: 90, y: 300, w: 22, h: 8 })];
        const tick2 = [line("3000", { x: 140, y: 300, w: 22, h: 8 })];
        const tick3 = [line("2000", { x: 190, y: 300, w: 22, h: 8 })];
        const tick4 = [line("1000", { x: 240, y: 300, w: 22, h: 8 })];
        const transmittance = [line("Transmittance", { x: 60, y: 200, w: 13, h: 80 })];

        const lines = [...captionLines, ...tick1, ...tick2, ...tick3, ...tick4, ...transmittance];
        const cols: Rect[] = [
            colFromLines(captionLines),
            colFromLines(tick1),
            colFromLines(tick2),
            colFromLines(tick3),
            colFromLines(tick4),
            colFromLines(transmittance),
        ];

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(result.figurePage).toBe(true);
        expect(result.candidates).not.toContain(cols[0]); // caption preserved
        expect(result.candidates).toContain(cols[1]); // tick rows
        expect(result.candidates).toContain(cols[2]);
        expect(result.candidates).toContain(cols[3]);
        expect(result.candidates).toContain(cols[4]);
        expect(result.candidates).toContain(cols[5]); // rotated label
        expect(["rotated", "tiny_cluster"]).toContain(result.reasons.get(cols[5]));
        expect(result.reasons.get(cols[1])).toBe("tiny_cluster");
    });

    it("flags a wide rotated label as 'rotated'", () => {
        const rotatedLine = line("Number of Genes", { x: 80, y: 200, w: 13, h: 80 });
        const rotated = [rotatedLine];
        const ticks = [
            [line("0", { x: 90, y: 300, w: 6, h: 8 })],
            [line("1", { x: 140, y: 300, w: 6, h: 8 })],
            [line("2", { x: 190, y: 300, w: 6, h: 8 })],
        ];
        const lines = [...rotated, ...ticks.flat()];
        const cols = [colFromLines(rotated), ...ticks.map(colFromLines)];

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);
        expect(result.figurePage).toBe(true);
        expect(result.candidates).toContain(cols[0]);
    });

    it("does NOT flag a single rotated label when the page is not figure-heavy", () => {
        // 2 body columns + 1 rotated label — precondition fails.
        const body1 = [
            line(
                "This is a normal paragraph of body text. It contains several sentences.",
                { x: 60, y: 100, w: 240, h: 12 },
            ),
            line(
                "It continues across multiple lines with regular prose content here.",
                { x: 60, y: 116, w: 240, h: 12 },
            ),
        ];
        const body2 = [
            line(
                "A second column of body text sits next to the first one on this page.",
                { x: 320, y: 100, w: 240, h: 12 },
            ),
        ];
        const rotated = [line("Sidebar", { x: 30, y: 100, w: 12, h: 60 })];

        const lines = [...body1, ...body2, ...rotated];
        const cols = [colFromLines(body1), colFromLines(body2), colFromLines(rotated)];

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(result.figurePage).toBe(false);
        expect(result.candidates).toHaveLength(0);
    });

    it("flags a cluster of numeric tick rows", () => {
        const ticks = [
            [line("0.05", { x: 90, y: 300, w: 22, h: 8 })],
            [line("0.10", { x: 140, y: 300, w: 22, h: 8 })],
            [line("0.15", { x: 190, y: 300, w: 22, h: 8 })],
            [line("0.20", { x: 240, y: 300, w: 22, h: 8 })],
            [line("0.25", { x: 290, y: 300, w: 22, h: 8 })],
        ];
        const lines = ticks.flat();
        const cols = ticks.map(colFromLines);

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(result.figurePage).toBe(true);
        expect(result.candidates).toHaveLength(5);
    });

    it("does NOT flag a single tiny column on a body page", () => {
        const body = [
            line(
                "An ordinary paragraph of body text sits in the main column of the page.",
                { x: 60, y: 100, w: 360, h: 12 },
            ),
            line(
                "Wrapping to a second line so the column is clearly tall body content here.",
                { x: 60, y: 116, w: 360, h: 12 },
            ),
        ];
        const tiny = [line("3.14", { x: 480, y: 100, w: 22, h: 8 })];

        const lines = [...body, ...tiny];
        const cols = [colFromLines(body), colFromLines(tiny)];

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(result.figurePage).toBe(false);
        expect(result.candidates).toHaveLength(0);
    });

    it("preserves a figure caption (not flagged) on a figure-heavy page", () => {
        const captionLines = [line("Fig. 3:", { x: 80, y: 100, w: 60, h: 10 })];
        const ticks = [
            [line("1", { x: 90, y: 300, w: 6, h: 8 })],
            [line("2", { x: 140, y: 300, w: 6, h: 8 })],
            [line("3", { x: 190, y: 300, w: 6, h: 8 })],
            [line("4", { x: 240, y: 300, w: 6, h: 8 })],
        ];

        const lines = [...captionLines, ...ticks.flat()];
        const cols = [colFromLines(captionLines), ...ticks.map(colFromLines)];

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(result.figurePage).toBe(true);
        expect(result.candidates).not.toContain(cols[0]);
    });

    it("preserves a multi-word title-case panel title (not flagged)", () => {
        const titleLines = [line("Dehejia Wahba Sample", { x: 200, y: 100, w: 110, h: 12 })];
        const ticks = [
            [line("0", { x: 90, y: 300, w: 6, h: 8 })],
            [line("0.05", { x: 140, y: 300, w: 22, h: 8 })],
            [line("0.10", { x: 190, y: 300, w: 22, h: 8 })],
            [line("0.15", { x: 240, y: 300, w: 22, h: 8 })],
        ];

        const lines = [...titleLines, ...ticks.flat()];
        const cols = [colFromLines(titleLines), ...ticks.map(colFromLines)];

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(result.figurePage).toBe(true);
        expect(result.candidates).not.toContain(cols[0]);
    });

    it("flags a lowercase multi-word tick group", () => {
        const overlayLine = [line("no overlay with overlay", { x: 200, y: 320, w: 100, h: 8 })];
        const ticks = [
            [line("1", { x: 90, y: 300, w: 6, h: 8 })],
            [line("2", { x: 140, y: 300, w: 6, h: 8 })],
            [line("3", { x: 190, y: 300, w: 6, h: 8 })],
        ];

        const lines = [...overlayLine, ...ticks.flat()];
        const cols = [colFromLines(overlayLine), ...ticks.map(colFromLines)];

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(result.figurePage).toBe(true);
        expect(result.candidates).toContain(cols[0]);
    });

    it("preserves a narrow column ending in a sentence terminator", () => {
        const sentenceLine = [
            line("This explains the experimental setup briefly.", {
                x: 200,
                y: 100,
                w: 180,
                h: 10,
            }),
        ];
        const ticks = [
            [line("0", { x: 90, y: 300, w: 6, h: 8 })],
            [line("1", { x: 140, y: 300, w: 6, h: 8 })],
            [line("2", { x: 190, y: 300, w: 6, h: 8 })],
        ];

        const lines = [...sentenceLine, ...ticks.flat()];
        const cols = [colFromLines(sentenceLine), ...ticks.map(colFromLines)];

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(result.figurePage).toBe(true);
        expect(result.candidates).not.toContain(cols[0]);
    });

    it("does not treat '(P = 0.51)' as a sentence end", () => {
        const pValueLine = [line("(P = 0.51)", { x: 200, y: 320, w: 50, h: 8 })];
        const ticks = [
            [line("1", { x: 90, y: 300, w: 6, h: 8 })],
            [line("2", { x: 140, y: 300, w: 6, h: 8 })],
            [line("3", { x: 190, y: 300, w: 6, h: 8 })],
        ];

        const lines = [...pValueLine, ...ticks.flat()];
        const cols = [colFromLines(pValueLine), ...ticks.map(colFromLines)];

        const result = detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(result.figurePage).toBe(true);
        expect(result.candidates).toContain(cols[0]);
    });

    it("returns empty result for an empty column list", () => {
        const result = detectFigureTextColumns([], page([]), CONTENT_W);
        expect(result.candidates).toHaveLength(0);
        expect(result.figurePage).toBe(false);
    });

    it("does not mutate the input column array", () => {
        // Detection must be a pure read of the column list.
        const ticks = [
            [line("0", { x: 90, y: 300, w: 6, h: 8 })],
            [line("0.05", { x: 140, y: 300, w: 22, h: 8 })],
            [line("0.10", { x: 190, y: 300, w: 22, h: 8 })],
            [line("0.15", { x: 240, y: 300, w: 22, h: 8 })],
        ];
        const lines = ticks.flat();
        const cols = ticks.map(colFromLines);
        const before = cols.slice();

        detectFigureTextColumns(cols, page(lines), CONTENT_W);

        expect(cols).toEqual(before);
        expect(cols).toHaveLength(4);
    });
});
