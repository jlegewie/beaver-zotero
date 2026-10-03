import { describe, expect, it } from "vitest";

import type { RawLineDetailed, RawPageData } from "@beaver/agent-core/extract/types";

import { findCandidates } from "../../../src/beaver-extract/regions/candidates";
import type { Rect } from "../../../src/beaver-extract/regions/geometry";
import { mergeRowFragments, pageLines, type Primitive } from "../../../src/beaver-extract/regions/pageSignals";
import { runningTextLines } from "../../../src/beaver-extract/regions/textCandidates";

const W = 612;
const H = 792;
const BS = 10;

interface Spec {
    box: Rect;
    text: string;
    size?: number;
    font?: string;
    rotation?: number;
}

/** A page of structured-text lines; each line's characters are spread evenly over its box. */
function page(specs: Spec[]): RawPageData {
    const lines = specs.map((sp): RawLineDetailed => {
        const [x0, y0, x1, y1] = sp.box;
        const chars = [...sp.text];
        const step = (x1 - x0) / Math.max(1, chars.length);
        const size = sp.size ?? BS;
        const font = { name: sp.font ?? "Times-Roman", family: "Times", weight: "normal", style: "normal", size };
        return {
            wmode: 0,
            bbox: { l: x0, t: y0, r: x1, b: y1 },
            font,
            x: x0,
            y: y1,
            text: sp.text,
            rotation: sp.rotation ?? 0,
            chars: chars.map((c, i) => {
                const bbox = { l: x0 + i * step, t: y0, r: x0 + (i + 1) * step, b: y1 };
                return { c, bbox, quad: [bbox.l, bbox.t, bbox.r, bbox.t, bbox.l, bbox.b, bbox.r, bbox.b] };
            }),
            spans: [{ start: 0, font }],
        } as unknown as RawLineDetailed;
    });
    return {
        pageIndex: 0,
        pageNumber: 1,
        width: W,
        height: H,
        blocks: lines.map((l) => ({ type: "text", bbox: l.bbox, lines: [l] })),
    } as unknown as RawPageData;
}

const PROSE = "the quick brown fox jumps over the lazy dog again and again";
const prose = (y: number): Spec => ({ box: [72, y, 540, y + 11], text: PROSE });

/**
 * Places a box laid out upright in a reading frame (H wide and W tall) on the
 * page: upright, or as text reading down (90°) or up (270°).
 */
function place(rot: 0 | 90 | 270, [a0, b0, a1, b1]: Rect): Rect {
    return rot === 0 ? [a0, b0, a1, b1] : rot === 90 ? [W - b1, a0, W - b0, a1] : [b0, H - a1, b1, H - a0];
}

function textGroups(specs: Spec[]) {
    const lines = pageLines(page(specs));
    return findCandidates(lines, [], W, H, BS).candidates.filter((c) => c.source === "text");
}

describe("pageLines", () => {
    it("splits a line at a wide gap and reads math fonts", () => {
        // "x=y+1" then, far to the right, "(12)": one structured-text line.
        const detailed = page([{ box: [150, 100, 250, 112], text: "x=y+1", font: "CMMI10" }]);
        const line = detailed.blocks[0].lines![0] as RawLineDetailed;
        const numberChars = [..."(12)"].map((c, i) => {
            const bbox = { l: 500 + i * 6, t: 100, r: 506 + i * 6, b: 112 };
            return { c, bbox, quad: [bbox.l, bbox.t, bbox.r, bbox.t, bbox.l, bbox.b, bbox.r, bbox.b] as never };
        });
        line.text += " (12)";
        line.chars.push({ c: " ", bbox: { l: 250, t: 100, r: 500, b: 112 }, quad: [] as never }, ...numberChars);
        line.bbox = { l: 150, t: 100, r: 524, b: 112 };
        line.spans!.push({ start: 5, font: { ...line.font, name: "CMR10" } });

        const lines = pageLines(detailed);
        expect(lines.map((l) => l.text)).toEqual(["x=y+1", "(12)"]);
        expect(lines[0].mathChars).toBe(5);
        expect(lines[1].eqNumber).toBe(true);
        expect(lines[1].bbox[0]).toBe(500);
    });
});

describe("mergeRowFragments", () => {
    const WORDS = ["these", "words", "form", "one", "justified", "line"];
    const words = (y: number, xs: number[], w = 30, size?: number): Spec[] =>
        xs.map((x, i) => ({ box: [x, y, x + w, y + 10], text: WORDS[i], size }));

    it("reads a 0-size font's size from the line height", () => {
        const [line] = pageLines(page([{ box: [72, 100, 300, 109], text: "a line of text", size: 0 }]));
        expect(line.size).toBe(9);
    });

    it("joins word pieces and justified rows into lines", () => {
        // Word spacing (3pt) and justified spacing (12pt, even gaps).
        const tight = pageLines(page(words(100, [72, 105, 138, 171])));
        const justified = pageLines(page(words(120, [72, 114, 156, 198, 240])));
        expect(mergeRowFragments(tight, []).map((l) => l.text)).toEqual(["these words form one"]);
        expect(mergeRowFragments(justified, [])).toHaveLength(1);
    });

    it("keeps table cells and pieces across a vertical rule apart", () => {
        const cells = pageLines(page([
            { box: [72, 100, 102, 110], text: "0.01" },
            { box: [150, 100, 180, 110], text: "1.07(8)" },
            { box: [230, 100, 260, 110], text: "1.10(4)" },
        ]));
        expect(mergeRowFragments(cells, [])).toHaveLength(3);
        const ruled = pageLines(page([
            { box: [72, 100, 102, 110], text: "left" },
            { box: [106, 100, 136, 110], text: "right" },
        ]));
        const rule: Primitive = { bbox: [103.5, 95, 104.5, 115], kind: "vrule", rgb: 0, curve: false, stroked: true, rect: false, imageHash: 0 };
        expect(mergeRowFragments(ruled, [])).toHaveLength(1);
        expect(mergeRowFragments(ruled, [rule])).toHaveLength(2);
    });
});

describe("text candidates", () => {
    it("gives each numbered equation its own group", () => {
        const groups = textGroups([
            prose(80),
            { box: [200, 110, 330, 122], text: "a=b+c", font: "CMMI10" },
            { box: [520, 110, 540, 122], text: "(1)" },
            { box: [200, 126, 330, 138], text: "d=e+f", font: "CMMI10" },
            { box: [520, 126, 540, 138], text: "(2)" },
            prose(160),
        ]);
        expect(groups.map((g) => g.bbox.map(Math.round))).toEqual([
            [200, 110, 540, 122],
            [200, 126, 540, 138],
        ]);
    });

    it("splits an unnumbered stack of equations at rows with their own relation", () => {
        const groups = textGroups([
            prose(80),
            { box: [200, 110, 330, 122], text: "b2=x+y", font: "CMMI10" },
            { box: [200, 124, 330, 136], text: "−θ=x−y", font: "CMMI10" },
            { box: [210, 138, 330, 150], text: "=x+2y", font: "CMMI10" }, // continues the row above
            prose(170),
        ]);
        expect(groups.map((g) => [Math.round(g.bbox[1]), Math.round(g.bbox[3])])).toEqual([
            [110, 122],
            [124, 150],
        ]);
    });

    it("keeps prose, and a paragraph's short last line, out of equation groups", () => {
        const specs: Spec[] = [
            prose(80),
            { box: [72, 92, 160, 103], text: "is now given by" },
            { box: [200, 110, 330, 122], text: "a=b+c", font: "CMMI10" },
            prose(130),
        ];
        const lines = pageLines(page(specs));
        const running = runningTextLines(lines, BS);
        expect(lines.filter((l) => running.has(l)).map((l) => l.text)).toEqual([PROSE, "is now given by", PROSE]);
        const groups = textGroups(specs);
        expect(groups).toHaveLength(1);
        expect(groups[0].bbox.map(Math.round)).toEqual([200, 110, 330, 122]);
    });

    it("keeps prose with inline math out of equations by its place in the column", () => {
        const specs: Spec[] = [
            prose(80),
            prose(92),
            // To the right margin from a paragraph indent, with a few words: justified
            // prose, however much math.
            { box: [87, 104, 540, 115], text: "where xi ∈ Rd is the input and yi ∈ R the label", font: "CMMI10" },
            // Centred in the column: a display equation.
            { box: [220, 125, 390, 137], text: "y=Wx+b", font: "CMMI10" },
            // Starts at the margin: a line of words, not part of the equation above.
            { box: [72, 141, 300, 152], text: "where W and b are given by", font: "CMMI10" },
            prose(170),
        ];
        const running = runningTextLines(pageLines(page(specs)), BS);
        expect([...running].map((l) => l.text)).toContain("where xi ∈ Rd is the input and yi ∈ R the label");
        expect([...running].map((l) => l.text)).toContain("where W and b are given by");
        const groups = textGroups(specs);
        expect(groups).toHaveLength(1);
        expect(groups[0].bbox.map(Math.round)).toEqual([220, 125, 390, 137]);
    });

    it("groups a table whose header sits apart from its body", () => {
        const cells: Spec[] = [];
        const cols = [72, 250, 400];
        cols.forEach((x, c) => cells.push({ box: [x, 110, x + 60, 120], text: `Head${c}`, size: 8 }));
        for (let r = 0; r < 4; r++) {
            cols.forEach((x, c) => cells.push({ box: [x, 140 + r * 12, x + 40, 149 + r * 12], text: `${r}.${c}5`, size: 8 }));
        }
        const groups = textGroups([prose(80), ...cells, prose(220)]);
        expect(groups).toHaveLength(1);
        expect(groups[0].bbox.map(Math.round)).toEqual([72, 110, 460, 185]);
    });

    it("keeps each equation number with its equation in rotated text of either direction", () => {
        const upright: [Rect, string, string?][] = [
            [[72, 80, 720, 91], PROSE],
            [[250, 110, 380, 122], "a=b+c", "CMMI10"],
            [[680, 110, 700, 122], "(1)"],
            [[250, 126, 380, 138], "d=e+f", "CMMI10"],
            [[680, 126, 700, 138], "(2)"],
            [[72, 160, 720, 171], PROSE],
        ];
        for (const rot of [90, 270] as const) {
            const groups = textGroups(upright.map(([box, text, font]) => ({ box: place(rot, box), text, font, rotation: rot })));
            const byX = (a: number[], b: number[]) => a[0] - b[0];
            expect(groups.map((g) => g.bbox.map(Math.round)).sort(byX)).toEqual(
                [place(rot, [250, 110, 700, 122]), place(rot, [250, 126, 700, 138])].sort(byX),
            );
        }
    });

    it("groups a regression table whose standard errors look like equation numbers", () => {
        // Coefficients above parenthesized standard errors, with and without a label column.
        for (const cols of [[250, 350, 450], [250]]) {
            const cells: Spec[] = [];
            for (let r = 0; r < 4; r++) {
                const y = 110 + r * 24;
                cells.push({ box: [72, y, 110, y + 9], text: `Var${r}`, size: 8 });
                cols.forEach((x, c) => {
                    cells.push({ box: [x, y, x + 30, y + 9], text: `0.${r}${c}5`, size: 8 });
                    cells.push({ box: [x, y + 11, x + 30, y + 20], text: `(0.1${c})`, size: 8 });
                });
            }
            const groups = textGroups([prose(80), ...cells, prose(220)]);
            expect(groups).toHaveLength(1);
            expect(groups[0].bbox.map(Math.round)).toEqual([72, 110, cols[cols.length - 1] + 30, 202]);
        }
    });

    it("keeps equation numbers beside numbered equations set in a table-like stack", () => {
        const groups = textGroups([
            prose(80),
            { box: [200, 110, 330, 122], text: "a=b+c", font: "CMMI10" },
            { box: [520, 110, 540, 122], text: "(1.1)" },
            { box: [200, 124, 330, 136], text: "d=e+f", font: "CMMI10" },
            { box: [520, 124, 540, 136], text: "(1.2)" },
            prose(160),
        ]);
        expect(groups.map((g) => g.bbox.map(Math.round))).toEqual([
            [200, 110, 540, 122],
            [200, 124, 540, 136],
        ]);
    });

    it("keeps a rotated table's caption out of the table, as upright", () => {
        const layout: [Rect, string, number][] = [[[72, 106, 200, 116], "Table 1. Mean outcomes", 10]];
        const cols = [72, 250, 400];
        cols.forEach((x, c) => layout.push([[x, 120, x + 60, 129], `Head${c}`, 8]));
        for (let r = 0; r < 4; r++) {
            cols.forEach((x, c) => layout.push([[x, 132 + r * 12, x + 40, 141 + r * 12], `${r}.${c}5`, 8]));
        }
        for (const rot of [0, 90, 270] as const) {
            const specs = layout.map(([box, text, size]): Spec => ({ box: place(rot, box), text, size, rotation: rot }));
            const found = findCandidates(pageLines(page(specs)), [], W, H, BS);
            const groups = found.candidates.filter((c) => c.source === "text");
            expect(groups.map((g) => g.bbox.map(Math.round))).toEqual([place(rot, [72, 120, 460, 177])]);
            expect([...found.captionText].map((l) => l.text)).toEqual(["Table 1. Mean outcomes"]);
        }
    });

    it("reports rotated prose as running text, as upright", () => {
        const text = ["alpha", "beta", "gamma", "delta"].map((w) => `${w} ${PROSE}`);
        for (const rot of [0, 90, 270] as const) {
            const specs = text.map((t, i): Spec => ({ box: place(rot, [72, 100 + i * 13, 700, 111 + i * 13]), text: t, rotation: rot }));
            const found = findCandidates(pageLines(page(specs)), [], W, H, BS);
            expect([...found.running].map((l) => l.text).sort()).toEqual([...text].sort());
        }
    });

    it("groups a rotated table in its own frame", () => {
        const cells: Spec[] = [];
        for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 3; c++) {
                const x = 100 + r * 14;
                const y = 200 + c * 120;
                cells.push({ box: [x, y, x + 9, y + 50], text: `v${r}${c}`, size: 8, rotation: 90 });
            }
        }
        const groups = textGroups(cells);
        expect(groups).toHaveLength(1);
        expect(groups[0].rotated).toBe(true);
        expect(groups[0].bbox.map(Math.round)).toEqual([100, 200, 165, 490]);
    });
});

describe("page text", () => {
    const runningTexts = (specs: Spec[]) => {
        const lines = mergeRowFragments(pageLines(page(specs)), []);
        const running = runningTextLines(lines, BS);
        return lines.filter((l) => running.has(l)).map((l) => l.text);
    };
    const NARROW = [
        "the aim of this work is to pro-",
        "duce a comprehensive mapping of",
        "the existing literature comparing",
        "models in generating materials.",
    ];

    it("reads a narrow justified column as running text whatever its type size", () => {
        // Set in 8pt on a 10pt page and only 128pt wide: neither the size nor the
        // width rule sees prose, but both edges line up line after line.
        const specs: Spec[] = NARROW.map((text, i) => ({ box: [72, 100 + i * 10, 200, 108 + i * 10], text, size: 8 }));
        specs.push({ box: [72, 140, 130, 148], text: "and their uses.", size: 8 });
        expect(runningTexts(specs)).toEqual([...NARROW, "and their uses."]);
    });

    it("does not read aligned display equations as a justified paragraph", () => {
        const eqs = ["Loss = MSE + penalty", "Risk = MSE + variance", "Cost = SSE + penalty"];
        const specs: Spec[] = [
            ...[0, 1, 2].map((i): Spec => ({ box: [72, 60 + i * 13, 540, 71 + i * 13], text: PROSE })),
            ...eqs.map((text, i): Spec => ({ box: [200, 120 + i * 14, 330, 132 + i * 14], text, font: "CambriaMath" })),
        ];
        expect(runningTexts(specs)).toEqual([PROSE, PROSE, PROSE]);
        // The same in the text font, where few characters count as math.
        const plain = specs.map((sp) => (sp.font ? { ...sp, font: undefined } : sp));
        expect(runningTexts(plain)).toEqual([PROSE, PROSE, PROSE]);
    });

    it("does not read the justified cells of a text table as paragraphs", () => {
        const left = ["such a dialogue allows us to", "transcend medical boundaries", "in which the patient is not", "merely an object of scrutiny"];
        const right = ["the touch is configured as a", "dialogue mediated by the body", "whose meaning arises in the", "relation between the two of"];
        const specs: Spec[] = [
            ...left.map((text, i): Spec => ({ box: [72, 100 + i * 10, 200, 108 + i * 10], text, size: 8 })),
            ...right.map((text, i): Spec => ({ box: [215, 100 + i * 10, 343, 108 + i * 10], text, size: 8 })),
        ];
        expect(runningTexts(specs)).toEqual([]);
    });

    it("does not read a column of repeated cell values as a paragraph", () => {
        const specs: Spec[] = [0, 1, 2, 3].map((i) => ({ box: [300, 100 + i * 12, 420, 109 + i * 12], text: "Generated PEM Assessment Score", size: 8 }));
        expect(runningTexts(specs)).toEqual([]);
    });

    it("reads a paragraph's short last line as running text beside a table in the next column", () => {
        const specs: Spec[] = [
            { box: [72, 100, 290, 111], text: PROSE },
            { box: [72, 113, 290, 124], text: PROSE },
            { box: [72, 126, 150, 137], text: "chose preparation time." },
            // Table cells in the other column, on the last line's row.
            { box: [330, 127, 380, 136], text: "Deviation", size: 8 },
            { box: [420, 127, 450, 136], text: "Mean", size: 8 },
        ];
        expect(runningTexts(specs)).toEqual([PROSE, PROSE, "chose preparation time."]);
    });

    it("keeps a table's column of descriptions out of running text, but not prose beside a table", () => {
        // Labels with descriptions on their rows: one description is long enough to read
        // as prose, and the short ones start at its left edge.
        const table: Spec[] = [
            { box: [72, 100, 150, 110], text: "python_tool", size: 9 },
            { box: [200, 100, 540, 110], text: "Generates and deploys useful code for the whole tool chain" },
            { box: [72, 112, 150, 122], text: "reader_tool", size: 9 },
            { box: [200, 113, 400, 122], text: "Reads and returns file contents" },
            { box: [72, 124, 150, 134], text: "plotter_tool", size: 9 },
            { box: [200, 125, 380, 134], text: "Plots useful output data" },
        ];
        const tableRunning = runningTexts(table);
        expect(tableRunning).not.toContain("Reads and returns file contents");
        expect(tableRunning).not.toContain("Plots useful output data");

        // A cell to the right within the column blocks a line whether or not it shares
        // its line exactly (header cells in fonts with different boxes).
        const header: Spec[] = [
            { box: [72, 100, 540, 111], text: PROSE },
            { box: [72, 113, 160, 124], text: "Generalized Example Workflow", size: 9 },
            { box: [250, 116, 330, 127], text: "Description", size: 9 },
        ];
        expect(runningTexts(header)).toEqual([PROSE]);

        // A table in the left column; the right column's paragraph ends on a row that
        // overlaps a label without sharing its line.
        const beside: Spec[] = [
            { box: [72, 104, 150, 113], text: "Petrochemical based", size: 8 },
            { box: [72, 116, 150, 125], text: "Biological based", size: 8 },
            { box: [320, 90, 540, 101], text: PROSE },
            { box: [320, 103, 540, 114], text: PROSE },
            { box: [320, 116, 460, 127], text: "carbon source of the polymer." },
        ];
        expect(runningTexts(beside)).toContain("carbon source of the polymer.");
    });

    it("keeps row labels out of running text when the label above reads as prose", () => {
        const LONG = "Gatorade Original Fierce Organic Flow Zero Frost";
        // Tight rows at body size; numbers sit on every label's line.
        const row = (y: number, text: string, values = true): Spec[] => [
            { box: [72, y, 72 + 5 * text.length, y + 10], text },
            ...(values ? [{ box: [400, y, 420, y + 10], text: "0.46" }, { box: [480, y, 492, y + 10], text: "12" }] : []),
        ];
        const labels = runningTexts([...row(100, LONG), ...row(112, "Infuse Thirst Quencher")]);
        expect(labels).toEqual([LONG]);
        // A label read as prose without values of its own (a group row) still does not
        // turn the label below it, which has values, into running text.
        const group = runningTexts([...row(100, LONG, false), ...row(112, "Infuse Thirst Quencher")]);
        expect(group).toEqual([LONG]);
    });

    it("reads a paragraph's last word as running text beside a manuscript line number", () => {
        const specs: Spec[] = [
            { box: [72, 100, 290, 111], text: PROSE },
            { box: [72, 113, 290, 124], text: PROSE },
            { box: [72, 126, 100, 137], text: "time." },
            // Line numbers in the right margin, in the body font, on each line's baseline.
            ...[0, 1, 2].map((i): Spec => ({ box: [520, 100 + i * 13, 532, 111 + i * 13], text: `${10 + i}` })),
        ];
        expect(runningTexts(specs)).toContain("time.");
    });

    it("keeps the last line of a wrapped cell in its table when its label sits beside it", () => {
        const LONG = "Electrification of transport and power grids requires massive volumes of copper";
        const specs: Spec[] = [
            { box: [187, 100, 540, 110], text: LONG },
            { box: [187, 112, 260, 122], text: "and rare earths" },
            // The row label, centred on the two-line cell, in the cells' type size.
            { box: [65, 105, 140, 118], text: "Energy Transition" },
        ];
        expect(runningTexts(specs)).toEqual([LONG]);
    });

    it("reads only a line set apart in type as a paragraph's heading", () => {
        const para = [0, 1, 2].map((i): Spec => ({ box: [72, 104 + i * 13, 290, 115 + i * 13], text: PROSE }));
        // In the paragraph's own type: a table's group label over its cells, not a heading.
        expect(runningTexts([{ box: [72, 91, 140, 102], text: "Mastectomy" }, ...para])).not.toContain("Mastectomy");
        expect(runningTexts([{ box: [72, 91, 140, 102], text: "Mastectomy", font: "Times-Bold" }, ...para])).toContain("Mastectomy");
        // A display equation over its explanation, in a math font, is no heading.
        expect(runningTexts([{ box: [72, 91, 160, 102], text: "Luser = a(b + c)", font: "CambriaMath" }, ...para])).not.toContain(
            "Luser = a(b + c)",
        );
    });

    it("reads a heading over a paragraph as part of the text column, apart from a table beside it", () => {
        const specs: Spec[] = [
            { box: [72, 88, 150, 101], text: "2. OBJECTIVE", size: 12 },
            ...[0, 1, 2].map((i): Spec => ({ box: [72, 104 + i * 13, 290, 115 + i * 13], text: PROSE })),
        ];
        // A table to the right, its header on the heading's row.
        const cols = [330, 420, 500];
        cols.forEach((x, c) => specs.push({ box: [x, 91, x + 40, 100], text: ["Variable", "Theme", "Example"][c], size: 8 }));
        for (let r = 0; r < 4; r++) cols.forEach((x, c) => specs.push({ box: [x, 104 + r * 12, x + 30, 113 + r * 12], text: `${r}.${c}5`, size: 8 }));
        expect(runningTexts(specs)).toContain("2. OBJECTIVE");
        const groups = textGroups(specs);
        expect(groups).toHaveLength(1);
        expect(groups[0].bbox.map(Math.round)).toEqual([330, 91, 540, 149]);
    });

    it("keeps the rows of a table set tight under its caption out of the caption", () => {
        const specs: Spec[] = [
            { box: [330, 100, 480, 110], text: "Table 2 CFA results and indexes", size: 8 },
            { box: [330, 112, 370, 122], text: "Variables", size: 8 },
            { box: [400, 112, 440, 122], text: "Alpha", size: 8 },
            { box: [460, 112, 475, 122], text: "CR", size: 8 },
            { box: [330, 124, 345, 134], text: "BI", size: 8 },
            { box: [400, 124, 425, 134], text: "0.944", size: 8 },
            { box: [460, 124, 485, 134], text: "0.983", size: 8 },
        ];
        const found = findCandidates(pageLines(page(specs)), [], W, H, BS);
        expect([...found.captionText].map((l) => l.text)).toEqual(["Table 2 CFA results and indexes"]);

        // A caption line broken into pieces by inline math is still caption text.
        const inline: Spec[] = [
            { box: [55, 100, 400, 108], text: "FIG. 1. Sample reconstructions of the first mode", size: 7 },
            { box: [55, 110, 300, 118], text: "of the sample image, and the ratio", size: 7 },
            { box: [303, 109, 320, 119], text: "σ1/σi", size: 7 },
            { box: [324, 110, 400, 118], text: "displayed corresponds to", size: 7 },
        ];
        const caption = findCandidates(pageLines(page(inline)), [], W, H, BS).captionText;
        expect([...caption].map((l) => l.text).sort()).toEqual(inline.map((sp) => sp.text).sort());
    });

    it("never counts the page's own text font as math, whatever its name", () => {
        const specs: Spec[] = [
            ...[0, 1, 2].map((i): Spec => ({ box: [72, 100 + i * 13, 540, 111 + i * 13], text: PROSE, font: "STIX-Regular" })),
            { box: [200, 150, 300, 162], text: "x=y+z", font: "STIXMath" },
        ];
        const lines = pageLines(page(specs));
        expect(lines.map((l) => l.mathChars)).toEqual([0, 0, 0, 5]);
        // Equations are not prose, however wordy their variable names.
        const equations = pageLines(page(["Loss = MSE + variance + penalty", "Risk = MSE + variance + bias"].map(
            (text, i): Spec => ({ box: [150, 100 + i * 14, 400, 112 + i * 14], text, font: "CambriaMath" }),
        )));
        expect(equations.every((l) => l.mathChars === l.inkChars)).toBe(true);
        // Without text of its own on the page, the same font reads as math.
        expect(pageLines(page([{ box: [72, 100, 100, 111], text: "a+b", font: "STIX-Regular" }]))[0].mathChars).toBe(3);
    });

    it("reports the font setting most of a line, summed over its runs", () => {
        // Regular, the longest single span in bold, regular again: regular sets more characters overall.
        const p = page([{ box: [72, 100, 540, 111], text: "plain text BOLDEMPHASISXYZW then more text" }]);
        const line = p.blocks[0].lines![0] as RawLineDetailed;
        const font = (name: string) => ({ name, family: "Times", weight: "normal", style: "normal", size: BS });
        line.spans = [
            { start: 0, font: font("Times-Roman") },
            { start: 11, font: font("Times-Bold") },
            { start: 28, font: font("Times-Roman") },
        ];
        expect(pageLines(p).map((l) => l.font)).toEqual(["Times-Roman"]);
    });

    it("flags text set at an angle by its characters drifting across the line", () => {
        const p = page([
            { box: [126, 87, 553, 695], text: "UNCORRECTED PROOF", size: 59 },
            { box: [72, 100, 540, 111], text: PROSE, size: 0.24 }, // a font scaled by the text matrix
            { box: [72, 120, 300, 131], text: "a superscript at the end¹²" },
        ]);
        // The watermark's characters climb the page diagonally.
        const mark = p.blocks[0].lines![0] as RawLineDetailed;
        mark.chars.forEach((ch, i) => {
            const x = 126 + i * 24;
            const y = 640 - i * 32;
            ch.bbox = { l: x, t: y, r: x + 55, b: y + 55 } as never;
        });
        const sup = p.blocks[2].lines![0] as RawLineDetailed;
        for (const ch of sup.chars.slice(-2)) ch.bbox = { ...ch.bbox, t: 117, b: 124 } as never;
        const lines = pageLines(p);
        expect(lines[0].skewed).toBe(true);
        expect(lines.slice(1).filter((l) => l.skewed)).toEqual([]);
    });

    it("does not read a stacked delimiter or a fraction set as one line as angled text", () => {
        const p = page([
            { box: [300, 100, 310, 150], text: "⎛⎜⎜⎝)" }, // bracket pieces stacked straight down
            { box: [200, 200, 260, 230], text: "a+b=cd" }, // numerator "a+b", then "=", then denominator "cd"
        ]);
        const bracket = p.blocks[0].lines![0] as RawLineDetailed;
        bracket.chars.forEach((ch, i) => (ch.bbox = { l: 300, t: 100 + i * 10, r: 310, b: 110 + i * 10 } as never));
        const fraction = p.blocks[1].lines![0] as RawLineDetailed;
        const levels = [200, 200, 200, 210, 220, 220];
        fraction.chars.forEach((ch, i) => (ch.bbox = { l: 200 + i * 10, t: levels[i], r: 210 + i * 10, b: levels[i] + 10 } as never));
        expect(pageLines(p).filter((l) => l.skewed)).toEqual([]);
    });
});

describe("paragraph pieces next to display equations", () => {
    const running = (specs: Spec[]) => {
        const lines = pageLines(page(specs));
        const set = runningTextLines(lines, BS);
        return lines.filter((l) => set.has(l)).map((l) => l.text);
    };
    const column = (y: number, n: number, text = PROSE): Spec[] =>
        Array.from({ length: n }, (_, i): Spec => ({ box: [72, y + i * 13, 290, y + 11 + i * 13], text }));

    it("reads a sentence's last words without letters, stacked under its paragraph, as running text", () => {
        const tail: Spec = { box: [72, 139, 110, 150], text: "[84, 85]." };
        const equation: Spec = { box: [140, 168, 220, 180], text: "a=b+c", font: "CMMI10" };
        const specs = [...column(100, 3), tail, equation];
        expect(running(specs)).toContain("[84, 85].");
        const groups = textGroups(specs);
        expect(groups).toHaveLength(1);
        expect(groups[0].bbox.map(Math.round)).toEqual([140, 168, 220, 180]);
        // After a finished sentence, a lone citation is not that sentence's end.
        expect(running([...column(100, 2), { box: [72, 126, 290, 137], text: `${PROSE} ends.` }, tail, equation])).not.toContain(
            "[84, 85].",
        );
        // Nor is anything set apart from the paragraph.
        expect(running([...column(100, 3), { ...tail, box: [72, 145, 110, 156] }, equation])).not.toContain("[84, 85].");
    });

    it("reads inline math a word space from a prose line's words, on its row, as running text", () => {
        const specs: Spec[] = [
            ...column(100, 2),
            { box: [72, 126, 96, 137], text: "with n" },
            { box: [100, 124, 120, 139], text: "= R/|R|", font: "CMMI10" },
            { box: [124, 126, 290, 137], text: "and d the electric dipole operator of atom i." },
        ];
        expect(running(specs)).toEqual([PROSE, PROSE, "with n", "= R/|R|", "and d the electric dipole operator of atom i."]);
        // Set further off, the math is a display beside the text, not part of its line.
        const apart = specs.map((s) => (s.text === "= R/|R|" ? { ...s, box: [100, 124, 112, 139] as Rect } : s));
        apart[2] = { ...apart[2], box: [72, 126, 90, 137] };
        expect(running(apart)).not.toContain("= R/|R|");
    });

    it("does not read an equation's math as inline math of words beside it", () => {
        const words: Spec = { box: [72, 200, 250, 211], text: PROSE };
        // A flush-left equation whose first piece reads as words: its relation marks it.
        const equation: Spec[] = [
            { box: [72, 200, 250, 211], text: "General Recidivism Risk Score = age∗−w" },
            { box: [253, 200, 273, 211], text: "(xi)+", font: "CMMI10" },
        ];
        expect(running(equation)).not.toContain("(xi)+");
        // A fraction's numerator stacked over the end of a lead-in line.
        expect(running([words, { box: [240, 203, 280, 213], text: "ξk+1 − ξk", font: "CMMI10" }])).not.toContain("ξk+1 − ξk");
        // Set much larger than the words beside it: a banner or display, not inline.
        expect(running([words, { box: [253, 190, 400, 220], text: "~l·il·¥11-----", size: 22 }])).not.toContain("~l·il·¥11-----");
        // Math joins only directly beside words, not through other math; words after it do.
        const math: Spec = { box: [253, 200, 263, 211], text: "x²", font: "CMMI10" };
        const more: Spec = { box: [266, 200, 300, 211], text: "+ (a+b)", font: "CMMI10" };
        const tail: Spec = { box: [266, 200, 330, 211], text: "and so on" };
        expect(running([words, math, more])).toEqual([PROSE, "x²"]);
        expect(running([words, math, tail])).toEqual([PROSE, "x²", "and so on"]);
    });

    it("reads a line that inline math splits into pieces as a whole", () => {
        // A paragraph's indented first line, split by inline math, over its paragraph.
        const split: Spec[] = [
            { box: [87, 100, 200, 111], text: "Let us denote by |a⟩, |b⟩", font: "CMMI10" },
            { box: [204, 100, 290, 111], text: "the eigenstates of a single" },
            ...column(113, 2),
        ];
        expect(running(split)).toContain("Let us denote by |a⟩, |b⟩");
        // A paragraph's last line, split by inline math: its pieces are not each other's row-mates.
        const last: Spec[] = [
            ...column(100, 2),
            { box: [72, 126, 140, 137], text: "amplitude spectrum" },
            { box: [143, 126, 160, 137], text: "x̂(f)", font: "CMMI10" },
            { box: [163, 126, 300, 137], text: "and the phase spectrum, as" },
            { box: [200, 160, 260, 172], text: "x̂(f) = |x̂(f)|", font: "CMMI10" },
        ];
        expect(running(last)).toEqual(expect.arrayContaining(["amplitude spectrum", "and the phase spectrum, as"]));
        // An equation's pieces span the column too, but hold no run of words.
        const equation: Spec[] = [
            { box: [72, 100, 140, 111], text: "VBEC = MRb", font: "CMMI10" },
            { box: [144, 100, 290, 111], text: "(ω2 − Ω2) r2 + MRb zz2, (1)", font: "CMMI10" },
            ...column(122, 2),
        ];
        expect(running(equation)).toEqual([PROSE, PROSE]);
        // Nor do function names beside an equation's relation make a run of words.
        const names: Spec[] = [
            { box: [87, 100, 200, 111], text: "Π = cosh γ + sinh γ T = exp" },
            { box: [204, 100, 290, 111], text: "(γ T) (2.36)", font: "CMMI10" },
            ...column(122, 2),
        ];
        expect(running(names)).toEqual([PROSE, PROSE]);
        // A display equation whose words are function names, starting where a paragraph
        // does elsewhere: its own trailing piece still keeps it off the margin rule.
        const display: Spec[] = [
            { box: [207, 100, 540, 111], text: PROSE },
            { box: [207, 150, 403, 161], text: "Π = cosh γ + sinh γ T = exp (γ T)" },
            { box: [406, 150, 409, 161], text: "." },
        ];
        expect(running(display)).toEqual([PROSE]);
    });

    it("reads a heading beside an equation in the other column as part of its own column", () => {
        const right = (y: number, x0 = 320): Spec => ({ box: [x0, y, 540, y + 11], text: PROSE });
        const specs: Spec[] = [
            ...column(80, 3),
            { box: [120, 136, 200, 152], text: "I = a + b", font: "CMMI10" },
            { box: [104, 140, 116, 150], text: "{", font: "CMEX10" },
            ...column(170, 3),
            { box: [320, 128, 500, 139], text: "B. Step 2: Transfer Learning by Using a", font: "Times-Bold" },
            { box: [320, 141, 400, 152], text: "Pre-Trained Network", font: "Times-Bold" },
            right(155, 330),
            right(168),
            right(181),
        ];
        expect(running(specs)).toContain("Pre-Trained Network");
        // Words beside it, where a text column runs too, are a cell of its row: a text table.
        const cells = specs.map((s) => (s.text === "I = a + b" ? { ...s, text: "Treatment group", font: undefined } : s));
        expect(running(cells)).not.toContain("Pre-Trained Network");
        // Without a text column through its row, an equation beside the line still counts.
        const alone = specs.filter((s) => s.box[0] !== 72 || s.text !== PROSE);
        expect(running(alone)).not.toContain("Pre-Trained Network");
    });
});
