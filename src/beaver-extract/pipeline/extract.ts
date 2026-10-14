/**
 * The extraction pipeline behind every extract op: the document study, then
 * one of three engines over the target pages.
 *
 *  - `"paragraph"` → `extractParagraphPages`: `detectFilteredParagraphs`
 *    produces `paragraphResult.pageContent` (`## ` headers, `\n\n`
 *    separators).
 *  - `"block"` → `extractBlockPages`: column detection + PageExtractor.
 *  - `"structured"` → the structured pipeline (`./structured.ts`): per-page
 *    detailed walk, segmentation, item passes and sentence mapping. Populates
 *    `items`, `sentences`, `columns`, plus paragraph-engine `content`.
 *
 * The schema preset arrives whole and is turned into each leaf module's
 * settings here and in `./structured.ts` (`presetParagraphSettings`,
 * `presetRegionSettings` and the margin switches).
 *
 * Worker code: import package internals directly, never the `../index`
 * barrel (see `worker/ops.ts`).
 */

import { MarginFilter, pageNumberObservations } from "../MarginFilter";
import { derivePageLabels, pageEdgeRowObservations } from "../derivedPageLabels";
import { PageExtractor } from "../PageExtractor";
import { detectColumns, logColumnDetection } from "../ColumnDetector";
import { setAnalyzerLogging } from "../logging";
import type { PageLine } from "../LineDetector";
import {
    collectMarginItemsFromFilteredPage,
    detectFilteredParagraphs,
    reindexMarginItems,
} from "../FilteredParagraphPipeline";
import { inverseRotateBBox, type RotationAngle } from "../PageRotationNormalizer";
import type { PageParagraphResult, ParagraphDetectionSettings } from "../ParagraphDetector";
import type { SentenceSplitter } from "../SentenceMapper";
import type {
    BoundingBox,
    DocItem,
    DocumentAnalysis,
    InternalExtractionResult,
    InternalProcessedPage,
    ItemLine,
    StructuredPagePhaseTimings,
} from "@beaver/agent-core/extract/types";
import { shouldProbeGraphicsLayer } from "@beaver/agent-core/extract/types";
import { presetParagraphSettings } from "../schema/presets";
import { ERROR_CODES, workerError } from "../worker/errors";
import {
    extractGraphicsFromDoc,
    filterToContainerRects,
    filterToDividerLines,
} from "../worker/docHelpers";
import type { DocumentLike } from "../worker/mupdfApi";
import {
    buildAnalysisFromDoc,
    type DocumentAnalysisContext,
    type DocumentStudyInput,
    type ResolvedExtractionSettings,
} from "./documentAnalysis";
import type { ItemPass } from "./itemPasses";
import { projectColumnRect } from "./output";
import {
    analyzeDocument,
    createItemPasses,
    mapSentences,
    runItemPasses,
    segmentPages,
    type StructuredDocumentStudy,
    type StructuredRunContext,
    type StructuredRunObservers,
} from "./structured";

export type ExtractionEngine = "block" | "paragraph" | "structured";

/** One extraction run (`runExtraction`). */
export interface ExtractionRun extends DocumentStudyInput {
    engine: ExtractionEngine;
    opts: ResolvedExtractionSettings;
    /** Pages to process and emit in the result. */
    targetIndices: number[];
    /** The document's page labels (`collectPageLabels`). */
    pageLabels: Record<number, string>;
    /** The caller's paragraph settings; the preset's switches are applied over them. */
    paragraphSettings?: ParagraphDetectionSettings;
    /** Structured engine: the resolved sentence splitter (required). */
    splitter?: SentenceSplitter;
    /** Structured engine: item passes to run instead of the preset's. */
    itemPasses?: readonly ItemPass[];
    /** Structured engine: observers of the region pass and item boundaries. */
    observers?: StructuredRunObservers;
}

/** Per-page output of an engine. */
interface EnginePages {
    pages: InternalProcessedPage[];
    perPageMs: number[];
    /** Structured engine only. */
    perPagePhases?: StructuredPagePhaseTimings[];
}

/**
 * Runs the document study and the engine over `targetIndices`. The result
 * shape is the same `InternalExtractionResult` for every engine.
 *
 * The caller is responsible for opening the doc, resolving target +
 * analysis indices, collecting page labels, running the OCR text-layer
 * check, and (for the structured engine) resolving the splitter.
 *
 * Index sets:
 *  - `targetIndices` — pages to process and emit in the result.
 *  - `analysisIndices` — superset used for cross-page style + margin
 *    analysis. With `analysisWindow=0` this equals `targetIndices`;
 *    with `N>0` it adds neighbors so margin smart-removal and the
 *    body-style estimate see more of the document. Walked once; the
 *    target loop reuses the cached pages.
 */
export function runExtraction(doc: DocumentLike, run: ExtractionRun): InternalExtractionResult {
    const { engine, opts, preset, pageCount, targetIndices } = run;
    setAnalyzerLogging(!!opts.analyzerLogging);
    try {
        const tStart = performance.now();

        // Structured mode walks every target in detailed mode first and reuses
        // those walks for the analysis window (`analyzeDocument`). Markdown
        // engines don't need per-char data and go straight to the JSON walk
        // inside `buildAnalysisFromDoc`. Same helper `opAnalyzeLayout` calls —
        // keeps the prefix byte-identical between extract and analyze.
        const structuredStudy = engine === "structured" ? analyzeDocument(run, targetIndices) : undefined;
        const study = structuredStudy ?? buildAnalysisFromDoc(run);
        const { analysisPages, analysisPageByIndex, styleProfile, marginAnalysis, marginRemoval, walkMs, analysisMs } = study;

        // Drop any target page that failed to walk (unresolvable leaf in a
        // malformed page tree). `buildAnalysisFromDoc` skips such pages, so they
        // are absent from `analysisPageByIndex`; the per-engine output loops
        // rely on that lookup and would otherwise dereference `undefined`.
        const effectiveTargetIndices = targetIndices.filter((i) => analysisPageByIndex.has(i));
        if (effectiveTargetIndices.length === 0 && targetIndices.length > 0) {
            throw workerError(
                ERROR_CODES.PAGE_OUT_OF_RANGE,
                `None of the ${targetIndices.length} requested page(s) could be resolved (malformed page tree)`,
                { pageCount },
            );
        }

        const paragraphSettings = presetParagraphSettings(preset, run.paragraphSettings);
        const { pages, perPageMs, perPagePhases } =
            engine === "paragraph"
                ? extractParagraphPages(doc, run, study, paragraphSettings, effectiveTargetIndices)
                : engine === "structured"
                ? extractStructuredPages(doc, run, structuredStudy!, paragraphSettings, effectiveTargetIndices)
                : extractBlockPages(run, study, effectiveTargetIndices);

        const fullText = pages.map((p) => p.content).join("\n\n");
        const analysis: DocumentAnalysis = {
            pageCount,
            hasTextLayer: true,
            styleProfile,
            marginAnalysis,
        };

        const totalMs = performance.now() - tStart;
        // Printed page numbers need the margins of every page, which only
        // full-document structured extraction analyzes.
        const derivedPageLabels = preset.derivedPageLabels
            && engine === "structured"
            && analysisPageByIndex.size === pageCount
            ? derivePageLabels(
                [
                    ...pageNumberObservations(marginAnalysis, marginRemoval.removalsByPage, analysisPageByIndex),
                    ...pageEdgeRowObservations(analysisPages, undefined, opts.marginZone),
                ],
                pageCount,
                Array.from({ length: pageCount }, (_, index) => analysisPageByIndex.get(index)),
            )
            : undefined;

        return {
            pages,
            analysis,
            fullText,
            pageLabels: Object.keys(run.pageLabels).length > 0 ? run.pageLabels : undefined,
            ...(derivedPageLabels && Object.keys(derivedPageLabels).length > 0
                ? { derivedPageLabels }
                : {}),
            metadata: {
                extractedAt: new Date().toISOString(),
                version: preset.schemaVersion,
                settings: { ...opts },
                engine,
                // `docOpenMs` is unknown here (the doc is already open when
                // we're called). The op writes it onto the returned result.
                // Default to 0 so the field always exists.
                timings: {
                    totalMs,
                    docOpenMs: 0,
                    walkMs,
                    analysisMs,
                    perPageMs,
                    // Only the structured engine has a per-page phase
                    // breakdown; undefined signals "no phase breakdown
                    // available" to downstream consumers.
                    ...(perPagePhases && perPagePhases.length > 0 ? { perPagePhases } : {}),
                },
            },
        };
    } finally {
        setAnalyzerLogging(false);
    }
}

/**
 * Paragraph engine: line + paragraph detection produces markdown-shaped page
 * text via `paragraphResult.pageContent` (headers prefixed `## `, paragraphs
 * separated by `\n\n`). `detectFilteredParagraphs` accepts the precomputed
 * `marginRemoval` and `styleProfile` so it skips re-running cross-page
 * analysis.
 */
function extractParagraphPages(
    doc: DocumentLike,
    run: ExtractionRun,
    study: DocumentAnalysisContext,
    paragraphSettings: ParagraphDetectionSettings,
    targetIndices: number[],
): EnginePages {
    const { opts, preset } = run;
    const { analysisPages, analysisPageByIndex, styleProfile, marginRemoval } = study;
    const out: EnginePages = { pages: [], perPageMs: [] };
    const probeGraphics = shouldProbeGraphicsLayer(opts.graphicsLayerMode);
    for (const i of targetIndices) {
        const tPage = performance.now();
        const rawPage = analysisPageByIndex.get(i)!;
        // Gate the device walk on `graphicsLayerMode`. Skipping it
        // when off avoids the WASM→JS bridge cost per drawing
        // primitive (dominated by `fill_text` events on
        // text-dense pages) — restores v0.20 paragraph-engine
        // per-page performance for callers that don't need
        // tinted-display-container detection.
        const graphics = probeGraphics
            ? extractGraphicsFromDoc(doc, rawPage.pageIndex)
            : undefined;
        const fillBoundaries = graphics
            ? filterToContainerRects(graphics.fills, rawPage.width, rawPage.height)
            : undefined;
        const dividerLines = graphics
            ? filterToDividerLines(graphics.strokes, rawPage.width, rawPage.height)
            : undefined;
        const filtered = detectFilteredParagraphs({
            pages: analysisPages,
            pageIndex: rawPage.pageIndex,
            marginRemoval,
            styleProfile,
            margins: opts.margins,
            marginZone: opts.marginZone,
            marginTextRows: preset.marginTextRows,
            marginProseRows: preset.marginTextRows,
            paragraphSettings,
            compoundVocabulary: study.compoundVocabulary,
            fillBoundaries,
            dividerLines,
        });
        logColumnDetection(rawPage.pageIndex, filtered.columnResult);
        out.pages.push({
            index: rawPage.pageIndex,
            label: rawPage.label,
            // Always MuPDF-frame dims (rawPage came pre-rotation).
            width: rawPage.width,
            height: rawPage.height,
            viewBox: rawPage.viewBox,
            rotation: rawPage.rotation,
            content: filtered.paragraphResult.pageContent,
            // Column rects come out of the (possibly normalized)
            // pipeline in the upright working frame; project back
            // to MuPDF coords using the same source dims the
            // pipeline reported.
            columns: filtered.columnResult.columns.map((col) =>
                projectColumnRect(
                    col,
                    filtered.pageRotation,
                    filtered.sourceWidth,
                    filtered.sourceHeight,
                ),
            ),
            items: [
                ...docItemsFromParagraphResult(
                    filtered.paragraphResult,
                    filtered.pageRotation,
                    filtered.sourceWidth,
                    filtered.sourceHeight,
                ),
                ...reindexMarginItems(
                    filtered.marginItems,
                    filtered.paragraphResult.items.length,
                ),
            ],
        } as InternalProcessedPage);
        out.perPageMs.push(performance.now() - tPage);
    }
    return out;
}

/**
 * Structured engine (`./structured.ts` steps 2–4): reuses the shared analysis
 * context so margin removal and the style profile run only once across the
 * document.
 */
function extractStructuredPages(
    doc: DocumentLike,
    run: ExtractionRun,
    study: StructuredDocumentStudy,
    paragraphSettings: ParagraphDetectionSettings,
    targetIndices: number[],
): EnginePages {
    if (!run.splitter) {
        throw new Error(
            "runExtraction: engine='structured' requires a resolved `splitter`",
        );
    }
    const { observers = {} } = run;
    const ctx: StructuredRunContext = {
        doc,
        preset: run.preset,
        opts: run.opts,
        requestedRepeatThreshold: run.requestedRepeatThreshold,
        pageCount: run.pageCount,
        pageCache: run.pageCache,
        paragraphSettings,
        splitter: run.splitter,
        ...(observers.region ? { regionObserver: observers.region } : {}),
        ...(observers.boundaries ? { boundaryObserver: observers.boundaries } : {}),
    };
    const itemPasses = run.itemPasses ?? createItemPasses(run.preset);
    const segmented = segmentPages(ctx, study, targetIndices);
    const passes = runItemPasses(segmented, study, run.pageCount, itemPasses, paragraphSettings);
    return mapSentences(ctx, segmented, passes, study.compoundVocabulary);
}

/** Block engine: column detection + the block-based PageExtractor. */
function extractBlockPages(
    run: ExtractionRun,
    study: DocumentAnalysisContext,
    targetIndices: number[],
): EnginePages {
    const { opts, preset } = run;
    const { analysisPageByIndex, styleProfile, marginRemoval } = study;
    const out: EnginePages = { pages: [], perPageMs: [] };
    const pageExtractor = new PageExtractor({ styleProfile });
    for (const i of targetIndices) {
        const tPage = performance.now();
        const rawPage = analysisPageByIndex.get(i)!;
        const filteredPage = MarginFilter.filterPageWithSmartRemoval(
            rawPage,
            opts.margins,
            opts.marginZone,
            marginRemoval,
            styleProfile.bodyStyles,
            styleProfile.primaryBodyStyle,
            preset.marginTextRows,
            preset.marginTextRows,
        );
        const marginItems = collectMarginItemsFromFilteredPage(
            rawPage,
            filteredPage,
        );
        const columnResult = detectColumns(filteredPage, {
            headerMargin: opts.margins.top,
            footerMargin: opts.margins.bottom,
            bodyStyles: styleProfile.bodyStyles,
            debug: !!opts.analyzerLogging,
        });
        logColumnDetection(rawPage.pageIndex, columnResult);

        const page = pageExtractor.extractPageWithColumns(
            filteredPage,
            columnResult,
            true,
        );
        page.items = [
            ...page.items,
            ...reindexMarginItems(marginItems, page.items.length),
        ];
        out.pages.push(page);
        out.perPageMs.push(performance.now() - tPage);
    }
    return out;
}

function inverseMaybe<T extends { bbox: BoundingBox }>(
    value: T,
    pageRotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): T {
    return pageRotation === 0
        ? value
        : {
              ...value,
              bbox: inverseRotateBBox(
                  value.bbox,
                  pageRotation,
                  sourceWidth,
                  sourceHeight,
              ),
          };
}

function itemLinesFromPageLines(
    lines: PageLine[],
    fallbackText: string,
    fallbackBBox: BoundingBox,
    pageRotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): ItemLine[] {
    const mapped = lines.map((line) =>
        inverseMaybe(
            {
                text: line.text,
                bbox: line.bbox,
                fontSize: line.fontSize,
            },
            pageRotation,
            sourceWidth,
            sourceHeight,
        ),
    );
    if (mapped.length > 0) return mapped;
    return [
        inverseMaybe(
            { text: fallbackText, bbox: fallbackBBox },
            pageRotation,
            sourceWidth,
            sourceHeight,
        ),
    ];
}

function docItemsFromParagraphResult(
    paragraphResult: PageParagraphResult,
    pageRotation: RotationAngle,
    sourceWidth: number,
    sourceHeight: number,
): DocItem[] {
    return paragraphResult.items.map((item, index) => {
        const bbox = pageRotation === 0
            ? item.bbox
            : inverseRotateBBox(item.bbox, pageRotation, sourceWidth, sourceHeight);
        const lines = itemLinesFromPageLines(
            paragraphResult.itemLines?.[index] ?? [],
            item.text,
            item.bbox,
            pageRotation,
            sourceWidth,
            sourceHeight,
        );
        const base = {
            id: `p${paragraphResult.pageIndex}:i${index}`,
            pageIndex: paragraphResult.pageIndex,
            index,
            bbox,
            columnIndex: item.columnIndex,
            text: item.text,
            lines,
        };
        if (item.type === "header") {
            return { ...base, kind: "section_header" as const, level: 1 };
        }
        return { ...base, kind: "text" as const };
    });
}
