import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BoundingBox, TextStyle } from "@beaver/agent-core/extract/types";
import { FEATURES, FEATURE_GROUPS, FEATURE_SET, FEATURE_VERSION } from "../../../src/beaver-extract/boundaries/features";
import type { BoundaryPage } from "../../../src/beaver-extract/boundaries/input";
import {
    assertBoundaryModel,
    boundaryModelInput,
    boundaryProbability,
    type BoundaryModel,
} from "../../../src/beaver-extract/boundaries/model";
import { BOUNDARY_MODEL } from "../../../src/beaver-extract/boundaries/weights";
import type { DetectedSpan, PageLine, PageLineResult } from "../../../src/beaver-extract/LineDetector";
import { detectParagraphs, type DetectParagraphsOptions } from "../../../src/beaver-extract/ParagraphDetector";
import { draftItemsFromParagraphs } from "../../../src/beaver-extract/pipeline/draftItems";

/** Model parity fixture of the training repo (`bxm boundaries export`). */
interface BoundaryParityFixture {
    format: string;
    classes: number[];
    /** Rows in the model's `features` order; null for a missing value. */
    inputs: (number | null)[][];
    /** [continue, start] probabilities per row. */
    expected: number[][];
    features: string[];
    featureVersion: number;
    threshold: number;
}

const fixture = JSON.parse(
    readFileSync(join(__dirname, "fixtures/boundaryModelParity.json"), "utf8"),
) as BoundaryParityFixture;

/** A full feature row (`FEATURES` order) with the model's columns set by name and every other column missing. */
function fullRow(names: readonly string[], values: readonly (number | null)[]): number[] {
    const row = FEATURES.map(() => NaN);
    names.forEach((name, k) => {
        row[FEATURES.indexOf(name as (typeof FEATURES)[number])] = values[k] ?? NaN;
    });
    return row;
}

describe("boundary model parity with the training pipeline", () => {
    it("ships weights for the current feature set, without the heuristic group", () => {
        expect(BOUNDARY_MODEL.featureSet).toBe(FEATURE_SET);
        expect(BOUNDARY_MODEL.featureVersion).toBe(FEATURE_VERSION);
        expect(BOUNDARY_MODEL.model.features).toEqual(BOUNDARY_MODEL.features);
        for (const name of BOUNDARY_MODEL.features) expect(FEATURES).toContain(name);
        const decision = ["start", "rule", "headingRule", "startI"];
        const trace = FEATURE_GROUPS.heuristic.filter((name) => decision.includes(name) || /^(sig|veto)/.test(name));
        for (const name of trace) expect(BOUNDARY_MODEL.features).not.toContain(name);
        expect(() => assertBoundaryModel(BOUNDARY_MODEL)).not.toThrow();
    });

    it("matches the fixture's model description", () => {
        expect(fixture.features).toEqual([...BOUNDARY_MODEL.features]);
        expect(fixture.featureVersion).toBe(BOUNDARY_MODEL.featureVersion);
        expect(fixture.threshold).toBe(BOUNDARY_MODEL.threshold);
        expect(fixture.classes).toEqual([...BOUNDARY_MODEL.model.classes]);
    });

    it("reproduces the start probabilities from full feature rows", () => {
        expect(fixture.inputs.length).toBeGreaterThan(0);
        fixture.inputs.forEach((values, i) => {
            const p = boundaryProbability(BOUNDARY_MODEL, fullRow(fixture.features, values));
            expect(p, `row ${i}`).toBeCloseTo(fixture.expected[i][1], 9);
        });
    });

    it("maps a full row to the model's columns by name, missing values as NaN", () => {
        const values = fixture.inputs[0];
        const row = fullRow(fixture.features, values);
        row[FEATURES.indexOf(BOUNDARY_MODEL.features[0] as (typeof FEATURES)[number])] = Infinity;
        const x = boundaryModelInput(BOUNDARY_MODEL, row);
        expect(x).toHaveLength(BOUNDARY_MODEL.features.length);
        expect(x[0]).toBeNaN();
        values.slice(1).forEach((v, k) => (v === null ? expect(x[k + 1]).toBeNaN() : expect(x[k + 1]).toBe(v)));
    });

    it("rejects weights for another feature version or with a feature the set lacks", () => {
        const stale: BoundaryModel = { ...BOUNDARY_MODEL, featureVersion: FEATURE_VERSION + 1 };
        expect(() => assertBoundaryModel(stale)).toThrow(/feature version/);
        const features = [...BOUNDARY_MODEL.features.slice(0, -1), "noSuchFeature"];
        const unknown: BoundaryModel = { ...BOUNDARY_MODEL, features, model: { ...BOUNDARY_MODEL.model, features } };
        expect(() => assertBoundaryModel(unknown)).toThrow(/noSuchFeature/);
    });
});

// ---------------------------------------------------------------------------
// Segmentation with `learnedBoundaries`
// ---------------------------------------------------------------------------

const b64 = (array: ArrayBufferView) => Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString("base64");

/** A one-split model: a line starts an item exactly when it starts with a capital. */
const CAPITAL_STARTS: BoundaryModel = {
    trainedOn: "test",
    featureSet: FEATURE_SET,
    featureVersion: FEATURE_VERSION,
    features: ["startsUpper"],
    threshold: 0.5,
    model: {
        format: "bxm-trees-packed-v1",
        features: ["startsUpper"],
        classes: [0, 1],
        baseline: [0],
        depth: 1,
        trees: 1,
        score: b64(new Uint8Array([0])),
        feature: b64(new Int16Array([0])),
        threshold: b64(new Float64Array([0.5])),
        missingLeft: b64(new Uint8Array([0])),
        value: b64(new Float64Array([-5, 5])),
        featureVersion: FEATURE_VERSION,
    },
};

const BODY: TextStyle = { size: 10, font: "Times-Roman", bold: false, italic: false };

function makeLine(text: string, l: number, t: number, r = l + 240, h = 12, metrics = true): PageLine {
    const box: BoundingBox = { l, t, r, b: t + h, origin: "top-left" };
    const span: DetectedSpan = {
        text, bbox: box, lineBBox: box, size: BODY.size, fontName: BODY.font, fontWeight: "normal", fontStyle: "normal",
        ...(metrics ? { glyphMetrics: [{ size: BODY.size, glyphs: text.length, baseline: t + h - 2, top: t, bottom: t + h }] } : {}),
    };
    return { spans: [span], bboxes: [box], bbox: box, text, fontSize: BODY.size };
}

function pageOf(blocks: PageLine[][]): PageLineResult {
    const columnResults = blocks.map((lines, columnIndex) => {
        const box = lines.map((line) => line.bbox);
        const x = Math.min(...box.map((b) => b.l));
        const y = Math.min(...box.map((b) => b.t));
        return { column: { x, y, w: Math.max(...box.map((b) => b.r)) - x, h: Math.max(...box.map((b) => b.b)) - y }, columnIndex, lines };
    });
    return { pageIndex: 0, width: 612, height: 792, columnResults, allLines: columnResults.flatMap((c) => c.lines) };
}

/** Blocks of lines 14pt apart, each block from (l, t). */
function makePage(blocks: { l: number; t: number; lines: string[] }[], metrics = true): PageLineResult {
    return pageOf(blocks.map((block) => block.lines.map((text, k) => makeLine(text, block.l, block.t + 14 * k, undefined, 12, metrics))));
}

function detect(
    page: PageLineResult,
    regions: [number, number, number, number][] = [],
    barriers?: DetectParagraphsOptions["barriers"],
) {
    const captured: BoundaryPage[] = [];
    const result = detectParagraphs(page, [BODY], { learnedBoundaries: true }, { paragraph: 0, header: 0 }, {
        trackItemLines: true,
        regions,
        ...(barriers ? { barriers } : {}),
        boundaryModel: CAPITAL_STARTS,
        boundaries: { page: (input) => captured.push(input) },
    });
    return { result, input: captured[0] };
}

describe("learned boundaries", () => {
    it("starts items where the model says so inside a block", () => {
        const { result } = detect(makePage([{ l: 72, t: 100, lines: ["First paragraph that", "wraps here.", "Second one", "ends."] }]));
        expect(result.items.map((item) => item.text)).toEqual(["First paragraph that wraps here.", "Second one ends."]);
        expect(result.itemLines!.map((lines) => lines.length)).toEqual([2, 2]);
    });

    it("joins a block stacked under the previous one when its first line continues", () => {
        const page = makePage([
            { l: 72, t: 100, lines: ["A paragraph the block", "detector cut"] },
            { l: 72, t: 140, lines: ["off here goes on.", "Next paragraph."] },
        ]);
        const { result, input } = detect(page);
        expect(result.items.map((item) => item.text)).toEqual(["A paragraph the block detector cut off here goes on.", "Next paragraph."]);
        const [joined, next] = result.items;
        expect(joined.columnIndex).toBe(0);
        expect(joined.endColumnIndex).toBe(1);
        expect(next.columnIndex).toBe(1);
        expect(next.endColumnIndex).toBeUndefined();
        expect(joined.lineColumns).toEqual([0, 0, 1]);
        expect(next).not.toHaveProperty("lineColumns");
        const drafts = draftItemsFromParagraphs(result);
        expect(drafts.map((d) => [d.columnIndex, d.endColumnIndex, d.lineColumns])).toEqual([
            [0, 1, [0, 0, 1]],
            [1, undefined, undefined],
        ]);
        // The box covers the item's own lines only.
        expect(joined.bbox).toMatchObject({ l: 72, t: 100, r: 312, b: 152 });
        // The input records the model's decisions, with no heuristic trace.
        const lines = input.blocks.flatMap((block) => block.lines);
        expect(lines.map((line) => line.start)).toEqual([true, false, false, true]);
        expect(lines.every((line) => line.rule === null && line.signals === 0)).toBe(true);
        expect(lines[0].probability).toBeUndefined();
        expect(lines[2].probability).toBeLessThan(0.5);
        expect(lines[3].probability).toBeGreaterThan(0.5);
    });

    it("never joins side-by-side columns or blocks with a region between them", () => {
        const columns = makePage([
            { l: 72, t: 100, lines: ["The left column ends", "mid sentence"] },
            { l: 330, t: 100, lines: ["and the right goes on."] },
        ]);
        expect(detect(columns).result.items).toHaveLength(2);
        const stacked = makePage([
            { l: 72, t: 100, lines: ["Text above a figure", "mid sentence"] },
            { l: 72, t: 300, lines: ["and below it."] },
        ]);
        expect(detect(stacked).result.items).toHaveLength(1);
        expect(detect(stacked, [[72, 150, 312, 290]]).result.items).toHaveLength(2);
    });

    it("never joins across a divider rule or a shaded container's edge the column detector kept", () => {
        // Same x, a 2pt gap: without barriers the blocks join.
        const page = () =>
            makePage([
                { l: 72, t: 100, lines: ["Text in a box that", "ends mid sentence"] },
                { l: 72, t: 128, lines: ["and text below it."] },
            ]);
        expect(detect(page()).result.items).toHaveLength(1);
        const divider = { orientation: "horizontal" as const, position: 127, start: 60, end: 330, thickness: 0.5 };
        expect(detect(page(), [], { dividerLines: [divider] }).result.items).toHaveLength(2);
        // A divider beside the blocks is no barrier.
        expect(detect(page(), [], { dividerLines: [{ ...divider, start: 400, end: 560 }] }).result.items).toHaveLength(1);
        // The first block in a shaded box, the second outside it: apart. Both inside one box: joined.
        expect(detect(page(), [], { fillBoundaries: [{ x: 66, y: 96, w: 252, h: 30 }] }).result.items).toHaveLength(2);
        expect(detect(page(), [], { fillBoundaries: [{ x: 66, y: 96, w: 252, h: 50 }] }).result.items).toHaveLength(1);
    });

    it("joins a block that overlaps the previous one vertically, below its last line", () => {
        // The second block starts 8pt above the first one's bottom: not `stacked`, but below and not beside.
        const page = makePage([
            { l: 72, t: 100, lines: ["A paragraph the block", "detector cut"] },
            { l: 72, t: 118, lines: ["off here goes on."] },
        ]);
        const { result, input } = detect(page);
        expect(result.items.map((item) => item.text)).toEqual(["A paragraph the block detector cut off here goes on."]);
        expect(input.blocks[1].lines[0].start).toBe(false);
    });

    it("keeps a line wrapping around a drop cap in its item, whatever the model says", () => {
        // A three-line drop cap "T"; the line beside it opens with a capital, which the stub model reads as a start.
        const dropCap = makeLine("T", 72, 100, 100, 36);
        const wrapped = [makeLine("Here the text wraps", 104, 100), makeLine("around the drop cap.", 104, 114)];
        const { result, input } = detect(pageOf([[dropCap, ...wrapped]]));
        expect(input.blocks[0].lines[1].probability).toBeGreaterThan(0.5);
        expect(result.items.map((item) => item.text)).toEqual(["T Here the text wraps around the drop cap."]);
        // A cap that doesn't reach below the line beside it is no drop cap: the model decides.
        const short = makeLine("T", 72, 100, 100, 14);
        expect(detect(pageOf([[short, ...wrapped]])).result.items.map((item) => item.text)).toEqual([
            "T",
            "Here the text wraps around the drop cap.",
        ]);
    });

    it("never joins blocks that don't overlap horizontally, even beside a tall line", () => {
        // A 48pt heading block with a body block beside it, both starting at the same height: not side by side
        // by `sideBySide` (same top), and the heading reaches far below the body line.
        const heading = makeLine("RESULTS", 72, 100, 160, 48);
        const body = makeLine("and the body text goes on.", 180, 100, 420);
        expect(detect(pageOf([[heading], [body]])).result.items).toHaveLength(2);
    });

    it("joins blocks that overlap horizontally by at least 0.3 of the narrower one", () => {
        // The second block is 100pt wide; it overlaps the first (72–312) by 40pt (0.4), or by 20pt (0.2).
        const page = (l: number) =>
            pageOf([
                [makeLine("A paragraph the block", 72, 100), makeLine("detector cut", 72, 114)],
                [makeLine("off here goes on.", l, 128, l + 100)],
            ]);
        expect(detect(page(272)).result.items).toHaveLength(1);
        expect(detect(page(292)).result.items).toHaveLength(2);
    });

    it("keeps startNewItem on pages without glyph metrics", () => {
        const page = makePage([{ l: 72, t: 100, lines: ["First paragraph that", "Wraps with a capital.", "Second one", "ends."] }], false);
        const { result, input } = detect(page);
        // The heuristic decided: its trace is recorded and no probability is.
        const lines = input.blocks[0].lines;
        expect(lines.every((line) => line.rule !== null && line.probability === undefined)).toBe(true);
        expect(result.items).toHaveLength(1);
    });

    it("leaves today's segmentation alone with the switch off", () => {
        const page = makePage([
            { l: 72, t: 100, lines: ["A paragraph the block", "detector cut"] },
            { l: 72, t: 140, lines: ["off here goes on."] },
        ]);
        const off = detectParagraphs(page, [BODY], {}, { paragraph: 0, header: 0 }, { boundaryModel: CAPITAL_STARTS });
        expect(off.items.map((item) => item.columnIndex)).toEqual([0, 1]);
    });
});
