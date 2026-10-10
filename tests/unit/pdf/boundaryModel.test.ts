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

function makeLine(text: string, l: number, t: number, r = l + 240): PageLine {
    const box: BoundingBox = { l, t, r, b: t + 12, origin: "top-left" };
    const span: DetectedSpan = {
        text, bbox: box, lineBBox: box, size: BODY.size, fontName: BODY.font, fontWeight: "normal", fontStyle: "normal",
    };
    return { spans: [span], bboxes: [box], bbox: box, text, fontSize: BODY.size };
}

/** Blocks of lines 14pt apart, each block from (l, t). */
function makePage(blocks: { l: number; t: number; lines: string[] }[]): PageLineResult {
    const columnResults = blocks.map((block, columnIndex) => {
        const lines = block.lines.map((text, k) => makeLine(text, block.l, block.t + 14 * k));
        return { column: { x: block.l, y: block.t, w: 240, h: 14 * lines.length }, columnIndex, lines };
    });
    return { pageIndex: 0, width: 612, height: 792, columnResults, allLines: columnResults.flatMap((c) => c.lines) };
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

    it("leaves today's segmentation alone with the switch off", () => {
        const page = makePage([
            { l: 72, t: 100, lines: ["A paragraph the block", "detector cut"] },
            { l: 72, t: 140, lines: ["off here goes on."] },
        ]);
        const off = detectParagraphs(page, [BODY], {}, { paragraph: 0, header: 0 }, { boundaryModel: CAPITAL_STARTS });
        expect(off.items.map((item) => item.columnIndex)).toEqual([0, 1]);
    });
});
