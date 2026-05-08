/**
 * Public API types for sentence-level bbox extraction.
 *
 * Lives outside `types.ts` because `ExtractSentenceBBoxesArgs` and
 * `WorkerSentenceBBoxOptions` reference `ParagraphDetectionSettings`
 * (from `./ParagraphDetector`), which already depends on `types.ts`.
 * Using `import type` keeps this file structural-only so the dependency
 * graph stays acyclic.
 *
 * Three distinct types deliberately:
 *
 *   - `SentenceSplitterConfig` — serializable, crosses the worker boundary.
 *   - `ExtractSentenceBBoxesArgs` — public PDFExtractor facade input. Uses
 *     `splitter` for ergonomics; PDFExtractor immediately translates that
 *     into a `splitterConfig` before calling the worker client.
 *   - `WorkerSentenceBBoxOptions` — worker-boundary input shape. Discriminated
 *     union over `debug`: production variant (`debug?: false`) cannot carry
 *     `recordSplitter`; debug variant (`debug: true`) may. Uses
 *     `splitterConfig` (no name collision with the function-valued
 *     `splitter` field on the internal mapper contract
 *     `PageSentenceBBoxOptions`).
 *
 * The two meanings of "splitter" never coexist in shared types.
 */

import type { ParagraphDetectionSettings } from "./ParagraphDetector";
import type { SentenceRange } from "./SentenceMapper";
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
 * Public input shape for `PDFExtractor.extractSentenceBBoxes`.
 *
 * When both `splitter` and `language` are provided, the explicit
 * `splitter.language` wins. `language` is only consulted when the
 * caller omits `splitter` entirely (in which case the facade defaults
 * to `{ type: "sentencex", language }`).
 */
export interface ExtractSentenceBBoxesArgs {
    pageIndex: number;
    splitter?: SentenceSplitterConfig;
    language?: string;
    paragraphSettings?: ParagraphDetectionSettings;
    analysisWindow?: number;
}

/**
 * Shared production fields for `WorkerSentenceBBoxOptions`. The full type is
 * a discriminated union over `debug` — see below.
 */
interface WorkerSentenceBBoxBaseOptions {
    splitterConfig?: SentenceSplitterConfig;
    paragraphSettings?: ParagraphDetectionSettings;
    analysisWindow?: number;
}

/**
 * Cloneable input to the worker op `extractSentenceBBoxes`. Used by the
 * worker client and the worker dispatcher. Does NOT carry the
 * function-valued `splitter` (would break `postMessage`) and does NOT
 * carry `precomputed` (the worker always runs the full filtered-paragraph
 * pipeline; precomputed shortcuts live on the internal mapper contract
 * `PageSentenceBBoxOptions` and are used only by main-thread debug paths).
 *
 * Discriminated by `debug`: production calls (`debug?: false`) cannot
 * carry `recordSplitter`; debug calls (`debug: true`) may. The op /
 * worker-client method narrow the return type via overloads keyed off the
 * `debug` literal — production returns `PageSentenceBBoxResult`, debug
 * returns `SentenceBBoxTraceResult`. Callers passing an options *variable*
 * whose `debug` has widened to `boolean` must `as const` the literal or
 * type the variable as one of the union variants.
 */
export type WorkerSentenceBBoxOptions =
    | (WorkerSentenceBBoxBaseOptions & { debug?: false; recordSplitter?: never })
    | (WorkerSentenceBBoxBaseOptions & { debug: true; recordSplitter?: boolean });

/**
 * Intermediates surfaced by the worker op `extractSentenceBBoxes` when
 * called with `debug: true`.
 *
 * Mirrors the intermediates surfaced by the worker-side sentence extraction
 * helper, with the sentence result living at the top level of
 * `SentenceBBoxTraceResult`.
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
    /** Present iff the debug-variant `recordSplitter === true`. */
    splitterRecording?: Array<{ text: string; ranges: SentenceRange[] }>;
}

/** Result envelope returned by `extractSentenceBBoxes` when `debug: true`. */
export interface SentenceBBoxTraceResult {
    result: PageSentenceBBoxResult;
    trace: SentenceBBoxTrace;
}
