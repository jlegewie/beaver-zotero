import { describe, expect, it } from "vitest";

import type { StructuredExtractResult } from "@beaver/agent-core/extract/schema";

import { extractPdf } from "../../../src/beaver-extract/node/api";
import { syntheticFigurePdf, syntheticSpanningTablePdf } from "../../helpers/syntheticRegionPdf";

async function extract(schemaVersion: string, pdf: () => Uint8Array = syntheticFigurePdf) {
    const result = (await extractPdf({
        pdfData: pdf(),
        mode: "structured",
        schemaVersion,
        settings: { checkTextLayer: false },
    })) as StructuredExtractResult;
    return result.document.pages[0].items;
}

const proseText = (items: Awaited<ReturnType<typeof extract>>) =>
    items.filter((i) => i.kind === "text").map((i) => ("text" in i ? i.text : "")).join("\n");

describe("regions in structured extraction", () => {
    it("emits figures with their labels in schema 5 and keeps captions as prose", async () => {
        const items = await extract("5");
        const pictures = items.filter((i) => i.kind === "picture");
        expect(pictures.map((p) => p.id)).toEqual(["fig1.1", "fig1.2"]);
        // The chart keeps its axis title; tick numbers are dropped from it and leave the prose.
        expect(pictures[0].text).toBe("Time in minutes");
        expect(pictures[1].text).toBeUndefined();
        const prose = proseText(items);
        expect(prose).not.toContain("Time in minutes");
        expect(prose).not.toMatch(/\b0 20 40\b/);
        expect(prose).toContain("Figure 1. A synthetic chart");
        expect(prose).toContain("Figure 2. A synthetic photo.");
        // Each figure comes right before its caption.
        const order = items.map((i) => (i.kind === "picture" ? i.id : "text" in i ? i.text.slice(0, 8) : i.kind));
        expect(order[order.indexOf("fig1.1") + 1]).toBe("Figure 1");
        expect(order[order.indexOf("fig1.2") + 1]).toBe("Figure 2");
    });

    it.each([
        ["upright", false],
        ["upside down", true],
    ])("reads both columns above a full-width table before the table and the text below it (%s)", async (_, upsideDown) => {
        const items = await extract("5", () => syntheticSpanningTablePdf(upsideDown));
        const tables = items.filter((i) => i.kind === "table");
        expect(tables).toHaveLength(1);
        const rows = tables[0].text.split("\n");
        expect(rows[0]).toBe("Variable | Model 1 | Model 2 | Model 3 | Model 4 | Model 5");
        expect(rows[1]).toBe("Covariate 1 | 0.137 | 0.274 | 0.411 | 0.548 | 0.685");

        const order = items.map((i) => (i.kind === "table" ? "table" : "text" in i ? i.text.slice(0, 11) : i.kind));
        expect(order.filter((o) => /upper|lower|table/.test(o))).toEqual([
            "Left upper ",
            "Right upper",
            "table",
            "Left lower ",
            "Right lower",
        ]);
    });

    it("keeps the page orientation when the text outside a table is too short to detect it", async () => {
        const items = await extract("5", () => syntheticSpanningTablePdf(true, true));
        const order = items.map((i) => (i.kind === "table" ? "table" : "text" in i ? i.text : i.kind));
        expect(order).toEqual([
            "Left upper 0: short. Left upper 1: short. Left upper 2: short.",
            "Table 1. A synthetic table spanning both columns.",
            "table",
            "Left lower 0: short. Left lower 1: short. Left lower 2: short.",
        ]);
    });

    it("leaves schema 4 without regions", async () => {
        const items = await extract("4");
        expect(items.some((i) => i.kind === "picture")).toBe(false);
        expect(proseText(items)).toContain("Time in minutes");
    });
});
