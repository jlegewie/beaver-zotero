import { describe, expect, it } from "vitest";

import type { Rect } from "../../../src/beaver-extract/regions/geometry";
import type { RegionLine } from "../../../src/beaver-extract/regions/pageSignals";
import { completeTableRows } from "../../../src/beaver-extract/regions/tableRows";

const PROSE = "the quick brown fox jumps over the lazy dog again and again";

interface TestLine {
    bbox: Rect;
    text: string;
    running?: boolean;
    caption?: boolean;
    /** Routed to the table (index 0) before completion. */
    cell?: boolean;
}

function regionLine(bbox: Rect, text: string): RegionLine {
    const ink = text.replace(/\s/g, "").length;
    return {
        bbox,
        text,
        size: 10,
        rot: 0,
        words: text.split(/\s+/).length,
        nchar: text.length,
        alphaWords: text.split(/\s+/).filter((w) => /^\p{L}{3,}/u.test(w)).length,
        mathChars: 0,
        inkChars: ink,
        minSize: 10,
        maxSize: 10,
        eqNumber: false,
        source: 0,
        pieces: 1,
        range: [0, text.length],
    };
}

/** Routes after completion for one table at `box`: "T" for the table, "-" for prose. */
function complete(test: TestLine[], box: Rect, rules: Rect[] = []): string {
    const lines = test.map((l) => regionLine(l.bbox, l.text));
    const routes = test.map((l) => (l.cell ? 0 : -1));
    completeTableRows(
        {
            lines,
            running: test.map((l) => !!l.running),
            caption: test.map((l) => !!l.caption),
            tables: [{ index: 0, bbox: box }],
            rules,
        },
        routes,
    );
    return routes.map((r) => (r === 0 ? "T" : "-")).join("");
}

/** Routes after completion for two tables: lines at `second` start in table 1. */
function completeTwo(test: TestLine[], box0: Rect, box1: Rect, rules: Rect[], second: number[]): string {
    const lines = test.map((l) => regionLine(l.bbox, l.text));
    const routes = test.map((l, i) => (second.includes(i) ? 1 : l.cell ? 0 : -1));
    completeTableRows(
        {
            lines,
            running: test.map((l) => !!l.running),
            caption: test.map((l) => !!l.caption),
            tables: [
                { index: 0, bbox: box0 },
                { index: 1, bbox: box1 },
            ],
            rules,
        },
        routes,
    );
    return routes.map((r) => (r === 0 ? "T" : r === 1 ? "1" : "-")).join("");
}

/** Prose of the page, below the tables: it sets how wide a paragraph line is. */
const text: TestLine[] = [300, 312, 324].map((y) => ({ bbox: [72, y, 540, y + 10], text: PROSE, running: true }));

/** A table row at `y`: a label at x=72 and two values. */
function row(y: number, label: string, opts: Partial<TestLine> = {}): TestLine[] {
    return [
        { bbox: [72, y, 72 + 6 * label.length, y + 10], text: label, cell: true, ...opts },
        { bbox: [400, y, 430, y + 10], text: "0.12", cell: true },
        { bbox: [480, y, 510, y + 10], text: "0.34", cell: true },
    ];
}

describe("completeTableRows", () => {
    it("routes a long row label read as running text to the table its values are in", () => {
        const lines = [
            ...row(100, "Age"),
            ...row(114, "Volume of stumps at early decay stages", { cell: false, running: true }),
            ...row(128, "Income"),
            ...text,
        ];
        expect(complete(lines, [70, 98, 512, 140])).toBe("TTTTTTTTT---");
    });

    it("routes a short group header between rows, but not a paragraph between them", () => {
        const header: TestLine = { bbox: [72, 114, 250, 124], text: "Employment status of the respondent", running: true };
        expect(complete([...row(100, "Age"), header, ...row(128, "Income"), ...text], [70, 98, 512, 140])).toBe("TTTTTTT---");

        const paragraph: TestLine[] = [114, 126, 138].map((y) => ({ bbox: [72, y, 300, y + 10], text: "a note set between the rows", running: true }));
        expect(complete([...row(100, "Age"), ...paragraph, ...row(152, "Income")], [70, 98, 512, 164])).toBe("TTT---TTT");
    });

    it("keeps prose of the neighbouring column in prose when the box reaches over it", () => {
        // A table in the left column; its box reaches into the right column, whose
        // paragraph runs above and below the table at the same line pitch.
        const table: TestLine[] = [100, 114, 128].flatMap((y) => [
            { bbox: [40, y, 120, y + 10], text: "Label", cell: true },
            { bbox: [200, y, 240, y + 10], text: "1.23", cell: true },
        ]);
        const column: TestLine[] = [72, 86, 100, 114, 128, 142, 156].map((y) => ({ bbox: [320, y, 560, y + 10], text: PROSE, running: true }));
        expect(complete([...table, ...column], [38, 98, 560, 140])).toBe("TTTTTT-------");
    });

    it("routes a label column left of the box when the table's rules span it", () => {
        // The labels sit under the caption at its line spacing, so they read as its
        // continuation; the table's rules, drawn as one segment per column, cover them.
        const caption: TestLine = { bbox: [72, 86, 280, 96], text: "Table 1. Searching and filtering", caption: true };
        const labels: TestLine[] = [98, 110, 122].map((y, k) => ({ bbox: [72, y, 160, y + 10], text: `Filter step ${k}`, caption: true }));
        const values: TestLine[] = [98, 110, 122].flatMap((y) => [
            { bbox: [350, y, 380, y + 10], text: "407", cell: true },
            { bbox: [470, y, 490, y + 10], text: "120", cell: true },
        ]);
        const rules: Rect[] = [
            [72, 97, 312, 97.5],
            [312, 97, 522, 97.5],
            [72, 133, 312, 133.5],
            [312, 133, 522, 133.5],
        ];
        const lines = [caption, ...labels, ...values];
        expect(complete(lines, [348, 96, 522, 134], rules)).toBe("-TTTTTTTTT");
        expect(complete(lines, [348, 96, 522, 134])).toBe("----TTTTTT");
    });

    it("routes rows below the box down to the table's next rule and stops at a note", () => {
        const rules: Rect[] = [[72, 96, 522, 96.5], [72, 160, 522, 160.5]];
        const missed: TestLine[] = [
            { bbox: [72, 126, 160, 136], text: "Total documents", caption: true },
            { bbox: [410, 126, 430, 136], text: "100" },
            { bbox: [72, 140, 400, 150], text: "Values are counts of documents.", running: true },
        ];
        expect(complete([...row(100, "Initial"), ...row(112, "Social"), ...missed], [70, 98, 512, 124], rules)).toBe("TTTTTTTT-");
    });

    it("keeps a caption set beside the table's rows in prose", () => {
        const caption: TestLine[] = [
            { bbox: [20, 100, 60, 110], text: "Table 2 Help-seeking", caption: true },
            { bbox: [20, 112, 60, 122], text: "attitudes and", caption: true },
            { bbox: [20, 124, 60, 134], text: "intention", caption: true },
        ];
        const table: TestLine[] = [100, 112, 124].flatMap((y) => [
            { bbox: [80, y, 200, y + 10], text: "Attitudes", cell: true },
            { bbox: [300, y, 340, y + 10], text: ".30", cell: true },
        ]);
        expect(complete([...caption, ...table], [18, 98, 342, 136])).toBe("---TTTTTT");
    });

    it("keeps a side caption out of rows routed below the box", () => {
        // The table's top and bottom rules span its side caption; the box misses its last row.
        const caption: TestLine[] = [
            { bbox: [20, 100, 60, 110], text: "Table 2 Help-seeking", caption: true },
            { bbox: [20, 112, 60, 122], text: "attitudes and", caption: true },
            { bbox: [20, 124, 60, 134], text: "intention", caption: true },
        ];
        const table: TestLine[] = [100, 112, 124].flatMap((y) => [
            { bbox: [80, y, 200, y + 10], text: "Attitudes", cell: y < 124 },
            { bbox: [300, y, 340, y + 10], text: ".30", cell: y < 124 },
        ]);
        const rules: Rect[] = [[18, 97, 342, 97.5], [18, 137, 342, 137.5]];
        expect(complete([...caption, ...table], [78, 98, 342, 124], rules).slice(0, 3)).toBe("---");
    });

    it("keeps a ragged paragraph beside the table in prose under a page-wide rule", () => {
        // The paragraph's lines sit on the table's rows; a rule over both columns must not
        // widen the table over them.
        const table: TestLine[] = [100, 114, 128].flatMap((y) => [
            { bbox: [40, y, 120, y + 10], text: "Label", cell: true },
            { bbox: [200, y, 240, y + 10], text: "1.23", cell: true },
        ]);
        const beside: TestLine[] = [
            { bbox: [320, 100, 540, 110], text: PROSE, running: true },
            { bbox: [320, 114, 520, 124], text: PROSE, running: true },
            { bbox: [320, 128, 500, 138], text: PROSE, running: true },
        ];
        const rules: Rect[] = [[30, 96, 560, 96.5]];
        expect(complete([...table, ...beside], [38, 98, 242, 140], rules)).toBe("TTTTTT---");
    });

    it("keeps a ragged paragraph in prose when the box reaches over it", () => {
        const table: TestLine[] = [100, 114, 128].flatMap((y) => [
            { bbox: [40, y, 120, y + 10], text: "Label", cell: true },
            { bbox: [200, y, 240, y + 10], text: "1.23", cell: true },
        ]);
        const beside: TestLine[] = [
            { bbox: [320, 100, 540, 110], text: PROSE, running: true },
            { bbox: [320, 114, 520, 124], text: PROSE, running: true },
            { bbox: [320, 128, 500, 138], text: PROSE, running: true },
        ];
        expect(complete([...table, ...beside], [38, 98, 560, 140])).toBe("TTTTTT---");
    });

    it("keeps a ragged side caption and a tall watermark line out of the table", () => {
        const caption: TestLine[] = [
            { bbox: [20, 100, 60, 110], text: "Table 2 Help-seeking", caption: true },
            { bbox: [25, 112, 60, 122], text: "attitudes and", caption: true },
            { bbox: [30, 124, 60, 134], text: "intention", caption: true },
        ];
        const watermark: TestLine = { bbox: [72, 60, 300, 270], text: "UNCORRECTED PROOF" };
        const table: TestLine[] = [100, 112, 124].flatMap((y) => [
            { bbox: [80, y, 200, y + 10], text: "Attitudes", cell: true },
            { bbox: [300, y, 340, y + 10], text: ".30", cell: true },
        ]);
        expect(complete([...caption, watermark, ...table], [18, 98, 342, 136])).toBe("----TTTTTT");
    });

    it("keeps a caption above the table out of rows routed above the box", () => {
        // A rule above the caption; the caption's second line is split by an inline equation.
        const caption: TestLine[] = [
            { bbox: [72, 70, 400, 80], text: "Table 1 Estimates of the model", caption: true },
            { bbox: [72, 82, 200, 92], text: "with the constraint", caption: true },
            { bbox: [240, 82, 300, 92], text: "x = 1", caption: true },
        ];
        const rules: Rect[] = [[70, 66, 512, 66.5], [70, 96, 512, 96.5]];
        expect(complete([...caption, ...row(100, "Age"), ...row(112, "Income"), ...row(124, "Sex")], [70, 98, 512, 136], rules)).toBe("---TTTTTTTTT");
    });

    it("keeps the opening of a paragraph below the table out of rows routed below the box", () => {
        // The paragraph's first line is split by inline math; a rule follows the paragraph.
        const opening: TestLine[] = [
            { bbox: [72, 150, 300, 160], text: "the model is estimated with", running: true },
            { bbox: [310, 150, 360, 160], text: "x = 1" },
        ];
        const rest: TestLine[] = [162, 174].map((y) => ({ bbox: [72, y, 540, y + 10], text: PROSE, running: true }));
        const rules: Rect[] = [[70, 96, 512, 96.5], [70, 190, 512, 190.5]];
        const lines = [...row(100, "Age"), ...row(112, "Income"), ...row(124, "Sex"), ...opening, ...rest, ...text];
        expect(complete(lines, [70, 98, 512, 136], rules)).toBe("TTTTTTTTT-------");
    });

    it("keeps a side caption starting above the first row in prose", () => {
        const caption: TestLine[] = [
            { bbox: [20, 86, 60, 96], text: "Table 2 Help-seeking", caption: true },
            { bbox: [20, 100, 60, 110], text: "attitudes and", caption: true },
            { bbox: [20, 114, 60, 124], text: "intention", caption: true },
        ];
        const table: TestLine[] = [100, 114, 128].flatMap((y) => [
            { bbox: [80, y, 200, y + 10], text: "Attitudes", cell: true },
            { bbox: [300, y, 340, y + 10], text: ".30", cell: true },
        ]);
        expect(complete([...caption, ...table], [18, 98, 342, 140])).toBe("---TTTTTT");
    });

    it("leaves a row whose values belong to another table to that table", () => {
        // Two ruled tables stacked; the lower table's label sits between the upper table's
        // cells and its next rule.
        const upper = row(100, "Age");
        const lower: TestLine[] = [
            { bbox: [72, 140, 300, 150], text: "Volume of stumps at early decay stages", running: true },
            { bbox: [400, 140, 430, 150], text: "0.12" },
            { bbox: [480, 140, 510, 150], text: "0.34" },
        ];
        const rules: Rect[] = [[70, 96, 512, 96.5], [70, 160, 512, 160.5]];
        const lines = [...upper, ...row(112, "Income"), ...lower, ...text];
        // The lower table's values (lines 7 and 8) are routed to a second table.
        expect(completeTwo(lines, [70, 98, 512, 124], [395, 138, 512, 152], rules, [7, 8])).toBe("TTTTTT-11---");
    });

    it("takes a row whole: a caption's inline math stays with its caption", () => {
        // Extending upward, the math fragment (its box a little lower) is visited before
        // the caption text on its row.
        const caption: TestLine[] = [
            { bbox: [72, 70, 400, 80], text: "Table 1 Estimates of the model", caption: true },
            { bbox: [72, 82, 200, 92], text: "with the constraint", caption: true },
            { bbox: [240, 83, 300, 93], text: "x = 1" },
        ];
        const rules: Rect[] = [[70, 66, 512, 66.5], [70, 96, 512, 96.5]];
        expect(complete([...caption, ...row(100, "Age"), ...row(112, "Income"), ...row(124, "Sex"), ...text], [70, 98, 512, 136], rules)).toBe(
            "---TTTTTTTTT---",
        );
    });

    it("keeps a sentence split by inline math below the table in prose", () => {
        const sentence: TestLine[] = [
            { bbox: [72, 140, 250, 150], text: "The model is estimated subject to", running: true },
            { bbox: [253, 140, 290, 150], text: "x = 1" },
        ];
        const rules: Rect[] = [[70, 96, 512, 96.5], [70, 137, 512, 137.5], [70, 172, 512, 172.5]];
        expect(complete([...row(100, "Age"), ...row(112, "Income"), ...row(124, "Sex"), ...sentence, ...text], [70, 98, 512, 136], rules)).toBe(
            "TTTTTTTTT-----",
        );
    });

    it("keeps the short last line of a two-line paragraph beside the box in prose", () => {
        const table: TestLine[] = [100, 114, 128].flatMap((y) => [
            { bbox: [40, y, 120, y + 10], text: "Label", cell: true },
            { bbox: [200, y, 240, y + 10], text: "1.23", cell: true },
        ]);
        const paragraph: TestLine[] = [
            { bbox: [332, 114, 540, 124], text: PROSE, running: true },
            { bbox: [320, 128, 400, 138], text: "and again.", running: true },
        ];
        const column: TestLine[] = [300, 312].map((y) => ({ bbox: [320, y, 540, y + 10], text: PROSE, running: true }));
        expect(complete([...table, ...paragraph, ...column], [38, 98, 560, 140])).toBe("TTTTTT----");
    });

    it("does not cross the table's bottom rule into a note split by inline math", () => {
        // Bottom border right under the last row; a note in two fragments; a page rule below.
        const note: TestLine[] = [
            { bbox: [72, 142, 250, 152], text: "Standard errors in parentheses." },
            { bbox: [300, 142, 400, 152], text: "95% CI in brackets" },
        ];
        const rules: Rect[] = [[70, 96, 512, 96.5], [70, 135, 512, 135.5], [70, 160, 512, 160.5]];
        expect(complete([...row(100, "Age"), ...row(112, "Income"), ...row(124, "Sex"), ...note, ...text], [70, 98, 512, 136], rules)).toBe(
            "TTTTTTTTT-----",
        );
    });

    it("does not cross the bottom rule into a note whose fragments line up with columns", () => {
        // Both fragments start exactly at a column's left edge, as header cells would.
        const note: TestLine[] = [
            { bbox: [72, 142, 250, 152], text: "Standard errors in parentheses." },
            { bbox: [400, 142, 480, 152], text: "95% CI in brackets" },
        ];
        const rules: Rect[] = [[70, 96, 512, 96.5], [70, 135, 512, 135.5], [70, 160, 512, 160.5]];
        expect(complete([...row(100, "Age"), ...row(112, "Income"), ...row(124, "Sex"), ...note, ...text], [70, 98, 512, 136], rules)).toBe(
            "TTTTTTTTT-----",
        );
    });

    it("routes a header row above the box past the rule that separates it", () => {
        const header: TestLine[] = [
            { bbox: [72, 84, 110, 94], text: "Variable" },
            { bbox: [398, 84, 432, 94], text: "Mean" },
            { bbox: [478, 84, 512, 94], text: "SD" },
        ];
        const rules: Rect[] = [[70, 80, 512, 80.5], [70, 97, 512, 97.5]];
        expect(complete([...header, ...row(100, "Age"), ...row(112, "Income"), ...row(124, "Sex"), ...text], [70, 98, 512, 136], rules)).toBe(
            "TTTTTTTTTTTT---",
        );
    });

    it("leaves a label column to the table whose cells are nearer on its rows", () => {
        // Two side-by-side tables; the left table's box reaches over the right table's labels.
        const left: TestLine[] = [100, 114, 128].flatMap((y) => [
            { bbox: [40, y, 90, y + 10], text: "Label", cell: true },
            { bbox: [120, y, 150, y + 10], text: "1.23", cell: true },
        ]);
        const labels: TestLine[] = [100, 114, 128].map((y) => ({ bbox: [300, y, 480, y + 10], text: "Volume of stumps at early decay stages", running: true }));
        const values: TestLine[] = [100, 114, 128].map((y) => ({ bbox: [500, y, 530, y + 10], text: "0.12" }));
        const lines = [...left, ...labels, ...values, ...text];
        // The labels stay in prose rather than join the wrong table (the right table's box
        // does not reach them).
        expect(completeTwo(lines, [38, 98, 490, 140], [495, 98, 535, 140], [], [9, 10, 11])).toBe("TTTTTT---111---");
    });

    it("does not widen a table to a page-wide rule over the other column's prose", () => {
        const table: TestLine[] = [100, 114, 128].flatMap((y) => [
            { bbox: [72, y, 120, y + 10], text: "Label", cell: true },
            { bbox: [200, y, 240, y + 10], text: "1.23", cell: true },
        ]);
        const column: TestLine[] = [86, 100, 114, 128, 142].map((y) => ({ bbox: [320, y, 560, y + 10], text: PROSE, running: true }));
        const rules: Rect[] = [[40, 141, 580, 141.5]];
        expect(complete([...table, ...column], [70, 98, 242, 140], rules)).toBe("TTTTTT-----");
    });
});
