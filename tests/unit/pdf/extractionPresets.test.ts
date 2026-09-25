import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "@beaver/agent-core/extract/schema";
import {
    CURRENT_PDF_EXTRACTION_PRESET,
    pdfExtractionPreset,
} from "../../../src/beaver-extract/schema/presets";

describe("PDF extraction presets", () => {
    it("keeps text repair off for schema 4", () => {
        expect(pdfExtractionPreset("4")).toEqual({ schemaVersion: "4", textRepair: false });
    });

    it("turns text repair on for schema 5", () => {
        expect(pdfExtractionPreset("5")).toEqual({ schemaVersion: "5", textRepair: true });
    });

    it("returns undefined for a version it can't produce", () => {
        expect(pdfExtractionPreset("3")).toBeUndefined();
    });

    it("uses the preset of the current schema version", () => {
        expect(CURRENT_PDF_EXTRACTION_PRESET.schemaVersion).toBe(SCHEMA_VERSION);
        expect(CURRENT_PDF_EXTRACTION_PRESET.textRepair).toBe(false);
    });
});
