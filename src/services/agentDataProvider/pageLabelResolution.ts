/**
 * Page label resolution for label-aware page number requests.
 *
 * When a backend handler sets `prefer_page_labels=true` on a page extraction
 * request, the agent's page numbers are interpreted as PDF page **labels**
 * (e.g. "38" meaning "the page that prints 38 in the footer") rather than
 * 1-based document indices.
 *
 * A label is looked up among the printed labels first (the ones the model is
 * shown), then among the labels the PDF declares, then read as a physical page.
 */

import { BeaverExtractor, isWorkerDeadlineError } from '../../beaver-extract';
import type { DocumentCacheMetadata, PageLabels } from '../documentCache';
import { zoteroLocatorPageLabelsFromMetadata } from '../documentExtraction/pageLabels';
import { logger } from '@beaver/agent-core/platform/logger';

/**
 * Maximum number of sample labels to include in InvalidPageValueError payloads.
 * Keeps error messages compact while still giving the agent enough context to recover.
 */
const MAX_LABEL_SAMPLES = 10;

/**
 * Thrown by `resolvePageValue` when the input can't be resolved to a valid
 * 1-based physical page index. Carries a sample of known document labels
 * (when available) so callers can surface an actionable error to the agent.
 */
export class InvalidPageValueError extends Error {
    readonly knownLabels?: string[];

    constructor(message: string, knownLabels?: string[]) {
        super(message);
        this.name = 'InvalidPageValueError';
        this.knownLabels = knownLabels;
    }
}

/** Label maps a page value is resolved against, by namespace. */
export interface PageLabelResolutionLabels {
    /** Printed page labels (see `documentExtraction/pageLabels`). */
    printed: PageLabels | null;
    /** Labels the PDF declares. */
    locator: PageLabels | null;
}

/**
 * Length of the run of consecutive Arabic labels that page `index` belongs to.
 */
function arabicRunLength(labels: PageLabels, index: number): number {
    const value = (i: number): number | null => {
        const label = labels[i];
        return label != null && /^\d+$/.test(label) ? Number(label) : null;
    };
    if (value(index) === null) return 0;
    let start = index;
    while (value(start - 1) !== null && value(start - 1)! + 1 === value(start)) start--;
    let end = index;
    while (value(end + 1) !== null && value(end)! + 1 === value(end + 1)) end++;
    return end - start + 1;
}

/**
 * 1-based page whose label is `target`, or null. When several pages carry the
 * label, the one in the longest Arabic run (the main body) wins.
 */
function findLabelledPage(labels: PageLabels | null, target: string): number | null {
    if (!labels) return null;
    const matches = Object.entries(labels)
        .filter(([, label]) => label === target)
        .map(([idx]) => Number(idx))
        .filter((idx) => Number.isInteger(idx) && idx >= 0)
        .sort((a, b) => a - b);
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0] + 1;
    let best = matches[0];
    let bestRun = arabicRunLength(labels, best);
    for (const idx of matches.slice(1)) {
        const run = arabicRunLength(labels, idx);
        if (run > bestRun) {
            best = idx;
            bestRun = run;
        }
    }
    logger(`resolvePageValue: page label '${target}' is on ${matches.length} pages; using page ${best + 1}`, 2);
    return best + 1;
}

/**
 * Resolve a page reference (numeric index or label string) to a 1-based
 * physical page index.
 *
 * Rules:
 *   number input:
 *     preferPageLabels=false → physical 1-based index (no-op)
 *     preferPageLabels=true  → label lookup first, numeric fallback on miss
 *
 *   string input:
 *     preferPageLabels=true  → label lookup first; if miss, try numeric parse;
 *                              throw InvalidPageValueError if still invalid
 *     preferPageLabels=false → try numeric parse; throw InvalidPageValueError
 *                              if the string can't be parsed as a positive int
 *
 * Examples:
 *   const none = { printed: null, locator: null };
 *   resolvePageValue(5, none, false)                                              → 5
 *   resolvePageValue(1, { printed: {0:"i",1:"ii",2:"iii",3:"iv",4:"1"}, locator: null }, true) → 5
 *   resolvePageValue("iv", { printed: null, locator: {0:"i",1:"ii",2:"iii",3:"iv"} }, true)    → 4
 *   resolvePageValue("38", none, false)                                           → 38
 *   resolvePageValue("iv", none, false)                                           → throws
 */
export function resolvePageValue(
    value: number | string,
    labels: PageLabelResolutionLabels,
    preferPageLabels: boolean,
): number {
    const matchLabel = (target: string): number | null =>
        findLabelledPage(labels.printed, target) ?? findLabelledPage(labels.locator, target);

    const parseAsPositiveInt = (s: string): number | null => {
        const trimmed = s.trim();
        if (!/^\d+$/.test(trimmed)) return null;
        const n = Number(trimmed);
        return Number.isInteger(n) && n >= 1 ? n : null;
    };

    // number input
    if (typeof value === 'number') {
        if (preferPageLabels) {
            const labelIdx = matchLabel(String(value));
            if (labelIdx !== null) return labelIdx;
        }
        return value;
    }

    // string input
    if (preferPageLabels) {
        const labelIdx = matchLabel(value);
        if (labelIdx !== null) return labelIdx;
        const numeric = parseAsPositiveInt(value);
        if (numeric !== null) return numeric;
        throw new InvalidPageValueError(
            buildLabelMissMessage(value, labels),
            sampleLabels(labels),
        );
    }

    const numeric = parseAsPositiveInt(value);
    if (numeric !== null) return numeric;
    throw new InvalidPageValueError(
        `Invalid page value '${value}': expected a positive integer. `
        + `Page labels are only resolved after a prior read_note call in this run.`,
    );
}

/** The labels shown to the model in errors: printed ones when there are any. */
function knownLabels(labels: PageLabelResolutionLabels): PageLabels | null {
    return labels.printed && Object.keys(labels.printed).length > 0 ? labels.printed : labels.locator;
}

/** Collect up to MAX_LABEL_SAMPLES distinct label values from the labels map. */
function sampleLabels(labels: PageLabelResolutionLabels): string[] | undefined {
    const known = knownLabels(labels);
    if (!known) return undefined;
    const seen = new Set<string>();
    const result: string[] = [];
    for (const label of Object.values(known)) {
        if (seen.has(label)) continue;
        seen.add(label);
        result.push(label);
        if (result.length >= MAX_LABEL_SAMPLES) break;
    }
    return result.length > 0 ? result : undefined;
}

/** Build a helpful error message for string inputs that didn't match any label. */
function buildLabelMissMessage(
    value: string,
    labels: PageLabelResolutionLabels,
): string {
    const known = knownLabels(labels);
    if (!known) {
        return `Invalid page value '${value}': no page labels are available for this document, and '${value}' is not a valid positive integer.`;
    }
    const sample = sampleLabels(labels);
    const totalLabels = Object.keys(known).length;
    const preview = sample && sample.length > 0
        ? ` Known labels include: ${sample.join(', ')}${totalLabels > sample.length ? ', …' : ''}.`
        : '';
    return `Page label '${value}' not found in document, and '${value}' is not a valid positive integer.${preview}`;
}

/**
 * Result of loading page labels for label-aware resolution.
 */
export interface PageLabelLoadResult {
    /**
     * Page labels map (0-indexed keys → label strings), or null when
     * unavailable.
     */
    labels: PageLabels | null;
    /** Total page count, or null when unavailable. */
    pageCount: number | null;
    /**
     * PDF file bytes, populated only when an eager load actually happened.
     */
    pdfData: Uint8Array | null;
}

/**
 * Ensure the labels the PDF declares are available for label-aware
 * resolution. Printed labels come from cache metadata only.
 *
 * Resolution order:
 *   1. Cached metadata (any non-null `pageLabels`, including `{}` which means
 *      "already checked, no custom labels")
 *   2. Eager metadata-only load via `BeaverExtractor.getMetadata` —
 *      opens the PDF once, reads the catalog, closes. No text extraction.
 *   3. Returns `labels: null` on failure; caller falls back to numeric
 *      resolution. Exception: a worker busy-lease deadline error is rethrown
 *      so the caller can classify it as a timeout instead.
 *
 * Empty label maps are normalised to `null` so the resolver can treat
 * "no labels" as a single case.
 */
export async function ensurePageLabelsForResolution(
    filePath: string,
    cachedMeta: DocumentCacheMetadata | null,
    extractor: BeaverExtractor,
    signal?: AbortSignal,
    onWorkerDispatch?: () => void,
): Promise<PageLabelLoadResult> {
    // 1. Cache hit — pageLabels === null means "not yet checked";
    //    {} means "checked, no custom labels".
    if (cachedMeta && cachedMeta.pageLabels !== null) {
        return {
            labels: zoteroLocatorPageLabelsFromMetadata(cachedMeta),
            pageCount: cachedMeta.pageCount,
            pdfData: null,
        };
    }

    // 2. Eager metadata-only load
    try {
        const pdfData = await IOUtils.read(filePath);
        onWorkerDispatch?.();
        const { pageCount, pageLabels } = await extractor.getMetadata(pdfData, signal);
        const normalised = Object.keys(pageLabels).length > 0 ? pageLabels : null;
        return { labels: normalised, pageCount, pdfData };
    } catch (error) {
        // A busy-lease reap must reach the caller's timeout classification
        // (and the worker diagnostics attached there) rather than being
        // hidden behind the best-effort null fallback below.
        if (isWorkerDeadlineError(error)) throw error;
        logger(`ensurePageLabelsForResolution: eager load failed for ${filePath}: ${error}`, 1);
        return { labels: null, pageCount: null, pdfData: null };
    }
}
