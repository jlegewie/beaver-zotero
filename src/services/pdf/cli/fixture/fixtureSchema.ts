/**
 * Runtime validators for the fixture file format.
 *
 * Targeted error messages — every failure cites the JSON path of the
 * offending field so the loader can surface "config.analysisScope is
 * invalid" rather than a deep-compare crash buried in the test runner.
 *
 * Schema is intentionally unversioned (per plan): when the extraction
 * return type changes, the projection in `extractionSnapshot.ts` is
 * updated and a `--update` sweep regenerates every fixture.
 */
import type {
    ExtractionPageSnapshot,
    ExtractionSnapshot,
    SnapshotBBox,
    SnapshotSentence,
} from "../../debug/extractionSnapshot";
import type { ExtractionSettings } from "../../types";
import type { ParagraphDetectionSettings } from "../../ParagraphDetector";
import type { SentenceSplitterConfig } from "../../sentenceTypes";
import { parseAnalysisScope, type AnalysisScope } from "./analysisScope";
import type { Fingerprints } from "./fingerprints";

export const FIXTURE_SCHEMA_VERSION = 1 as const;

export interface FixtureConfig {
    pageIndices: number[];
    analysisScope: AnalysisScope;
    splitterConfig: SentenceSplitterConfig;
    settings: ExtractionSettings;
    paragraphSettings: ParagraphDetectionSettings;
}

export interface CapturedFixture {
    schema: typeof FIXTURE_SCHEMA_VERSION;
    id: string;
    capturedAt: string;
    updatedAt: string;
    pdfSha256: string;
    pdfBytes: number;
    config: FixtureConfig;
    fingerprints: Fingerprints;
    tolerance: { bboxAbsPt: number };
    expected: ExtractionSnapshot;
}

export class FixtureValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FixtureValidationError";
    }
}

/**
 * Validate an arbitrary parsed JSON value as a `CapturedFixture`. Throws
 * `FixtureValidationError` with a path-prefixed message on the first
 * problem encountered. Returns the value typed.
 */
export function validateFixture(value: unknown, source = "fixture"): CapturedFixture {
    const v = expectObject(value, source);
    const schema = expectInt(v.schema, `${source}.schema`);
    if (schema !== FIXTURE_SCHEMA_VERSION) {
        throw new FixtureValidationError(
            `${source}.schema: expected ${FIXTURE_SCHEMA_VERSION}, got ${schema}`,
        );
    }
    const id = expectString(v.id, `${source}.id`);
    const capturedAt = expectString(v.capturedAt, `${source}.capturedAt`);
    const updatedAt = expectString(v.updatedAt, `${source}.updatedAt`);
    const pdfSha256 = expectString(v.pdfSha256, `${source}.pdfSha256`);
    if (!/^[0-9a-f]{64}$/.test(pdfSha256)) {
        throw new FixtureValidationError(
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

    return {
        schema: FIXTURE_SCHEMA_VERSION,
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
}

function validateConfig(value: unknown, source: string): FixtureConfig {
    const v = expectObject(value, source);
    const pageIndices = expectIntArray(v.pageIndices, `${source}.pageIndices`);
    if (pageIndices.length === 0) {
        throw new FixtureValidationError(`${source}.pageIndices must be non-empty`);
    }
    let scope: AnalysisScope;
    try {
        scope = parseAnalysisScope(v.analysisScope);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new FixtureValidationError(`${source}.analysisScope: ${msg}`);
    }
    const splitterConfig = validateSplitterConfig(
        v.splitterConfig,
        `${source}.splitterConfig`,
    );
    // settings and paragraphSettings are forwarded as-is to extractPdf;
    // their own validation lives in the package. We only check object-ness.
    const settings = expectObject(v.settings, `${source}.settings`) as ExtractionSettings;
    const paragraphSettings = expectObject(
        v.paragraphSettings,
        `${source}.paragraphSettings`,
    ) as ParagraphDetectionSettings;

    return {
        pageIndices,
        analysisScope: scope,
        splitterConfig,
        settings,
        paragraphSettings,
    };
}

function validateSplitterConfig(value: unknown, source: string): SentenceSplitterConfig {
    const v = expectObject(value, source);
    const type = expectString(v.type, `${source}.type`);
    if (type === "simple") return { type: "simple" };
    if (type === "sentencex") {
        const out: { type: "sentencex"; language?: string } = { type: "sentencex" };
        if (v.language != null) {
            out.language = expectString(v.language, `${source}.language`);
        }
        return out;
    }
    throw new FixtureValidationError(
        `${source}.type: expected "sentencex" | "simple", got "${type}"`,
    );
}

function validateFingerprints(value: unknown, source: string): Fingerprints {
    const v = expectObject(value, source);
    return {
        extractorGitSha: expectStringOrNull(v.extractorGitSha, `${source}.extractorGitSha`),
        extractorVersion: expectStringOrNull(v.extractorVersion, `${source}.extractorVersion`),
        mupdfWasmSha256: expectString(v.mupdfWasmSha256, `${source}.mupdfWasmSha256`),
        sentencexWasmSha256: expectString(v.sentencexWasmSha256, `${source}.sentencexWasmSha256`),
    };
}

function validateTolerance(value: unknown, source: string): { bboxAbsPt: number } {
    const v = expectObject(value, source);
    const bboxAbsPt = v.bboxAbsPt;
    if (typeof bboxAbsPt !== "number" || !Number.isFinite(bboxAbsPt) || bboxAbsPt < 0) {
        throw new FixtureValidationError(
            `${source}.bboxAbsPt must be a non-negative finite number`,
        );
    }
    return { bboxAbsPt };
}

function validateSnapshot(value: unknown, source: string): ExtractionSnapshot {
    const v = expectObject(value, source);
    const perPageRaw = expectArray(v.perPage, `${source}.perPage`);
    const perPage: ExtractionPageSnapshot[] = perPageRaw.map((p, i) =>
        validatePage(p, `${source}.perPage[${i}]`),
    );
    const totals = expectObject(v.totals, `${source}.totals`);
    return {
        perPage,
        totals: {
            paragraphCount: expectInt(totals.paragraphCount, `${source}.totals.paragraphCount`),
            sentenceCount: expectInt(totals.sentenceCount, `${source}.totals.sentenceCount`),
            degradedParagraphs: expectInt(
                totals.degradedParagraphs,
                `${source}.totals.degradedParagraphs`,
            ),
        },
    };
}

function validatePage(value: unknown, source: string): ExtractionPageSnapshot {
    const v = expectObject(value, source);
    const sentencesRaw = expectArray(v.sentences, `${source}.sentences`);
    const sentences = sentencesRaw.map((s, i) =>
        validateSentence(s, `${source}.sentences[${i}]`),
    );
    return {
        pageIndex: expectInt(v.pageIndex, `${source}.pageIndex`),
        pageWidth: expectFiniteNumber(v.pageWidth, `${source}.pageWidth`),
        pageHeight: expectFiniteNumber(v.pageHeight, `${source}.pageHeight`),
        content: expectString(v.content, `${source}.content`),
        paragraphCount: expectInt(v.paragraphCount, `${source}.paragraphCount`),
        sentenceCount: expectInt(v.sentenceCount, `${source}.sentenceCount`),
        degradedParagraphs: expectInt(v.degradedParagraphs, `${source}.degradedParagraphs`),
        sentences,
    };
}

function validateSentence(value: unknown, source: string): SnapshotSentence {
    const v = expectObject(value, source);
    const kindRaw = expectString(v.kind, `${source}.kind`);
    if (kindRaw !== "text" && kindRaw !== "heading") {
        throw new FixtureValidationError(
            `${source}.kind: expected "text" | "heading", got "${kindRaw}"`,
        );
    }
    const bboxesRaw = expectArray(v.bboxes, `${source}.bboxes`);
    const bboxes = bboxesRaw.map((b, i) => validateBBox(b, `${source}.bboxes[${i}]`));
    const out: SnapshotSentence = {
        index: expectInt(v.index, `${source}.index`),
        paragraphIndex: expectInt(v.paragraphIndex, `${source}.paragraphIndex`),
        sentenceIndex: expectInt(v.sentenceIndex, `${source}.sentenceIndex`),
        kind: kindRaw,
        text: expectString(v.text, `${source}.text`),
        bboxes,
    };
    if (v.joinWithNext === true) out.joinWithNext = true;
    else if (v.joinWithNext != null && v.joinWithNext !== false) {
        throw new FixtureValidationError(
            `${source}.joinWithNext: expected omitted or true, got ${JSON.stringify(v.joinWithNext)}`,
        );
    }
    return out;
}

function validateBBox(value: unknown, source: string): SnapshotBBox {
    const v = expectObject(value, source);
    return {
        x: expectFiniteNumber(v.x, `${source}.x`),
        y: expectFiniteNumber(v.y, `${source}.y`),
        w: expectFiniteNumber(v.w, `${source}.w`),
        h: expectFiniteNumber(v.h, `${source}.h`),
    };
}

// ---------------------------------------------------------------------------
// Tiny shape primitives — every error path reports the JSON pointer.
// ---------------------------------------------------------------------------

function expectObject(value: unknown, source: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new FixtureValidationError(`${source}: expected object`);
    }
    return value as Record<string, unknown>;
}

function expectArray(value: unknown, source: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new FixtureValidationError(`${source}: expected array`);
    }
    return value;
}

function expectString(value: unknown, source: string): string {
    if (typeof value !== "string") {
        throw new FixtureValidationError(`${source}: expected string`);
    }
    return value;
}

function expectStringOrNull(value: unknown, source: string): string | null {
    if (value === null) return null;
    if (typeof value !== "string") {
        throw new FixtureValidationError(`${source}: expected string or null`);
    }
    return value;
}

function expectInt(value: unknown, source: string): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new FixtureValidationError(`${source}: expected integer`);
    }
    return value;
}

function expectIntArray(value: unknown, source: string): number[] {
    const arr = expectArray(value, source);
    return arr.map((v, i) => expectInt(v, `${source}[${i}]`));
}

function expectFiniteNumber(value: unknown, source: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new FixtureValidationError(`${source}: expected finite number`);
    }
    return value;
}
