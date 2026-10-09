import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parsePresetOverrides } from "../../../src/beaver-extract/cli/options";
import { extractPdf, itemsExport } from "../../../src/beaver-extract/node/api";
import { createItemPasses } from "../../../src/beaver-extract/pipeline/structured";
import {
    applyPresetOverrides,
    pdfExtractionPreset,
    type StructuredExtractResult,
} from "../../../src/beaver-extract/schema";

const PDF = join(__dirname, "../../fixtures/pdfs/extract-public/_shared/d86a26bf17a0e19194abe41f10b32b4cf86e8caddf3c854773802e5a76b607cf.pdf");

async function structured(presetOverrides?: { itemTypeModel?: boolean }): Promise<StructuredExtractResult> {
    const result = await extractPdf({
        pdfData: new Uint8Array(readFileSync(PDF)),
        mode: "structured",
        ...(presetOverrides ? { presetOverrides } : {}),
    });
    if (result.mode !== "structured") throw new Error("expected a structured result");
    const { createdAt: _createdAt, ...rest } = result;
    return rest as StructuredExtractResult;
}

const references = (result: StructuredExtractResult) =>
    result.document.pages.flatMap((page) =>
        page.items.filter((item) => item.kind === "reference").map((item) => [page.index, item.bbox, item.text]),
    );

describe("item-type preset switch", () => {
    it("is off in schemas 4 and 5, and the CLI may turn it on", () => {
        expect(pdfExtractionPreset("4")!.itemTypeModel).toBe(false);
        expect(pdfExtractionPreset("5")!.itemTypeModel).toBe(false);
        const on = applyPresetOverrides(pdfExtractionPreset("5")!, { itemTypeModel: true });
        expect(createItemPasses(on).map((pass) => pass.name)).toEqual(["itemTypes", "references"]);
        expect(createItemPasses(pdfExtractionPreset("5")!).map((pass) => pass.name)).toEqual(["references"]);
        const v4 = applyPresetOverrides(pdfExtractionPreset("4")!, { itemTypeModel: true });
        expect(createItemPasses(v4).map((pass) => pass.name)).toEqual(["itemTypes"]);
    });

    it("parses --preset switches and rejects unknown ones", () => {
        expect(parsePresetOverrides("itemTypeModel")).toEqual({ itemTypeModel: true });
        expect(parsePresetOverrides("itemTypeModel=false")).toEqual({ itemTypeModel: false });
        expect(() => parsePresetOverrides("regions=false")).toThrow(/can't be overridden/);
        expect(() => parsePresetOverrides("itemTypeModel=yes")).toThrow(/--preset/);
    });
});

describe("item-type pass", () => {
    it("changes nothing with the switch off", async () => {
        expect(await structured({ itemTypeModel: false })).toEqual(await structured());
    }, 60_000);

    it("relabels items while the reference pass keeps deciding references", async () => {
        const off = await structured();
        const on = await structured({ itemTypeModel: true });
        expect(references(on)).toEqual(references(off));
        const kinds = new Set(on.document.pages.flatMap((page) => page.items.map((item) => item.kind)));
        // Margin items stay internal; captions are emitted as text.
        expect(kinds.has("margin")).toBe(false);
        expect(kinds.has("caption")).toBe(false);
        // Footnotes carry sentences like text.
        for (const page of on.document.pages) {
            for (const item of page.items) {
                if (item.kind === "footnote") expect(item.sentences?.length).toBeGreaterThan(0);
            }
        }
    }, 60_000);

    it("exports its items next to the step-2 units", async () => {
        const pdfData = new Uint8Array(readFileSync(PDF));
        const on = await structured({ itemTypeModel: true });
        const row = await itemsExport({ pdfData, task: "item-type", presetOverrides: { itemTypeModel: true }, bboxPrecision: 1 });
        expect(row.pages.map((page) => page.items.map((item) => [item.id, item.kind]))).toEqual(
            on.document.pages.map((page) => page.items.map((item) => [item.id, item.kind])),
        );
        // Units keep the paragraph detector's kinds.
        const unitKinds = new Set(row.pages.flatMap((page) => page.units.map((unit) => unit.kind)));
        for (const kind of unitKinds) expect(["text", "section_header"]).toContain(kind);
    }, 60_000);
});
