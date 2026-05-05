/**
 * Sentence Extraction Pipeline — single source of truth for the
 * sentence-level orchestration shared by:
 *
 *   1. `PDFExtractor.extractSentenceBBoxes()` (production main-thread path),
 *   2. `/beaver/test/pdf-pipeline-trace` (debug endpoint),
 *
 * When `trace: true` the helper returns the production
 * intermediates alongside the result; presentation-layer shaping (IDs,
 * cross-stage links, JSON formatting) stays at the call site.
 *
 * Worker-safe note: this helper runs on the **main thread** because the
 * sentence splitter is non-cloneable. Worker-side sentence extraction
 * (see `worker/ops.ts:opExtractSentenceBBoxes`) currently keeps its own
 * orchestration; folding it onto this helper is a follow-up.
 */

import { getMuPDFWorkerClient } from "./MuPDFWorkerClient";
import { resolveAnalysisPageIndices } from "./AnalysisWindow";
import { MarginFilter } from "./MarginFilter";
import {
    detectFilteredParagraphs,
    type FilteredParagraphResult,
} from "./FilteredParagraphPipeline";
import { pagesForFilterWithBridgedFonts } from "./RawFontBridge";
import {
    extractPageSentenceBBoxes,
    type PageSentenceBBoxOptions,
    type PageSentenceBBoxResult,
} from "./ParagraphSentenceMapper";
import {
    DEFAULT_MARGINS,
    DEFAULT_MARGIN_ZONE,
    type MarginAnalysis,
    type MarginRemovalResult,
    type RawDocumentData,
    type RawPageData,
    type RawPageDataDetailed,
} from "./types";
import type { SentenceSplitter } from "./SentenceMapper";
import {
    getSentenceSplitterWithFallback,
    normalizeLanguageCode,
} from "./SentencexSplitter";
import {
    detectLanguageFromText,
    type DetectSource,
} from "./LanguageDetector";

/**
 * Inputs for `runSentenceExtractionPipeline`.
 *
 * Splitter resolution is handled inside the pipeline so detection can
 * run on already-loaded text (no extra MuPDF pass). Caller-provided
 * `splitter` always wins; otherwise:
 *   - explicit `language` is used as-is;
 *   - `detectLanguage` (default true) gates automatic detection;
 *   - `languageFallback` is used when the sample is too sparse or the
 *     detected code is outside the accepted-detection allowlist.
 *
 * `precomputed` from `PageSentenceBBoxOptions` is intentionally
 * excluded: that shortcut bypasses the analysis window entirely and
 * lives outside this helper (see `PDFExtractor.extractSentenceBBoxes`).
 */
export interface SentencePipelineOptions
    extends Omit<PageSentenceBBoxOptions, "precomputed" | "splitter"> {
    pdfData: Uint8Array | ArrayBuffer;
    pageIndex: number;
    /** Caller-provided splitter; bypasses language resolution entirely. */
    splitter?: SentenceSplitter;
    /** Used when no caller-provided splitter is available and detection runs. */
    languageFallback?: string;
    /** Default `true`. Set `false` to skip detection and use language → fallback → "en". */
    detectLanguage?: boolean;
    analysisPageWindow?: number;
}

/**
 * Production intermediates surfaced when `trace: true`. Consumers MUST
 * read the target page from `pagesForFilter` (not `rawDoc.pages`) when
 * cross-linking to `filteredResult.{lineResult, paragraphResult,
 * columnResult}` — bbox object identity only matches the substituted
 * detailed page.
 */
export interface SentencePipelineTrace {
    analysisPageIndices: number[];
    rawDoc: RawDocumentData;
    detailed: RawPageDataDetailed;
    pagesForFilter: RawPageData[];
    marginAnalysis: MarginAnalysis;
    marginRemoval: MarginRemovalResult;
    filteredResult: FilteredParagraphResult;
    sentenceResult: PageSentenceBBoxResult;
    /**
     * How the sentencex splitter's language was decided for this run.
     * `language` is `null` when the caller supplied their own splitter
     * and we don't know what language it splits.
     */
    languageResolution: {
        language: string | null;
        source: DetectSource;
    };
}

export type SentencePipelineOutput =
    | { result: PageSentenceBBoxResult }
    | { result: PageSentenceBBoxResult; trace: SentencePipelineTrace };

// Must match `SAMPLE_LETTER_CAP` in `LanguageDetector.ts`. The
// detector caps its own working sample at the same threshold, so any
// letters the builder collects beyond it would be discarded inside
// the detector — wasting `filterPageWithSmartRemoval` work on
// non-target pages.
const SAMPLE_LETTER_CAP = 3000;
// Must match the detector's `DEFAULT_MIN_LETTERS` so the primary →
// raw cascade kicks in on the same threshold the detector itself uses
// to declare a sample sparse.
const SAMPLE_MIN_LETTERS = 200;

/**
 * Count Unicode letter codepoints in a string. Used by the sample
 * builder so its cap and primary-vs-raw threshold align with the
 * detector's own sparseness gate (which also counts `\p{L}`).
 * A reference-heavy or numeric-heavy filtered sample can have many
 * characters but few letters; using `string.length` would skip the
 * raw-text fallback unnecessarily in that case.
 */
function countLetters(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; ) {
        const cp = s.codePointAt(i)!;
        const step = cp > 0xffff ? 2 : 1;
        if (
            (cp >= 0x41 && cp <= 0x5a) ||
            (cp >= 0x61 && cp <= 0x7a) ||
            (cp >= 0xc0 && cp <= 0x024f) ||
            (cp >= 0x1e00 && cp <= 0x1eff) ||
            (cp >= 0x0370 && cp <= 0x03ff) ||
            (cp >= 0x0400 && cp <= 0x04ff) ||
            (cp >= 0x0590 && cp <= 0x05ff) ||
            (cp >= 0x0600 && cp <= 0x06ff) ||
            (cp >= 0x0750 && cp <= 0x077f) ||
            (cp >= 0x0900 && cp <= 0x097f) ||
            (cp >= 0x0e00 && cp <= 0x0e7f) ||
            (cp >= 0x3040 && cp <= 0x309f) ||
            (cp >= 0x30a0 && cp <= 0x30ff) ||
            (cp >= 0xac00 && cp <= 0xd7af) ||
            (cp >= 0x4e00 && cp <= 0x9fff) ||
            (cp >= 0x3400 && cp <= 0x4dbf) ||
            (cp >= 0x20000 && cp <= 0x2a6df) ||
            (cp >= 0xfb50 && cp <= 0xfdff) ||
            (cp >= 0xfe70 && cp <= 0xfeff)
        ) {
            n++;
        }
        i += step;
    }
    return n;
}

/**
 * Build the analysis-window-level text sample fed to the language
 * detector. Front-loads the target page so its content is
 * overrepresented (the user's actual focus), then walks the rest of
 * the analysis window in reading order.
 *
 * Primary source: each page filtered with smart-margin removal — the
 * same filter `detectFilteredParagraphs` uses internally per-page, so
 * we get production-equivalent text without re-running paragraph
 * detection on the entire window.
 *
 * Secondary source: raw line text. Used when the filtered sample is
 * letter-sparse (e.g. references-heavy pages, table-of-contents
 * pages, anything where smart removal happens to leave mostly numbers
 * and punctuation).
 */
function buildLanguageSample(args: {
    pagesForFilter: RawPageData[];
    targetPageIndex: number;
    marginRemoval: MarginRemovalResult;
}): string {
    const { pagesForFilter, targetPageIndex, marginRemoval } = args;

    // Page order: target first, then the rest of the window in order.
    const ordered: RawPageData[] = [];
    const target = pagesForFilter.find(
        (p) => p.pageIndex === targetPageIndex,
    );
    if (target) ordered.push(target);
    for (const p of pagesForFilter) {
        if (p.pageIndex !== targetPageIndex) ordered.push(p);
    }

    const collectFrom = (pages: RawPageData[], applyFilter: boolean): string => {
        const parts: string[] = [];
        let letters = 0;
        for (const page of pages) {
            const usePage = applyFilter
                ? MarginFilter.filterPageWithSmartRemoval(
                      page,
                      DEFAULT_MARGINS,
                      DEFAULT_MARGIN_ZONE,
                      marginRemoval,
                  )
                : page;
            for (const block of usePage.blocks) {
                if (block.type !== "text" || !block.lines) continue;
                for (const line of block.lines) {
                    const t = line.text;
                    if (!t) continue;
                    parts.push(t);
                    letters += countLetters(t);
                    if (letters >= SAMPLE_LETTER_CAP) {
                        return parts.join("\n");
                    }
                }
            }
        }
        return parts.join("\n");
    };

    const primary = collectFrom(ordered, true);
    if (countLetters(primary) >= SAMPLE_MIN_LETTERS) return primary;

    const secondary = collectFrom(ordered, false);
    return countLetters(secondary) > countLetters(primary)
        ? secondary
        : primary;
}

function debugLog(msg: string): void {
    try {
        (globalThis as any).Zotero?.debug?.(msg);
    } catch {
        // best effort
    }
}

export async function runSentenceExtractionPipeline(
    opts: SentencePipelineOptions & { trace?: false },
): Promise<{ result: PageSentenceBBoxResult }>;
export async function runSentenceExtractionPipeline(
    opts: SentencePipelineOptions & { trace: true },
): Promise<{ result: PageSentenceBBoxResult; trace: SentencePipelineTrace }>;
export async function runSentenceExtractionPipeline(
    opts: SentencePipelineOptions & { trace?: boolean },
): Promise<SentencePipelineOutput> {
    // Explicit destructure: `language`, `languageFallback`, and
    // `detectLanguage` are pipeline concerns and MUST NOT leak into the
    // mapper layer via `...rest`. The mapper API
    // (`PageSentenceBBoxOptions`) only consumes `splitter` once we've
    // resolved it.
    const {
        pdfData,
        pageIndex,
        splitter: optSplitter,
        language,
        languageFallback,
        detectLanguage,
        analysisPageWindow,
        trace: wantTrace,
        ...mapperRest
    } = opts;

    const client = getMuPDFWorkerClient();

    const tExtract0 = performance.now();
    const pageCount = await client.getPageCount(pdfData);
    const analysisPageIndices = resolveAnalysisPageIndices(
        pageIndex,
        pageCount,
        analysisPageWindow,
    );
    const rawDoc = await client.extractRawPages(pdfData, analysisPageIndices);
    const detailed = await client.extractRawPageDetailed(pdfData, pageIndex);
    const tExtractMs = performance.now() - tExtract0;

    // Substitute the detailed target page into the analysis window so
    // paragraph detection runs on the same walk the mapper later looks
    // up (exact bbox identity, no bridge drift), AND bridge real font
    // metadata from the JSON walk onto the detailed target page —
    // otherwise heading detection is silently disabled on the target
    // page (the wasm font binding leaves every detailed-walk line with
    // empty `font.{name, family, weight, style}`). See
    // `RawFontBridge.ts`.
    const pagesForFilter = pagesForFilterWithBridgedFonts(
        rawDoc.pages,
        pageIndex,
        detailed,
    );

    // Pre-compute margin analysis from `pagesForFilter` so trace can
    // expose them. This is a no-op for production: if we omitted these,
    // `detectFilteredParagraphs` would compute the same values from
    // `ctx.pages` (= pagesForFilter) internally per
    // `FilteredParagraphPipeline.ts:106-112`. Computing from
    // `rawDoc.pages` instead would silently diverge on the target page.
    const marginAnalysis = MarginFilter.collectMarginElements(
        pagesForFilter,
        DEFAULT_MARGIN_ZONE,
    );
    const marginRemoval = MarginFilter.identifyElementsToRemove(
        marginAnalysis,
        3,
        true,
    );

    const tFilter0 = performance.now();
    const filteredResult = detectFilteredParagraphs({
        pages: pagesForFilter,
        pageIndex,
        marginRemoval,
        paragraphSettings: mapperRest.paragraphSettings,
    });
    const tFilterMs = performance.now() - tFilter0;

    // Resolve the splitter. Caller-provided wins; explicit language
    // wins next; otherwise detect (or skip detection if explicitly
    // disabled).
    let splitter = optSplitter;
    let languageResolution: { language: string | null; source: DetectSource };
    let tDetectMs = 0;
    let tSplitter0 = 0;

    if (splitter) {
        languageResolution = language
            ? {
                  language: normalizeLanguageCode(language),
                  source: "caller-splitter",
              }
            : { language: null, source: "caller-splitter" };
    } else if (language) {
        const lang = normalizeLanguageCode(language);
        languageResolution = { language: lang, source: "explicit" };
        tSplitter0 = performance.now();
        splitter = await getSentenceSplitterWithFallback(lang);
    } else {
        const detect = detectLanguage !== false;
        if (detect) {
            const sample = buildLanguageSample({
                pagesForFilter,
                targetPageIndex: pageIndex,
                marginRemoval,
            });
            const tDetect0 = performance.now();
            const result = await detectLanguageFromText(sample, {
                fallback: languageFallback,
            });
            tDetectMs = performance.now() - tDetect0;
            languageResolution = result;
        } else {
            languageResolution = languageFallback
                ? {
                      language: normalizeLanguageCode(languageFallback),
                      source: "fallback",
                  }
                : { language: "en", source: "default" };
        }
        tSplitter0 = performance.now();
        splitter = await getSentenceSplitterWithFallback(
            languageResolution.language ?? "en",
        );
    }
    const tSplitterMs = tSplitter0 ? performance.now() - tSplitter0 : 0;

    const sentenceResult = extractPageSentenceBBoxes(detailed, {
        ...mapperRest,
        splitter,
        precomputed: { paragraphResult: filteredResult.paragraphResult },
    });

    debugLog(
        `[Beaver][pipeline] page=${pageIndex} ` +
            `extract=${tExtractMs.toFixed(1)}ms ` +
            `filter=${tFilterMs.toFixed(1)}ms ` +
            `langDetect=${tDetectMs.toFixed(1)}ms ` +
            `splitterInit=${tSplitterMs.toFixed(1)}ms ` +
            `lang=${languageResolution.language ?? "(caller)"} ` +
            `source=${languageResolution.source}`,
    );

    if (!wantTrace) {
        return { result: sentenceResult };
    }

    return {
        result: sentenceResult,
        trace: {
            analysisPageIndices,
            rawDoc,
            detailed,
            pagesForFilter,
            marginAnalysis,
            marginRemoval,
            filteredResult,
            sentenceResult,
            languageResolution,
        },
    };
}
