/**
 * Worker-side shared helper for sentence-level bbox extraction.
 *
 * Single source of truth for the per-page sentence pipeline. Used by
 * both `opExtractSentenceBBoxes` (production, compact result) and
 * `opExtractSentenceBBoxesTrace` (debug, result + intermediates).
 *
 * Pipeline stages:
 *   1. Resolve splitter from config (sentencex with simple fallback).
 *   2. Resolve analysis-window page indices.
 *   3. JSON-walk every analysis page.
 *   4. Substitute the detailed target page into the analysis window and
 *      bridge real font metadata onto it (`pagesForFilterWithBridgedFonts`).
 *   5. Run `detectFilteredParagraphs` (column + line + paragraph detection
 *      with smart cross-page margin removal).
 *   6. Map paragraphs → sentences via `extractPageSentenceBBoxes`.
 *
 * In `trace: true` mode, also pre-compute `marginAnalysis` and
 * `marginRemoval` from the same `pagesForFilter` so they can be returned
 * (mirrors `SentenceExtractionPipeline.ts:128–139`). In `trace: false`
 * mode, skip the standalone pre-compute — `detectFilteredParagraphs`
 * computes the same values internally from `ctx.pages`, so omitting the
 * pre-compute is a true no-op.
 *
 * In `recordSplitter: true` mode (only available with `trace: true`),
 * the resolved splitter is wrapped to capture `(text → ranges)` pairs
 * which are returned in `trace.splitterRecording`. Used by fixture
 * capture for hermetic unit-test replay. Ranges are deep-copied (`{
 * start, end }`) before pushing — the splitter's returned array could
 * be mutated downstream, and copying keeps fixture capture
 * deterministic across the postMessage boundary.
 *
 * Caller is responsible for `acquireDoc`/`releaseDoc` and pageIndex
 * validation. This helper trusts its inputs.
 */

import { extractPageSentenceBBoxes } from "../ParagraphSentenceMapper";
import type { PageSentenceBBoxResult } from "../ParagraphSentenceMapper";
import { resolveAnalysisPageIndices } from "../AnalysisWindow";
import {
    detectFilteredParagraphs,
} from "../FilteredParagraphPipeline";
import { pagesForFilterWithBridgedFonts } from "../RawFontBridge";
import { MarginFilter, getEffectiveRepeatThreshold } from "../MarginFilter";
import { DEFAULT_MARGIN_ZONE } from "../types";
import type {
    SentenceRange,
    SentenceSplitter,
} from "../SentenceMapper";
import type { ParagraphDetectionSettings } from "../ParagraphDetector";
import type {
    SentenceSplitterConfig,
    SentenceBBoxTraceResult,
} from "../sentenceTypes";
import { extractRawPageDetailedFromDoc, extractRawPageFromDoc } from "./docHelpers";
import type { DocumentLike } from "./mupdfApi";
import { resolveSplitter } from "./splitterResolver";

interface BaseArgs {
    doc: DocumentLike;
    pageIndex: number;
    pageCount: number;
    splitterConfig?: SentenceSplitterConfig;
    analysisPageWindow?: number;
    paragraphSettings?: ParagraphDetectionSettings;
}

export async function runSentenceExtractionFromDoc(
    args: BaseArgs & { trace?: false },
): Promise<{ result: PageSentenceBBoxResult }>;
export async function runSentenceExtractionFromDoc(
    args: BaseArgs & { trace: true; recordSplitter?: boolean },
): Promise<SentenceBBoxTraceResult>;
export async function runSentenceExtractionFromDoc(
    args: BaseArgs & { trace?: boolean; recordSplitter?: boolean },
): Promise<{ result: PageSentenceBBoxResult } | SentenceBBoxTraceResult> {
    const {
        doc,
        pageIndex,
        pageCount,
        splitterConfig,
        analysisPageWindow,
        paragraphSettings,
        trace: wantTrace,
        recordSplitter,
    } = args;

    // Resolve the splitter once per request (not per paragraph).
    const innerSplitter = await resolveSplitter(
        splitterConfig ?? { type: "sentencex" },
    );

    // When recording is requested (only meaningful in trace mode), wrap
    // the splitter and deep-copy each `ranges` array — the splitter's
    // returned array could be mutated downstream, and copying keeps
    // fixture capture deterministic across postMessage.
    let splitter: SentenceSplitter = innerSplitter;
    let recordings: Array<{ text: string; ranges: SentenceRange[] }> | undefined;
    if (wantTrace && recordSplitter) {
        const buf: Array<{ text: string; ranges: SentenceRange[] }> = [];
        recordings = buf;
        splitter = (text, ctx): SentenceRange[] => {
            const ranges = innerSplitter(text, ctx);
            buf.push({
                text,
                ranges: ranges.map((r) => ({ start: r.start, end: r.end })),
            });
            return ranges;
        };
    }

    // Detailed target page (per-character quads + bbox identity for the
    // mapper). Walked once and substituted into the analysis window.
    const detailed = extractRawPageDetailedFromDoc(doc, pageIndex, false);

    // Analysis window for cross-page smart margin removal + style profile.
    const analysisPageIndices = resolveAnalysisPageIndices(
        pageIndex,
        pageCount,
        analysisPageWindow,
    );
    const jsonPages = analysisPageIndices.map((i) =>
        extractRawPageFromDoc(doc, i),
    );
    const pagesForFilter = pagesForFilterWithBridgedFonts(
        jsonPages,
        pageIndex,
        detailed,
    );

    if (!wantTrace) {
        // Production path. `detectFilteredParagraphs` computes margin
        // analysis/removal internally from `pages` — passing
        // `totalPageCount` is enough.
        const filtered = detectFilteredParagraphs({
            pages: pagesForFilter,
            pageIndex,
            totalPageCount: pageCount,
            paragraphSettings,
        });
        const result = extractPageSentenceBBoxes(detailed, {
            paragraphSettings,
            splitter,
            precomputed: { paragraphResult: filtered.paragraphResult },
        });
        return { result };
    }

    // Trace path. Pre-compute marginAnalysis/marginRemoval so we can
    // return them; `detectFilteredParagraphs` would otherwise compute
    // identical values internally from `pagesForFilter`. Computing from
    // `jsonPages` instead would silently diverge on the target page.
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
        paragraphSettings,
    });
    const result = extractPageSentenceBBoxes(detailed, {
        paragraphSettings,
        splitter,
        precomputed: { paragraphResult: filteredResult.paragraphResult },
    });

    return {
        result,
        trace: {
            analysisPageIndices,
            rawDoc: { pageCount, pages: jsonPages },
            detailed,
            pagesForFilter,
            marginAnalysis,
            marginRemoval,
            filteredResult,
            splitterRecording: recordings,
        },
    };
}
