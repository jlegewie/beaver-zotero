/**
 * Unit tests for `projectOcrSnapshot()` + `diffOcrSnapshots()`.
 *
 * Each test wires a synthetic `OCRDetectionResult`, projects it, and
 * exercises one diff branch (changed scalar, tolerance, set, length).
 */
import { describe, it, expect } from "vitest";

import {
    diffOcrSnapshots,
    mergeEffectiveOptions,
    projectOcrSnapshot,
} from "../../../src/services/pdf/debug/ocrSnapshot";
import { DEFAULT_OCR_DETECTION_OPTIONS } from "../../../src/services/pdf/types";
import type {
    OCRDetectionResult,
    OCRIssueReason,
} from "../../../src/services/pdf/types";
import type { CapturedOcrFixture } from "../../../src/services/pdf/cli/fixture/ocrFixtureSchema";

const ALL_REASONS_ZERO = (): Record<OCRIssueReason, number> => ({
    no_text_blocks: 0,
    insufficient_text: 0,
    high_whitespace_ratio: 0,
    high_newline_ratio: 0,
    low_alphanumeric_ratio: 0,
    invalid_characters: 0,
    large_image_coverage: 0,
    bbox_overflow: 0,
    excessive_line_overlap: 0,
});

function syntheticResult(overrides: Partial<OCRDetectionResult> = {}): OCRDetectionResult {
    return {
        needsOCR: false,
        primaryReason: "text_extraction_acceptable",
        issueRatio: 0,
        issueBreakdown: ALL_REASONS_ZERO(),
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
        ...overrides,
    };
}

function fixtureFor(result: OCRDetectionResult): CapturedOcrFixture {
    return {
        schema: 1,
        id: "synthetic",
        capturedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        pdfSha256: "0".repeat(64),
        pdfBytes: 0,
        config: { options: {}, effectiveOptions: mergeEffectiveOptions({}) },
        fingerprints: {
            extractorGitSha: null,
            extractorVersion: null,
            mupdfWasmSha256: "0".repeat(64),
        },
        tolerance: { issueRatioAbs: 0.02, textLengthAbs: 5 },
        expected: projectOcrSnapshot(result),
    };
}

describe("projectOcrSnapshot", () => {
    it("normalizes missing breakdown keys to zero", () => {
        // Synthetically delete one key to simulate a sparse worker reply.
        const result = syntheticResult();
        delete (result.issueBreakdown as unknown as Record<string, number>)
            .bbox_overflow;
        const snap = projectOcrSnapshot(result);
        expect(snap.issueBreakdown.bbox_overflow).toBe(0);
    });

    it("sorts issues so set comparisons are stable", () => {
        const result = syntheticResult({
            pageAnalyses: [
                {
                    pageIndex: 0,
                    hasIssues: true,
                    issues: ["large_image_coverage", "no_text_blocks"],
                    textLength: 0,
                    hasImages: true,
                },
            ],
        });
        const snap = projectOcrSnapshot(result);
        expect(snap.pageAnalyses[0].issues).toEqual([
            "large_image_coverage",
            "no_text_blocks",
        ]);
    });
});

describe("diffOcrSnapshots", () => {
    const baseEffective = mergeEffectiveOptions({});

    it("returns no diffs when expected and actual are identical", () => {
        const r = syntheticResult();
        const fix = fixtureFor(r);
        const diffs = diffOcrSnapshots(
            fix,
            { snapshot: projectOcrSnapshot(r), effectiveOptions: baseEffective },
            { issueRatioAbs: 0.02, textLengthAbs: 5 },
        );
        expect(diffs).toEqual([]);
    });

    it("flags a needsOCR flip", () => {
        const fix = fixtureFor(syntheticResult({ needsOCR: false }));
        const actual = projectOcrSnapshot(syntheticResult({ needsOCR: true }));
        const diffs = diffOcrSnapshots(
            fix,
            { snapshot: actual, effectiveOptions: baseEffective },
            { issueRatioAbs: 0.02, textLengthAbs: 5 },
        );
        expect(diffs.some((d) => d.path === "expected.needsOCR")).toBe(true);
    });

    it("flags an issueRatio drift outside tolerance", () => {
        const fix = fixtureFor(syntheticResult({ issueRatio: 0.1 }));
        const actual = projectOcrSnapshot(syntheticResult({ issueRatio: 0.5 }));
        const diffs = diffOcrSnapshots(
            fix,
            { snapshot: actual, effectiveOptions: baseEffective },
            { issueRatioAbs: 0.02, textLengthAbs: 5 },
        );
        const hit = diffs.find((d) => d.path === "expected.issueRatio");
        expect(hit?.kind).toBe("tolerance");
    });

    it("does NOT flag issueRatio drift within tolerance", () => {
        const fix = fixtureFor(syntheticResult({ issueRatio: 0.5 }));
        const actual = projectOcrSnapshot(syntheticResult({ issueRatio: 0.51 }));
        const diffs = diffOcrSnapshots(
            fix,
            { snapshot: actual, effectiveOptions: baseEffective },
            { issueRatioAbs: 0.02, textLengthAbs: 5 },
        );
        expect(diffs).toEqual([]);
    });

    it("flags a per-page issues set difference", () => {
        const fix = fixtureFor(
            syntheticResult({
                pageAnalyses: [
                    {
                        pageIndex: 0,
                        hasIssues: true,
                        issues: ["no_text_blocks"],
                        textLength: 0,
                        hasImages: false,
                    },
                ],
            }),
        );
        const actual = projectOcrSnapshot(
            syntheticResult({
                pageAnalyses: [
                    {
                        pageIndex: 0,
                        hasIssues: true,
                        issues: ["insufficient_text"],
                        textLength: 0,
                        hasImages: false,
                    },
                ],
            }),
        );
        const diffs = diffOcrSnapshots(
            fix,
            { snapshot: actual, effectiveOptions: baseEffective },
            { issueRatioAbs: 0.02, textLengthAbs: 5 },
        );
        expect(diffs.some((d) => d.path.endsWith(".issues"))).toBe(true);
    });

    it("flags textLength outside tolerance", () => {
        const fix = fixtureFor(
            syntheticResult({
                pageAnalyses: [
                    {
                        pageIndex: 0,
                        hasIssues: false,
                        issues: [],
                        textLength: 1500,
                        hasImages: false,
                    },
                ],
            }),
        );
        const actual = projectOcrSnapshot(
            syntheticResult({
                pageAnalyses: [
                    {
                        pageIndex: 0,
                        hasIssues: false,
                        issues: [],
                        textLength: 1800,
                        hasImages: false,
                    },
                ],
            }),
        );
        const diffs = diffOcrSnapshots(
            fix,
            { snapshot: actual, effectiveOptions: baseEffective },
            { issueRatioAbs: 0.02, textLengthAbs: 5 },
        );
        const hit = diffs.find((d) => d.path.endsWith(".textLength"));
        expect(hit?.kind).toBe("tolerance");
    });

    it("flags a default-options drift via config.effectiveOptions", () => {
        const fix = fixtureFor(syntheticResult());
        // Simulate a default-value drift between capture and evaluate.
        const driftedEffective = {
            ...mergeEffectiveOptions({}),
            sampleSize: DEFAULT_OCR_DETECTION_OPTIONS.sampleSize + 1,
        };
        const diffs = diffOcrSnapshots(
            fix,
            {
                snapshot: projectOcrSnapshot(syntheticResult()),
                effectiveOptions: driftedEffective,
            },
            { issueRatioAbs: 0.02, textLengthAbs: 5 },
        );
        expect(diffs.some((d) => d.path === "config.effectiveOptions.sampleSize")).toBe(
            true,
        );
    });

    it("flags a pageAnalyses length mismatch", () => {
        const fix = fixtureFor(syntheticResult());
        const actual = projectOcrSnapshot(
            syntheticResult({
                pageAnalyses: [
                    ...syntheticResult().pageAnalyses,
                    {
                        pageIndex: 2,
                        hasIssues: false,
                        issues: [],
                        textLength: 1000,
                        hasImages: false,
                    },
                ],
            }),
        );
        const diffs = diffOcrSnapshots(
            fix,
            { snapshot: actual, effectiveOptions: baseEffective },
            { issueRatioAbs: 0.02, textLengthAbs: 5 },
        );
        expect(diffs.some((d) => d.path === "expected.pageAnalyses.length")).toBe(true);
    });
});
