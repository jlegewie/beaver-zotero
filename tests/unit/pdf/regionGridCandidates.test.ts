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
import type { RawPageDataDetailed } from "@beaver/agent-core/extract/types";
import {
    LINE_RUNNING,
    detectRegions,
    gridFallback,
    resolveOverlaps,
    routeLines,
    type DetectedRegion,
    type RegionDetection,
} from "../../../src/beaver-extract/regions/RegionDetector";
import { regionItemsForPage } from "../../../src/beaver-extract/regions/regionItems";
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

describe("grid candidates' rows past the last bordered row", () => {
    const table = () => definitions(72, 180, 540, 130, 6);
    const memberTexts = (specs: Spec[]) => grids(specs)[0]?.memberLines?.map((l) => l.text) ?? [];

    it("takes a cell's wrapped lines but no note, list of abbreviations or heading set under the table", () => {
        const t = table();
        // The line after the last row's wrapped lines, at their line spacing.
        const next = t.bottom - 4;
        const at = (x0: number, x1: number, text: string): Spec => ({ box: [x0, next, x1, next + LINE], text });
        expect(memberTexts(t.specs)).toContain(t.specs[t.specs.length - 1].text);
        for (const extra of [
            at(72, 300, "h, human; m, mouse; NR, no response."),
            at(72, 240, "a) values at baseline in the trial"),
            at(72, 130, "3.2. Results"),
        ]) {
            const texts = memberTexts([...t.specs, extra]);
            expect(texts).toContain(t.specs[t.specs.length - 1].text);
            expect(texts).not.toContain(extra.text);
        }
        // A wrapped line of the last definition joins.
        const wrapped = at(180, 420, "and the review of the course work in the program");
        expect(memberTexts([...t.specs, wrapped])).toContain(wrapped.text);
    });

    it("measures the gap to a line under the table from the table's own rows, not the next text column's", () => {
        const t = definitions(72, 140, 300, 72 + 6 * PITCH, 5);
        // A note in the label column a line and a half under the table; the prose of the next
        // column runs on beside it, a line of it between the two.
        const note: Spec = { box: [72, t.bottom - 4 + 0.6 * PITCH, 128, t.bottom - 4 + 0.6 * PITCH + LINE], text: "Values (SEM)." };
        const specs = [...prose(72, 300, 72, 5), ...t.specs, note, ...prose(72, 300, t.bottom + 2 * PITCH, 8), ...prose(312, 540, 72, 40)];
        const found = grids(specs);
        expect(found).toHaveLength(1);
        expect(found[0].memberLines!.map((l) => l.text)).not.toContain(note.text);
        expect(found[0].bbox[3]).toBeLessThan(note.box[1]);
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
        // Another source's table takes only the grid's lines inside its box.
        const above: DetectedRegion = { ...outer, bbox: [50, 40, 560, 95] };
        expect(routeLines(lines, [LINE_RUNNING], [above, { ...inner, containedIn: 0 }], [], [undefined, new Set(lines)])).toEqual([-1]);
        expect(routeLines(lines, [LINE_RUNNING], [above], [], [new Set(lines)])).toEqual([-1]);
    });
});

describe("grid candidates and the emission gate", () => {
    /** Four rows of a label and two numbers, from `y`, in [72, 300]. */
    const numbers = (y: number): Spec[] =>
        ["Alpha", "Beta", "Gamma", "Delta"].flatMap((label, r): Spec[] => [
            { box: [72, y + r * PITCH, 120, y + r * PITCH + LINE], text: label },
            { box: [180, y + r * PITCH, 210, y + r * PITCH + LINE], text: `0.${r + 1}2` },
            { box: [260, y + r * PITCH, 290, y + r * PITCH + LINE], text: `0.${r + 3}4` },
        ]);
    /**
     * A page routed as the detector does with grid candidates: `regions` with their labels
     * before overlap resolution, and the grid lines each takes as a table (by text).
     */
    const routed = (specs: Spec[], running: string[], regions: DetectedRegion[], takes: (string[] | undefined)[]) => {
        const raw = page(specs) as unknown as RawPageDataDetailed;
        const lines = mergeRowFragments(pageLines(raw), []);
        const flags = lines.map((l) => (running.includes(l.text) ? LINE_RUNNING : 0));
        const labels = regions.map((r) => r.label);
        const boxes = regions.map((r) => r.bbox);
        resolveOverlaps(regions);
        const sets = takes.map((t) => (t ? new Set(lines.filter((l) => t.includes(l.text))) : undefined));
        const handed = lines.map(() => -1);
        const routes = routeLines(lines, flags, regions, [], sets, { handed });
        const detection: RegionDetection = { pageIndex: 0, scanned: false, bodySize: BS, candidates: regions, routing: { lines, flags, routes, rules: [] }, ms: 0 };
        detection.routing!.gridFallback = gridFallback(regions, labels, boxes, detection.routing!, sets, handed);
        return { raw, detection };
    };
    const region = (source: DetectedRegion["source"], bbox: Rect, p: number): DetectedRegion => ({
        bbox,
        anchored: false,
        source,
        features: [],
        probs: { other: 1 - p, picture: 0, decoration: 0, table: p, formula: 0 },
        label: "table",
    });
    const sentences = SENTENCES.slice(0, 4);

    it("restores the tables a grid table displaced when it fails the gate", () => {
        // A grid over a table of numbers and the paragraph under it: as a table, its rows
        // are fragments of the paragraph's sentences.
        const specs = [...numbers(100), ...prose(72, 300, 100 + 4 * PITCH, 4).map((sp, i) => ({ ...sp, text: sentences[i] }))];
        const v5 = region("text", [72, 100, 290, 100 + 3 * PITCH + LINE], 1);
        const grid = region("grid", [72, 100, 300, 100 + 7 * PITCH + LINE], 0.85);
        const { raw, detection } = routed(specs, sentences, [v5, grid], [undefined, specs.map((sp) => sp.text)]);
        expect(detection.candidates[0]).toMatchObject({ label: "other", containedIn: 1 });
        const { items, page: rest } = regionItemsForPage(raw, detection);
        expect(items.map((it) => it.region)).toEqual([0]);
        expect(items[0].rows).toHaveLength(4);
        expect(detection.candidates.map((c) => c.label)).toEqual(["table", "other"]);
        const left = rest.blocks.flatMap((b) => (b.lines ?? []).map((l) => l.text));
        expect(left).toEqual(sentences);
    });

    it("undoes a grid table's merge into another table, its box and what it displaced", () => {
        // A ruled table of numbers, two rows its box missed, and a grid table of more rows in
        // its columns under them: row completion takes the missed rows and merges the grid
        // fragment, growing the table's box over it. An equation box lies in the fragment.
        const cells = (y: number, n: number, k: number): Spec[] =>
            Array.from({ length: n }, (_, r): Spec[] => [
                { box: [72, y + r * PITCH, 120, y + r * PITCH + LINE], text: ["Alpha", "Beta", "Gamma", "Delta", "Eps", "Zeta", "Eta", "Theta"][(k + r) % 8] },
                { box: [180, y + r * PITCH, 210, y + r * PITCH + LINE], text: `${k}.${r + 1}2` },
                { box: [260, y + r * PITCH, 290, y + r * PITCH + LINE], text: `${k}.${r + 3}4` },
            ]).flat();
        const top = 100 + 6 * PITCH;
        const raw = page([...cells(100, 4, 0), ...cells(100 + 4 * PITCH, 2, 2), ...cells(top, 4, 4)]);
        const lines = mergeRowFragments(pageLines(raw), []);
        const rules = Array.from({ length: 11 }, (_, i): Rect => {
            const y = i < 6 ? 98.5 + i * PITCH : top - 1.5 + (i - 6) * PITCH;
            return [72, y, 290, y + 0.5];
        });
        const v5 = region("text", [72, 100, 290, 100 + 3 * PITCH + LINE], 1);
        const grid = region("grid", [72, top, 290, top + 3 * PITCH + LINE], 0.9);
        const equation: DetectedRegion = { ...region("text", [215, top + PITCH, 255, top + 2 * PITCH], 0), label: "formula" };
        const regions = [v5, grid, equation];
        const labels = regions.map((r) => r.label);
        const boxes = regions.map((r) => r.bbox);
        resolveOverlaps(regions);
        const takes = [undefined, new Set(lines.filter((l) => l.bbox[1] >= top)), undefined];
        const handed = lines.map(() => -1);
        const routing = { lines, flags: lines.map(() => 0), routes: routeLines(lines, lines.map(() => 0), regions, rules, takes, { handed }), rules };
        expect(regions.map((r) => [r.label, r.containedIn])).toEqual([["table", undefined], ["other", 0], ["other", 1]]);
        expect(v5.bbox[3]).toBeCloseTo(top + 3 * PITCH + LINE);
        const fallback = gridFallback(regions, labels, boxes, routing, takes, handed);
        expect(fallback.involved(0)).toBe(true);
        fallback.release([0]);
        // The grid is withdrawn with its merge: the table has its own box, the equation its label.
        expect(regions.map((r) => r.label)).toEqual(["table", "other", "formula"]);
        expect(regions[0].bbox).toEqual([72, 100, 290, 100 + 3 * PITCH + LINE]);
        expect(regions[2].containedIn).toBeUndefined();
    });

    it("emits a table with its own lines when it fails the gate only with a grid's", () => {
        // A table whose box takes in the paragraph beside it, set on baselines of its own; the
        // grid that repeats the table hands it the paragraph's lines, rows of sentence fragments.
        const specs = [...numbers(100), ...prose(320, 540, 100 + PITCH / 2, 4).map((sp, i) => ({ ...sp, text: sentences[i] }))];
        const v5 = region("text", [72, 100, 540, 100 + 4 * PITCH], 1);
        const { raw, detection } = routed(specs, sentences, [v5], [specs.map((sp) => sp.text)]);
        expect(detection.routing!.routes.filter((r) => r === 0)).toHaveLength(16);
        const { items, page: rest } = regionItemsForPage(raw, detection);
        expect(items.map((it) => it.region)).toEqual([0]);
        expect(items[0].rows.map((row) => row.length)).toEqual([3, 3, 3, 3]);
        expect(rest.blocks.flatMap((b) => (b.lines ?? []).map((l) => l.text))).toEqual(sentences);
    });
});

describe("grid candidates that list entries", () => {
    /** Rows of cells at the given left edges, `PITCH` + 5 apart from `y`; each cell 6 points a character wide, at most 300. */
    const rowsOf = (cells: [number, string][][], y = 100): Spec[] =>
        cells.flatMap((row, r) =>
            row.map(([x, text]): Spec => ({ box: [x, y + r * (PITCH + 5), Math.min(x + 300, x + 6 * text.length), y + r * (PITCH + 5) + LINE], text })),
        );
    const found = (specs: Spec[]) => gridGroups(pageLines(page(specs)), new Set(), new Set(), new Set(), [], BS);
    const TITLES = ["Prologue", "The Roots of the Field", "Neural Networks", "Looking and Seeing", "Learning to Play", "Words and Meaning", "On Understanding", "Notes"];

    it("proposes nothing for a table of contents, whose pages increase down it", () => {
        const contents = rowsOf(TITLES.map((t, i) => [[72, t], [500, `p. ${3 + 14 * i}`]]));
        const groups = found(contents);
        expect(groups).toHaveLength(1);
        expect(groups[0].proposes).toBeNull();
        expect(grids(contents)).toEqual([]);
        // Numbered entries, and a column of pages without "p." under the head "Page".
        const numbered = rowsOf([
            [[72, "Chapter"], [500, "Page"]],
            ...TITLES.map((t, i): [number, string][] => [[72, `${i + 1}`], [96, t], [500, String(3 + 14 * i)]]),
        ]);
        expect(found(numbered).map((g) => g.proposes)).toEqual([null]);
    });

    it("proposes nothing for a list of figures with dot leaders, nor for an index ordered by name", () => {
        const figures = rowsOf(TITLES.map((t, i) => [[72, `${t} . . . . . . . . . .`], [500, String([12, 4, 30, 8, 22, 17, 40, 2][i])]]));
        expect(found(figures).map((g) => g.proposes)).toEqual([null]);
        const names = ["Adams Ruth", "Baker John", "Chen Wei", "Diaz Ana", "Evans Tom", "Fischer Lea", "Garcia Luis", "Hall Amy"];
        const index = rowsOf(names.map((n, i) => [[72, n], [220, TITLES[i]], [500, String([67, 50, 82, 27, 14, 84, 9, 33][i])]]));
        expect(found(index).map((g) => g.proposes)).toEqual([null]);
    });

    it("keeps a table whose last column holds small integers", () => {
        const counts = [12, 4, 30, 8, 22, 17, 40, 2];
        const LABELS = ["Survey", "Interview", "Archive", "Fieldwork", "Diary study", "Focus group", "Panel", "Case study"];
        // Values that do not increase down the table, beside labels in no order.
        const unordered = rowsOf(LABELS.map((t, i) => [[72, t], [500, String(counts[i])]]));
        expect(found(unordered).map((g) => g.proposes)).toEqual([undefined]);
        expect(grids(unordered)).toHaveLength(1);
        // Increasing values under a header row.
        const headed = rowsOf([[[72, "Method"], [500, "N"]], ...LABELS.map((t, i): [number, string][] => [[72, t], [500, String(2 + 5 * i)]])]);
        expect(found(headed).map((g) => g.proposes)).toEqual([undefined]);
        // Rows numbered one by one beside quotations.
        const numberedRows = rowsOf(TITLES.map((t, i) => [[72, String(i + 1)], [96, `${t} was what the participant said`]]));
        expect(found(numberedRows).map((g) => g.proposes)).toEqual([undefined]);
        // A constant value beside descriptions: no pages, however ordered.
        const DESCRIPTIONS = LABELS.map((t) => `${t} of the households in the sample`);
        const constant = rowsOf(DESCRIPTIONS.map((t) => [[72, t], [500, "12"]]));
        expect(found(constant).map((g) => g.proposes)).toEqual([undefined]);
        // Descriptions sharing their first word, in no order beyond it, beside unordered values.
        const shared = rowsOf(["share", "count", "mean", "rate", "total", "level", "index", "ratio"].map((w, i) => [[72, `The ${w} of the households`], [500, String(counts[i])]]));
        expect(found(shared).map((g) => g.proposes)).toEqual([undefined]);
        // Increasing counts under a table's caption.
        const captioned: Spec[] = [
            { box: [72, 76, 260, 76 + LINE], text: "Table 1. Sample size by method" },
            ...rowsOf(LABELS.map((t, i) => [[72, `${t} of the households in the sample`], [500, String(10 + 7 * i)]])),
        ];
        const captionLines = pageLines(page(captioned));
        const captionSet = new Set(captionLines.filter((l) => l.text.startsWith("Table 1.")));
        expect(gridGroups(captionLines, captionSet, captionSet, new Set(), [], BS).map((g) => g.proposes)).toEqual([undefined]);
        // A caption whose title ends with a number.
        const numberedTitle = pageLines(page([{ box: [72, 76, 356, 76 + LINE], text: "Table 1. Sample size by method in Experiment 2" }, ...captioned.slice(1)]));
        const numberedSet = new Set(numberedTitle.filter((l) => l.text.startsWith("Table 1.")));
        expect(gridGroups(numberedTitle, numberedSet, numberedSet, new Set(), [], BS).map((g) => g.proposes)).toEqual([undefined]);
        // A list of tables whose entries read as captions, each ending with its page.
        const listed: Spec[] = [
            { box: [72, 76, 198, 76 + LINE], text: "Table 1. Sample sizes" },
            { box: [500, 76, 506, 76 + LINE], text: "3" },
            ...rowsOf(TITLES.map((t, i) => [[72, `Table ${i + 2}. ${t}`], [500, String(5 + 4 * i)]])),
        ];
        const listedLines = pageLines(page(listed));
        const entrySet = new Set(listedLines.filter((l) => l.text === "Table 1. Sample sizes"));
        expect(gridGroups(listedLines, entrySet, entrySet, new Set(), [], BS).map((g) => g.proposes)).toEqual([null]);
        // A headed table of increasing counts under a running head whose page number sits over
        // the counts: judged on its rows short of the head, or by the header under that number.
        const headedRows = [
            ...rowsOf([[[72, "Journal of Testing Studies"], [500, "7"]]], 16),
            ...rowsOf([[[72, "Method"], [500, "N"]], ...LABELS.map((t, i): [number, string][] => [[72, `${t} of the households`], [500, String(10 + 7 * i)]])], 40),
        ];
        const headedLines = pageLines(page(headedRows));
        const running = new Set(headedLines.filter((l) => l.text === "Journal of Testing Studies" || (l.text === "7" && l.bbox[1] < 30)));
        const withStops = gridGroups(headedLines, new Set(), new Set(), new Set(), [], BS, undefined, undefined, running);
        expect(withStops).toHaveLength(1);
        expect(withStops[0].proposes?.lines.map((l) => l.text)).toEqual(expect.arrayContaining(["Method", "N", "17"]));
        expect(found(headedRows).map((g) => g.proposes)).not.toContain(null);
        // Increasing values in the last of two columns of values.
        const values = rowsOf(LABELS.map((t, i) => [[72, t], [300, (0.12 + 0.31 * (i % 3)).toFixed(2)], [500, String(2 + 5 * i)]]));
        expect(found(values).map((g) => g.proposes)).toEqual([undefined]);
    });
});

describe("grid candidates and running headers and footers", () => {
    const LABELS = ["Survey", "Interview", "Archive", "Fieldwork", "Diary study", "Focus group"];
    /** A running head, then six rows of a label and two values, then a "continued" line and a running foot. */
    const specs: Spec[] = [
        { box: [72, 40, 300, 40 + LINE], text: "Journal of Testing Studies 12 (2025)" },
        { box: [500, 40, 512, 40 + LINE], text: "7" },
        ...LABELS.flatMap((label, r): Spec[] => [
            { box: [72, 70 + r * PITCH, 140, 70 + r * PITCH + LINE], text: label },
            { box: [300, 70 + r * PITCH, 324, 70 + r * PITCH + LINE], text: (0.1 * r + 0.12).toFixed(2) },
            { box: [480, 70 + r * PITCH, 512, 70 + r * PITCH + LINE], text: String(10 + ((r * 7) % 13)) },
        ]),
        { box: [72, 70 + 6 * PITCH, 190, 70 + 6 * PITCH + LINE], text: "(Continued)" },
    ];
    const lines = pageLines(page(specs));
    const head = (l: { text: string }) => l.text.startsWith("Journal") || l.text === "7";
    const groups = (lines: ReturnType<typeof pageLines>, stops: Set<(typeof lines)[number]>) => gridGroups(lines, new Set(), new Set(), new Set(), [], BS, undefined, undefined, stops);
    /** The lines the page's candidates take from its grids. */
    const taken = (lines: ReturnType<typeof pageLines>, stops: Set<(typeof lines)[number]>) =>
        findCandidates(lines, [], W, H, BS, { grid: true, stops }).candidates.flatMap((c) => c.memberLines ?? []).map((l) => l.text);

    it("ends a grid's rows at the page's running head and at a line saying the table continues", () => {
        const [whole] = groups(lines, new Set());
        expect(whole.lines.some(head)).toBe(true);
        expect(whole.lines.map((l) => l.text)).toContain("(Continued)");
        // Without stops, only the line saying the table continues ends its rows.
        expect(whole.proposes!.lines.some(head)).toBe(true);
        expect(whole.proposes!.lines.map((l) => l.text)).not.toContain("(Continued)");
        expect(taken(lines, new Set())).toContain("7");
        const found = groups(lines, new Set(lines.filter(head)));
        expect(found).toHaveLength(1);
        // Found as without the stops, it proposes the rows between them.
        expect(found[0].bbox).toEqual(whole.bbox);
        const texts = found[0].proposes!.lines.map((l) => l.text);
        expect(texts).toContain("Survey");
        expect(texts).toContain("Focus group");
        expect(texts.some((t) => t.startsWith("Journal") || t === "7" || t === "(Continued)")).toBe(false);
        expect(found[0].proposes!.bbox[1]).toBeCloseTo(70);
        // A head whose cells happen to line up with the table's columns, set apart from its rows.
        const aligned = pageLines(page([{ box: [300, 40, 400, 40 + LINE], text: "Journal of Testing" }, { box: [500, 40, 512, 40 + LINE], text: "7" }, ...specs.slice(2)]));
        const [apart] = groups(aligned, new Set(aligned.filter((l) => l.text === "Journal of Testing" || l.text === "7")));
        expect(apart.lines.map((l) => l.text)).toContain("Journal of Testing");
        expect(apart.proposes!.lines.map((l) => l.text)).not.toContain("Journal of Testing");
        const kept = taken(lines, new Set(lines.filter(head)));
        expect(kept).toContain("Survey");
        expect(kept.some((t) => t.startsWith("Journal") || t === "7" || t === "(Continued)")).toBe(false);
    });

    it("describes and classifies a grid cut short of a running head as the grid as found", () => {
        const table = definitions(72, 180, 540, 130, 6);
        const header: Spec[] = [
            { box: [72, 104, 152, 104 + LINE], text: "J Test 12 (2025)" },
            { box: [500, 104, 512, 104 + LINE], text: "7" },
        ];
        const cutLines = pageLines(page([...header, ...table.specs]));
        const stops = new Set(cutLines.filter((l) => l.text === "J Test 12 (2025)" || l.text === "7"));
        const found = (s?: Set<(typeof cutLines)[number]>) => findCandidates(cutLines, [], W, H, BS, { grid: true, ...(s ? { stops: s } : {}) });
        const [whole] = found().candidates.filter((c) => c.source === "grid");
        expect(whole.bbox[1]).toBeCloseTo(104);
        const withStops = found(stops);
        const [cut] = withStops.candidates.filter((c) => c.source === "grid");
        expect(cut.bbox[1]).toBeCloseTo(130);
        expect(cut.memberLines!.map((l) => l.text)).not.toContain("7");
        expect(cut.found!.bbox).toEqual(whole.bbox);
        expect(candidateFeatures(cut.found!, withStops, EMPTY_DOC_CONTEXT)).toEqual(candidateFeatures(whole, found(), EMPTY_DOC_CONTEXT));
    });

    it("keeps a row of several numbers alone, a table's column numbers set in the margin band", () => {
        const numbers = [72, 300, 480].map((x, k): Spec => ({ box: [x, 40, x + 18, 40 + LINE], text: `(${k + 1})` }));
        const numbered = pageLines(page([...numbers, ...specs.slice(2)]));
        const [found] = groups(numbered, new Set(numbered.filter((l) => /^\(\d\)$/u.test(l.text))));
        expect(found.lines.map((l) => l.text)).toContain("(2)");
        // The line saying the table continues still ends its rows.
        expect(found.proposes!.lines.map((l) => l.text)).toContain("(2)");
        expect(found.proposes!.lines.map((l) => l.text)).not.toContain("(Continued)");
        // Nor does a continued table's header of two cells set over its columns, at its rows' spacing.
        const twoHeader = [
            { box: [72, 64, 120, 64 + LINE] as Rect, text: "Variable" },
            { box: [300, 64, 360, 64 + LINE] as Rect, text: "Definition" },
        ];
        const definitions = LABELS.flatMap((label, r): Spec[] => [
            { box: [72, 80 + r * PITCH, 140, 80 + r * PITCH + LINE], text: label },
            { box: [300, 80 + r * PITCH, 420, 80 + r * PITCH + LINE], text: `the ${label.toLowerCase()} measure` },
        ]);
        const continued = pageLines(page([...twoHeader, ...definitions]));
        const [withHeader] = groups(continued, new Set(continued.filter((l) => l.text === "Variable" || l.text === "Definition")));
        expect((withHeader.proposes ?? withHeader).lines.map((l) => l.text)).toEqual(expect.arrayContaining(["Variable", "Definition"]));
        // Nor when it stands a little further off, as over a rule, its cells over the columns.
        const ruled = pageLines(page([...twoHeader, ...definitions.map((d) => ({ ...d, box: [d.box[0], d.box[1] + 4, d.box[2], d.box[3] + 4] as Rect }))]));
        const [overRule] = groups(ruled, new Set(ruled.filter((l) => l.text === "Variable" || l.text === "Definition")));
        expect((overRule.proposes ?? overRule).lines.map((l) => l.text)).toEqual(expect.arrayContaining(["Variable", "Definition"]));
        // Nor a header of two rows, each at the rows' spacing from the next.
        const twoRows = pageLines(page([
            { box: [72, 54, 120, 54 + LINE], text: "Variable" },
            { box: [300, 54, 380, 54 + LINE], text: "Description" },
            { box: [72, 67, 120, 67 + LINE], text: "(name)" },
            { box: [300, 67, 360, 67 + LINE], text: "(text)" },
            ...definitions,
        ]));
        const headerTexts = ["Variable", "Description", "(name)", "(text)"];
        const [stacked] = groups(twoRows, new Set(twoRows.filter((l) => headerTexts.includes(l.text))));
        expect((stacked.proposes ?? stacked).lines.map((l) => l.text)).toEqual(expect.arrayContaining(headerTexts));
        // Nor does a header of words in every column, repeated on each page of a long table.
        const header = ["Method", "Mean", "Count"].map((t, k): Spec => ({ box: [[72, 300, 480][k], 40, [72, 300, 480][k] + 30, 40 + LINE], text: t }));
        const headed = pageLines(page([...header, ...specs.slice(2)]));
        const [table] = groups(headed, new Set(headed.filter((l) => ["Method", "Mean", "Count"].includes(l.text))));
        expect(table.proposes!.lines.map((l) => l.text)).toContain("Mean");
    });
});

