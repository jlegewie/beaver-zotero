import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { itemsExport } from "../../../src/beaver-extract/node/api";
import {
    FEATURES,
    FEATURE_GROUPS,
    FEATURE_SET,
    FEATURE_VERSION,
    boundaryFeatures,
    boundaryRow,
    prepareBoundaryPage,
} from "../../../src/beaver-extract/boundaries/features";
import type { BlockThresholds, BoundaryLine, BoundaryPage } from "../../../src/beaver-extract/boundaries/input";
import { START_RULES } from "../../../src/beaver-extract/boundaries/rules";
import { ITEMS_EXPORT_TASKS, type ItemsExportRow } from "../../../src/beaver-extract/pipeline/itemsExport";
import { lineGeometry } from "../../../src/beaver-extract/features/style";
import { detectLinesOnPage, type DetectedSpan, type PageLine } from "../../../src/beaver-extract/LineDetector";
import { rotateRawPage } from "../../../src/beaver-extract/PageRotationNormalizer";
import type { RawGlyphMetrics, RawLine, RawPageData } from "@beaver/agent-core/extract/types";

const PDF = join(__dirname, "../../fixtures/pdfs/extract-public/_shared/d86a26bf17a0e19194abe41f10b32b4cf86e8caddf3c854773802e5a76b607cf.pdf");
const FIXTURE = join(__dirname, "fixtures/boundaryFeatureParity.json");

interface ParityFixture {
    featureSet: string;
    featureVersion: number;
    names: string[];
    input: BoundaryPage[];
    /** Feature rows per page, block and line; null for NaN. */
    expected: (number | null)[][][][];
}

const asJson = (rows: number[][][]) => rows.map((block) => block.map((row) => row.map((v) => (Number.isNaN(v) ? null : v))));

/** The boundary input of the public fixture PDF's pages, captured where the export computes features. */
async function captureInput(): Promise<BoundaryPage[]> {
    const pages: BoundaryPage[] = [];
    ITEMS_EXPORT_TASKS.capture = {
        ...ITEMS_EXPORT_TASKS.boundaries,
        lineFeatures: (page) => {
            pages.push(page);
            return boundaryFeatures(page);
        },
    };
    try {
        await itemsExport({ pdfData: new Uint8Array(readFileSync(PDF)), task: "capture" });
    } finally {
        delete ITEMS_EXPORT_TASKS.capture;
    }
    return pages;
}

const col = (name: string) => FEATURES.indexOf(name as (typeof FEATURES)[number]);

const THRESHOLDS: BlockThresholds = {
    leftEdgeMode: 72,
    rightEdgeMode: 300,
    leftEdgeMad: 0,
    rightEdgeMad: 0,
    maxRightEdge: 300,
    indentExcessThreshold: 5,
    earlyEndExcessThreshold: 45,
    gapExcessThreshold: 4,
    medianGap: 2,
};

/** A body line at `top` with its baseline 8 below and its core the line's box. */
function line(text: string, top: number, extra: Partial<BoundaryLine> = {}): BoundaryLine {
    const style = { font: "Body", size: 10, bold: false, italic: false };
    return {
        l: 72, t: top, r: 300, b: top + 10, text, size: 10, font: "Body", bold: 0, italic: 0,
        first: style, last: style, lead: null, baseline: top + 8, coreTop: top, coreBottom: top + 10,
        start: false, rule: "none", signals: 0, vetoes: 0, role: 0, headerStyle: false, isolatedHeading: false,
        ...extra,
    };
}

function page(blocks: BoundaryLine[][], regions: BoundaryPage["regions"] = []): BoundaryPage {
    return {
        pageIndex: 0,
        width: 612,
        height: 792,
        body: { size: 10, font: "Body", bold: false, italic: false },
        medianHeight: 10,
        gapExcessThreshold: 4,
        regions,
        blocks: blocks.map((lines, index) => ({ index, lines, thresholds: THRESHOLDS })),
    };
}

// Pins the feature implementation. Training reads the values from `items
// export`; a change here needs a FEATURE_VERSION bump and a new export.
// Regenerate with UPDATE_BOUNDARY_FIXTURE=1 after a deliberate change.
describe("boundary features", () => {
    it("names every column once", () => {
        expect(new Set(FEATURES).size).toBe(FEATURES.length);
        expect(FEATURES).toEqual(Object.values(FEATURE_GROUPS).flat());
    });

    it("reproduces the fixture's feature rows from its input", async () => {
        if (process.env.UPDATE_BOUNDARY_FIXTURE) {
            const input = await captureInput();
            const fixture: ParityFixture = {
                featureSet: FEATURE_SET,
                featureVersion: FEATURE_VERSION,
                names: [...FEATURES],
                input,
                expected: input.map((p) => asJson(boundaryFeatures(p))),
            };
            writeFileSync(FIXTURE, JSON.stringify(fixture) + "\n");
        }
        const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as ParityFixture;
        expect(fixture.featureSet).toBe(FEATURE_SET);
        expect(fixture.featureVersion).toBe(FEATURE_VERSION);
        expect(fixture.names).toEqual([...FEATURES]);
        expect(fixture.input.flatMap((p) => p.blocks).length).toBeGreaterThan(1);
        expect(fixture.input.map((p) => asJson(boundaryFeatures(p)))).toEqual(fixture.expected);
    }, 60_000);

    it("measures gaps baseline to baseline, so a tall inline formula does not read as a break", () => {
        // The middle line carries a formula 4pt above its core: its box gap above shrinks, below grows.
        const lines = [
            line("The model is", 100),
            line("given by x = ∑ a over the sample, where", 112, { t: 108, coreTop: 112 }),
            line("each term is weighted.", 124),
        ];
        const prep = prepareBoundaryPage(page([lines]));
        const above = boundaryRow(prep, 0, 1);
        const below = boundaryRow(prep, 0, 2);
        expect(above[col("pitch")]).toBe(1.2);
        expect(below[col("pitch")]).toBe(1.2);
        expect(above[col("pitchVsBlock")]).toBe(0);
        expect(above[col("gap")]).toBe(-0.2);
        expect(below[col("gap")]).toBe(0.2);
        expect(above[col("coreGap")]).toBe(0.2);
        expect(above[col("extraAboveJ")]).toBe(0.4);
        expect(below[col("extraAboveI")]).toBe(0.4);
    });

    it("describes a block's first line against the previous block's last", () => {
        const first = [line("A paragraph that the", 100), line("block detector cut", 112)];
        const second = [line("off here continues.", 160), line("More text.", 172)];
        const side = [{ ...line("Other column", 100), l: 320, r: 540 }];
        const region: [number, number, number, number] = [72, 125, 300, 155];
        const prep = prepareBoundaryPage(page([first, second, side], [region]));
        const stacked = boundaryRow(prep, 1, 0);
        expect(stacked[col("pairType")]).toBe(1);
        expect(stacked[col("stacked")]).toBe(1);
        expect(stacked[col("blockOverlap")]).toBe(1);
        expect(stacked[col("sideBySide")]).toBe(0);
        expect(stacked[col("regionBetween")]).toBe(1);
        expect(stacked[col("textBetween")]).toBe(0);
        expect(stacked[col("gap")]).toBe(3.8);
        const column = boundaryRow(prep, 2, 0);
        expect(column[col("stacked")]).toBe(0);
        expect(column[col("sideBySide")]).toBe(1);
        const pageFirst = boundaryRow(prep, 0, 0);
        expect(pageFirst[col("pairType")]).toBe(2);
        expect(pageFirst[col("gap")]).toBeNaN();
        expect(boundaryRow(prep, 0, 1)[col("stacked")]).toBeNaN();
    });

    it("reads the next number of a list from the lines above, not from the item", () => {
        const lines = [
            line("1. First entry that", 100),
            line("wraps.", 112),
            line("2. Second entry.", 124),
            line("4. Not the next one.", 136),
        ];
        const rows = boundaryFeatures(page([lines]))[0];
        expect(rows.map((r) => r[col("numberNext")])).toEqual([0, 0, 1, 0]);
        expect(rows.map((r) => r[col("listNumber")])).toEqual([1, 0, 1, 1]);
        expect(rows[2][col("endsTerminal")]).toBe(1);
        expect(rows[1][col("startsLower")]).toBe(1);
    });
});

describe("items export --task boundaries", () => {
    it("lists the flow lines in unit order, with the detector's decisions and a feature row each", async () => {
        const pdfData = new Uint8Array(readFileSync(PDF));
        const row = (await itemsExport({ pdfData: pdfData.slice(), task: "boundaries", bboxPrecision: 2 })) as ItemsExportRow;
        const itemType = (await itemsExport({ pdfData: pdfData.slice(), task: "item-type", bboxPrecision: 2 })) as ItemsExportRow;
        expect(row).toMatchObject({ feature_set: FEATURE_SET, feature_version: FEATURE_VERSION, names: [...FEATURES] });
        expect(itemType.names).toBeUndefined();
        expect(row.pages.map((p) => [p.items, p.filtered_lines])).toEqual(itemType.pages.map((p) => [p.items, p.filtered_lines]));
        for (const [k, p] of row.pages.entries()) {
            const lines = p.lines!;
            expect(lines.length).toBeGreaterThan(10);
            expect(p.units.map(({ features, ...unit }) => unit)).toEqual(itemType.pages[k].units.map(({ features, ...unit }) => unit));
            // The flow is the units' lines in order.
            const fromUnits = p.units.flatMap((unit) => unit.lines.map((l) => [l.bbox, l.text, unit.unit]));
            expect(lines.map((l) => [l.bbox, l.text, l.unit])).toEqual(fromUnits);
            lines.forEach((l, n) => {
                // A line starts a unit exactly where the detector decided so.
                expect(l.start).toBe(n === 0 || lines[n - 1].unit !== l.unit);
                expect(l.start).toBe(l.reason !== "none" && l.reason !== "heading_continues");
                expect(START_RULES).toContain(l.reason);
                expect(l.features).toHaveLength(FEATURES.length);
                expect(l.features[col("start")]).toBe(l.start ? 1 : 0);
                expect(l.baseline).not.toBeNull();
                expect(l.baseline!).toBeGreaterThan(l.coreTop!);
                expect(l.baseline!).toBeLessThan(l.coreBottom!);
            });
            expect(p.units.every((unit) => unit.features.length === 0)).toBe(true);
        }
    }, 60_000);
});

describe("line geometry", () => {
    const box = (t: number, b: number) => ({ l: 72, t, r: 300, b, origin: "top-left" as const });
    function span(text: string, size: number, metrics: RawGlyphMetrics[]): DetectedSpan {
        const font = { name: "Body", family: "Body", weight: "normal", style: "normal", size: Math.trunc(size) };
        return {
            text, bbox: box(40, 52), lineBBox: box(40, 52), size, fontName: "Body",
            styleRuns: [{ font, exactSize: size, chars: text.replace(/\s/g, "").length, letters: 0 }],
            glyphMetrics: metrics,
        };
    }
    const pageLine = (spans: DetectedSpan[]): PageLine => ({
        spans, bboxes: spans.map((s) => s.bbox), bbox: box(36, 52), text: spans.map((s) => s.text).join(" "), fontSize: 10,
    });

    it("reads the baseline and core of the dominant size, not of merged scripts", () => {
        const line = pageLine([
            span("body text of the line", 10, [{ size: 10, glyphs: 18, baseline: 50, top: 42, bottom: 52 }]),
            span("2", 6, [{ size: 6, glyphs: 1, baseline: 45, top: 36, bottom: 47 }]),
        ]);
        expect(lineGeometry(line)).toEqual({ baseline: 50, coreTop: 42, coreBottom: 52 });
    });

    it("combines spans of the dominant size by their glyphs", () => {
        const line = pageLine([
            span("short", 10, [{ size: 10, glyphs: 5, baseline: 51, top: 43, bottom: 53 }]),
            span("the longer part", 10, [{ size: 10, glyphs: 13, baseline: 50, top: 42, bottom: 52 }]),
        ]);
        expect(lineGeometry(line)).toEqual({ baseline: 50, coreTop: 42, coreBottom: 52 });
    });

    it("is null without glyph metrics", () => {
        const plain = span("text", 10, []);
        delete plain.glyphMetrics;
        expect(lineGeometry(pageLine([plain]))).toBeNull();
    });

    it("turns the metrics of rotated text upright with the page", () => {
        const metrics = [{ size: 10, glyphs: 5, baseline: 102, top: 110, bottom: 100 }];
        const rawLine = (rotation: 0 | 90): RawLine => ({
            wmode: 0, bbox: { l: 100, t: 50, r: 112, b: 400, origin: "top-left" },
            font: { name: "Body", family: "Body", weight: "normal", style: "normal", size: 10 },
            x: 100, y: 50, text: "rotated", rotation, glyphMetrics: metrics,
        });
        const raw: RawPageData = {
            pageIndex: 0, pageNumber: 1, width: 612, height: 792,
            blocks: [{ type: "text", bbox: { l: 100, t: 50, r: 112, b: 400, origin: "top-left" }, lines: [rawLine(90), rawLine(0)] }],
        } as RawPageData;
        const [upright, other] = rotateRawPage(raw, 90).page.blocks[0].lines!;
        // Upright y is the page width minus the source x: the ascent edge is on top.
        expect(upright.glyphMetrics).toEqual([{ size: 10, glyphs: 5, baseline: 510, top: 502, bottom: 512 }]);
        expect(other.glyphMetrics).toBeUndefined();
        expect(rotateRawPage(raw, 0).page.blocks[0].lines![0].glyphMetrics).toBe(metrics);
    });

    it("keeps glyph metrics only for lines written in the page's upright direction", () => {
        const metrics = [{ size: 10, glyphs: 5, baseline: 58, top: 50, bottom: 60 }];
        const rawLine = (rotation: 0 | 90, bbox: RawLine["bbox"]): RawLine => ({
            wmode: 0, bbox, font: { name: "Body", family: "Body", weight: "normal", style: "normal", size: 10 },
            x: bbox.l, y: bbox.t, text: rotation ? "rotated label" : "upright body text", rotation, glyphMetrics: metrics,
        });
        const upright = rawLine(0, { l: 72, t: 50, r: 300, b: 60, origin: "top-left" });
        const label = rawLine(90, { l: 320, t: 40, r: 330, b: 200, origin: "top-left" });
        const raw = {
            pageIndex: 0, pageNumber: 1, width: 612, height: 792,
            blocks: [{ type: "text", bbox: { l: 72, t: 40, r: 330, b: 200, origin: "top-left" }, lines: [upright, label] }],
        } as RawPageData;
        const column = { x: 0, y: 0, w: 612, h: 792 };
        const spans = (page: RawPageData, textRotation: 0 | 90) =>
            detectLinesOnPage(page, [column], { textRotation }).allLines.flatMap((l) => l.spans);
        // An upright page: the rotated label's metrics lie on the x axis and are dropped.
        const onUpright = spans(raw, 0);
        expect(onUpright.find((s) => s.text === "upright body text")!.glyphMetrics).toBe(metrics);
        expect(onUpright.find((s) => s.text === "rotated label")!.glyphMetrics).toBeUndefined();
        // A page turned upright by 90°: the label is upright and keeps its (turned) metrics.
        const onRotated = spans(rotateRawPage(raw, 90).page, 90);
        expect(onRotated.find((s) => s.text === "rotated label")!.glyphMetrics).toHaveLength(1);
        expect(onRotated.find((s) => s.text === "upright body text")!.glyphMetrics).toBeUndefined();
    });
});

