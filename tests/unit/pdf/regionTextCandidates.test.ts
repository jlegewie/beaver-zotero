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
