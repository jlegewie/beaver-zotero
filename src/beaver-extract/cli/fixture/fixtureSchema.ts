/**
 * Runtime validators for the fixture file format.
 *
 * Targeted error messages cite the JSON path of the offending field so the
 * loader can surface "config.analysisScope is invalid" rather than a
 * deep-compare crash buried in the test runner.
 *
 * Bump `FIXTURE_SCHEMA_VERSION` whenever the fixture wire shape changes
 * incompatibly. The loader rejects stale fixtures so regeneration failures
 * surface immediately instead of comparing mixed wire shapes.
 */
import type {
    DocumentItem,
    DocumentItemKind,
    MarkdownPage,
    Rect,
    Sentence,
    StructuredPage,
} from "../../schema";
import type { ExtractionSettings } from "../../types";
import type { ParagraphDetectionSettings } from "../../ParagraphDetector";
import type { SentenceSplitterConfig } from "../../sentenceTypes";
import { parseAnalysisScope, type AnalysisScope } from "./analysisScope";
import type { Fingerprints } from "./fingerprints";

export const FIXTURE_SCHEMA_VERSION = 5 as const;

export interface FixtureConfig {
    pageIndices: number[];
    analysisScope: AnalysisScope;
    splitterConfig: SentenceSplitterConfig;
    settings: ExtractionSettings;
    paragraphSettings: ParagraphDetectionSettings;
}

export interface ExpectedExtraction {
    structured: { pages: StructuredPage[] };
    markdown: { pages: MarkdownPage[] };
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
    expected: ExpectedExtraction;
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
    const expected = validateExpected(v.expected, config, `${source}.expected`);

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

export function validateConfig(value: unknown, source: string): FixtureConfig {
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

export function validateTolerance(value: unknown, source: string): { bboxAbsPt: number } {
    const v = expectObject(value, source);
    const bboxAbsPt = v.bboxAbsPt;
    if (typeof bboxAbsPt !== "number" || !Number.isFinite(bboxAbsPt) || bboxAbsPt < 0) {
        throw new FixtureValidationError(
            `${source}.bboxAbsPt must be a non-negative finite number`,
        );
    }
    return { bboxAbsPt };
}

function validateExpected(
    value: unknown,
    config: FixtureConfig,
    source: string,
): ExpectedExtraction {
    const v = expectObject(value, source);
    const structured = expectObject(v.structured, `${source}.structured`);
    const markdown = expectObject(v.markdown, `${source}.markdown`);
    const structuredPages = expectArray(
        structured.pages,
        `${source}.structured.pages`,
    ).map((p, i) => validateStructuredPage(p, `${source}.structured.pages[${i}]`));
    const markdownPages = expectArray(
        markdown.pages,
        `${source}.markdown.pages`,
    ).map((p, i) => validateMarkdownPage(p, `${source}.markdown.pages[${i}]`));

    validatePageIndexSet(
        structuredPages,
        config,
        `${source}.structured.pages`,
    );
    validatePageIndexSet(markdownPages, config, `${source}.markdown.pages`);

    return {
        structured: { pages: structuredPages },
        markdown: { pages: markdownPages },
    };
}

function validatePageIndexSet(
    pages: Array<{ index: number }>,
    config: FixtureConfig,
    source: string,
): void {
    const actual = pages.map((p) => p.index);
    const expected = [...config.pageIndices].sort((a, b) => a - b);
    if (
        actual.length !== expected.length ||
        actual.some((index, i) => index !== expected[i])
    ) {
        throw new FixtureValidationError(
            `${source}: page indices [${actual.join(", ")}] do not match config.pageIndices [${expected.join(", ")}]`,
        );
    }
}

function validateStructuredPage(value: unknown, source: string): StructuredPage {
    const v = expectObject(value, source);
    const items = expectArray(v.items, `${source}.items`).map((item, i) =>
        validateDocumentItem(item, `${source}.items[${i}]`),
    );
    const out: StructuredPage = {
        index: expectInt(v.index, `${source}.index`),
        width: expectFiniteNumber(v.width, `${source}.width`),
        height: expectFiniteNumber(v.height, `${source}.height`),
        items,
    };
    if (v.label !== undefined) out.label = expectString(v.label, `${source}.label`);
    return out;
}

function validateMarkdownPage(value: unknown, source: string): MarkdownPage {
    const v = expectObject(value, source);
    const out: MarkdownPage = {
        index: expectInt(v.index, `${source}.index`),
        width: expectFiniteNumber(v.width, `${source}.width`),
        height: expectFiniteNumber(v.height, `${source}.height`),
        markdown: expectString(v.markdown, `${source}.markdown`),
    };
    if (v.label !== undefined) out.label = expectString(v.label, `${source}.label`);
    return out;
}

const allowedKinds = new Set<DocumentItemKind>([
    "text",
    "section_header",
    "list_item",
    "caption",
    "footnote",
    "formula",
    "table",
    "picture",
    "margin",
]);

const textBearingKinds = new Set<DocumentItemKind>([
    "text",
    "section_header",
    "list_item",
    "caption",
    "footnote",
    "formula",
    "margin",
]);

const sentenceBearingKinds = new Set<DocumentItemKind>([
    "text",
    "list_item",
    "caption",
    "footnote",
]);

function validateDocumentItem(value: unknown, source: string): DocumentItem {
    const v = expectObject(value, source);
    const kind = expectString(v.kind, `${source}.kind`) as DocumentItemKind;
    if (!allowedKinds.has(kind)) {
        throw new FixtureValidationError(
            `${source}.kind: unexpected item kind "${kind}"`,
        );
    }
    const base = {
        id: expectString(v.id, `${source}.id`),
        pageIndex: expectInt(v.pageIndex, `${source}.pageIndex`),
        order: expectInt(v.order, `${source}.order`),
        bbox: validateRect(v.bbox, `${source}.bbox`),
    };

    if (textBearingKinds.has(kind)) {
        if (v.text === undefined) {
            throw new FixtureValidationError(`${source}.text: expected string`);
        }
    } else if (v.text !== undefined) {
        throw new FixtureValidationError(`${source}.text: forbidden for ${kind}`);
    }

    if (sentenceBearingKinds.has(kind)) {
        const sentences = v.sentences === undefined
            ? undefined
            : expectArray(v.sentences, `${source}.sentences`).map((s, i) =>
                validateSentence(s, `${source}.sentences[${i}]`),
              );
        return {
            ...base,
            kind,
            text: expectString(v.text, `${source}.text`),
            ...(sentences === undefined ? {} : { sentences }),
        } as DocumentItem;
    }

    if (v.sentences !== undefined) {
        throw new FixtureValidationError(`${source}.sentences: forbidden for ${kind}`);
    }

    if (kind === "section_header") {
        if (v.level === undefined) {
            throw new FixtureValidationError(`${source}.level: expected finite number`);
        }
        return {
            ...base,
            kind,
            text: expectString(v.text, `${source}.text`),
            level: expectFiniteNumber(v.level, `${source}.level`),
        };
    }

    if (v.level !== undefined) {
        throw new FixtureValidationError(`${source}.level: forbidden for ${kind}`);
    }

    if (textBearingKinds.has(kind)) {
        return {
            ...base,
            kind,
            text: expectString(v.text, `${source}.text`),
        } as DocumentItem;
    }

    return { ...base, kind } as DocumentItem;
}

function validateSentence(value: unknown, source: string): Sentence {
    const v = expectObject(value, source);
    const bboxes = expectArray(v.bboxes, `${source}.bboxes`).map((b, i) =>
        validateRect(b, `${source}.bboxes[${i}]`),
    );
    const out: Sentence = {
        id: expectString(v.id, `${source}.id`),
        order: expectInt(v.order, `${source}.order`),
        text: expectString(v.text, `${source}.text`),
        bboxes,
    };
    if (v.joinWithNext === true) out.joinWithNext = true;
    else if (v.joinWithNext !== undefined) {
        throw new FixtureValidationError(
            `${source}.joinWithNext: expected omitted or true, got ${JSON.stringify(v.joinWithNext)}`,
        );
    }
    return out;
}

function validateRect(value: unknown, source: string): Rect {
    const arr = expectArray(value, source);
    if (arr.length !== 4) {
        throw new FixtureValidationError(`${source}: expected Rect tuple length 4`);
    }
    return [
        expectFiniteNumber(arr[0], `${source}[0]`),
        expectFiniteNumber(arr[1], `${source}[1]`),
        expectFiniteNumber(arr[2], `${source}[2]`),
        expectFiniteNumber(arr[3], `${source}[3]`),
    ];
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
