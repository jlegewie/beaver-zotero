/**
 * Unit tests for `validateOcrFixture()`.
 *
 * Targets: each failure path surfaces a path-prefixed
 * `OcrFixtureValidationError`, and a well-formed fixture round-trips.
 */
import { describe, it, expect } from "vitest";

import {
    OCR_FIXTURE_SCHEMA_VERSION,
    OcrFixtureValidationError,
    validateOcrFixture,
} from "../../../src/beaver-extract/cli/fixture/ocrFixtureSchema";

function wellFormed(): Record<string, unknown> {
    return {
        schema: OCR_FIXTURE_SCHEMA_VERSION,
        id: "TESTKEY",
        capturedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pdfSha256: "a".repeat(64),
        pdfBytes: 1024,
        config: {
            options: {},
            effectiveOptions: {
                minTextPerPage: 100,
                sampleSize: 6,
                expandedSampleSize: 20,
                expandLowerThreshold: 0.1,
                expandUpperThreshold: 0.8,
                confirmationThreshold: 0.5,
                maxWhitespaceRatio: 0.7,
                maxNewlineRatio: 0.6,
                minAlphanumericRatio: 0.3,
                maxInvalidCharRatio: 0.3,
                minValidCharsToAccept: 1000,
                imageCoverageThreshold: 0.65,
                maxLineOverlapRatio: 0.1,
                boundaryMargin: 5,
                checkBoundingBoxes: false,
            },
        },
        fingerprints: {
            extractorGitSha: null,
            extractorVersion: null,
            mupdfWasmSha256: "0".repeat(64),
        },
        tolerance: { issueRatioAbs: 0.02, textLengthAbs: 5 },
        expected: {
            needsOCR: false,
            primaryReason: "text_extraction_acceptable",
            issueRatio: 0,
            issueBreakdown: {
                no_text_blocks: 0,
                insufficient_text: 0,
                high_whitespace_ratio: 0,
                high_newline_ratio: 0,
                low_alphanumeric_ratio: 0,
                invalid_characters: 0,
                large_image_coverage: 0,
                bbox_overflow: 0,
                excessive_line_overlap: 0,
            },
            sampledPages: 6,
            totalPages: 12,
            pageAnalyses: [
                {
                    pageIndex: 1,
                    hasIssues: false,
                    issues: [],
                    textLength: 1500,
                    hasImages: false,
                },
            ],
        },
    };
}

describe("validateOcrFixture", () => {
    it("accepts a well-formed fixture", () => {
        const fix = validateOcrFixture(wellFormed());
        expect(fix.id).toBe("TESTKEY");
        expect(fix.expected.pageAnalyses).toHaveLength(1);
        expect(fix.notes).toBeUndefined();
    });

    it("preserves an explicit notes field", () => {
        const raw = wellFormed();
        raw.notes = "false positive";
        const fix = validateOcrFixture(raw);
        expect(fix.notes).toBe("false positive");
    });

    it("rejects a non-string notes field", () => {
        const raw = wellFormed();
        raw.notes = 42 as unknown as string;
        expect(() => validateOcrFixture(raw)).toThrow(/notes/);
    });

    it("rejects a non-hex pdfSha256", () => {
        const raw = wellFormed();
        raw.pdfSha256 = "not-hex";
        expect(() => validateOcrFixture(raw)).toThrow(/pdfSha256/);
    });

    it("rejects a schema version mismatch", () => {
        const raw = wellFormed();
        raw.schema = 999;
        expect(() => validateOcrFixture(raw)).toThrow(OcrFixtureValidationError);
    });

    it("rejects negative issueRatioAbs", () => {
        const raw = wellFormed();
        (raw.tolerance as Record<string, unknown>).issueRatioAbs = -1;
        expect(() => validateOcrFixture(raw)).toThrow(/issueRatioAbs/);
    });

    it("rejects non-integer textLengthAbs", () => {
        const raw = wellFormed();
        (raw.tolerance as Record<string, unknown>).textLengthAbs = 1.5;
        expect(() => validateOcrFixture(raw)).toThrow(/textLengthAbs/);
    });

    it("rejects an unknown OCRIssueReason in pageAnalyses", () => {
        const raw = wellFormed();
        const pa = (raw.expected as Record<string, unknown>).pageAnalyses as Record<
            string,
            unknown
        >[];
        pa[0].issues = ["something_that_does_not_exist"];
        expect(() => validateOcrFixture(raw)).toThrow(/issues/);
    });

    it("rejects a missing effectiveOptions field", () => {
        const raw = wellFormed();
        delete (raw.config as Record<string, unknown>).effectiveOptions;
        expect(() => validateOcrFixture(raw)).toThrow(/effectiveOptions/);
    });

    it("path-prefixes every validation error with the source", () => {
        const raw = wellFormed();
        raw.id = 42 as unknown as string;
        try {
            validateOcrFixture(raw, "myFile");
            throw new Error("expected throw");
        } catch (e) {
            expect((e as Error).message).toMatch(/^myFile\.id:/);
        }
    });
});
