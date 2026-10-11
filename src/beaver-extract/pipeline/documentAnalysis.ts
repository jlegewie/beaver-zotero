/**
 * Document study shared by every extraction engine: page walks and the
 * cross-page analysis context (body style, repeating margin text).
 *
 * Worker code: import package internals directly, never the `../index`
 * barrel (see `worker/ops.ts`).
 */

import { StyleAnalyzer } from "../StyleAnalyzer";
import { MarginFilter } from "../MarginFilter";
import { buildPageAnalysisContext } from "../PageAnalysisContext";
import type {
    ExtractionSettings,
    MarginAnalysis,
    MarginRemovalResult,
    RawPageData,
    RawPageDataDetailed,
    StyleProfile,
} from "@beaver/agent-core/extract/types";
import { postLog } from "../worker/errors";
import { isRecoverablePageError } from "../wasmFatal";
import { extractRawPageDetailedFromDoc, extractRawPageFromDoc } from "../worker/docHelpers";
import type { DocumentLike, FontApi } from "../worker/mupdfApi";
import type { GraphicsSummary } from "../worker/graphicsSummary";
import { buildCompoundVocabulary } from "../worker/sentenceExtraction";

/** Extraction settings after the op merged in the defaults. */
export type ResolvedExtractionSettings = Required<Omit<ExtractionSettings, "pages" | "minTextPerPage">> &
    ExtractionSettings;

/**
 * Per-`opExtract` page-walk cache.
 *
 * The OCR gate (`DocumentAnalyzer`) samples a spread of pages across the
 * document, and the extraction pipeline then walks every target/analysis
 * page. For a whole-document extract every sampled page is also a
 * pipeline page, so without sharing each such page's `toStructuredText`
 * walk runs twice — once for the gate, once for extraction. The doubling
 * is invisible on cheap pages but doubles the wall time of a page that is
 * expensive to walk (heavy vector content, redraw-stamped text layers).
 *
 * This cache memoizes the walk so each page is walked at most once per
 * `opExtract` call: the gate populates it, the pipeline reuses it.
 *
 * `includeImages` only takes effect on a cache MISS. It is the OCR gate,
 * not the extraction pipeline, that needs image blocks (to measure
 * scanned-page coverage). The gate always runs first, so the pages it
 * samples are walked WITH images and the pipeline reuses them as-is —
 * image blocks are inert for every downstream text consumer (line /
 * column / paragraph / margin / sentence detection all filter to
 * `type === "text"`). Pages the gate did not sample — and every page
 * when `checkTextLayer` is off and the gate never runs — are walked by
 * the pipeline WITHOUT images, exactly as before this cache existed.
 *
 *  - `getPlain`    — JSON-walk pages for the markdown engines and the
 *                    markdown-mode gate.
 *  - `getDetailed` — per-char detailed-walk pages for structured
 *                    extraction and the structured-mode gate. With `regions`,
 *                    the walk also records font runs and the page's graphics
 *                    summary (`graphicsFor`) for region detection.
 */
export class PageWalkCache {
    private readonly plain = new Map<number, RawPageData>();
    private readonly detailed = new Map<number, RawPageDataDetailed>();
    private readonly graphics = new Map<number, GraphicsSummary>();

    constructor(
        private readonly doc: DocumentLike,
        private readonly fontApi: FontApi | undefined,
        /** Text repair of the op's schema preset; applies to every walk. */
        private readonly textRepair: boolean,
        /** Whether detailed walks record per-glyph style runs. */
        private readonly styleRuns: boolean,
        /** Region detection of the op's schema preset (structured mode). */
        readonly regions = false,
    ) {}

    getPlain(pageIndex: number, includeImages: boolean): RawPageData {
        let page = this.plain.get(pageIndex);
        if (!page) {
            page = extractRawPageFromDoc(this.doc, pageIndex, {
                includeImages,
                textRepair: this.textRepair,
            });
            this.plain.set(pageIndex, page);
        }
        return page;
    }

    getDetailed(pageIndex: number, includeImages: boolean): RawPageDataDetailed {
        let page = this.detailed.get(pageIndex);
        if (!page) {
            page = extractRawPageDetailedFromDoc(
                this.doc,
                pageIndex,
                includeImages,
                this.fontApi,
                this.textRepair,
                {
                    styleRuns: this.styleRuns,
                    ...(this.regions
                        ? { onGraphics: (g: GraphicsSummary) => this.graphics.set(pageIndex, g), fontSpans: true }
                        : {}),
                },
            );
            this.detailed.set(pageIndex, page);
        }
        return page;
    }

    /** Graphics summary of a page walked by `getDetailed` (with `regions`). */
    graphicsFor(pageIndex: number): GraphicsSummary | undefined {
        return this.graphics.get(pageIndex);
    }
}

/** Cross-page analysis of the analysis window (`buildAnalysisFromDoc`). */
export interface DocumentAnalysisContext {
    analysisPages: RawPageData[];
    analysisPageByIndex: Map<number, RawPageData>;
    styleProfile: StyleProfile;
    marginAnalysis: MarginAnalysis;
    marginRemoval: MarginRemovalResult;
    /**
     * Genuine hyphenated compounds (lowercased) seen mid-line across the
     * analysis window. Used by the structured sentence mapper to keep a
     * line-break hyphen when the compound is attested (e.g. "broken-windows")
     * and join it otherwise. Coverage scales with the analysis window — for
     * full-document structured extraction it spans the whole document.
     */
    compoundVocabulary: ReadonlySet<string>;
    walkMs: number;
    analysisMs: number;
}

/**
 * Shared analysis-context prefix for `runExtractFromIndices` and
 * `opAnalyzeLayout`. Walks the analysis-window pages once and runs the
 * cross-page `buildPageAnalysisContext` (StyleAnalyzer + MarginFilter)
 * over them.
 *
 * Both extract and analyzeLayout call this so they see the SAME
 * `marginRemoval` / `marginAnalysis` / `styleProfile` for the same input
 * `analysisIndices`. This is what guarantees the margins overlay (built
 * on `analyzeLayout`'s output) and structured extract agree on a given
 * page's filter decisions.
 *
 * Caller resolves `analysisIndices` (typically via `resolveAnalysisPages`)
 * and supplies the document's total `pageCount` (so
 * `getEffectiveRepeatThreshold` can apply the short-doc relaxation).
 *
 * `preWalked` lets the structured branch reuse target-page detailed
 * walks (which carry every field a JSON walk produces — line bbox,
 * font, page dims — with the WASM font helpers wired up). Indices in
 * the map are NOT re-walked; everything else gets a JSON walk as
 * before. This is what eliminates the redundant per-target JSON walk
 * for structured mode when `analysisWindow=0`.
 */
export function buildAnalysisFromDoc(
    doc: DocumentLike,
    opts: ExtractionSettings,
    requestedRepeatThreshold: number | undefined,
    analysisIndices: number[],
    pageCount: number,
    preWalked?: Map<number, RawPageData>,
    pageCache?: PageWalkCache,
    pageNumberRuns = true,
): DocumentAnalysisContext {
    const tWalkStart = performance.now();
    const analysisPages: RawPageData[] = [];
    for (const i of analysisIndices) {
        const pre = preWalked?.get(i);
        if (pre) {
            analysisPages.push(pre);
            continue;
        }
        try {
            analysisPages.push(
                pageCache
                    ? pageCache.getPlain(i, false)
                    : extractRawPageFromDoc(doc, i),
            );
        } catch (err) {
            // A malformed page tree can fail to resolve individual leaves.
            // Skip the bad page and keep going so one unresolvable page
            // does not abort the whole extraction (mirrors `mutool`).
            if (!isRecoverablePageError(err)) throw err;
            postLog(
                "warn",
                `[mupdf-worker] buildAnalysisFromDoc: skipping unresolvable page ${i}: ${String(err)}`,
            );
        }
    }
    const analysisPageByIndex = new Map<number, RawPageData>(
        analysisPages.map((p) => [p.pageIndex, p]),
    );
    // Genuine mid-line hyphenated compounds across the analysis window. Built
    // from the already-walked line text (no extra walk) and consumed by the
    // structured sentence mapper's line-break de-hyphenation.
    const compoundVocabulary = buildCompoundVocabulary(analysisPages);
    const walkMs = performance.now() - tWalkStart;

    const tAnalysisStart = performance.now();
    const { styleProfile, marginAnalysis, marginRemoval } = buildPageAnalysisContext({
        pages: analysisPages,
        totalPageCount: pageCount,
        marginZone: opts.marginZone,
        repeatThreshold: requestedRepeatThreshold,
        detectPageSequences: opts.detectPageSequences,
        marginTextRows: opts.marginTextRows,
        pageNumberRuns,
    });
    const analysisMs = performance.now() - tAnalysisStart;
    StyleAnalyzer.logStyleProfile(styleProfile);
    MarginFilter.logRemovalCandidates(marginRemoval);

    return {
        analysisPages,
        analysisPageByIndex,
        styleProfile,
        marginAnalysis,
        marginRemoval,
        compoundVocabulary,
        walkMs,
        analysisMs,
    };
}
