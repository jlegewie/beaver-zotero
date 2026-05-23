/**
 * Unit tests for the OCR fixture filesystem layer.
 *
 * Targets: round-trip writeOcrFixtureFile / readOcrFixture; listOcrFixtureIds
 * discovers `ocr.json` and ignores extract-only folders; semanticallyEqualOcr
 * ignores timestamps but treats `notes` as part of identity.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    listOcrFixtureIds,
    ocrFixtureLocation,
    readOcrFixture,
    semanticallyEqualOcr,
    writeOcrFixtureFile,
} from "../../../src/beaver-extract/cli/fixture/ocrFixtureFile";
import { mergeEffectiveOptions } from "../../../src/beaver-extract/debug/ocrSnapshot";
import type { CapturedOcrFixture } from "../../../src/beaver-extract/cli/fixture/ocrFixtureSchema";

let tmpRoot = "";

beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "beaver-ocr-fixture-"));
});

afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
    tmpRoot = "";
});

function syntheticFixture(): CapturedOcrFixture {
    return {
        schema: 1,
        id: "TESTKEY",
        capturedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pdfSha256: "0".repeat(64),
        pdfBytes: 1024,
        config: { options: {}, effectiveOptions: mergeEffectiveOptions({}) },
        fingerprints: {
            extractorGitSha: null,
            extractorVersion: null,
            mupdfWasmSha256: "a".repeat(64),
        },
        tolerance: { issueRatioAbs: 0.02, textLengthAbs: 5 },
        expected: {
            needsOCR: false,
            issueRatio: 0,
            issueBreakdown: {
                no_text_blocks: 0,
                no_body_text: 0,
                insufficient_text: 0,
                high_whitespace_ratio: 0,
                high_newline_ratio: 0,
                low_alphanumeric_ratio: 0,
                invalid_characters: 0,
                fragmented_text_lines: 0,
                large_image_coverage: 0,
                bbox_overflow: 0,
                excessive_line_overlap: 0,
            },
            sampledPages: 6,
            totalPages: 12,
            pageAnalyses: [],
        },
    };
}

describe("writeOcrFixtureFile / readOcrFixture", () => {
    it("round-trips a fixture through disk", () => {
        const loc = ocrFixtureLocation(tmpRoot, "TESTKEY");
        const fix = syntheticFixture();
        writeOcrFixtureFile(loc, fix);
        const read = readOcrFixture(tmpRoot, "TESTKEY");
        expect(read).toEqual(fix);
    });

    it("preserves an explicit notes field across write/read", () => {
        const loc = ocrFixtureLocation(tmpRoot, "TESTKEY");
        const fix: CapturedOcrFixture = { ...syntheticFixture(), notes: "false positive" };
        writeOcrFixtureFile(loc, fix);
        const read = readOcrFixture(tmpRoot, "TESTKEY");
        expect(read.notes).toBe("false positive");
    });

    it("throws a path-prefixed error when the file is missing", () => {
        expect(() => readOcrFixture(tmpRoot, "MISSING")).toThrow(/OCR fixture not found/);
    });

    it("throws a path-prefixed error when JSON is malformed", () => {
        const loc = ocrFixtureLocation(tmpRoot, "BADJSON");
        mkdirSync(loc.folder, { recursive: true });
        writeFileSync(loc.ocrJson, "{ not json");
        expect(() => readOcrFixture(tmpRoot, "BADJSON")).toThrow(/failed to parse JSON/);
    });
});

describe("listOcrFixtureIds", () => {
    it("returns ids of folders that contain ocr.json", () => {
        writeOcrFixtureFile(ocrFixtureLocation(tmpRoot, "AAA"), syntheticFixture());
        writeOcrFixtureFile(ocrFixtureLocation(tmpRoot, "BBB"), syntheticFixture());
        expect(listOcrFixtureIds(tmpRoot)).toEqual(["AAA", "BBB"]);
    });

    it("skips folders that only contain fixture.json (extract fixtures)", () => {
        // Extract fixture: paperKey__p0 with fixture.json but no ocr.json.
        const extractDir = join(tmpRoot, "paperKey__p0");
        mkdirSync(extractDir, { recursive: true });
        writeFileSync(join(extractDir, "fixture.json"), "{}");

        // OCR fixture: paperKey with ocr.json.
        writeOcrFixtureFile(ocrFixtureLocation(tmpRoot, "paperKey"), syntheticFixture());

        expect(listOcrFixtureIds(tmpRoot)).toEqual(["paperKey"]);
    });

    it("skips _shared and dotfile folders", () => {
        mkdirSync(join(tmpRoot, "_shared"), { recursive: true });
        writeFileSync(join(tmpRoot, "_shared", "stuff.pdf"), "fake");
        mkdirSync(join(tmpRoot, ".hidden"), { recursive: true });
        writeFileSync(join(tmpRoot, ".hidden", "ocr.json"), "{}");
        writeOcrFixtureFile(ocrFixtureLocation(tmpRoot, "REAL"), syntheticFixture());
        expect(listOcrFixtureIds(tmpRoot)).toEqual(["REAL"]);
    });

    it("returns [] for a non-existent root", () => {
        expect(listOcrFixtureIds(join(tmpRoot, "does-not-exist"))).toEqual([]);
    });
});

describe("semanticallyEqualOcr", () => {
    it("ignores capturedAt and updatedAt", () => {
        const a = syntheticFixture();
        const b: CapturedOcrFixture = {
            ...syntheticFixture(),
            capturedAt: "2027-06-12T00:00:00.000Z",
            updatedAt: "2027-06-12T00:00:00.000Z",
        };
        expect(semanticallyEqualOcr(a, b)).toBe(true);
    });

    it("treats a notes change as semantically different", () => {
        const a = syntheticFixture();
        const b: CapturedOcrFixture = { ...syntheticFixture(), notes: "now flagged" };
        expect(semanticallyEqualOcr(a, b)).toBe(false);
    });

    it("treats expected snapshot drift as semantically different", () => {
        const a = syntheticFixture();
        const b: CapturedOcrFixture = {
            ...syntheticFixture(),
            expected: { ...syntheticFixture().expected, needsOCR: true },
        };
        expect(semanticallyEqualOcr(a, b)).toBe(false);
    });
});
