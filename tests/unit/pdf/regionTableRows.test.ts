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
    /** Gaps wider than a word space inside the line. */
    gaps?: [number, number][];
    /** Type size (default 10). */
    size?: number;
}

function regionLine(bbox: Rect, text: string, gaps?: [number, number][], size = 10): RegionLine {
    const ink = text.replace(/\s/g, "").length;
    return {
        bbox,
        text,
        size,
        rot: 0,
        words: text.split(/\s+/).length,
        nchar: text.length,
        alphaWords: text.split(/\s+/).filter((w) => /^\p{L}{3,}/u.test(w)).length,
        mathChars: 0,
        inkChars: ink,
        minSize: size,
        maxSize: size,
        eqNumber: false,
        source: 0,
        pieces: 1,
        range: [0, text.length],
        ...(gaps ? { gaps } : {}),
    };
}

/** Routes after completion for one table at `box`: "T" for the table, "-" for prose. */
function complete(test: TestLine[], box: Rect, rules: Rect[] = []): string {
    const lines = test.map((l) => regionLine(l.bbox, l.text, l.gaps, l.size));
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
function completeTwo(test: TestLine[], box0: Rect, box1: Rect, rules: Rect[], second: number[], merged?: Map<number, number>): string {
    const lines = test.map((l) => regionLine(l.bbox, l.text, l.gaps));
    const routes = test.map((l, i) => (second.includes(i) ? 1 : l.cell ? 0 : -1));
    const into = completeTableRows(
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
    for (const [k, v] of into) merged?.set(k, v);
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

    describe("tables that rule off each row", () => {
        /** A row at `y` whose label and values are all routed to the table, or all prose. */
        const ruledRow = (y: number, label: string, cell: boolean): TestLine[] =>
            row(y, label).map((l) => ({ ...l, cell }));
        const note: TestLine = { bbox: [72, 176, 400, 186], text: "Values are counts of documents.", running: true };
        const labels = ["Age", "Income", "Sex", "Region", "Tenure"];

        it("routes rows the box missed past the rule under its last row, down to the bottom rule", () => {
            // A rule under every row; the box ends at the third row's rule.
            const rules: Rect[] = [96, 112, 126, 140, 154, 168].map((y): Rect => [70, y, 512, y + 0.5]);
            const lines = [...labels.flatMap((l, k) => ruledRow(100 + 14 * k, l, k < 3)), note, ...text];
            expect(complete(lines, [70, 98, 512, 139], rules)).toBe("T".repeat(15) + "----");
        });

        it("routes them when the rows that show the ruling lie above the box", () => {
            // The box holds the third and fourth rows only: one rule between its rows, until the
            // rows above join.
            const rules: Rect[] = [96, 112, 126, 140, 154, 168].map((y): Rect => [70, y, 512, y + 0.5]);
            const lines = [...labels.flatMap((l, k) => ruledRow(100 + 14 * k, l, k === 2 || k === 3)), note, ...text];
            expect(complete(lines, [70, 126, 512, 153], rules)).toBe("T".repeat(15) + "----");
        });

        it("does not cross the bottom rule of a table ruled only under its header", () => {
            // Booktabs: top, header and bottom rules; a block of rows under a further rule below.
            const rules: Rect[] = [96, 112, 140, 168].map((y): Rect => [70, y, 512, y + 0.5]);
            const lines = [...labels.flatMap((l, k) => ruledRow(100 + 14 * k, l, k < 3)), note, ...text];
            expect(complete(lines, [70, 98, 512, 139], rules)).toBe("T".repeat(9) + "-".repeat(10));
        });

        it("does not take a section heading under the bottom rule into rows past it", () => {
            // Ruled under every row, nothing between the last row and the bottom rule; a heading in
            // two pieces (number and title) set larger below it, and the next table's rule.
            const rules: Rect[] = [96, 112, 126, 140, 172].map((y): Rect => [70, y, 512, y + 0.5]);
            const heading: TestLine[] = [
                { bbox: [72, 148, 90, 160], text: "4.4", size: 12 },
                { bbox: [110, 148, 230, 160], text: "Ablation Study", size: 12 },
            ];
            const lines = [...labels.slice(0, 3).flatMap((l, k) => ruledRow(100 + 14 * k, l, true)), ...heading, ...text];
            expect(complete(lines, [70, 98, 512, 139], rules)).toBe("T".repeat(9) + "-----");
            // The same pieces in the table's type size are a row.
            const row10 = heading.map((l) => ({ ...l, size: 10 }));
            expect(complete([...labels.slice(0, 3).flatMap((l, k) => ruledRow(100 + 14 * k, l, true)), ...row10, ...text], [70, 98, 512, 139], rules)).toBe("T".repeat(11) + "---");
        });

        it("keeps its bottom where it was when no rows follow the rule it crossed", () => {
            // A thick bar under the last row; a line set inside the bar belongs to no row.
            const rules: Rect[] = [96, 112, 126].map((y): Rect => [70, y, 512, y + 0.5]);
            const bar: Rect = [70, 140, 512, 152];
            const inBar: TestLine = { bbox: [72, 142, 300, 150], text: "nique, as well as of our incubation" };
            const lines = [...labels.slice(0, 3).flatMap((l, k) => ruledRow(100 + 14 * k, l, true)), inBar, ...text];
            expect(complete(lines, [70, 98, 512, 139], [...rules, bar])).toBe("T".repeat(9) + "----");
        });
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

    it("returns to its paragraph the last line the box took from the column beside the table", () => {
        const table: TestLine[] = [100, 112, 124, 136, 148].flatMap((y) => [
            { bbox: [60, y, 100, y + 10], text: `${y}`, cell: true },
            { bbox: [120, y, 240, y + 10], text: "Extremely Characteristic", cell: true },
        ]);
        const column: TestLine[] = [
            { bbox: [325, 78, 540, 88], text: "CEO, more so than any other chemical company, has long", running: true },
            { bbox: [325, 88, 540, 98], text: "been run by its board, and the board has in turn always", running: true },
            { bbox: [325, 100, 540, 110], text: "always been managed by a team of executives rather than", running: true },
            { bbox: [325, 110, 540, 120], text: "an autocratic CEO, says John Roberts, analyst at Merrill", running: true },
            { bbox: [325, 120, 420, 130], text: "Lynch (Westervelt, 2000).", cell: true },
            { bbox: [325, 138, 540, 148], text: "CEO Michael Parker notes that the top management team", running: true },
        ];
        expect(complete([...table, ...column], [58, 98, 545, 160])).toBe("T".repeat(10) + "------");
        // A column of running text that ends with the table is the table's: it keeps its lines.
        expect(complete([...table, ...column.slice(2)], [58, 98, 545, 160]).slice(12, 13)).toBe("T");
        // So does a table's own column of running text under the table's rules.
        const ruled: Rect[] = [[56, 96, 545, 96.5], [56, 160, 545, 160.5]];
        expect(complete([...table, ...column], [58, 98, 545, 160], ruled).slice(14, 15)).toBe("T");
        // A caption's sentence running on above a header cell of the table keeps no line.
        const caption: TestLine = { bbox: [20, 66, 540, 78], text: "Table 1 Data sources of Landsat images used", running: true, caption: true };
        const header: TestLine = { bbox: [20, 84, 52, 94], text: "Year Satellite", cell: true };
        expect(complete([caption, header, ...table], [18, 82, 245, 160])).toBe("-T" + "T".repeat(10));
    });

    describe("tables framed by their own rules", () => {
        /** A header row and the rules of a booktabs table: top, under the header, bottom. */
        const header: TestLine[] = [
            { bbox: [72, 104, 120, 114], text: "Theme", cell: true },
            { bbox: [200, 104, 230, 114], text: "Gap", cell: true },
            { bbox: [380, 104, 480, 114], text: "Research questions", cell: true },
        ];
        const rules: Rect[] = [[70, 100, 540, 100.5], [70, 117, 540, 117.5], [70, 220, 540, 220.5]];
        /** A row at `y`: a short label, a three-line cell of running text, a centred two-line one. */
        const textRow = (y: number, cell: boolean): TestLine[] => [
            { bbox: [72, y, 150, y + 10], text: "Circular supply chain", cell },
            ...[0, 1, 2].map((k): TestLine => ({ bbox: [180, y + 12 * k, 340, y + 12 * k + 10], text: "focus on circular supply chain management with", running: true })),
            { bbox: [372, y, 532, y + 10], text: "RQ1 What are the key success factors for", running: true },
            { bbox: [384, y + 12, 519, y + 22], text: "the circular economy transition to work?", running: true },
        ];

        it("routes its running-text cells and the rows its box missed", () => {
            const lines = [...header, ...textRow(122, true), ...textRow(162, false), ...text];
            expect(complete(lines, [70, 102, 540, 133], rules)).toBe("TTT" + "T".repeat(6) + "T".repeat(6) + "---");
        });

        it("leaves the text beside it to the page without a frame or a second column", () => {
            const lines = [...header, ...textRow(122, true), ...textRow(162, false), ...text];
            // Unframed (one rule), the rows the box missed stay prose.
            expect(complete(lines, [70, 102, 540, 133], rules.slice(0, 1)).slice(9)).toBe("-".repeat(9));
            // A framed listing has one column, no grid: its running lines stay prose.
            const listing: TestLine[] = [
                { bbox: [72, 104, 200, 114], text: "tree:", cell: true },
                { bbox: [82, 116, 220, 126], text: "- id: N04", cell: true },
                { bbox: [92, 128, 300, 138], text: "title: three layers that separate the evidence from code", running: true },
                { bbox: [92, 140, 200, 150], text: "type: decision", cell: true },
            ];
            expect(complete([...listing, ...text], [70, 102, 302, 152], [[70, 100, 540, 100.5], [70, 155, 540, 155.5]])).toBe("TT-T---");
        });

        it("ends at its frame: lines its box took from the next text column go back to it", () => {
            const table: TestLine[] = [100, 114, 128, 142].flatMap((y) => [
                { bbox: [40, y, 120, y + 10], text: "Method", cell: true },
                { bbox: [200, y, 240, y + 10], text: "70.2", cell: true },
            ]);
            const frame: Rect[] = [[38, 96, 280, 96.5], [38, 154, 280, 154.5]];
            // The next column: a heading the box took, among paragraph lines.
            const column: TestLine[] = [
                { bbox: [320, 72, 560, 82], text: PROSE, running: true },
                { bbox: [320, 84, 560, 94], text: PROSE, running: true },
                { bbox: [320, 114, 420, 124], text: "Supplementary materials", cell: true },
                { bbox: [320, 140, 560, 150], text: PROSE, running: true },
                { bbox: [320, 152, 560, 162], text: PROSE, running: true },
            ];
            expect(complete([...table, ...column], [38, 98, 560, 152], frame)).toBe("TTTTTTTT-----");
            // Without its own rules the box decides, as before.
            expect(complete([...table, ...column], [38, 98, 560, 152])).toBe("TTTTTTTT--T--");
        });

        it("merges a fragment of the table directly under its rows, not a table past its caption", () => {
            const rows = (y: number, cell: boolean, n = 3): TestLine[] =>
                Array.from({ length: n }, (_, k) => 12 * k).flatMap((d) => [
                    { bbox: [72, y + d, 140, y + d + 10], text: `C57BL/${y + d} mice`, cell },
                    { bbox: [250, y + d, 360, y + d + 10], text: "Shanghai Model Organisms", cell },
                    { bbox: [400, y + d, 440, y + d + 10], text: `SM-${y + d}`, cell },
                ]);
            const ruled: Rect[] = [100, 112, 124, 136, 148, 160, 172, 184].map((y): Rect => [70, y - 2.5, 540, y - 2]);
            // Cut at a ruled row: the lower fragment is the table's.
            const merged = new Map<number, number>();
            const lines = [...rows(100, true), ...rows(136, false), ...text];
            const second = Array.from({ length: 9 }, (_, k) => 9 + k);
            expect(completeTwo(lines, [70, 98, 540, 134], [70, 134, 540, 170], ruled, second, merged)).toBe("T".repeat(18) + "---");
            expect([...merged]).toEqual([[1, 0]]);
            // Cut at a band of its grid (a group header): the band joins too, in its place.
            const band: TestLine = { bbox: [72, 140, 230, 150], text: "Experimental models: Organisms/strains", running: true };
            const lower = Array.from({ length: 9 }, (_, k) => 10 + k);
            const banded = [...rows(100, true), band, ...rows(152, false), ...text];
            expect(completeTwo(banded, [70, 98, 540, 136], [70, 150, 540, 188], ruled, lower, new Map()).slice(0, 19)).toBe("T".repeat(19));
            // A caption between them keeps two tables apart.
            const caption: TestLine = { bbox: [72, 140, 230, 150], text: "Table 2. Organisms and strains", caption: true };
            const tables = [...rows(100, true), caption, ...rows(152, false), ...text];
            expect(completeTwo(tables, [70, 98, 540, 136], [70, 150, 540, 188], ruled, lower, new Map()).slice(9, 19)).toBe("-111111111");
            // As does one set wider than the tables, past the ends of their rules.
            const wide = [...rows(100, true), { ...caption, bbox: [72, 140, 540, 150] as Rect }, ...rows(152, false), ...text];
            const narrow: Rect[] = ruled.map((r): Rect => [r[0], r[1], 445, r[3]]);
            expect(completeTwo(wide, [70, 98, 445, 136], [70, 150, 445, 188], narrow, lower, new Map()).slice(9, 19)).toBe("-111111111");
            const paragraph: TestLine = { bbox: [72, 140, 540, 150], text: "The second table lists the strains bred in house.", running: true };
            const parted = [...rows(100, true), paragraph, ...rows(152, false), ...text];
            expect(completeTwo(parted, [70, 98, 445, 136], [70, 150, 445, 188], narrow, lower, new Map()).slice(9, 19)).toBe("-111111111");
            // A cell of the table's own reaching past its rules is no such line.
            const cell: TestLine = { bbox: [250, 140, 520, 150], text: "G (baking ⇒ F serving)" };
            const reaching = [...rows(100, true), cell, ...rows(152, false), ...text];
            expect(completeTwo(reaching, [70, 98, 445, 136], [70, 150, 445, 188], narrow, lower, new Map()).slice(0, 9)).toBe("T".repeat(9));
            expect(completeTwo(reaching, [70, 98, 445, 136], [70, 150, 445, 188], narrow, lower, new Map()).slice(10, 19)).toBe("T".repeat(9));
            // So does a header the lower table repeats.
            const header = (y: number, cell: boolean): TestLine[] => [
                { bbox: [72, y, 140, y + 10], text: "Strain", cell },
                { bbox: [250, y, 360, y + 10], text: "Source", cell },
                { bbox: [400, y, 440, y + 10], text: "Identifier", cell },
            ];
            const repeated = [...header(88, true), ...rows(100, true), ...header(136, false), ...rows(148, false), ...text];
            const lowerTable = Array.from({ length: 12 }, (_, k) => 12 + k);
            expect(completeTwo(repeated, [70, 86, 540, 134], [70, 134, 540, 182], ruled, lowerTable, new Map()).slice(12, 24)).toBe("1".repeat(12));
            // Or repeats its rows under labels of its own (a wiring diagram over the second table).
            const twoRowHeader = (y: number, cell: boolean): TestLine[] => [
                ...header(y, cell),
                { bbox: [250, y + 10, 360, y + 20], text: "Supplier name", cell },
                { bbox: [400, y + 10, 440, y + 20], text: "Catalog number", cell },
            ];
            const labels: TestLine[] = [
                { bbox: [72, 136, 90, 146], text: "H1", cell: false },
                { bbox: [250, 136, 268, 146], text: "H6", cell: false },
            ];
            const diagram = [...twoRowHeader(78, true), ...rows(100, true), ...labels, ...twoRowHeader(148, false), ...rows(170, false), ...text];
            const lowerDiagram = Array.from({ length: 16 }, (_, k) => 14 + k);
            const ruledDiagram: Rect[] = [100, 112, 124, 136, 170, 182, 194, 206].map((y): Rect => [70, y - 2.5, 540, y - 2]);
            expect(completeTwo(diagram, [70, 76, 540, 134], [70, 134, 540, 204], ruledDiagram, lowerDiagram, new Map()).slice(0, 30)).toBe("T".repeat(14) + "1".repeat(16));
            // One repeated row under a group header of its own is a panel of the same table.
            const panel = [...header(88, true), ...rows(100, true), ...labels, ...header(148, false), ...rows(160, false), ...text];
            const lowerPanel = Array.from({ length: 14 }, (_, k) => 12 + k);
            const ruledPanel: Rect[] = [100, 112, 124, 136, 160, 172, 184, 196].map((y): Rect => [70, y - 2.5, 540, y - 2]);
            expect(new Set(completeTwo(panel, [70, 86, 540, 134], [70, 134, 540, 194], ruledPanel, lowerPanel, new Map()).slice(0, 26)).size).toBe(1);
        });

        it("bounds its grid by its frame, not by a stray line the box took beside it", () => {
            // A ruled table in the left column; the box reaches over the right column, where it
            // took an equation number at the column's edge.
            const table: TestLine[] = [100, 114, 128, 142, 156, 170, 184, 198].flatMap((y) => [
                { bbox: [40, y, 120, y + 10], text: "Coarse Tree", cell: true },
                { bbox: [200, y, 240, y + 10], text: "72.00", cell: true },
            ]);
            const frame: Rect[] = [96, 110, 124, 138, 152, 166, 180, 194, 210].map((y): Rect => [38, y, 280, y + 0.5]);
            const column: TestLine[] = [
                { bbox: [554, 100, 565, 110], text: "(3)", cell: true },
                ...[114, 128, 142, 156].map((y): TestLine => ({ bbox: [312, y, 565, y + 10], text: PROSE, running: true })),
            ];
            expect(complete([...table, ...column], [38, 98, 565, 208], frame).slice(16)).toBe("-----");
            // A fraction bar in the next column, level with one of the table's rules, does not
            // carry the frame across the gutter to the equation over it.
            const equation: TestLine = { bbox: [389, 114, 469, 123], text: "Total signals", cell: true };
            const bar: Rect = [346, 124, 470, 124.5];
            expect(complete([...table, ...column, equation], [38, 98, 565, 208], [...frame, bar]).slice(21)).toBe("-");
        });

        it("returns a list's numbers beyond the frame to the entries they open", () => {
            // A framed table whose box reaches into the reference list beside it.
            const table: TestLine[] = [100, 114, 128, 142].flatMap((y) => [
                { bbox: [40, y, 120, y + 10], text: "Shuhei", cell: true },
                { bbox: [200, y, 270, y + 10], text: "Neurology", cell: true },
            ]);
            const frame: Rect[] = [[38, 96, 280, 96.5], [38, 154, 280, 154.5]];
            const references: TestLine[] = [86, 100, 114, 128, 142, 156].flatMap((y, k) => [
                { bbox: [300, y, 310, y + 10], text: `${15 + k}.`, cell: y >= 100 && y <= 142 },
                { bbox: [320, y, 560, y + 10], text: PROSE, running: true },
            ]);
            expect(complete([...table, ...references], [38, 98, 450, 152], frame)).toBe("T".repeat(8) + "-".repeat(12));
        });

        it("routes cells of two grid columns that one line joins at their gutter", () => {
            // The third row's theme and gap stand on one structured-text line across the gutter.
            const joined: TestLine[] = [
                { bbox: [76, 202, 334, 212], text: "Circular ecosystem architecture Limited exploration of ecosystems", running: true, gaps: [[150, 180]] },
                { bbox: [372, 202, 532, 212], text: "RQ8 How do circular ecosystem architectures", running: true },
                { bbox: [196, 214, 324, 224], text: "and stakeholders' role in supporting", running: true },
            ];
            const lines = [...header, ...textRow(122, true), ...textRow(162, true), ...joined, ...text];
            const frame: Rect[] = [[70, 100, 540, 100.5], [70, 117, 540, 117.5], [70, 240, 540, 240.5]];
            expect(complete(lines, [70, 102, 540, 200], frame).slice(15, 18)).toBe("TTT");
            // Without a gap at the gutter the line spans two columns: no cell of the grid.
            const spanning = joined.map((l) => ({ ...l, gaps: undefined }));
            expect(complete([...header, ...textRow(122, true), ...textRow(162, true), ...spanning, ...text], [70, 102, 540, 200], frame).slice(15, 16)).toBe("-");
        });
    });
});
