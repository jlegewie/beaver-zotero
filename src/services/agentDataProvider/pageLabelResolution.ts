/**
 * Page label resolution for label-aware page number requests.
 *
 * When a backend handler sets `prefer_page_labels=true` on a page extraction
 * request, the agent's page numbers are interpreted as PDF page **labels**
 * (e.g. "38" meaning "the page that prints 38 in the footer") rather than
 * 1-based document indices.
 *
 */

import { PDFExtractor } from '../pdf';
import type { AttachmentFileCacheRecord } from '../database';
import { logger } from '../../utils/logger';

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
 *   resolvePageValue(5, null, false)                                  → 5
 *   resolvePageValue(1, {0:"i",1:"ii",2:"iii",3:"iv",4:"1"}, true)    → 5
 *   resolvePageValue("iv", {0:"i",1:"ii",2:"iii",3:"iv"}, true)       → 4
 *   resolvePageValue("38", null, false)                               → 38
 *   resolvePageValue("iv", null, false)                               → throws
 */
export function resolvePageValue(
    value: number | string,
    labels: Record<number, string> | null,
    preferPageLabels: boolean,
): number {
    const matchLabel = (target: string): number | null => {
        if (!labels) return null;
        for (const [idx, label] of Object.entries(labels)) {
            if (label === target) return Number(idx) + 1; // 0-based → 1-based
        }
        return null;
    };

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

/** Collect up to MAX_LABEL_SAMPLES distinct label values from the labels map. */
function sampleLabels(labels: Record<number, string> | null): string[] | undefined {
    if (!labels) return undefined;
    const seen = new Set<string>();
    const result: string[] = [];
    for (const label of Object.values(labels)) {
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
    labels: Record<number, string> | null,
): string {
    if (!labels) {
        return `Invalid page value '${value}': no page labels are available for this document, and '${value}' is not a valid positive integer.`;
    }
    const sample = sampleLabels(labels);
    const totalLabels = Object.keys(labels).length;
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
    labels: Record<number, string> | null;
    /** Total page count, or null when unavailable. */
    pageCount: number | null;
    /**
     * PDF file bytes, populated only when an eager load actually happened.
     */
    pdfData: Uint8Array | null;
}

/**
 * Ensure page labels are available for label-aware resolution.
 *
 * Resolution order:
 *   1. Cached metadata (any non-null `page_labels`, including `{}` which means
 *      "already checked, no custom labels")
 *   2. Eager metadata-only load via `PDFExtractor.getPageCountAndLabels` —
 *      opens the PDF once, reads the catalog, closes. No text extraction.
 *   3. Returns `labels: null` on failure; caller falls back to numeric resolution.
 *
 * Empty label maps are normalised to `null` so the resolver can treat
 * "no labels" as a single case.
 */
export async function ensurePageLabelsForResolution(
    filePath: string,
    cachedMeta: AttachmentFileCacheRecord | null,
    extractor: PDFExtractor,
): Promise<PageLabelLoadResult> {
    // 1. Cache hit — page_labels === null means "not yet checked";
    //    {} means "checked, no custom labels".
    if (cachedMeta && cachedMeta.page_labels !== null) {
        const normalised = Object.keys(cachedMeta.page_labels).length > 0
            ? cachedMeta.page_labels
            : null;
        return {
            labels: normalised,
            pageCount: cachedMeta.page_count,
            pdfData: null,
        };
    }

    // 2. Eager metadata-only load
    try {
        const pdfData = await IOUtils.read(filePath);
        const { count, labels } = await extractor.getPageCountAndLabels(pdfData);
        const normalised = Object.keys(labels).length > 0 ? labels : null;
        return { labels: normalised, pageCount: count, pdfData };
    } catch (error) {
        logger(`ensurePageLabelsForResolution: eager load failed for ${filePath}: ${error}`, 1);
        return { labels: null, pageCount: null, pdfData: null };
    }
}
