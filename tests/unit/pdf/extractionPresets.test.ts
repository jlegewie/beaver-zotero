import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "@beaver/agent-core/extract/schema";
import {
    CURRENT_PDF_EXTRACTION_PRESET,
    PRODUCIBLE_PDF_SCHEMA_VERSIONS,
    pdfExtractionPreset,
} from "../../../src/beaver-extract/schema/presets";

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
        expect(CURRENT_PDF_EXTRACTION_PRESET.textRepair).toBe(false);
        expect(CURRENT_PDF_EXTRACTION_PRESET.idScheme).toBe("document");
    });

    it("declares only the current version producible, and every producible version has a preset", () => {
        expect(PRODUCIBLE_PDF_SCHEMA_VERSIONS).toEqual([SCHEMA_VERSION]);
        for (const version of PRODUCIBLE_PDF_SCHEMA_VERSIONS) {
            expect(pdfExtractionPreset(version)).toBeDefined();
        }
    });
});
