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
import type { PdfExtractionPreset } from "../schema/presets";
import { postLog } from "../worker/errors";
import { isRecoverablePageError } from "../wasmFatal";
import { extractRawPageDetailedFromDoc, extractRawPageFromDoc } from "../worker/docHelpers";
import type { DocumentLike, FontApi } from "../worker/mupdfApi";
import type { GraphicsSummary } from "../worker/graphicsSummary";
import { buildCompoundVocabulary } from "../worker/sentenceExtraction";

/** Extraction settings after the op merged in the defaults. */
export type ResolvedExtractionSettings = Required<Omit<ExtractionSettings, "pages" | "minTextPerPage">> &
    ExtractionSettings;

/** Preset switches that change what a page walk produces. */
export type PageWalkPreset = Pick<PdfExtractionPreset, "textRepair" | "styleRuns" | "regions">;

/**
 * Per-op page-walk cache.
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
 *                    extraction and the structured-mode gate. With the
 *                    preset's `regions`, the walk also records font runs and
 *                    the page's graphics summary (`graphicsFor`) for region
 *                    detection.
 *
 * Every walk applies the preset's text repair; detailed walks record style
 * runs with its `styleRuns`.
 */
export class PageWalkCache {
    private readonly plain = new Map<number, RawPageData>();
    private readonly detailed = new Map<number, RawPageDataDetailed>();
    private readonly graphics = new Map<number, GraphicsSummary>();

    constructor(
        private readonly doc: DocumentLike,
        /** WASM font helpers; detailed walks need them for line fonts. */
        readonly fontApi: FontApi | undefined,
        readonly preset: PageWalkPreset,
    ) {}

    getPlain(pageIndex: number, includeImages: boolean): RawPageData {
        let page = this.plain.get(pageIndex);
        if (!page) {
            page = extractRawPageFromDoc(this.doc, pageIndex, {
                includeImages,
                textRepair: this.preset.textRepair,
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
                this.preset.textRepair,
                {
                    styleRuns: this.preset.styleRuns,
                    ...(this.preset.regions
                        ? { onGraphics: (g: GraphicsSummary) => this.graphics.set(pageIndex, g), fontSpans: true }
                        : {}),
                },
            );
            this.detailed.set(pageIndex, page);
        }
        return page;
    }

    /** Graphics summary of a page walked by `getDetailed` (with the preset's `regions`). */
    graphicsFor(pageIndex: number): GraphicsSummary | undefined {
        return this.graphics.get(pageIndex);
    }
}

/** Inputs of the document study (`buildAnalysisFromDoc`, `analyzeDocument`). */
export interface DocumentStudyInput {
    pageCache: PageWalkCache;
    /** The schema preset; its margin switches shape the analysis. */
    preset: PdfExtractionPreset;
    opts: ExtractionSettings;
    /** The caller's `repeatThreshold` before defaults (`getEffectiveRepeatThreshold`). */
    requestedRepeatThreshold: number | undefined;
    /** Pages of the cross-page analysis (`resolveAnalysisPages`). */
    analysisIndices: number[];
    /** The document's page count. */
    pageCount: number;
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
 * Shared analysis-context prefix for `runExtraction` and
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
 * the map are NOT re-walked; everything else gets a JSON walk from
 * `pageCache`. This is what eliminates the redundant per-target JSON walk
 * for structured mode when `analysisWindow=0`.
 */
export function buildAnalysisFromDoc(
    input: DocumentStudyInput,
    preWalked?: Map<number, RawPageData>,
): DocumentAnalysisContext {
    const { pageCache, preset, opts, requestedRepeatThreshold, analysisIndices, pageCount } = input;
    const tWalkStart = performance.now();
    const analysisPages: RawPageData[] = [];
    for (const i of analysisIndices) {
        const pre = preWalked?.get(i);
        if (pre) {
            analysisPages.push(pre);
            continue;
        }
        try {
            analysisPages.push(pageCache.getPlain(i, false));
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
        marginTextRows: preset.marginTextRows,
        pageNumberRuns: preset.pageNumberRuns,
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
