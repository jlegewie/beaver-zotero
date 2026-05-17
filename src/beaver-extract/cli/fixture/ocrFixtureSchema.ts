/**
 * Runtime validators for the OCR fixture file format (`ocr.json`).
 *
 * Mirrors the structure of `fixtureSchema.ts` (used by extract fixtures)
 * but targets `OCRDetectionResult` rather than `ExtractionResult`. Every
 * failure reports the JSON path of the offending field so a malformed
 * fixture surfaces a precise error rather than a deep-compare crash.
 *
 * Kept free of any Node-only dependency so `debug/ocrSnapshot.ts` can
 * type-import the wire shapes without dragging `node/paths.ts` (which
 * uses `import.meta`) into the main `tsc --noEmit` build. The companion
 * `ocrFingerprints.ts` module imports `OcrFingerprints` from this file,
 * not the other way around.
 */
import type {
    OCRDetectionOptions,
    OCRIssueReason,
} from "../../types";
import { DEFAULT_OCR_DETECTION_OPTIONS } from "../../types";

export const OCR_FIXTURE_SCHEMA_VERSION = 1 as const;

/**
 * Fingerprint shape stored on every OCR fixture. The capture / diff /
 * warning helpers that produce and consume these values live in
 * `ocrFingerprints.ts`; the wire shape is owned here so the schema is a
 * self-contained leaf module.
 */
export interface OcrFingerprints {
    extractorGitSha: string | null;
    extractorVersion: string | null;
    mupdfWasmSha256: string;
}

const OCR_ISSUE_REASONS: readonly OCRIssueReason[] = [
    "no_text_blocks",
    "insufficient_text",
    "high_whitespace_ratio",
    "high_newline_ratio",
    "low_alphanumeric_ratio",
    "invalid_characters",
    "large_image_coverage",
    "bbox_overflow",
    "excessive_line_overlap",
];

export interface SnapshotPageOcr {
    pageIndex: number;
    hasIssues: boolean;
    issues: OCRIssueReason[];
    textLength: number;
    hasImages: boolean;
}

export interface OcrSnapshot {
    needsOCR: boolean;
    primaryReason: string;
    issueRatio: number;
    issueBreakdown: Record<OCRIssueReason, number>;
    sampledPages: number;
    totalPages: number;
    pageAnalyses: SnapshotPageOcr[];
}

export interface OcrFixtureConfig {
    /** User overrides only. Stable across DEFAULT_OCR_DETECTION_OPTIONS drift. */
    options: OCRDetectionOptions;
    /**
     * Full merged options that were actually passed to `analyzeOCRNeeds`.
     * Snapshotted so the diff can call out default-value drift explicitly.
     */
    effectiveOptions: Required<OCRDetectionOptions>;
}

export interface CapturedOcrFixture {
    schema: typeof OCR_FIXTURE_SCHEMA_VERSION;
    id: string;
    capturedAt: string;
    updatedAt: string;
    pdfSha256: string;
    pdfBytes: number;
    config: OcrFixtureConfig;
    fingerprints: OcrFingerprints;
    tolerance: {
        issueRatioAbs: number;
        textLengthAbs: number;
    };
    expected: OcrSnapshot;
    /** Optional human note (e.g. "false positive — should be false"). */
    notes?: string;
}

export class OcrFixtureValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OcrFixtureValidationError";
    }
}

export function validateOcrFixture(
    value: unknown,
    source = "ocrFixture",
): CapturedOcrFixture {
    const v = expectObject(value, source);
    const schema = expectInt(v.schema, `${source}.schema`);
    if (schema !== OCR_FIXTURE_SCHEMA_VERSION) {
        throw new OcrFixtureValidationError(
            `${source}.schema: expected ${OCR_FIXTURE_SCHEMA_VERSION}, got ${schema}`,
        );
    }
    const id = expectString(v.id, `${source}.id`);
    const capturedAt = expectString(v.capturedAt, `${source}.capturedAt`);
    const updatedAt = expectString(v.updatedAt, `${source}.updatedAt`);
    const pdfSha256 = expectString(v.pdfSha256, `${source}.pdfSha256`);
    if (!/^[0-9a-f]{64}$/.test(pdfSha256)) {
        throw new OcrFixtureValidationError(
            `${source}.pdfSha256: not a 64-char lowercase hex string`,
        );
    }
    const pdfBytes = expectInt(v.pdfBytes, `${source}.pdfBytes`);
    const config = validateConfig(v.config, `${source}.config`);
    const fingerprints = validateFingerprints(
        v.fingerprints,
        `${source}.fingerprints`,
    );
    const tolerance = validateTolerance(v.tolerance, `${source}.tolerance`);
    const expected = validateSnapshot(v.expected, `${source}.expected`);

    const notes = v.notes;
    if (notes != null && typeof notes !== "string") {
        throw new OcrFixtureValidationError(
            `${source}.notes: expected string or omitted, got ${typeof notes}`,
        );
    }

    const out: CapturedOcrFixture = {
        schema: OCR_FIXTURE_SCHEMA_VERSION,
        id,
        capturedAt,
        updatedAt,
        pdfSha256,
        pdfBytes,
        config,
        fingerprints,
        tolerance,
        expected,
    };
    if (typeof notes === "string") out.notes = notes;
    return out;
}

function validateConfig(value: unknown, source: string): OcrFixtureConfig {
    const v = expectObject(value, source);
    const options = expectObject(v.options, `${source}.options`) as OCRDetectionOptions;
    const effectiveObj = expectObject(
        v.effectiveOptions,
        `${source}.effectiveOptions`,
    );
    const effectiveOptions = validateEffectiveOptions(
        effectiveObj,
        `${source}.effectiveOptions`,
    );
    return { options, effectiveOptions };
}

function validateEffectiveOptions(
    v: Record<string, unknown>,
    source: string,
): Required<OCRDetectionOptions> {
    return {
        minTextPerPage: expectInt(v.minTextPerPage, `${source}.minTextPerPage`),
        // Backward-compatible: fixtures captured before `minMeanTextPerPage`
        // existed omit it — fall back to the current default so older
        // `ocr.json` files still validate.
        minMeanTextPerPage:
            v.minMeanTextPerPage === undefined
                ? DEFAULT_OCR_DETECTION_OPTIONS.minMeanTextPerPage
                : expectInt(v.minMeanTextPerPage, `${source}.minMeanTextPerPage`),
        sampleSize: expectInt(v.sampleSize, `${source}.sampleSize`),
        expandedSampleSize: expectInt(v.expandedSampleSize, `${source}.expandedSampleSize`),
        expandLowerThreshold: expectFiniteNumber(
            v.expandLowerThreshold,
            `${source}.expandLowerThreshold`,
        ),
        expandUpperThreshold: expectFiniteNumber(
            v.expandUpperThreshold,
            `${source}.expandUpperThreshold`,
        ),
        confirmationThreshold: expectFiniteNumber(
            v.confirmationThreshold,
            `${source}.confirmationThreshold`,
        ),
        maxWhitespaceRatio: expectFiniteNumber(
            v.maxWhitespaceRatio,
            `${source}.maxWhitespaceRatio`,
        ),
        maxNewlineRatio: expectFiniteNumber(v.maxNewlineRatio, `${source}.maxNewlineRatio`),
        minAlphanumericRatio: expectFiniteNumber(
            v.minAlphanumericRatio,
            `${source}.minAlphanumericRatio`,
        ),
        maxInvalidCharRatio: expectFiniteNumber(
            v.maxInvalidCharRatio,
            `${source}.maxInvalidCharRatio`,
        ),
        minValidCharsToAccept: expectInt(
            v.minValidCharsToAccept,
            `${source}.minValidCharsToAccept`,
        ),
        imageCoverageThreshold: expectFiniteNumber(
            v.imageCoverageThreshold,
            `${source}.imageCoverageThreshold`,
        ),
        maxLineOverlapRatio: expectFiniteNumber(
            v.maxLineOverlapRatio,
            `${source}.maxLineOverlapRatio`,
        ),
        boundaryMargin: expectFiniteNumber(v.boundaryMargin, `${source}.boundaryMargin`),
        checkBoundingBoxes: expectBool(
            v.checkBoundingBoxes,
            `${source}.checkBoundingBoxes`,
        ),
    };
}

function validateFingerprints(value: unknown, source: string): OcrFingerprints {
    const v = expectObject(value, source);
    return {
        extractorGitSha: expectStringOrNull(v.extractorGitSha, `${source}.extractorGitSha`),
        extractorVersion: expectStringOrNull(
            v.extractorVersion,
            `${source}.extractorVersion`,
        ),
        mupdfWasmSha256: expectString(v.mupdfWasmSha256, `${source}.mupdfWasmSha256`),
    };
}

function validateTolerance(
    value: unknown,
    source: string,
): { issueRatioAbs: number; textLengthAbs: number } {
    const v = expectObject(value, source);
    const issueRatioAbs = v.issueRatioAbs;
    if (
        typeof issueRatioAbs !== "number" ||
        !Number.isFinite(issueRatioAbs) ||
        issueRatioAbs < 0
    ) {
        throw new OcrFixtureValidationError(
            `${source}.issueRatioAbs must be a non-negative finite number`,
        );
    }
    const textLengthAbs = v.textLengthAbs;
    if (
        typeof textLengthAbs !== "number" ||
        !Number.isInteger(textLengthAbs) ||
        textLengthAbs < 0
    ) {
        throw new OcrFixtureValidationError(
            `${source}.textLengthAbs must be a non-negative integer`,
        );
    }
    return { issueRatioAbs, textLengthAbs };
}

function validateSnapshot(value: unknown, source: string): OcrSnapshot {
    const v = expectObject(value, source);
    const needsOCR = expectBool(v.needsOCR, `${source}.needsOCR`);
    const primaryReason = expectString(v.primaryReason, `${source}.primaryReason`);
    const issueRatio = expectFiniteNumber(v.issueRatio, `${source}.issueRatio`);
    const issueBreakdown = validateIssueBreakdown(
        v.issueBreakdown,
        `${source}.issueBreakdown`,
    );
    const sampledPages = expectInt(v.sampledPages, `${source}.sampledPages`);
    const totalPages = expectInt(v.totalPages, `${source}.totalPages`);
    const pageAnalysesRaw = expectArray(v.pageAnalyses, `${source}.pageAnalyses`);
    const pageAnalyses = pageAnalysesRaw.map((p, i) =>
        validatePage(p, `${source}.pageAnalyses[${i}]`),
    );
    return {
        needsOCR,
        primaryReason,
        issueRatio,
        issueBreakdown,
        sampledPages,
        totalPages,
        pageAnalyses,
    };
}

function validateIssueBreakdown(
    value: unknown,
    source: string,
): Record<OCRIssueReason, number> {
    const v = expectObject(value, source);
    const out = {} as Record<OCRIssueReason, number>;
    for (const reason of OCR_ISSUE_REASONS) {
        out[reason] = expectInt(v[reason], `${source}.${reason}`);
    }
    return out;
}

function validatePage(value: unknown, source: string): SnapshotPageOcr {
    const v = expectObject(value, source);
    const issuesRaw = expectArray(v.issues, `${source}.issues`);
    const issues = issuesRaw.map((r, i) => {
        const s = expectString(r, `${source}.issues[${i}]`);
        if (!OCR_ISSUE_REASONS.includes(s as OCRIssueReason)) {
            throw new OcrFixtureValidationError(
                `${source}.issues[${i}]: "${s}" is not a known OCRIssueReason`,
            );
        }
        return s as OCRIssueReason;
    });
    return {
        pageIndex: expectInt(v.pageIndex, `${source}.pageIndex`),
        hasIssues: expectBool(v.hasIssues, `${source}.hasIssues`),
        issues,
        textLength: expectInt(v.textLength, `${source}.textLength`),
        hasImages: expectBool(v.hasImages, `${source}.hasImages`),
    };
}

// ---------------------------------------------------------------------------
// Shape primitives (mirror those in fixtureSchema.ts but throw the
// OCR-specific error type so the validator's failure mode is unambiguous).
// ---------------------------------------------------------------------------

function expectObject(value: unknown, source: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new OcrFixtureValidationError(`${source}: expected object`);
    }
    return value as Record<string, unknown>;
}

function expectArray(value: unknown, source: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new OcrFixtureValidationError(`${source}: expected array`);
    }
    return value;
}

function expectString(value: unknown, source: string): string {
    if (typeof value !== "string") {
        throw new OcrFixtureValidationError(`${source}: expected string`);
    }
    return value;
}

function expectStringOrNull(value: unknown, source: string): string | null {
    if (value === null) return null;
    if (typeof value !== "string") {
        throw new OcrFixtureValidationError(`${source}: expected string or null`);
    }
    return value;
}

function expectInt(value: unknown, source: string): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new OcrFixtureValidationError(`${source}: expected integer`);
    }
    return value;
}

function expectFiniteNumber(value: unknown, source: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new OcrFixtureValidationError(`${source}: expected finite number`);
    }
    return value;
}

function expectBool(value: unknown, source: string): boolean {
    if (typeof value !== "boolean") {
        throw new OcrFixtureValidationError(`${source}: expected boolean`);
    }
    return value;
}
