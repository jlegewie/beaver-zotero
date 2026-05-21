import type {
    DocumentItem,
    MarkdownPage,
    Rect,
    Sentence,
    StructuredPage,
} from "../../schema";

export interface SnapshotDiff {
    /** JSON-pointer-ish path to the offending field, e.g. "pages[0].items[3].text". */
    path: string;
    kind: "missing" | "extra" | "changed" | "tolerance";
    expected?: unknown;
    actual?: unknown;
    /** Human-readable note for tolerance breaches. */
    note?: string;
}

interface DiffOptions {
    maxDiffs?: number;
}

interface StructuredDiffOptions extends DiffOptions {
    bboxAbsPt: number;
}

export function diffStructuredPages(
    expected: StructuredPage[],
    actual: StructuredPage[],
    opts: StructuredDiffOptions,
): SnapshotDiff[] {
    const diffs: SnapshotDiff[] = [];
    const cap = opts.maxDiffs ?? 200;
    diffArrayLength("pages", expected, actual, diffs);
    const max = Math.max(expected.length, actual.length);
    for (let i = 0; i < max && diffs.length < cap; i++) {
        const ep = expected[i];
        const ap = actual[i];
        if (!ep) {
            diffs.push({ path: `pages[${i}]`, kind: "extra", actual: ap });
            continue;
        }
        if (!ap) {
            diffs.push({ path: `pages[${i}]`, kind: "missing", expected: ep });
            continue;
        }
        diffStructuredPage(`pages[${i}]`, ep, ap, opts, diffs, cap);
    }
    truncateDiffs(diffs, cap);
    return diffs;
}

export function diffMarkdownPages(
    expected: MarkdownPage[],
    actual: MarkdownPage[],
    opts: DiffOptions = {},
): SnapshotDiff[] {
    const diffs: SnapshotDiff[] = [];
    const cap = opts.maxDiffs ?? 200;
    diffArrayLength("pages", expected, actual, diffs);
    const max = Math.max(expected.length, actual.length);
    for (let i = 0; i < max && diffs.length < cap; i++) {
        const ep = expected[i];
        const ap = actual[i];
        if (!ep) {
            diffs.push({ path: `pages[${i}]`, kind: "extra", actual: ap });
            continue;
        }
        if (!ap) {
            diffs.push({ path: `pages[${i}]`, kind: "missing", expected: ep });
            continue;
        }
        diffScalar(`${basePage(i)}.index`, ep.index, ap.index, diffs);
        diffScalar(`${basePage(i)}.width`, ep.width, ap.width, diffs);
        diffScalar(`${basePage(i)}.height`, ep.height, ap.height, diffs);
        diffScalar(
            `${basePage(i)}.markdown`,
            normalizeWhitespace(ep.markdown),
            normalizeWhitespace(ap.markdown),
            diffs,
        );
    }
    truncateDiffs(diffs, cap);
    return diffs;
}

function diffStructuredPage(
    base: string,
    e: StructuredPage,
    a: StructuredPage,
    opts: StructuredDiffOptions,
    diffs: SnapshotDiff[],
    cap: number,
): void {
    diffScalar(`${base}.index`, e.index, a.index, diffs);
    diffScalar(`${base}.width`, e.width, a.width, diffs);
    diffScalar(`${base}.height`, e.height, a.height, diffs);
    diffScalar(`${base}.label`, e.label, a.label, diffs);
    if (diffs.length >= cap) return;

    const maxItems = Math.max(e.items.length, a.items.length);
    for (let i = 0; i < maxItems && diffs.length < cap; i++) {
        const ei = e.items[i];
        const ai = a.items[i];
        if (!ei && ai?.kind === "margin" && i >= e.items.length) continue;
        if (!ei) {
            diffs.push({ path: `${base}.items[${i}]`, kind: "extra", actual: ai });
            continue;
        }
        if (!ai) {
            diffs.push({ path: `${base}.items[${i}]`, kind: "missing", expected: ei });
            continue;
        }
        diffItem(`${base}.items[${i}]`, ei, ai, opts, diffs, cap);
    }
}

function diffItem(
    base: string,
    e: DocumentItem,
    a: DocumentItem,
    opts: StructuredDiffOptions,
    diffs: SnapshotDiff[],
    cap: number,
): void {
    diffScalar(`${base}.id`, e.id, a.id, diffs);
    diffScalar(`${base}.kind`, e.kind, a.kind, diffs);
    diffScalar(`${base}.pageIndex`, e.pageIndex, a.pageIndex, diffs);
    diffScalar(`${base}.order`, e.order, a.order, diffs);
    if ("text" in e || "text" in a) {
        diffScalar(
            `${base}.text`,
            "text" in e ? normalizeWhitespace(e.text) : undefined,
            "text" in a ? normalizeWhitespace(a.text) : undefined,
            diffs,
        );
    }
    if ("level" in e || "level" in a) {
        diffScalar(
            `${base}.level`,
            "level" in e ? e.level : undefined,
            "level" in a ? a.level : undefined,
            diffs,
        );
    }
    diffRect(`${base}.bbox`, e.bbox, a.bbox, opts.bboxAbsPt, diffs);
    if (diffs.length >= cap) return;

    const eSentences = "sentences" in e ? e.sentences ?? [] : [];
    const aSentences = "sentences" in a ? a.sentences ?? [] : [];
    if (eSentences.length !== aSentences.length) {
        diffs.push({
            path: `${base}.sentences.length`,
            kind: "changed",
            expected: eSentences.length,
            actual: aSentences.length,
        });
    }
    const max = Math.max(eSentences.length, aSentences.length);
    for (let i = 0; i < max && diffs.length < cap; i++) {
        const es = eSentences[i];
        const as = aSentences[i];
        if (!es) {
            diffs.push({ path: `${base}.sentences[${i}]`, kind: "extra", actual: as });
            continue;
        }
        if (!as) {
            diffs.push({
                path: `${base}.sentences[${i}]`,
                kind: "missing",
                expected: es,
            });
            continue;
        }
        diffSentence(`${base}.sentences[${i}]`, es, as, opts.bboxAbsPt, diffs);
    }
}

function diffSentence(
    base: string,
    e: Sentence,
    a: Sentence,
    bboxAbsPt: number,
    diffs: SnapshotDiff[],
): void {
    diffScalar(`${base}.id`, e.id, a.id, diffs);
    diffScalar(`${base}.order`, e.order, a.order, diffs);
    diffScalar(`${base}.text`, normalizeWhitespace(e.text), normalizeWhitespace(a.text), diffs);
    diffScalar(
        `${base}.joinWithNext`,
        e.joinWithNext === true,
        a.joinWithNext === true,
        diffs,
    );
    if (e.bboxes.length !== a.bboxes.length) {
        diffs.push({
            path: `${base}.bboxes.length`,
            kind: "changed",
            expected: e.bboxes.length,
            actual: a.bboxes.length,
        });
        return;
    }
    for (let i = 0; i < e.bboxes.length; i++) {
        diffRect(`${base}.bboxes[${i}]`, e.bboxes[i], a.bboxes[i], bboxAbsPt, diffs);
    }
}

function diffRect(
    path: string,
    expected: Rect,
    actual: Rect,
    tol: number,
    diffs: SnapshotDiff[],
): void {
    const breaches: string[] = [];
    const labels = ["l", "t", "r", "b"] as const;
    for (let i = 0; i < 4; i++) {
        const delta = Math.abs(actual[i] - expected[i]);
        if (delta > tol) breaches.push(`Δ${labels[i]}=${delta.toFixed(3)}pt`);
    }
    if (breaches.length > 0) {
        diffs.push({
            path,
            kind: "tolerance",
            expected,
            actual,
            note: `${breaches.join(", ")} > ${tol}pt`,
        });
    }
}

function diffArrayLength(
    path: string,
    expected: unknown[],
    actual: unknown[],
    diffs: SnapshotDiff[],
): void {
    if (expected.length === actual.length) return;
    diffs.push({
        path: `${path}.length`,
        kind: "changed",
        expected: expected.length,
        actual: actual.length,
    });
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

function truncateDiffs(diffs: SnapshotDiff[], cap: number): void {
    if (diffs.length <= cap) return;
    diffs.length = cap;
    diffs.push({ path: "<truncated>", kind: "extra", actual: `more than ${cap} diffs` });
}

function basePage(i: number): string {
    return `pages[${i}]`;
}

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
        lines.push(`  ... and ${diffs.length - HEAD} more`);
    }
    return lines.join("\n");
}

function truncate(value: unknown, max = 80): string {
    let s: string;
    if (typeof value === "string") s = value;
    else if (value === undefined) s = "undefined";
    else s = JSON.stringify(value);
    s = s.replace(/\s+/g, " ");
    return s.length > max ? s.slice(0, max) + "..." : s;
}
