/**
 * Snapshot projection + structural diff for `OCRDetectionResult`.
 *
 * Used by the OCR fixture suite (`beaver-extract ocr-fixture …` and
 * `tests/smoke/ocrFixtures.smoke.test.ts`) to produce a stable JSON
 * shape and to compare a captured `expected` snapshot against the live
 * detector output.
 *
 * Browser-safe — no `fs` or other Node-only imports.
 */
import { DEFAULT_OCR_DETECTION_OPTIONS } from "../types";
import type {
    OCRDetectionOptions,
    OCRDetectionResult,
    OCRIssueReason,
    PageOCRAnalysis,
} from "../types";
import type {
    CapturedOcrFixture,
    OcrSnapshot,
    SnapshotPageOcr,
} from "../cli/fixture/ocrFixtureSchema";

// Re-export the snapshot types so consumers can stay within one module.
export type { OcrSnapshot, SnapshotPageOcr } from "../cli/fixture/ocrFixtureSchema";

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project an `OCRDetectionResult` to the snapshot wire shape. Idempotent
 * and pure — keys of `issueBreakdown` are normalized into a fully
 * populated record so diffs aren't sensitive to missing-vs-zero ambiguity.
 */
export function projectOcrSnapshot(result: OCRDetectionResult): OcrSnapshot {
    return {
        needsOCR: result.needsOCR,
        primaryReason: result.primaryReason,
        issueRatio: round3(result.issueRatio),
        issueBreakdown: normalizeBreakdown(result.issueBreakdown),
        sampledPages: result.sampledPages,
        totalPages: result.totalPages,
        pageAnalyses: result.pageAnalyses.map(projectPage),
    };
}

function projectPage(p: PageOCRAnalysis): SnapshotPageOcr {
    return {
        pageIndex: p.pageIndex,
        hasIssues: p.hasIssues,
        issues: [...p.issues].sort(),
        textLength: p.textLength,
        hasImages: p.hasImages,
    };
}

function normalizeBreakdown(
    raw: Record<OCRIssueReason, number>,
): Record<OCRIssueReason, number> {
    return {
        no_text_blocks: raw.no_text_blocks ?? 0,
        no_body_text: raw.no_body_text ?? 0,
        insufficient_text: raw.insufficient_text ?? 0,
        high_whitespace_ratio: raw.high_whitespace_ratio ?? 0,
        high_newline_ratio: raw.high_newline_ratio ?? 0,
        low_alphanumeric_ratio: raw.low_alphanumeric_ratio ?? 0,
        invalid_characters: raw.invalid_characters ?? 0,
        fragmented_text_lines: raw.fragmented_text_lines ?? 0,
        large_image_coverage: raw.large_image_coverage ?? 0,
        bbox_overflow: raw.bbox_overflow ?? 0,
        excessive_line_overlap: raw.excessive_line_overlap ?? 0,
    };
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}

/**
 * Merge user overrides onto the defaults. The result is the snapshot of
 * "what was actually passed to `analyzeOCRNeeds`" — captured on disk so
 * subsequent runs can detect default-value drift.
 */
export function mergeEffectiveOptions(
    overrides: OCRDetectionOptions,
): Required<OCRDetectionOptions> {
    return { ...DEFAULT_OCR_DETECTION_OPTIONS, ...overrides };
}

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

export interface OcrDiff {
    /** JSON-pointer-ish path to the offending field. */
    path: string;
    kind: "missing" | "extra" | "changed" | "tolerance";
    expected?: unknown;
    actual?: unknown;
    /** Human note for tolerance breaches. */
    note?: string;
}

export interface OcrDiffOptions {
    issueRatioAbs: number;
    textLengthAbs: number;
    /** Hard cap on diffs returned (default 100). */
    maxDiffs?: number;
}

/**
 * Diff a captured fixture against fresh `OcrSnapshot` + effective options.
 *
 * The effective-options snapshot lives on the fixture (`config.effectiveOptions`)
 * because `OCRDetectionResult` doesn't include it. Callers compute the
 * actual side via `mergeEffectiveOptions(fixture.config.options)`.
 */
export function diffOcrSnapshots(
    fixture: CapturedOcrFixture,
    actual: {
        snapshot: OcrSnapshot;
        effectiveOptions: Required<OCRDetectionOptions>;
    },
    opts: OcrDiffOptions,
): OcrDiff[] {
    const diffs: OcrDiff[] = [];
    const cap = opts.maxDiffs ?? 100;

    diffEffectiveOptions(
        fixture.config.effectiveOptions,
        actual.effectiveOptions,
        diffs,
    );
    if (diffs.length >= cap) return diffs;

    diffSnapshot(fixture.expected, actual.snapshot, opts, diffs, cap);
    return diffs;
}

function diffEffectiveOptions(
    e: Required<OCRDetectionOptions>,
    a: Required<OCRDetectionOptions>,
    diffs: OcrDiff[],
): void {
    for (const k of Object.keys(e) as (keyof Required<OCRDetectionOptions>)[]) {
        if (e[k] !== a[k]) {
            diffs.push({
                path: `config.effectiveOptions.${String(k)}`,
                kind: "changed",
                expected: e[k],
                actual: a[k],
            });
        }
    }
}

function diffSnapshot(
    e: OcrSnapshot,
    a: OcrSnapshot,
    opts: OcrDiffOptions,
    diffs: OcrDiff[],
    cap: number,
): void {
    diffScalar("expected.needsOCR", e.needsOCR, a.needsOCR, diffs);
    diffScalar("expected.primaryReason", e.primaryReason, a.primaryReason, diffs);

    if (Math.abs(e.issueRatio - a.issueRatio) > opts.issueRatioAbs) {
        diffs.push({
            path: "expected.issueRatio",
            kind: "tolerance",
            expected: e.issueRatio,
            actual: a.issueRatio,
            note: `Δ=${(a.issueRatio - e.issueRatio).toFixed(4)} > ${opts.issueRatioAbs}`,
        });
    }

    for (const reason of Object.keys(
        e.issueBreakdown,
    ) as (keyof typeof e.issueBreakdown)[]) {
        diffScalar(
            `expected.issueBreakdown.${reason}`,
            e.issueBreakdown[reason],
            a.issueBreakdown[reason],
            diffs,
        );
    }

    diffScalar("expected.sampledPages", e.sampledPages, a.sampledPages, diffs);
    diffScalar("expected.totalPages", e.totalPages, a.totalPages, diffs);

    if (diffs.length >= cap) return;

    if (e.pageAnalyses.length !== a.pageAnalyses.length) {
        diffs.push({
            path: "expected.pageAnalyses.length",
            kind: "changed",
            expected: e.pageAnalyses.length,
            actual: a.pageAnalyses.length,
        });
    }
    const max = Math.max(e.pageAnalyses.length, a.pageAnalyses.length);
    for (let i = 0; i < max; i++) {
        if (diffs.length >= cap) return;
        const ep = e.pageAnalyses[i];
        const ap = a.pageAnalyses[i];
        if (!ep) {
            diffs.push({
                path: `expected.pageAnalyses[${i}]`,
                kind: "extra",
                actual: ap,
            });
            continue;
        }
        if (!ap) {
            diffs.push({
                path: `expected.pageAnalyses[${i}]`,
                kind: "missing",
                expected: ep,
            });
            continue;
        }
        diffPage(`expected.pageAnalyses[${i}]`, ep, ap, opts, diffs);
    }
}

function diffPage(
    base: string,
    e: SnapshotPageOcr,
    a: SnapshotPageOcr,
    opts: OcrDiffOptions,
    diffs: OcrDiff[],
): void {
    diffScalar(`${base}.pageIndex`, e.pageIndex, a.pageIndex, diffs);
    diffScalar(`${base}.hasIssues`, e.hasIssues, a.hasIssues, diffs);
    diffScalar(`${base}.hasImages`, e.hasImages, a.hasImages, diffs);
    if (!sameSet(e.issues, a.issues)) {
        diffs.push({
            path: `${base}.issues`,
            kind: "changed",
            expected: e.issues,
            actual: a.issues,
        });
    }
    if (Math.abs(e.textLength - a.textLength) > opts.textLengthAbs) {
        diffs.push({
            path: `${base}.textLength`,
            kind: "tolerance",
            expected: e.textLength,
            actual: a.textLength,
            note: `Δ=${a.textLength - e.textLength} > ${opts.textLengthAbs}`,
        });
    }
}

function diffScalar(
    path: string,
    expected: unknown,
    actual: unknown,
    diffs: OcrDiff[],
): void {
    if (expected !== actual) {
        diffs.push({ path, kind: "changed", expected, actual });
    }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const sa = new Set(a);
    for (const x of b) if (!sa.has(x)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatOcrDiffs(label: string, diffs: OcrDiff[]): string {
    if (diffs.length === 0) return `${label}: OK`;
    const lines: string[] = [`${label}: ${diffs.length} diff(s)`];
    for (const d of diffs) {
        const parts: string[] = [`  ${d.path} [${d.kind}]`];
        if (d.note) parts.push(`  note: ${d.note}`);
        if (d.expected !== undefined) {
            parts.push(`  expected: ${truncate(JSON.stringify(d.expected))}`);
        }
        if (d.actual !== undefined) {
            parts.push(`  actual:   ${truncate(JSON.stringify(d.actual))}`);
        }
        lines.push(parts.join("\n"));
    }
    return lines.join("\n");
}

function truncate(s: string, max = 240): string {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
