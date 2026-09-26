import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "@beaver/agent-core/extract/schema";
import {
    CURRENT_PDF_EXTRACTION_PRESET,
    PRODUCIBLE_PDF_SCHEMA_VERSIONS,
    pdfExtractionPreset,
} from "../../../src/beaver-extract/schema/presets";
import { detailedStructuredTextOptions } from "../../../src/beaver-extract/worker/docHelpers";

describe("PDF extraction presets", () => {
    it("keeps text repair off and ids document-wide for schema 4", () => {
        expect(pdfExtractionPreset("4")).toEqual({
            schemaVersion: "4",
            textRepair: false,
            idScheme: "document",
        });
    });

    it("turns text repair on and ids page-scoped for schema 5", () => {
        expect(pdfExtractionPreset("5")).toEqual({
            schemaVersion: "5",
            textRepair: true,
            idScheme: "page",
        });
    });

    it("returns undefined for a version it can't produce", () => {
        expect(pdfExtractionPreset("3")).toBeUndefined();
    });

    it("uses the preset of the current schema version", () => {
        expect(CURRENT_PDF_EXTRACTION_PRESET.schemaVersion).toBe(SCHEMA_VERSION);
        expect(CURRENT_PDF_EXTRACTION_PRESET.textRepair).toBe(true);
        expect(CURRENT_PDF_EXTRACTION_PRESET.idScheme).toBe("page");
    });

    it("declares schema 4 and the current version producible, and every producible version has a preset", () => {
        expect(SCHEMA_VERSION).toBe("5");
        expect(PRODUCIBLE_PDF_SCHEMA_VERSIONS).toEqual(["4", "5"]);
        for (const version of PRODUCIBLE_PDF_SCHEMA_VERSIONS) {
            expect(pdfExtractionPreset(version)).toBeDefined();
        }
    });
});

describe("detailed structured-text options", () => {
    const options = (includeImages: boolean, version: string) =>
        detailedStructuredTextOptions(includeImages, pdfExtractionPreset(version)!.textRepair).split(",");

    it("keeps ligatures as single characters for schema 4", () => {
        expect(options(false, "4")).toEqual(["preserve-whitespace", "preserve-ligatures"]);
        expect(options(true, "4")).toEqual([
            "preserve-whitespace",
            "preserve-images",
            "preserve-ligatures",
        ]);
    });

    it("lets MuPDF expand ligatures into letters for schema 5", () => {
        for (const includeImages of [false, true]) {
            const opts = options(includeImages, "5");
            expect(opts).not.toContain("preserve-ligatures");
            expect(opts).toContain("use-known-glyph-outlines");
            expect(opts).toContain("space-after-symbols");
            expect(opts.includes("preserve-images")).toBe(includeImages);
        }
    });
});
