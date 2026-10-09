import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractPdf, itemsExport } from "../../../src/beaver-extract/node/api";
import { createItemPasses } from "../../../src/beaver-extract/pipeline/structured";
import { pdfExtractionPreset, type StructuredExtractResult } from "../../../src/beaver-extract/schema";

const PDF = join(__dirname, "../../fixtures/pdfs/extract-public/_shared/d86a26bf17a0e19194abe41f10b32b4cf86e8caddf3c854773802e5a76b607cf.pdf");

async function structured(): Promise<StructuredExtractResult> {
    const result = await extractPdf({ pdfData: new Uint8Array(readFileSync(PDF)), mode: "structured" });
    if (result.mode !== "structured") throw new Error("expected a structured result");
    const { createdAt: _createdAt, ...rest } = result;
    return rest as StructuredExtractResult;
}

describe("item passes of the presets", () => {
    it("runs the item-type model, then reference entry segmentation, in schema 5 and no pass in schema 4", () => {
        expect(createItemPasses(pdfExtractionPreset("5")!).map((pass) => pass.name)).toEqual(["itemTypes", "references"]);
        expect(createItemPasses(pdfExtractionPreset("4")!)).toEqual([]);
    });
});

describe("item-type pass", () => {
    it("relabels items", async () => {
        const result = await structured();
        const kinds = new Set(result.document.pages.flatMap((page) => page.items.map((item) => item.kind)));
        // Margin items stay internal; captions are emitted as text.
        expect(kinds.has("margin")).toBe(false);
        expect(kinds.has("caption")).toBe(false);
        // Footnotes carry sentences like text.
        for (const page of result.document.pages) {
            for (const item of page.items) {
                if (item.kind === "footnote") expect(item.sentences?.length).toBeGreaterThan(0);
            }
        }
    }, 60_000);

    it("exports its items next to the step-2 units", async () => {
        const pdfData = new Uint8Array(readFileSync(PDF));
        const result = await structured();
        const row = await itemsExport({ pdfData, task: "item-type", bboxPrecision: 1 });
        expect(row.pages.map((page) => page.items.map((item) => [item.id, item.kind]))).toEqual(
            result.document.pages.map((page) => page.items.map((item) => [item.id, item.kind])),
        );
        // Units keep the paragraph detector's kinds.
        const unitKinds = new Set(row.pages.flatMap((page) => page.units.map((unit) => unit.kind)));
        for (const kind of unitKinds) expect(["text", "section_header"]).toContain(kind);
    }, 60_000);
});
