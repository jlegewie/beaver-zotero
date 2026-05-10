/**
 * Public API types for sentence-level bbox extraction.
 *
 * Lives outside `types.ts` because `WorkerSentenceBBoxDebugOptions` and the
 * trace envelope reference `ParagraphDetectionSettings` (from
 * `./ParagraphDetector`) and `FilteredParagraphResult` (from
 * `./FilteredParagraphPipeline`), both of which already depend on
 * `types.ts`. Using `import type` keeps this file structural-only so the
 * dependency graph stays acyclic.
 *
 * Two distinct types:
 *
 *   - `SentenceSplitterConfig` — serializable, crosses the worker boundary.
 *   - `WorkerSentenceBBoxDebugOptions` — debug-only worker op input. The
 *     production sentence path lives on `extract({ mode: "structured" })`
 *     (see `types.ts` for `ProcessedPage` sentence fields); this options
 *     type is for the dev-only `extractSentenceBBoxesDebug` op that
 *     surfaces single-page intermediates.
 */

import type { ParagraphDetectionSettings } from "./ParagraphDetector";
import type {
    MarginAnalysis,
    MarginRemovalResult,
    RawDocumentData,
    RawPageData,
    RawPageDataDetailed,
} from "./types";
import type { FilteredParagraphResult } from "./FilteredParagraphPipeline";
import type { PageSentenceBBoxResult } from "./ParagraphSentenceMapper";

/**
 * Serializable splitter configuration. Crosses the worker boundary via
 * `postMessage`, so all members must be `structuredClone`-able.
 */
export type SentenceSplitterConfig =
    | { type: "sentencex"; language?: string }
    | { type: "simple" };

/**
 * Cloneable input to the dev-only worker op `extractSentenceBBoxesDebug`.
 * Used by the worker client and the worker dispatcher.
 *
 * Does NOT carry the function-valued `splitter` (would break
 * `postMessage`) and does NOT carry `precomputed` (the worker always runs
 * the full filtered-paragraph pipeline; precomputed shortcuts live on the
 * internal mapper contract `PageSentenceBBoxOptions` and are used only by
 * main-thread debug paths).
 *
 * The op is implicitly debug — there is no production variant. Production
 * sentence-level extraction goes through `extract({ mode: "structured" })`.
 */
export interface WorkerSentenceBBoxDebugOptions {
    splitterConfig?: SentenceSplitterConfig;
    paragraphSettings?: ParagraphDetectionSettings;
    analysisWindow?: number;
}

/**
 * Intermediates surfaced by the dev-only `extractSentenceBBoxesDebug` op.
 *
 * **Map/Set across the worker boundary.** `marginAnalysis`,
 * `marginRemoval`, and `filteredResult.styleProfile` carry `Map`/`Set`
 * fields. `postMessage` preserves them via structured clone, but
 * `JSON.stringify` does NOT — so any HTTP handler that returns the raw
 * trace MUST flatten Map/Set fields to plain objects/arrays before
 * writing the response.
 */
export interface SentenceBBoxTrace {
    analysisPageIndices: number[];
    rawDoc: RawDocumentData;
    detailed: RawPageDataDetailed;
    pagesForFilter: RawPageData[];
    marginAnalysis: MarginAnalysis;
    marginRemoval: MarginRemovalResult;
    filteredResult: FilteredParagraphResult;
}

/** Result envelope returned by `extractSentenceBBoxesDebug`. */
export interface SentenceBBoxTraceResult {
    result: PageSentenceBBoxResult;
    trace: SentenceBBoxTrace;
}
