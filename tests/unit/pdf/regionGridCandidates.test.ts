import { describe, expect, it } from "vitest";

import type { RawLineDetailed, RawPageData } from "@beaver/agent-core/extract/types";

import { findCandidates } from "../../../src/beaver-extract/regions/candidates";
import {
    EMPTY_DOC_CONTEXT,
    GRID_FEATURES,
    REGION_FEATURES,
    REGION_GRID_FEATURES,
    REGION_GRID_FEATURE_VERSION,
    candidateFeatures,
    gridFeatures,
} from "../../../src/beaver-extract/regions/features";
import type { Rect } from "../../../src/beaver-extract/regions/geometry";
import { gridGroups, rowStructure } from "../../../src/beaver-extract/regions/gridCandidates";
import { assertCompatible, readsGridFeatures, type RegionModelWeights } from "../../../src/beaver-extract/regions/model";
import { mergeRowFragments, pageLines, sourceLines } from "../../../src/beaver-extract/regions/pageSignals";
import { LINE_RUNNING, detectRegions, routeLines, type DetectedRegion } from "../../../src/beaver-extract/regions/RegionDetector";
import { GRAPHICS_SUMMARY_STRIDE, type GraphicsSummary } from "../../../src/beaver-extract/worker/graphicsSummary";

const W = 612;
const H = 792;
const BS = 10;
const LINE = 11;
const PITCH = 13;

type Spec = { box: Rect; text: string };

/**
 * A page of structured-text lines; each line's characters are spread evenly over its box.
 * `turned`: the page set upside down (each box turned about the page's centre, text
 * reading right to left).
 */
function page(specs: Spec[], turned = false): RawPageData {
    const lines = specs.map((sp): RawLineDetailed => {
        const [x0, y0, x1, y1] = turned ? ([W - sp.box[2], H - sp.box[3], W - sp.box[0], H - sp.box[1]] as Rect) : sp.box;
        const chars = [...sp.text];
        const step = (x1 - x0) / Math.max(1, chars.length);
        const font = { name: "Times-Roman", family: "Times", weight: "normal", style: "normal", size: BS };
        return {
            wmode: 0,
            bbox: { l: x0, t: y0, r: x1, b: y1 },
            font,
            x: x0,
            y: y1,
            text: sp.text,
            rotation: turned ? 180 : 0,
            chars: chars.map((c, i) => {
                const l = turned ? x1 - (i + 1) * step : x0 + i * step;
                const bbox = { l, t: y0, r: l + step, b: y1 };
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

const EMPTY_GRAPHICS: GraphicsSummary = {
    area: [0, 0, W, H],
    seen: { fillPath: 0, strokePath: 0, image: 0, imageMask: 0, shade: 0 },
    count: 0,
    records: new Float32Array(GRAPHICS_SUMMARY_STRIDE * 0),
    overflow: false,
    incomplete: false,
    grid: null,
    gridSize: 0,
};

const SENTENCES = [
    "the program examines how students relate social problems to food systems",
    "critically introduces keywords and concepts used throughout the course work",
    "explores causes and consequences of problems evident in the food system",
    "students begin projects by identifying a social problem of interest here",
    "considers the roles of scholarship in social change and in transformation",
    "engages key concepts in the philosophy of science and in critical inquiry",
];
/** Ragged right edges of wrapped cell lines. */
const RAGGED = [528, 497, 515, 471, 509, 489];

/** A paragraph of justified prose lines over [x0, x1] from `y`. */
function prose(x0: number, x1: number, y: number, n: number): Spec[] {
    return Array.from({ length: n }, (_, i) => ({
        box: [x0, y + i * PITCH, x1, y + i * PITCH + LINE] as Rect,
        text: SENTENCES[i % SENTENCES.length],
    }));
}

/**
 * A two-column table of short labels beside definitions wrapping over two or three
 * lines, from `y`, with the label column at [x0, ...] and definitions at [dx, ...].
 */
function definitions(x0: number, dx: number, right: number, y: number, rows: number): { specs: Spec[]; bottom: number } {
    const specs: Spec[] = [];
    for (let r = 0; r < rows; r++) {
        specs.push({ box: [x0, y, x0 + 60, y + LINE], text: ["Food inquiry", "Core concepts", "Food policy", "Capstone one", "Social change", "Food theory"][r % 6] });
        const wraps = 2 + (r % 2);
        for (let k = 0; k < wraps; k++) {
            const end = Math.min(right, dx + (RAGGED[(r + k) % RAGGED.length] - 180) * ((right - dx) / 360));
            specs.push({ box: [dx, y, end, y + LINE], text: SENTENCES[(r + k) % SENTENCES.length] });
            y += PITCH;
        }
        y += 4;
    }
    return { specs, bottom: y };
}

function grids(specs: Spec[]) {
    const lines = pageLines(page(specs));
    return findCandidates(lines, [], W, H, BS, { grid: true }).candidates.filter((c) => c.source === "grid");
}

describe("grid candidates", () => {
    it("proposes a table of labels beside wrapped definitions of running text, only when asked", () => {
        const table = definitions(72, 180, 540, 130, 6);
        const specs = [...prose(72, 540, 72, 3), ...table.specs, ...prose(72, 540, table.bottom + 20, 4)];
        const found = grids(specs);
        expect(found).toHaveLength(1);
        const [x0, y0, x1, y1] = found[0].bbox;
        expect(x0).toBeCloseTo(72);
        expect(y0).toBeCloseTo(130);
        expect(x1).toBeGreaterThan(500);
        // The last definition's wrapped lines included.
        expect(y1).toBeCloseTo(table.bottom - 4 - PITCH + LINE);
        // Running text joins: the definitions are among the candidate's lines.
        expect(found[0].lines!.some((l) => l.text === SENTENCES[0])).toBe(true);
        expect(found[0].memberLines).toHaveLength(found[0].lines!.length);

        const lines = pageLines(page(specs));
        expect(findCandidates(lines, [], W, H, BS).candidates.some((c) => c.source === "grid")).toBe(false);
    });

    it("never reads two columns of justified prose as a grid, with or without a gap in one of them", () => {
        expect(grids([...prose(72, 300, 72, 30), ...prose(312, 540, 72, 30)])).toEqual([]);
        // A figure leaves rows of the left column empty.
        expect(grids([...prose(72, 300, 72, 10), ...prose(72, 300, 72 + 20 * PITCH, 10), ...prose(312, 540, 72, 30)])).toEqual([]);
    });

    it("reads a numbered list as a list, not a table", () => {
        const specs: Spec[] = [];
        let y = 72;
        for (let i = 1; i <= 8; i++) {
            specs.push({ box: [72, y, 84, y + LINE], text: `${i}.` });
            specs.push({ box: [92, y, RAGGED[i % 6], y + LINE], text: SENTENCES[i % 6] });
            specs.push({ box: [92, y + PITCH, RAGGED[(i + 1) % 6] - 40, y + PITCH + LINE], text: SENTENCES[(i + 1) % 6] });
            y += 2 * PITCH + 4;
        }
        expect(grids(specs)).toEqual([]);
        // Markers set on their items' lines, a gutter's width from them.
        const joined = [1, 2, 3, 4, 5, 6].map((i): Spec => ({ box: [72, 72 + i * (PITCH + 4), 132, 72 + i * (PITCH + 4) + LINE], text: `${i}.    item ${i} text` }));
        expect(pageLines(page(joined))).toHaveLength(6);
        expect(gridGroups(pageLines(page(joined)), new Set(), new Set(), new Set(), [], BS)).toEqual([]);
    });

    it("proposes a table whose cells of running text start on one row in every column", () => {
        const specs: Spec[] = [];
        const columns: [number, number][] = [
            [72, 220],
            [240, 390],
            [410, 540],
        ];
        let y = 100;
        for (let r = 0; r < 4; r++) {
            let rowBottom = y;
            columns.forEach(([x0, x1], c) => {
                const n = 2 + ((r + c) % 3);
                for (let k = 0; k < n; k++) {
                    specs.push({ box: [x0, y + k * PITCH, x1 - ((r + c + k) % 4) * 9, y + k * PITCH + LINE], text: SENTENCES[(r + c + k) % 6] });
                }
                rowBottom = Math.max(rowBottom, y + n * PITCH);
            });
            y = rowBottom + 10;
        }
        const found = grids(specs);
        expect(found).toHaveLength(1);
        expect(found[0].bbox[0]).toBeCloseTo(72);
        expect(found[0].bbox[2]).toBeGreaterThan(500);
    });

    it("proposes a table of two wide columns of justified text only when its rows are ruled apart and start together", () => {
        const rule = (bbox: Rect) => ({ bbox, kind: "hrule" as const, rgb: 0, curve: false, stroked: true, rect: true, imageHash: 0 });
        // Four rows of two justified lines in each of two 220-point columns, `band` apart.
        const table = (band: number) => {
            const specs: Spec[] = [];
            const rules: ReturnType<typeof rule>[] = [];
            let y = 100;
            for (let r = 0; r < 4; r++) {
                for (let k = 0; k < 2; k++) {
                    specs.push({ box: [72, y + k * PITCH, 292, y + k * PITCH + LINE], text: SENTENCES[(r + k) % 6] });
                    specs.push({ box: [312, y + k * PITCH, 532, y + k * PITCH + LINE], text: SENTENCES[(r + k + 1) % 6] });
                }
                y += 2 * PITCH + band;
                if (r < 3) rules.push(rule([72, y - band / 2 - 1, 532, y - band / 2 - 0.5]));
            }
            return { lines: pageLines(page(specs)), rules };
        };
        const grids = (lines: ReturnType<typeof pageLines>, rules: ReturnType<typeof rule>[]) =>
            findCandidates(lines, rules, W, H, BS, { grid: true }).candidates.filter((c) => c.source === "grid");
        const ruled = table(10);
        const found = grids(ruled.lines, ruled.rules);
        expect(found).toHaveLength(1);
        expect(found[0].bbox[0]).toBeCloseTo(72);
        expect(found[0].bbox[2]).toBeCloseTo(532);
        // Rows that start together without rules may be paragraphs of two text columns...
        expect(grids(ruled.lines, [])).toEqual([]);
        // ...and rules between lines that run on are no rows of a table.
        const continuous = table(0);
        expect(grids(continuous.lines, continuous.rules)).toEqual([]);
    });

    it("keeps a table in one text column apart from the prose in the next", () => {
        const table = definitions(72, 140, 300, 72 + 6 * PITCH, 5);
        const specs = [
            ...prose(72, 300, 72, 5),
            ...table.specs,
            ...prose(72, 300, table.bottom + 10, 8),
            ...prose(312, 540, 72, 40),
        ];
        const found = grids(specs);
        expect(found).toHaveLength(1);
        expect(found[0].bbox[2]).toBeLessThanOrEqual(300);
    });
});

describe("grid candidates beside other sources", () => {
    it("hands its lines to a candidate it repeats, such as a ruled table's graphics", () => {
        const table = definitions(72, 180, 540, 130, 6);
        const lines = pageLines(page(table.specs));
        const rule = (bbox: Rect, kind: "hrule" | "vrule") => ({ bbox, kind, rgb: 0, curve: false, stroked: true, rect: true, imageHash: 0 });
        // A frame of rules, and one between the label column and the definitions.
        const rules = [
            rule([72, 127, 540, 127.5], "hrule"),
            rule([72, table.bottom - 2, 540, table.bottom - 1.5], "hrule"),
            rule([72, 127, 72.5, table.bottom - 1.5], "vrule"),
            rule([539.5, 127, 540, table.bottom - 1.5], "vrule"),
            rule([170, 127, 170.5, table.bottom - 1.5], "vrule"),
        ];
        const found = findCandidates(lines, rules, W, H, BS, { grid: true }).candidates;
        expect(found.some((c) => c.source === "grid")).toBe(false);
        const ruled = found.find((c) => c.source === "graphics")!;
        expect(ruled.memberLines?.some((l) => l.text === SENTENCES[0])).toBe(true);
    });

    it("counts cells, not lines: a row's cells may be one structured-text line", () => {
        // Cells a word space or two apart (closer than a line split) on one line per row.
        const row = (y: number): Spec => ({ box: [72, y, 172, y + LINE], text: "Alpha   0.12   0.34" });
        expect(pageLines(page([row(100)]))).toHaveLength(1);
        const lines = pageLines(page([row(100), row(113), row(126), row(139)]));
        expect(gridGroups(lines, new Set(), new Set(), new Set(), [], BS)).toHaveLength(1);
    });
});

describe("cells MuPDF set on one line", () => {
    const withSources = (specs: Spec[]) => {
        const raw = page(specs);
        return findCandidates(pageLines(raw), [], W, H, BS, { grid: true, sources: sourceLines(raw) }).candidates.filter((c) => c.source === "grid");
    };

    it("keeps the words of a line joined from one structured-text line per word apart, upright or upside down", () => {
        // Two columns of justified prose, each word its own structured-text line, with
        // paragraph breaks that line up across the columns.
        const specs: Spec[] = [];
        const words = ["the", "program", "examines", "how", "students", "relate", "social", "problems"];
        const line = (x0: number, x1: number, y: number) => {
            const gap = 3;
            const unit = (x1 - x0 - gap * (words.length - 1)) / words.join("").length;
            let x = x0;
            for (const w of words) {
                specs.push({ box: [x, y, x + w.length * unit, y + LINE], text: w });
                x += w.length * unit + gap;
            }
        };
        let y = 72;
        for (let p = 0; p < 4; p++) {
            for (let k = 0; k < 4; k++) {
                line(72, 300, y);
                line(312, 540, y);
                y += PITCH;
            }
            y += 8;
        }
        for (const turned of [false, true]) {
            const raw = page(specs, turned);
            const visual = mergeRowFragments(pageLines(raw), []);
            expect(visual).toHaveLength(32);
            const found = findCandidates(visual, [], W, H, BS, { grid: true, sources: sourceLines(raw) }).candidates;
            expect(found.filter((c) => c.source === "grid")).toEqual([]);
        }
    });

    it("reads a label by its own words when its definition's first line shares its line", () => {
        const specs: Spec[] = [];
        let y = 130;
        for (let r = 0; r < 6; r++) {
            // "Label r" a gutter (three spaces) before the definition's first line.
            const text = `Label ${r + 1}   ${SENTENCES[r]}`;
            specs.push({ box: [72, y, 72 + text.length * 5.5, y + LINE], text });
            for (let k = 1; k < 2 + (r % 2); k++) {
                y += PITCH;
                const next = SENTENCES[(r + k) % 6];
                specs.push({ box: [72 + 10 * 5.5, y, 72 + (10 + next.length) * 5.5, y + LINE], text: next });
            }
            y += PITCH + 4;
        }
        expect(pageLines(page(specs)).length).toBe(specs.length);
        const found = withSources(specs);
        expect(found).toHaveLength(1);
        expect(found[0].bbox[0]).toBeCloseTo(72);
    });

    it("leaves out a text column's prose that shares lines with a table's cells beside it", () => {
        const step = 128 / 23;
        const proseLine = (y: number, r: number): Spec => ({ box: [72, y, 72 + 23 * step, y + LINE], text: SENTENCES[r % 6].slice(0, 23) });
        // The column's prose runs on above and below the table's rows.
        const specs: Spec[] = [proseLine(97, 4), proseLine(110, 5)];
        for (let r = 0; r < 4; r++) {
            const y = 130 + r * 20;
            // Prose ending at x=200, a gutter, then two cells from x=212.
            const text = `${SENTENCES[r].slice(0, 23)}   Label ${r}   0.${r}5`;
            specs.push({ box: [72, y, 72 + text.length * step, y + LINE], text });
        }
        specs.push(proseLine(130 + 4 * 20, 1), proseLine(130 + 4 * 20 + PITCH, 2));
        // Every row of the table shares its line with the prose: no line can be taken
        // without the prose, so no grid is proposed (rather than one taking the prose).
        expect(withSources(specs)).toEqual([]);
    });

    it("takes a line's ink span only when its characters are its text's and run left to right", () => {
        const raw = page([{ box: [72, 100, 200, 111], text: "Some text here" }]);
        const [x0, x1] = pageLines(raw, true)[0].inkSpan!;
        expect([x0, x1]).toEqual([72, expect.closeTo(200)]);
        expect(pageLines(raw)[0].inkSpan).toBeUndefined();
        const chars = (raw.blocks[0].lines![0] as RawLineDetailed).chars;
        [chars[1].bbox, chars[2].bbox] = [chars[2].bbox, chars[1].bbox];
        expect(pageLines(raw, true)[0].inkSpan).toBeUndefined();
        [chars[1].bbox, chars[2].bbox] = [chars[2].bbox, chars[1].bbox];
        chars[3].c = "x";
        expect(pageLines(raw, true)[0].inkSpan).toBeUndefined();
    });

    it("finds the same candidates and features taking lines whole by their gaps as cutting them from their characters", () => {
        const labelled: Spec[] = [];
        let y = 130;
        for (let r = 0; r < 6; r++) {
            const text = `Label ${r + 1}   ${SENTENCES[r]}`;
            labelled.push({ box: [72, y, 72 + text.length * 5.5, y + LINE], text });
            labelled.push({ box: [72 + 10 * 5.5, y + PITCH, 72 + (10 + SENTENCES[(r + 1) % 6].length) * 5.5, y + PITCH + LINE], text: SENTENCES[(r + 1) % 6] });
            y += 2 * PITCH + 4;
        }
        const table = definitions(72, 180, 540, 130, 6);
        for (const specs of [labelled, [...prose(72, 540, 72, 3), ...table.specs, ...prose(72, 540, table.bottom + 20, 4)]]) {
            const raw = page(specs);
            const run = (inkSpans: boolean) => {
                const lines = pageLines(raw, inkSpans);
                const found = findCandidates(lines, [], W, H, BS, { grid: true, sources: sourceLines(raw) });
                return {
                    whole: lines.filter((l) => l.inkSpan).length,
                    candidates: found.candidates.map((c) => ({ source: c.source, bbox: c.bbox, lines: c.lines?.map((l) => l.text), grid: gridFeatures(c, found) })),
                };
            };
            const [fromGaps, fromChars] = [run(true), run(false)];
            expect(fromGaps.whole).toBeGreaterThan(0);
            expect(fromChars.whole).toBe(0);
            expect(fromGaps.candidates.some((c) => c.source === "grid")).toBe(true);
            expect(fromGaps.candidates).toEqual(fromChars.candidates);
        }
    });

    it("keeps a table's column of justified descriptions, which ends with the table", () => {
        const specs: Spec[] = [];
        let y = 130;
        for (let r = 0; r < 6; r++) {
            specs.push({ box: [72, y, 130, y + LINE], text: `Label ${r + 1}` });
            specs.push({ box: [150, y, 250, y + LINE], text: `Group ${r % 2}` });
            for (let k = 0; k < 2; k++) {
                specs.push({ box: [270, y + k * PITCH, 540, y + k * PITCH + LINE], text: SENTENCES[(r + k) % 6] });
            }
            y += 2 * PITCH + 8;
        }
        const found = withSources([...prose(72, 540, 72, 3), ...specs, ...prose(72, 540, y + 20, 3)]);
        expect(found).toHaveLength(1);
        expect(found[0].bbox[2]).toBeGreaterThan(530);
    });
});

/** A logistic model on the grid feature set (version 6) that calls grid candidates tables. */
function gridFeatureModel(): RegionModelWeights {
    const names = [...REGION_GRID_FEATURES];
    const src = names.indexOf("src_grid");
    return {
        format: "bxm-logistic-v1",
        featureVersion: REGION_GRID_FEATURE_VERSION,
        features: names,
        classes: ["other", "picture", "decoration", "table", "formula"],
        mean: names.map(() => 0),
        scale: names.map(() => 1),
        coef: [0, 1, 2, 3, 4].map((k) => names.map((_, i) => (k === 3 && i === src ? 10 : 0))),
        intercept: [0, -20, -20, -5, -20],
        trainedOn: "test",
    };
}

describe("upside-down grid candidates", () => {
    const withSources = (specs: Spec[], turned: boolean) => {
        const raw = page(specs, turned);
        return findCandidates(pageLines(raw), [], W, H, BS, { grid: true, sources: sourceLines(raw) }).candidates.filter((c) => c.source === "grid");
    };

    it("reads a numbered list set upside down as a list, its markers first", () => {
        const specs: Spec[] = [];
        let y = 72;
        for (let i = 1; i <= 4; i++) {
            specs.push({ box: [72, y, 84, y + LINE], text: `${i}.` });
            specs.push({ box: [92, y, RAGGED[i % 6], y + LINE], text: SENTENCES[i % 6] });
            specs.push({ box: [92, y + PITCH, RAGGED[(i + 1) % 6] - 40, y + PITCH + LINE], text: SENTENCES[(i + 1) % 6] });
            y += 2 * PITCH + 4;
        }
        expect(withSources(specs, false)).toEqual([]);
        expect(pageLines(page(specs, true)).every((l) => l.turned)).toBe(true);
        expect(withSources(specs, true)).toEqual([]);
    });

    it("proposes an upside-down table as upright, taking its page lines", () => {
        const table = definitions(72, 180, 540, 130, 6);
        const specs = [...prose(72, 540, 72, 3), ...table.specs, ...prose(72, 540, table.bottom + 20, 4)];
        const found = withSources(specs, true);
        expect(found).toHaveLength(1);
        const [x0, y0, x1, y1] = found[0].bbox;
        // The upright table's box, turned about the page's centre.
        expect(x1).toBeCloseTo(W - 72);
        expect(y1).toBeCloseTo(H - 130);
        expect(x0).toBeLessThan(W - 500);
        expect(y0).toBeCloseTo(H - (table.bottom - 4 - PITCH + LINE));
        expect(found[0].memberLines!.every((l) => l.turned)).toBe(true);
    });
});

describe("rotated grid candidates", () => {
    /**
     * A table set sideways (text reading down the page), each row one structured-text
     * line holding a label and, a gutter further on, a sentence: rows stack leftward.
     */
    function sideways(row = (r: number) => `Label ${r + 1}${" ".repeat(4)}${SENTENCES[r]}`, pitch = 22): RawPageData {
        const font = { name: "Times-Roman", family: "Times", weight: "normal", style: "normal", size: BS };
        const lines = [0, 1, 2, 3].map((r): RawLineDetailed => {
            const x1 = 540 - r * pitch;
            const x0 = x1 - LINE;
            const text = row(r);
            const chars = [...text];
            const step = 4.5;
            const y0 = 100;
            return {
                wmode: 0,
                bbox: { l: x0, t: y0, r: x1, b: y0 + chars.length * step },
                font,
                x: x1,
                y: y0,
                text,
                rotation: 90,
                chars: chars.map((c, i) => {
                    const bbox = { l: x0, t: y0 + i * step, r: x1, b: y0 + (i + 1) * step };
                    return { c, bbox, quad: [bbox.r, bbox.t, bbox.r, bbox.b, bbox.l, bbox.t, bbox.l, bbox.b] };
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

    it("finds the cells of rotated lines in their reading frame", () => {
        const raw = sideways();
        const lines = pageLines(raw);
        expect(lines.every((l) => l.rot === 90 && !l.skewed)).toBe(true);
        const found = findCandidates(lines, [], W, H, BS, { grid: true, sources: sourceLines(raw) });
        const grid = found.candidates.filter((c) => c.source === "grid");
        expect(grid).toHaveLength(1);
        expect(grid[0].rotated).toBe(true);
        expect(grid[0].memberLines).toHaveLength(4);
        // Its features read the same cells, and its text, in its reading frame.
        expect(gridFeatures(grid[0], found)[2]).toBe(1);
        const base = candidateFeatures(grid[0], found, EMPTY_DOC_CONTEXT);
        const named = (name: string) => base[REGION_FEATURES.indexOf(name as (typeof REGION_FEATURES)[number])];
        expect(named("n_rows")).toBe(4);
        expect(named("n_cols")).toBeGreaterThan(0);
        expect(named("alpha_word_frac")).toBeGreaterThan(0.5);
        // Without the structured-text lines, a rotated line is one cell.
        expect(findCandidates(lines, [], W, H, BS, { grid: true }).candidates.some((c) => c.source === "grid")).toBe(false);
    });

    it("gives a model on the grid feature set the same inputs with or without grid candidates", () => {
        // Three short cells per rotated line: a text candidate, which the grid repeats.
        const raw = sideways((r) => `Label ${r + 1}    0.${r}5    1.${r}0`, PITCH);
        const model = gridFeatureModel();
        const features = (gridCandidates: boolean) =>
            detectRegions(raw, EMPTY_GRAPHICS, { pageIndex: 0, model, gridCandidates })
                .candidates.filter((c) => c.source !== "grid")
                .map((c) => c.gridFeatures);
        const plain = features(false);
        expect(plain.length).toBeGreaterThan(0);
        expect(plain).toEqual(features(true));
        const names = [...GRID_FEATURES];
        expect(plain.some((f) => f![names.indexOf("grid_gutters")] === 2 && f![names.indexOf("grid_multi_rows")] === 1)).toBe(true);
    });
});

describe("row structure", () => {
    it("counts a label column's gutter, its rows and how sparse the column is", () => {
        const lines = pageLines(page(definitions(72, 180, 540, 100, 6).specs));
        const shape = rowStructure(lines);
        expect(shape.gutters).toBe(1);
        expect(shape.rows).toBe(15);
        expect(shape.sparseOccupancy).toBeCloseTo(6 / 15);
        expect(shape.anchored).toBe(1);
        expect(rowStructure(pageLines(page(prose(72, 540, 72, 6))))).toMatchObject({ gutters: 0, sparseOccupancy: 1 });
    });

    it("reads a gutter broken by a header spanning the columns as one", () => {
        const cells = (y: number): Spec[] => [0, 1, 2].flatMap((r): Spec[] => [
            { box: [72, y + r * PITCH, 130, y + r * PITCH + LINE], text: "Label" },
            { box: [200, y + r * PITCH, 260, y + r * PITCH + LINE], text: "0.25" },
        ]);
        const specs = [...cells(100), { box: [72, 100 + 3 * PITCH, 260, 100 + 3 * PITCH + LINE], text: "A group header spanning both columns" }, ...cells(100 + 4 * PITCH)];
        expect(rowStructure(pageLines(page(specs)))).toMatchObject({ gutters: 1, anchored: 1 });
    });

    it("reads every row of a full table as anchored", () => {
        const specs = [0, 1, 2, 3].flatMap((r): Spec[] => [
            { box: [72, 100 + r * PITCH, 130, 111 + r * PITCH], text: "Label" },
            { box: [200, 100 + r * PITCH, 260, 111 + r * PITCH], text: "0.25" },
        ]);
        expect(rowStructure(pageLines(page(specs)))).toMatchObject({ gutters: 1, sparseOccupancy: 1, anchored: 1, multiRows: 1 });
    });
});

describe("grid candidates in detection", () => {
    const table = definitions(72, 180, 540, 130, 6);
    const specs = [...prose(72, 540, 72, 3), ...table.specs, ...prose(72, 540, table.bottom + 20, 4)];

    it("adds the grid features only with grid candidates", () => {
        const on = detectRegions(page(specs), EMPTY_GRAPHICS, { pageIndex: 0, gridCandidates: true });
        const grid = on.candidates.find((c) => c.source === "grid")!;
        expect(grid.gridFeatures).toHaveLength(GRID_FEATURES.length);
        expect(grid.gridFeatures![0]).toBe(1);
        expect(on.candidates.filter((c) => c.source !== "grid").every((c) => c.gridFeatures?.[0] === 0)).toBe(true);
        const off = detectRegions(page(specs), EMPTY_GRAPHICS, { pageIndex: 0 });
        expect(off.candidates.some((c) => c.source === "grid" || c.gridFeatures)).toBe(false);
        // The other sources' candidates and features are those of a run without grid candidates.
        expect(on.candidates.filter((c) => c.source !== "grid").map((c) => c.features)).toEqual(off.candidates.map((c) => c.features));
    });

    it("classifies with a model trained on the grid feature set, and routes a grid table's running text to it", () => {
        const model = gridFeatureModel();
        expect(() => assertCompatible(model)).not.toThrow();
        expect(() => assertCompatible({ ...model, features: model.features.slice(0, -1) })).toThrow();
        const detection = detectRegions(page(specs), EMPTY_GRAPHICS, { pageIndex: 0, model, route: true, gridCandidates: true });
        const k = detection.candidates.findIndex((c) => c.source === "grid");
        expect(detection.candidates[k].label).toBe("table");
        const { lines, flags, routes } = detection.routing!;
        const definition = lines.findIndex((l, i) => l.text === SENTENCES[0] && l.bbox[1] >= 130 && l.bbox[1] < table.bottom && flags[i] & LINE_RUNNING);
        expect(definition).toBeGreaterThanOrEqual(0);
        expect(routes[definition]).toBe(k);
    });

    it("computes grid features only where the model may read them, giving the same classes", () => {
        // A tree model on the grid feature set: other candidates (src_grid 0) never read a
        // grid feature; grid candidates read their gutters.
        const names = [...REGION_GRID_FEATURES];
        const [src, gutters] = [names.indexOf("src_grid"), names.indexOf("grid_gutters")];
        const model: RegionModelWeights = {
            format: "bxm-trees-v1",
            featureVersion: REGION_GRID_FEATURE_VERSION,
            features: names,
            classes: ["other", "picture", "decoration", "table", "formula"],
            baseline: [0, -5, -5, -1, -5],
            trees: [{ score: 3, feature: [src, -1, gutters, -1, -1], threshold: [0.5, 0, 0.5, 0, 0], left: [1, 0, 3, 0, 0], right: [2, 0, 4, 0, 0], value: [0, -2, 0, 0, 5] }],
            trainedOn: "test",
        };
        expect([readsGridFeatures(model, 0), readsGridFeatures(model, 1)]).toEqual([false, true]);
        expect([readsGridFeatures(gridFeatureModel(), 0), readsGridFeatures(gridFeatureModel(), 1)]).toEqual([true, true]);
        const opts = { pageIndex: 0, model, gridCandidates: true };
        const lean = detectRegions(page(specs), EMPTY_GRAPHICS, opts);
        const all = detectRegions(page(specs), EMPTY_GRAPHICS, { ...opts, allGridFeatures: true });
        expect(lean.candidates.some((c) => c.source === "grid" && c.label === "table")).toBe(true);
        expect(lean.candidates.map((c) => [c.probs, c.label])).toEqual(all.candidates.map((c) => [c.probs, c.label]));
        expect(lean.candidates.every((c) => (c.source === "grid") === !!c.gridFeatures)).toBe(true);
        expect(all.candidates.every((c) => c.gridFeatures)).toBe(true);
    });

    it("leaves running text in the prose unless a grid table takes it", () => {
        const lines = pageLines(page(prose(72, 540, 100, 1)));
        const regions: DetectedRegion[] = [{ bbox: [60, 90, 550, 120], anchored: false, source: "grid", features: [], label: "table" }];
        expect(routeLines(lines, [LINE_RUNNING], regions)).toEqual([-1]);
        expect(routeLines(lines, [LINE_RUNNING], regions, [], [new Set(lines)])).toEqual([0]);
        expect(routeLines(lines, [LINE_RUNNING], [{ ...regions[0], label: "other" }], [], [new Set(lines)])).toEqual([-1]);
        // A grid that became part of a larger table hands its lines to that table.
        const outer: DetectedRegion = { bbox: [50, 80, 560, 300], anchored: false, source: "graphics", features: [], label: "table" };
        const inner: DetectedRegion = { ...regions[0], label: "other", containedIn: 0 };
        expect(routeLines(lines, [LINE_RUNNING], [outer, inner], [], [undefined, new Set(lines)])).toEqual([0]);
    });
});
