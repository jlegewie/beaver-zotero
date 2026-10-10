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

function page(lines: RawLine[]): RawPageData {
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: 612,
        height: 792,
        blocks: [{ type: "text", bbox: bboxFromXYWH(0, 0, 612, 792, "top-left"), lines }],
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
});
