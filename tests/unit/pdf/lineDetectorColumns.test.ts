/**
 * Line detection when column boxes overlap: each raw line is read in one
 * column only (`LineDetectionOptions.exclusiveColumns`, PDF schema 5).
 */

import { describe, expect, it } from "vitest";

import type { Rect } from "../../../src/beaver-extract/ColumnDetector";
import { detectLinesOnPage } from "../../../src/beaver-extract/LineDetector";
import { bboxFromXYWH, type RawLine, type RawPageData } from "@beaver/agent-core/extract/types";

function line(text: string, x: number, y: number, w: number, h = 9, size = 9): RawLine {
    return {
        wmode: 0,
        bbox: bboxFromXYWH(x, y, w, h, "top-left"),
        font: { name: "Times-Roman", family: "Times-Roman", weight: "normal", style: "normal", size },
        x,
        y,
        text,
    };
}

/** A page of one MuPDF block per argument. */
function page(...blocks: RawLine[][]): RawPageData {
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: 612,
        height: 792,
        blocks: blocks.map((lines) => ({ type: "text" as const, bbox: bboxFromXYWH(0, 0, 612, 792, "top-left"), lines })),
    };
}

const rect = (x: number, y: number, r: number, b: number): Rect => ({ x, y, w: r - x, h: b - y });

/** Each column's line texts. */
function columnTexts(raw: RawPageData, columns: Rect[], exclusiveColumns: boolean): string[][] {
    return detectLinesOnPage(raw, columns, { exclusiveColumns }).columnResults.map((c) => c.lines.map((l) => l.text));
}

describe("detectLinesOnPage with overlapping columns", () => {
    // Two boxes drawn from MuPDF blocks that straddle a row share that row.
    const straddling = page([
        line("first row of the abstract", 100, 100, 300),
        line("second row of the abstract", 100, 112, 300),
        line("third row read in both boxes", 100, 124, 300),
        line("fourth row of the abstract", 100, 136, 300),
    ]);
    const straddlingColumns = [rect(100, 100, 400, 133), rect(100, 124, 400, 145)];

    it("reads a line inside two boxes in both without the switch", () => {
        const texts = columnTexts(straddling, straddlingColumns, false);
        expect(texts.flat().filter((t) => t.startsWith("third row"))).toHaveLength(2);
    });

    it("reads a line inside two boxes once, in the larger box", () => {
        expect(columnTexts(straddling, straddlingColumns, true)).toEqual([
            ["first row of the abstract", "second row of the abstract", "third row read in both boxes"],
            ["fourth row of the abstract"],
        ]);
    });

    it("keeps a superscript cut out of a paragraph's row in the paragraph", () => {
        const raw = page([
            line("34 Cambon, Rapport sur la Loi du 1", 70, 675, 245, 9),
            line("er", 315, 672.5, 8, 6, 6),
            line("juillet 1885 et sur les Règlements", 323, 675, 200, 9),
        ]);
        const columns = [rect(312, 672.5, 324, 680), rect(70, 675, 523, 684)];
        expect(columnTexts(raw, columns, true)).toEqual([
            [],
            ["34 Cambon, Rapport sur la Loi du 1 er juillet 1885 et sur les Règlements"],
        ]);
    });

    it("keeps the middle of a justified row in the row's column", () => {
        // MuPDF split "30-dB" out of its row with justified word spaces wider
        // than half an em; its own box sits inside the paragraph's.
        const raw = page([
            line("noise has a", 54, 230, 60),
            line("30-dB", 125, 230, 30),
            line("decade slope", 166, 230, 80),
            line("next row of the paragraph", 54, 242, 192),
        ]);
        const columns = [rect(54, 230, 246, 251), rect(125, 230, 155, 239)];
        expect(columnTexts(raw, columns, true)).toEqual([["noise has a 30-dB decade slope", "next row of the paragraph"], []]);
    });

    it("keeps the middles of several justified rows in their rows' column", () => {
        const raw = page([
            line("noise has a", 54, 230, 60),
            line("30-dB", 125, 230, 30),
            line("decade slope", 166, 230, 80),
            line("and the", 54, 242, 60),
            line("40-dB", 125, 242, 30),
            line("band is flat", 166, 242, 80),
        ]);
        const columns = [rect(54, 230, 246, 251), rect(125, 230, 155, 251)];
        expect(columnTexts(raw, columns, true)).toEqual([
            ["noise has a 30-dB decade slope", "and the 40-dB band is flat"],
            [],
        ]);
    });

    it("gives a table column its own box though one row's cells sit close", () => {
        // Cells 10pt (1.1 em) apart on the first row, 27pt (3 em) on the others.
        const raw = page([
            line("Study", 54, 230, 60),
            line("Sample", 124, 230, 40),
            line("Result", 174, 230, 60),
            line("Smith et al.", 54, 242, 60),
            line("n = 14", 141, 242, 23),
            line("improved", 191, 242, 43),
            line("Jones (2010)", 54, 254, 60),
            line("n = 20", 141, 254, 23),
            line("no change", 191, 254, 43),
        ]);
        const columns = [rect(54, 230, 234, 263), rect(124, 230, 164, 263)];
        expect(columnTexts(raw, columns, true)).toEqual([
            ["Study Result", "Smith et al. improved", "Jones (2010) no change"],
            ["Sample", "n = 14", "n = 20"],
        ]);
    });

    it("gives a one-row figure label far from the text on both sides its own box", () => {
        const raw = page(
            [line("for ex-", 54, 230, 40), line("ample the", 240, 230, 60), line("next row of the paragraph", 54, 242, 246)],
            [line("W1 b1 W2 b2", 140, 230, 50, 6, 6)],
        );
        const columns = [rect(54, 230, 300, 251), rect(140, 230, 190, 236)];
        expect(columnTexts(raw, columns, true)).toEqual([["for ex- ample the", "next row of the paragraph"], ["W1 b1 W2 b2"]]);
        // A small image elsewhere on the page does not tie the label to the text.
        raw.blocks.splice(1, 0, { type: "image", bbox: bboxFromXYWH(400, 600, 8, 7, "top-left") });
        expect(columnTexts(raw, columns, true)).toEqual([["for ex- ample the", "next row of the paragraph"], ["W1 b1 W2 b2"]]);
    });

    it("keeps a piece of a row cut out by inline math in the row's column", () => {
        // MuPDF left out a formula on both sides of "to the output"; the
        // paragraph's next row, in the same block, runs under both gaps.
        const raw = page([
            line("the transfer function from", 54, 230, 110),
            line("to the output", 190, 230, 55),
            line("should be linear", 280, 230, 70),
            line("in the range of interest, as the next row of the paragraph shows", 54, 242, 296),
        ]);
        const columns = [rect(54, 230, 350, 251), rect(190, 230, 245, 239)];
        expect(columnTexts(raw, columns, true)).toEqual([
            ["the transfer function from to the output should be linear", "in the range of interest, as the next row of the paragraph shows"],
            [],
        ]);
    });

    it("reads a paragraph MuPDF split at inline formula images as one block", () => {
        // MuPDF ends a text block at each inline image; the paragraph's
        // blocks still bridge the fragment's gaps.
        const image = (x: number, y: number, w = 8, h = 7) => ({ type: "image" as const, bbox: bboxFromXYWH(x, y, w, h, "top-left") });
        const [before, fragment, after] = page([line("the transfer function from", 54, 230, 110)], [line("to the output", 190, 230, 55)], [
            line("should be linear", 280, 230, 70),
            line("in the range of interest, as the next row of the paragraph shows", 54, 242, 296),
        ]).blocks;
        const columns = [rect(54, 230, 350, 251), rect(190, 230, 245, 239)];
        const fragmentColumn = (first: RawPageData["blocks"][number], second: RawPageData["blocks"][number]) => {
            const raw = page();
            raw.blocks = [before, first, fragment, second, after];
            return columnTexts(raw, columns, true)[1];
        };
        expect(fragmentColumn(image(170, 231), image(249, 231))).toEqual([]);
        // Small images elsewhere on the page, or a figure, separate them.
        expect(fragmentColumn(image(400, 500), image(400, 520))).toEqual(["to the output"]);
        expect(fragmentColumn(image(170, 231), image(100, 400, 200, 120))).toEqual(["to the output"]);
    });

    it("gives a one-row heading beside the next column its own box", () => {
        const raw = page([
            line("Introduction", 73, 270, 51),
            line("right column text row one", 315, 270, 245),
            line("right column text row two", 315, 282, 245),
        ]);
        const columns = [rect(73, 270, 124, 279), rect(73, 270, 560, 291)];
        expect(columnTexts(raw, columns, true)).toEqual([
            ["Introduction"],
            ["right column text row one", "right column text row two"],
        ]);
    });

    it("gives a real column under a box spanning the page its own lines", () => {
        const raw = page([
            line("left column text row one", 54, 230, 248),
            line("right column text row one", 315, 230, 245),
            line("left column text row two", 54, 242, 248),
            line("right column text row two", 315, 242, 245),
        ]);
        const columns = [rect(54, 230, 560, 251), rect(315, 230, 560, 251)];
        expect(columnTexts(raw, columns, true)).toEqual([
            ["left column text row one", "left column text row two"],
            ["right column text row one", "right column text row two"],
        ]);
    });

    it("reads a line inside two separate boxes once under a low overlap threshold", () => {
        // Each box holds 40% of the line, enough for both at this threshold.
        const raw = page([line("a line spanning two separate boxes", 0, 100, 100)]);
        const columns = [rect(0, 100, 40, 109), rect(60, 100, 100, 109)];
        const result = detectLinesOnPage(raw, columns, { exclusiveColumns: true, minColumnOverlap: 0.4 });
        expect(result.allLines.map((l) => l.text)).toEqual(["a line spanning two separate boxes"]);
    });
});
