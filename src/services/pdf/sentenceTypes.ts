/**
 * Public API types for sentence-level bbox extraction.
 *
 * Lives outside `types.ts` because `WorkerSentenceDebugOptions` and the
 * trace envelope reference `ParagraphDetectionSettings` (from
 * `./ParagraphDetector`) and `FilteredParagraphResult` (from
 * `./FilteredParagraphPipeline`), both of which already depend on
 * `types.ts`. Using `import type` keeps this file structural-only so the
 * dependency graph stays acyclic.
 *
 * Two distinct types:
 *
 *   - `SentenceSplitterConfig` — serializable, crosses the worker boundary.
 *   - `WorkerSentenceDebugOptions` — debug-only worker op input. The
 *     production sentence path lives on `extract({ mode: "structured" })`
 *     (see `types.ts` for `ProcessedPage` sentence fields); this options
 *     type is for the dev-only `extractSentenceDebug` op that
 *     surfaces single-page intermediates.
 */

import type { ParagraphDetectionSettings } from "./ParagraphDetector";
import type {
    GraphicsLayerMode,
    MarginAnalysis,
    MarginRemovalResult,
    MarginSettings,
    RawDocumentData,
    RawPageData,
    RawPageDataDetailed,
} from "./types";
import type { FilteredParagraphResult } from "./FilteredParagraphPipeline";
import type { PageSentenceResult } from "./ParagraphSentenceMapper";

/**
 * Serializable splitter configuration. Crosses the worker boundary via
 * `postMessage`, so all members must be `structuredClone`-able.
 */
export type SentenceSplitterConfig =
    | { type: "sentencex"; language?: string }
    | { type: "simple" };

/**
 * Cloneable input to the dev-only worker op `extractSentenceDebug`.
 * Used by the worker client and the worker dispatcher.
 *
 * Does NOT carry the function-valued `splitter` (would break
 * `postMessage`) and does NOT carry `precomputed` (the worker always runs
 * the full filtered-paragraph pipeline; precomputed shortcuts live on the
 * internal mapper contract `PageSentenceOptions` and are used only by
 * main-thread debug paths).
 *
 * The op is implicitly debug — there is no production variant. Production
 * sentence-level extraction goes through `extract({ mode: "structured" })`.
 *
 * The four settings fields below are the worker-clonable subset of
 * `ExtractionSettings` that affect single-page layout/filtering. The OCR
 * fields (`checkTextLayer`, `minTextPerPage`) are intentionally excluded —
 * they gate the document at `extract()` entry, before any single-page
 * trace runs.
 */
export interface WorkerSentenceDebugOptions {
    splitterConfig?: SentenceSplitterConfig;
    paragraphSettings?: ParagraphDetectionSettings;
    analysisWindow?: number;
    margins?: MarginSettings;
    marginZone?: MarginSettings;
    repeatThreshold?: number;
    detectPageSequences?: boolean;
    /**
     * Graphics-layer probe mode for the per-page column detector
     * (see `GraphicsLayerMode`). Mirrors `ExtractionSettings.graphicsLayerMode`
     * so trace output reflects what the corresponding production
     * `extract` call would see.
     */
    graphicsLayerMode?: GraphicsLayerMode;
}

/**
 * Intermediates surfaced by the dev-only `extractSentenceDebug` op.
 *
 * **Map/Set across the worker boundary.** `marginAnalysis`,
 * `marginRemoval`, and `filteredResult.styleProfile` carry `Map`/`Set`
 * fields. `postMessage` preserves them via structured clone, but
 * `JSON.stringify` does NOT — so any HTTP handler that returns the raw
 * trace MUST flatten Map/Set fields to plain objects/arrays before
 * writing the response.
 */
export interface SentenceTrace {
    analysisPageIndices: number[];
    rawDoc: RawDocumentData;
    detailed: RawPageDataDetailed;
    pagesForFilter: RawPageData[];
    marginAnalysis: MarginAnalysis;
    marginRemoval: MarginRemovalResult;
    filteredResult: FilteredParagraphResult;
}

/** Result envelope returned by `extractSentenceDebug`. */
export interface SentenceTraceResult {
    result: PageSentenceResult;
    trace: SentenceTrace;
}
