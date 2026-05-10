/**
 * Snapshot projection + structural diff for `ExtractionResult`.
 *
 * Used by the BeaverExtract fixture suite (`beaver-extract fixture …` and
 * `tests/smoke/extractFixtures.smoke.test.ts`) to produce a stable,
 * inspectable JSON shape from the structured-mode extract output.
 *
 * Browser-safe — no `fs`, no Node-only imports. Mirrors the style of the
 * companion `analyzeLayoutProjection.ts` so HTTP handlers and live tests can
 * consume the same projection later.
 *
 * Snapshots cover only the fields that drive sentence-level regression: the
 * page geometry, the markdown `content`, paragraph + sentence counts, and
 * each `SentenceBBox` projected to the minimum stable subset (text + bboxes
 * rounded to 3 decimals + classification flags).
 */
import type { ExtractionResult, ProcessedPage, RawBBox, SentenceBBox } from "../types";

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

export interface SnapshotBBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface SnapshotSentence {
    /** Position in the page-flat sentence list (mirrors `ExtractionPageSnapshot.sentences`). */
    index: number;
    /** Source paragraph index on this page. */
    paragraphIndex: number;
    /** Position within the source paragraph (0-based). */
    sentenceIndex: number;
    kind: "text" | "heading";
    text: string;
    bboxes: SnapshotBBox[];
    /** Producer continuation hint. Omitted ≡ false; never serialized as false. */
    joinWithNext?: true;
}

export interface ExtractionPageSnapshot {
    pageIndex: number;
    pageWidth: number;
    pageHeight: number;
    /** Markdown content from the paragraph engine. Compared exactly. */
    content: string;
    paragraphCount: number;
    sentenceCount: number;
    /** Total degraded paragraphs on this page (from `ProcessedPage.degradation.count`). */
    degradedParagraphs: number;
    sentences: SnapshotSentence[];
}

export interface ExtractionSnapshot {
    perPage: ExtractionPageSnapshot[];
    /** Global totals across the captured pages. Coarse-grained signal only. */
    totals: {
        paragraphCount: number;
        sentenceCount: number;
        degradedParagraphs: number;
    };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project an `ExtractionResult` to the snapshot wire shape. Idempotent and
 * pure — bbox coords are rounded to 3 decimals to keep diffs stable across
 * insignificant float jitter.
 *
 * Only includes pages that the structured-mode op actually emitted; pages
 * outside `config.pageIndices` are not in `result.pages` to begin with.
 */
export function projectExtractionSnapshot(
    result: ExtractionResult,
): ExtractionSnapshot {
    const perPage = result.pages.map(projectPage);
    const totals = perPage.reduce(
        (acc, p) => ({
            paragraphCount: acc.paragraphCount + p.paragraphCount,
            sentenceCount: acc.sentenceCount + p.sentenceCount,
            degradedParagraphs: acc.degradedParagraphs + p.degradedParagraphs,
        }),
        { paragraphCount: 0, sentenceCount: 0, degradedParagraphs: 0 },
    );
    return { perPage, totals };
}

function projectPage(page: ProcessedPage): ExtractionPageSnapshot {
    const sentences = (page.sentences ?? []).map(projectSentence);
    return {
        pageIndex: page.index,
        pageWidth: page.width,
        pageHeight: page.height,
        content: page.content,
        paragraphCount: (page.paragraphs ?? []).length,
        sentenceCount: sentences.length,
        degradedParagraphs: page.degradation?.count ?? 0,
        sentences,
    };
}

function projectSentence(s: SentenceBBox, idx: number): SnapshotSentence {
    const out: SnapshotSentence = {
        index: idx,
        paragraphIndex: s.paragraphIndex,
        sentenceIndex: s.sentenceIndex,
        kind: s.kind ?? "text",
        text: s.text,
        bboxes: s.bboxes.map(roundBBox),
    };
    if (s.joinWithNext) out.joinWithNext = true;
    return out;
}

function roundBBox(b: RawBBox): SnapshotBBox {
    return {
        x: round3(b.x),
        y: round3(b.y),
        w: round3(b.w),
        h: round3(b.h),
    };
}

function round3(n: number): number {
    return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

export interface SnapshotDiff {
    /** JSON-pointer-ish path to the offending field, e.g. "perPage[0].sentences[12].text". */
    path: string;
    kind: "missing" | "extra" | "changed" | "tolerance";
    expected?: unknown;
    actual?: unknown;
    /** Human-readable note (e.g. "Δx=0.7pt > 0.5pt") for tolerance breaches. */
    note?: string;
}

export interface DiffOptions {
    /** Per-coordinate absolute tolerance (points) for bbox fields. */
    bboxAbsPt: number;
    /** Hard cap on diffs returned (default 200). Avoids OOM on snapshot drift. */
    maxDiffs?: number;
}

/**
 * Recursive structural walker that tolerates floating-point bbox drift up to
 * `bboxAbsPt`. Returns up to `maxDiffs` entries; truncation is signaled by an
 * extra synthetic diff with `kind: "extra"` and `path: "<truncated>"`.
 */
export function diffExtractionSnapshots(
    expected: ExtractionSnapshot,
    actual: ExtractionSnapshot,
    opts: DiffOptions,
): SnapshotDiff[] {
    const diffs: SnapshotDiff[] = [];
    const cap = opts.maxDiffs ?? 200;

    diffPages(expected.perPage, actual.perPage, opts, diffs, cap);
    if (diffs.length >= cap) return diffs;

    diffScalar("totals.paragraphCount", expected.totals.paragraphCount, actual.totals.paragraphCount, diffs);
    diffScalar("totals.sentenceCount", expected.totals.sentenceCount, actual.totals.sentenceCount, diffs);
    diffScalar("totals.degradedParagraphs", expected.totals.degradedParagraphs, actual.totals.degradedParagraphs, diffs);

    return diffs;
}

function diffPages(
    expected: ExtractionPageSnapshot[],
    actual: ExtractionPageSnapshot[],
    opts: DiffOptions,
    diffs: SnapshotDiff[],
    cap: number,
): void {
    if (expected.length !== actual.length) {
        diffs.push({
            path: "perPage.length",
            kind: "changed",
            expected: expected.length,
            actual: actual.length,
        });
    }
    const max = Math.max(expected.length, actual.length);
    for (let i = 0; i < max; i++) {
        if (diffs.length >= cap) return;
        const ep = expected[i];
        const ap = actual[i];
        if (!ep) {
            diffs.push({ path: `perPage[${i}]`, kind: "extra", actual: ap });
            continue;
        }
        if (!ap) {
            diffs.push({ path: `perPage[${i}]`, kind: "missing", expected: ep });
            continue;
        }
        diffPage(`perPage[${i}]`, ep, ap, opts, diffs, cap);
    }
}

function diffPage(
    base: string,
    e: ExtractionPageSnapshot,
    a: ExtractionPageSnapshot,
    opts: DiffOptions,
    diffs: SnapshotDiff[],
    cap: number,
): void {
    diffScalar(`${base}.pageIndex`, e.pageIndex, a.pageIndex, diffs);
    diffScalar(`${base}.pageWidth`, e.pageWidth, a.pageWidth, diffs);
    diffScalar(`${base}.pageHeight`, e.pageHeight, a.pageHeight, diffs);
    diffScalar(`${base}.content`, e.content, a.content, diffs);
    diffScalar(`${base}.paragraphCount`, e.paragraphCount, a.paragraphCount, diffs);
    diffScalar(`${base}.sentenceCount`, e.sentenceCount, a.sentenceCount, diffs);
    diffScalar(`${base}.degradedParagraphs`, e.degradedParagraphs, a.degradedParagraphs, diffs);

    if (diffs.length >= cap) return;
    const max = Math.max(e.sentences.length, a.sentences.length);
    for (let i = 0; i < max; i++) {
        if (diffs.length >= cap) return;
        const es = e.sentences[i];
        const as = a.sentences[i];
        if (!es) {
            diffs.push({ path: `${base}.sentences[${i}]`, kind: "extra", actual: as });
            continue;
        }
        if (!as) {
            diffs.push({ path: `${base}.sentences[${i}]`, kind: "missing", expected: es });
            continue;
        }
        diffSentence(`${base}.sentences[${i}]`, es, as, opts, diffs);
    }
}

function diffSentence(
    base: string,
    e: SnapshotSentence,
    a: SnapshotSentence,
    opts: DiffOptions,
    diffs: SnapshotDiff[],
): void {
    diffScalar(`${base}.paragraphIndex`, e.paragraphIndex, a.paragraphIndex, diffs);
    diffScalar(`${base}.sentenceIndex`, e.sentenceIndex, a.sentenceIndex, diffs);
    diffScalar(`${base}.kind`, e.kind, a.kind, diffs);
    diffScalar(`${base}.text`, normalizeWhitespace(e.text), normalizeWhitespace(a.text), diffs);
    diffScalar(`${base}.joinWithNext`, e.joinWithNext === true, a.joinWithNext === true, diffs);

    if (e.bboxes.length !== a.bboxes.length) {
        diffs.push({
            path: `${base}.bboxes.length`,
            kind: "changed",
            expected: e.bboxes.length,
            actual: a.bboxes.length,
        });
        return;
    }
    for (let j = 0; j < e.bboxes.length; j++) {
        diffBBox(`${base}.bboxes[${j}]`, e.bboxes[j], a.bboxes[j], opts.bboxAbsPt, diffs);
    }
}

function diffBBox(
    base: string,
    e: SnapshotBBox,
    a: SnapshotBBox,
    tol: number,
    diffs: SnapshotDiff[],
): void {
    const breaches: string[] = [];
    for (const k of ["x", "y", "w", "h"] as const) {
        const delta = Math.abs(a[k] - e[k]);
        if (delta > tol) breaches.push(`Δ${k}=${delta.toFixed(3)}pt`);
    }
    if (breaches.length > 0) {
        diffs.push({
            path: base,
            kind: "tolerance",
            expected: e,
            actual: a,
            note: `${breaches.join(", ")} > ${tol}pt`,
        });
    }
}

function diffScalar(
    path: string,
    expected: unknown,
    actual: unknown,
    diffs: SnapshotDiff[],
): void {
    if (Object.is(expected, actual)) return;
    diffs.push({ path, kind: "changed", expected, actual });
}

function normalizeWhitespace(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Failure formatting
// ---------------------------------------------------------------------------

/**
 * Render a list of diffs as an agent-readable failure block. Truncates long
 * `expected`/`actual` values to 80 chars and limits to the first 25 entries.
 */
export function formatDiffs(name: string, diffs: SnapshotDiff[]): string {
    if (diffs.length === 0) return `${name}: ok`;
    const HEAD = 25;
    const lines: string[] = [`${name}: ${diffs.length} diff(s)`];
    for (let i = 0; i < Math.min(HEAD, diffs.length); i++) {
        const d = diffs[i];
        switch (d.kind) {
            case "missing":
                lines.push(`  [missing] ${d.path}: ${truncate(d.expected)}`);
                break;
            case "extra":
                lines.push(`  [extra]   ${d.path}: ${truncate(d.actual)}`);
                break;
            case "tolerance":
                lines.push(`  [bbox]    ${d.path}: ${d.note ?? ""}`);
                break;
            case "changed":
                lines.push(
                    `  [diff]    ${d.path}:\n` +
                        `              expected: ${truncate(d.expected)}\n` +
                        `              actual:   ${truncate(d.actual)}`,
                );
                break;
        }
    }
    if (diffs.length > HEAD) {
        lines.push(`  … and ${diffs.length - HEAD} more`);
    }
    return lines.join("\n");
}

function truncate(value: unknown, max = 80): string {
    let s: string;
    if (typeof value === "string") s = value;
    else if (value === undefined) s = "undefined";
    else s = JSON.stringify(value);
    s = s.replace(/\s+/g, " ");
    return s.length > max ? s.slice(0, max) + "…" : s;
}
