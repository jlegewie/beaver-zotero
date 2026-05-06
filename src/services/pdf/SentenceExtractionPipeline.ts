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
import { MarginFilter, getEffectiveRepeatThreshold } from "./MarginFilter";
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
    DEFAULT_MARGIN_ZONE,
    type MarginAnalysis,
    type MarginRemovalResult,
    type RawDocumentData,
    type RawPageData,
    type RawPageDataDetailed,
} from "./types";
import type { SentenceSplitter } from "./SentenceMapper";

/**
 * Inputs for `runSentenceExtractionPipeline`. Splitter is required and
 * non-optional — callers (production and debug) already resolve it via
 * `getSentenceSplitterWithFallback`, and centralizing that here would
 * not remove duplication. `precomputed` from `PageSentenceBBoxOptions`
 * is intentionally excluded: that shortcut bypasses the analysis window
 * entirely and lives outside this helper.
 */
export interface SentencePipelineOptions
    extends Omit<PageSentenceBBoxOptions, "precomputed" | "splitter"> {
    pdfData: Uint8Array | ArrayBuffer;
    pageIndex: number;
    splitter: SentenceSplitter;
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
}

export type SentencePipelineOutput =
    | { result: PageSentenceBBoxResult }
    | { result: PageSentenceBBoxResult; trace: SentencePipelineTrace };

export async function runSentenceExtractionPipeline(
    opts: SentencePipelineOptions & { trace?: false },
): Promise<{ result: PageSentenceBBoxResult }>;
export async function runSentenceExtractionPipeline(
    opts: SentencePipelineOptions & { trace: true },
): Promise<{ result: PageSentenceBBoxResult; trace: SentencePipelineTrace }>;
export async function runSentenceExtractionPipeline(
    opts: SentencePipelineOptions & { trace?: boolean },
): Promise<SentencePipelineOutput> {
    const {
        pdfData,
        pageIndex,
        splitter,
        analysisPageWindow,
        trace: wantTrace,
        ...rest
    } = opts;

    const client = getMuPDFWorkerClient();

    const pageCount = await client.getPageCount(pdfData);
    const analysisPageIndices = resolveAnalysisPageIndices(
        pageIndex,
        pageCount,
        analysisPageWindow,
    );
    const rawDoc = await client.extractRawPages(pdfData, analysisPageIndices);
    const detailed = await client.extractRawPageDetailed(pdfData, pageIndex);

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
        getEffectiveRepeatThreshold({
            totalPageCount: pageCount,
            analysisPageCount: pagesForFilter.length,
        }),
        true,
    );

    const filteredResult = detectFilteredParagraphs({
        pages: pagesForFilter,
        pageIndex,
        marginRemoval,
        paragraphSettings: rest.paragraphSettings,
    });

    const sentenceResult = extractPageSentenceBBoxes(detailed, {
        ...rest,
        splitter,
        precomputed: { paragraphResult: filteredResult.paragraphResult },
    });

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
        },
    };
}
