import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractPdf, itemsExport } from "../../../src/beaver-extract/node/api";
import { FEATURES, FEATURE_GROUPS, FEATURE_SET, FEATURE_VERSION, itemTypeFeatures } from "../../../src/beaver-extract/itemTypes/features";
import { buildTypedDocument, type TypedDocument, type TypedItem, type TypedPage } from "../../../src/beaver-extract/itemTypes/input";
import { ITEMS_EXPORT_TASKS } from "../../../src/beaver-extract/pipeline/itemsExport";
import { ITEM_FEATURES as REFERENCE_ITEM_FEATURES } from "../../../src/beaver-extract/itemTypes/referenceFeatures";

const PDF = join(__dirname, "../../fixtures/pdfs/extract-public/_shared/d86a26bf17a0e19194abe41f10b32b4cf86e8caddf3c854773802e5a76b607cf.pdf");
const FIXTURE = join(__dirname, "fixtures/itemTypeFeatureParity.json");

interface ParityFixture {
    featureSet: string;
    featureVersion: number;
    names: string[];
    input: TypedDocument;
    /** Feature rows per page and item; null for NaN. */
    expected: (number | null)[][][];
}

const asJson = (rows: number[][][]) => rows.map((page) => page.map((row) => row.map((v) => (Number.isNaN(v) ? null : v))));

/** The item-type input of the public fixture PDF, captured where the export computes features. */
async function captureInput(): Promise<TypedDocument> {
    let input: TypedDocument | undefined;
    ITEMS_EXPORT_TASKS.capture = {
        ...ITEMS_EXPORT_TASKS["item-type"],
        compute: (doc) => {
            input = buildTypedDocument(doc);
            return itemTypeFeatures(input);
        },
    };
    try {
        await itemsExport({ pdfData: new Uint8Array(readFileSync(PDF)), task: "capture" });
    } finally {
        delete ITEMS_EXPORT_TASKS.capture;
    }
    return input!;
}

// Pins the feature implementation. Training reads the values from `items
// export`; a change here needs a FEATURE_VERSION bump and a new export.
// Regenerate with UPDATE_ITEM_TYPE_FIXTURE=1 after a deliberate change.
describe("item-type features", () => {
    it("names every column once, the reference item features last", () => {
        expect(new Set(FEATURES).size).toBe(FEATURES.length);
        expect(FEATURE_GROUPS.reference).toHaveLength(REFERENCE_ITEM_FEATURES.length);
        expect(FEATURES.slice(-REFERENCE_ITEM_FEATURES.length)).toEqual([...FEATURE_GROUPS.reference]);
    });

    it("reproduces the fixture's feature rows from its input", async () => {
        if (process.env.UPDATE_ITEM_TYPE_FIXTURE) {
            const input = await captureInput();
            const fixture: ParityFixture = {
                featureSet: FEATURE_SET,
                featureVersion: FEATURE_VERSION,
                names: [...FEATURES],
                input,
                expected: asJson(itemTypeFeatures(input)),
            };
            writeFileSync(FIXTURE, JSON.stringify(fixture) + "\n");
        }
        const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as ParityFixture;
        expect(fixture.featureSet).toBe(FEATURE_SET);
        expect(fixture.featureVersion).toBe(FEATURE_VERSION);
        expect(fixture.names).toEqual([...FEATURES]);
        expect(fixture.expected.flat().length).toBeGreaterThan(5);
        expect(asJson(itemTypeFeatures(fixture.input))).toEqual(fixture.expected);
    }, 60_000);

    it("reads document context across pages", () => {
        const line = (text: string, t: number, size = 10): TypedItem["lines"][number] => ({
            text, l: 72, t, r: 300, b: t + size, size, role: 0, lead: 1, font: "Body", bold: 0, italic: 0,
        });
        const item = (text: string, t: number, extra: Partial<TypedItem> = {}): TypedItem => ({
            header: false, column: 0, text, lines: [line(text, t)], marginPages: 0, ...extra,
        });
        const page = (pageIndex: number, items: TypedItem[]): TypedPage => ({
            pageIndex, width: 612, height: 792, bodySize: 10, items, columns: [[72, 72, 540, 720]], regions: [],
        });
        const doc: TypedDocument = {
            pageCount: 3,
            marginWindow: [0, 1, 2],
            body: { size: 10, font: "Body", bold: false, italic: false },
            pages: [
                page(0, [item("Journal of Things", 40, { marginPages: 2 }), item("Body text that runs on.", 100)]),
                page(1, [item("Journal of Things", 40), item("References", 100, { header: true }), item("Smith, J. (2001). A study. Journal, 3, 1–9.", 130)]),
                page(2, [item("Journal of Things", 40), item("Jones, K. (1999). Another. Press.", 100)]),
            ],
        };
        const rows = itemTypeFeatures(doc);
        const col = (name: string) => FEATURES.indexOf(name);
        // Repetition is a share of the other pages, next to a capped count.
        expect(rows[0][0][col("marginRepeat")]).toBe(1);
        expect(rows[0][0][col("marginRepeatCount")]).toBe(0.2);
        expect(rows[0][1][col("marginRepeat")]).toBe(0);
        expect(rows[0][0][col("windowPages")]).toBeCloseTo(Math.log1p(3) / 6, 4);
        expect(rows[0][0][col("textRepeat")]).toBe(1);
        expect(rows[0][0][col("textRepeatCount")]).toBe(0.2);
        expect(rows[0][1][col("textRepeat")]).toBe(0);
        expect(rows[0][0][col("gapAbove")]).toBeNaN();
        expect(rows[1][2][col("refHeadingOnPage")]).toBe(1);
        expect(rows[2][1][col("refHeadingBefore")]).toBe(1);
        expect(rows[2][1][col("refHeadingOnPage")]).toBe(0);
        expect(rows[2][1][col("headingsBefore")]).toBeCloseTo(Math.log1p(1) / 4, 4);
        expect(rows[0][1][col("sinceRefHeading")]).toBeNaN();
    });
});

describe("items export", () => {
    it("lists the structured result's items with their ids and boxes, and a feature row per unit", async () => {
        const pdfData = new Uint8Array(readFileSync(PDF));
        const structured = await extractPdf({ pdfData: pdfData.slice(), mode: "structured", structured: { bboxPrecision: 2 } });
        const row = await itemsExport({ pdfData: pdfData.slice(), task: "item-type", bboxPrecision: 2 });
        if (structured.mode !== "structured") throw new Error("expected a structured result");
        expect(row.pages.map((p) => p.items.map((item) => [item.id, item.kind, item.bbox]))).toEqual(
            structured.document.pages.map((p) => p.items.map((item) => [item.id, item.kind, item.bbox])),
        );
        expect(row).toMatchObject({ feature_set: FEATURE_SET, feature_version: FEATURE_VERSION });
        for (const page of row.pages) {
            expect(page.units.map((unit) => unit.unit)).toEqual(page.units.map((_, i) => i));
            for (const unit of page.units) {
                expect(unit.features).toHaveLength(FEATURES.length);
                for (const v of unit.features) expect(v === null || Number.isFinite(v)).toBe(true);
                expect(unit.lines.length).toBeGreaterThan(0);
            }
            // Every unit belongs to an item, or the item-type model read it as
            // page furniture and it is listed with the filtered lines. Text
            // items list their units, region items none.
            const listed = new Set(page.items.flatMap((item) => item.units));
            const filtered = new Set(page.filtered_lines.map((line) => line.text));
            for (const unit of page.units) {
                if (!listed.has(unit.unit)) expect(filtered.has(unit.text), unit.text).toBe(true);
            }
            expect([...listed].every((u) => u >= 0 && u < page.units.length)).toBe(true);
            for (const item of page.items) {
                const region = item.kind === "picture" || item.kind === "table" || item.kind === "formula";
                expect(item.units.length > 0).toBe(!region);
                if (!region) expect(item.lines.length).toBeGreaterThan(0);
            }
        }
    }, 60_000);
});
