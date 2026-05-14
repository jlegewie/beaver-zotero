/**
 * PDF Extraction Types
 *
 * Core type definitions for the PDF text extraction pipeline.
 *
 */

// ============================================================================
// Settings & Options
// ============================================================================

/** Margin thresholds in PDF points (1 point = 1/72 inch) */
export interface MarginSettings {
    /** Left margin threshold */
    left: number;
    /** Top margin threshold */
    top: number;
    /** Right margin threshold */
    right: number;
    /** Bottom margin threshold */
    bottom: number;
}

/** Default margin settings for simple filtering (in PDF points) */
export const DEFAULT_MARGINS: MarginSettings = {
    left: 25,
    top: 40,
    right: 25,
    bottom: 40,
};

/** Margin zone for smart filtering (larger area to collect candidates) */
export const DEFAULT_MARGIN_ZONE: MarginSettings = {
    left: 60,
    top: 80,
    right: 60,
    bottom: 80,
};

/**
 * Controls whether column detection probes the PDF graphics layer
 * (filled background rectangles for tinted asides / callouts) on each
 * target page to refine column boundaries and reading order.
 *
 * - `"off"` — never probe. Cheapest. Matches pre-feature column
 *   detection behavior. Pages with shaded display containers
 *   (DDS69CQI pp. 33 / 36) revert to the legacy mixed-reading-order
 *   output. Pick this on perf-sensitive extracts of corpora whose
 *   layouts don't use background-color cues (most academic papers).
 * - `"on"` — always probe. Pays a per-page cost on every target page
 *   (the WASM→JS device walk fires one callback per drawing
 *   primitive, dominated by `fill_text` events on text-dense pages).
 *   Pick this on documents you know rely on graphical layout cues.
 * - `"auto"` (default) — currently equivalent to `"on"`. Reserved
 *   for a future smart-gate that decides per-page from a cheap
 *   pixmap probe; until then, `"auto"` and `"on"` behave the same.
 */
export type GraphicsLayerMode = "off" | "on" | "auto";

/** Options for text extraction. Page selection lives on the args object of the calling op (e.g. `extract(args.pageIndices | args.pageRange)`), not here. */
export interface ExtractionSettings {
    /** Whether to check for text layer before processing */
    checkTextLayer?: boolean;
    /** Minimum text per page to consider it has a text layer */
    minTextPerPage?: number;
    /** Simple margin filtering thresholds (exclude content outside these) */
    margins?: MarginSettings;
    /** Margin zone for smart filtering (collect elements for analysis) */
    marginZone?: MarginSettings;
    /** Minimum pages a text must appear on to be considered "repeating" */
    repeatThreshold?: number;
    /** Whether to detect and remove page number sequences */
    detectPageSequences?: boolean;
    /**
     * Graphics-layer probe mode for column detection (see
     * `GraphicsLayerMode`). Default `"auto"`. Set `"off"` to opt out
     * of fill-rect detection entirely — useful when the per-page
     * device-walk cost outweighs the benefit on a corpus that doesn't
     * use tinted display containers.
     */
    graphicsLayerMode?: GraphicsLayerMode;
}

/** Default extraction settings */
export const DEFAULT_EXTRACTION_SETTINGS: Required<ExtractionSettings> = {
    checkTextLayer: true,
    minTextPerPage: 100,
    margins: DEFAULT_MARGINS,
    marginZone: DEFAULT_MARGIN_ZONE,
    repeatThreshold: 3,
    detectPageSequences: true,
    graphicsLayerMode: "auto",
};

/**
 * Resolve a `GraphicsLayerMode` to a boolean "probe the graphics
 * layer for this page" decision. `"off"` returns false; `"on"`
 * returns true; `"auto"` currently matches `"on"` (to preserve the
 * column-detection improvements from the feature) but is reserved
 * for a future smart-gate. Callers should consult this helper at
 * every site that would otherwise invoke
 * `extractFilledRectsFromDoc` — see worker/sentenceExtraction.ts
 * and worker/ops.ts.
 */
export function shouldProbeGraphicsLayer(
    mode: GraphicsLayerMode | undefined,
): boolean {
    if (mode === "off") return false;
    return true;
}

// ============================================================================
// Raw MuPDF Data Structures (from WASM JSON output)
// ============================================================================

export type CoordOrigin = "top-left" | "bottom-left";

/**
 * Axis-aligned page-space rectangle.
 *
 * `t` and `b` are semantic top/bottom edges. With top-left origin,
 * y increases downward and `t <= b`; with bottom-left origin, y
 * increases upward and `t >= b`. Public extraction/layout results emit
 * source MuPDF page coordinates with `origin: "top-left"`.
 */
export interface BoundingBox {
    l: number;
    t: number;
    r: number;
    b: number;
    origin: CoordOrigin;
}

export function bboxWidth(bbox: BoundingBox): number {
    return bbox.r - bbox.l;
}

export function bboxHeight(bbox: BoundingBox): number {
    return Math.abs(bbox.t - bbox.b);
}

export function mergeBoxes(boxes: BoundingBox[]): BoundingBox {
    if (boxes.length === 0) {
        return { l: 0, t: 0, r: 0, b: 0, origin: "top-left" };
    }
    const origin = boxes[0].origin;
    for (const box of boxes) {
        if (box.origin !== origin) {
            throw new Error("mergeBoxes requires all boxes to use the same origin");
        }
    }
    const l = Math.min(...boxes.map((b) => b.l));
    const r = Math.max(...boxes.map((b) => b.r));
    if (origin === "top-left") {
        return {
            l,
            t: Math.min(...boxes.map((b) => b.t)),
            r,
            b: Math.max(...boxes.map((b) => b.b)),
            origin,
        };
    }
    return {
        l,
        t: Math.max(...boxes.map((b) => b.t)),
        r,
        b: Math.min(...boxes.map((b) => b.b)),
        origin,
    };
}

export function flipOrigin(bbox: BoundingBox, pageHeight: number): BoundingBox {
    return {
        l: bbox.l,
        t: pageHeight - bbox.t,
        r: bbox.r,
        b: pageHeight - bbox.b,
        origin: bbox.origin === "top-left" ? "bottom-left" : "top-left",
    };
}

export function bboxFromXYWH(
    x: number,
    y: number,
    w: number,
    h: number,
    origin: CoordOrigin,
): BoundingBox {
    return {
        l: x,
        t: y,
        r: x + w,
        b: origin === "top-left" ? y + h : y - h,
        origin,
    };
}

export function bboxToTuple(bbox: BoundingBox): [number, number, number, number] {
    return [bbox.l, bbox.t, bbox.r, bbox.b];
}

export interface ReaderFrameContext {
    pageHeight: number;
    pageWidth: number;
    pageRotation: 0 | 90 | 180 | 270;
    cropBoxOffset?: { x: number; y: number };
    viewBoxLL?: { x: number; y: number };
}

function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
    const normalized = ((rotation % 360) + 360) % 360;
    if (normalized === 90 || normalized === 180 || normalized === 270) {
        return normalized;
    }
    return 0;
}

/**
 * Convert a public source-MuPDF/top-left bbox to Zotero reader annotation
 * coordinates. The returned bottom-left bbox keeps semantic edges:
 * `t` is the visual top edge and `b` the visual bottom edge.
 */
export function bboxToReaderFrame(
    bbox: BoundingBox,
    ctx: ReaderFrameContext,
): BoundingBox {
    if (bbox.origin !== "top-left") {
        throw new Error("bboxToReaderFrame expects a top-left source bbox");
    }
    const dx = (ctx.cropBoxOffset?.x ?? 0) + (ctx.viewBoxLL?.x ?? 0);
    const dy = (ctx.cropBoxOffset?.y ?? 0) + (ctx.viewBoxLL?.y ?? 0);
    const rotation = normalizeRotation(ctx.pageRotation);
    let l: number;
    let r: number;
    let bottom: number;
    let top: number;
    switch (rotation) {
        case 90:
            l = bbox.t + dx;
            r = bbox.b + dx;
            bottom = bbox.l + dy;
            top = bbox.r + dy;
            break;
        case 180:
            l = ctx.pageWidth - bbox.r + dx;
            r = ctx.pageWidth - bbox.l + dx;
            bottom = ctx.pageHeight - bbox.b + dy;
            top = ctx.pageHeight - bbox.t + dy;
            break;
        case 270:
            l = ctx.pageHeight - bbox.b + dx;
            r = ctx.pageHeight - bbox.t + dx;
            bottom = ctx.pageWidth - bbox.r + dy;
            top = ctx.pageWidth - bbox.l + dy;
            break;
        case 0:
        default:
            l = bbox.l + dx;
            r = bbox.r + dx;
            bottom = ctx.pageHeight - bbox.b + dy;
            top = ctx.pageHeight - bbox.t + dy;
            break;
    }
    return { l, t: top, r, b: bottom, origin: "bottom-left" };
}

function pointToReaderFrame(
    x: number,
    y: number,
    ctx: ReaderFrameContext,
): [number, number] {
    const dx = (ctx.cropBoxOffset?.x ?? 0) + (ctx.viewBoxLL?.x ?? 0);
    const dy = (ctx.cropBoxOffset?.y ?? 0) + (ctx.viewBoxLL?.y ?? 0);
    switch (normalizeRotation(ctx.pageRotation)) {
        case 90:
            return [y + dx, x + dy];
        case 180:
            return [ctx.pageWidth - x + dx, ctx.pageHeight - y + dy];
        case 270:
            return [ctx.pageHeight - y + dx, ctx.pageWidth - x + dy];
        case 0:
        default:
            return [x + dx, ctx.pageHeight - y + dy];
    }
}

export function quadsToReaderFrame(
    quads: QuadPoint[],
    ctx: ReaderFrameContext,
): QuadPoint[] {
    return quads.map((quad) => {
        const out: number[] = [];
        for (let i = 0; i < quad.length; i += 2) {
            const [x, y] = pointToReaderFrame(quad[i], quad[i + 1], ctx);
            out.push(x, y);
        }
        return out as QuadPoint;
    });
}

/**
 * Font information from MuPDF structured text JSON.
 */
export interface RawFont {
    name: string;
    family: string;
    weight: "normal" | "bold" | string;
    style: "normal" | "italic" | string;
    size: number;
}

/**
 * Raw line data from MuPDF structured text JSON.
 * Each line contains text with uniform styling.
 */
export interface RawLine {
    /** Writing mode: 0 = horizontal, 1 = vertical */
    wmode: number;
    /** Bounding box */
    bbox: BoundingBox;
    /** Font information */
    font: RawFont;
    /** Baseline X coordinate */
    x: number;
    /** Baseline Y coordinate */
    y: number;
    /** Text content */
    text: string;
    /**
     * Snapped angle (degrees) the writing direction is rotated from
     * upright in MuPDF's (top-left origin, y-down) frame. Derived from
     * the per-line `dir` vector emitted by `stext.walk` (or, when only
     * JSON-pass data is available, from bbox aspect ratio).
     *
     * Mapping (from observed `dir`):
     * - `[ 1,  0]` → 0   (upright body text)
     * - `[ 0,  1]` → 90  (writes downward — e.g. /Rotate-90 page body)
     * - `[-1,  0]` → 180
     * - `[ 0, -1]` → 270 (writes upward — e.g. side-rotated figure caption)
     *
     * Default 0 keeps existing fixtures and synthesized RawLine inputs
     * (which never set this field) on the unrotated path.
     */
    rotation?: 0 | 90 | 180 | 270;
}

/**
 * Raw block data from MuPDF structured text JSON.
 */
export interface RawBlock {
    /** Block type: "text" or "image" */
    type: "text" | "image";
    /** Bounding box */
    bbox: BoundingBox;
    /**
     * Lines (only for text blocks). `readonly` so detailed subtypes
     * (`RawBlockDetailed`) are covariantly assignable to `RawBlock` —
     * extracted page data is built once and treated as immutable.
     */
    lines?: readonly RawLine[];
}

/**
 * Raw page data extracted from MuPDF.
 */
export interface RawPageData {
    /** 0-based page index */
    pageIndex: number;
    /** 1-based page number */
    pageNumber: number;
    /** Page width in points */
    width: number;
    /** Page height in points */
    height: number;
    /** Page label (e.g., "iv", "220") */
    label?: string;
    /**
     * Structured text blocks. `readonly` for the same reason as
     * `RawBlock.lines` — lets `RawPageDataDetailed` be structurally
     * assignable to `RawPageData` without unsafe casts.
     */
    blocks: readonly RawBlock[];
}

// ============================================================================
// Detailed (character-level) raw data — for sentence-level bbox extraction
// ============================================================================

/**
 * A single character produced by MuPDF's structured-text walker.
 *
 * INVARIANT: within a RawLineDetailed, `text.length === chars.length` and
 * `text[i] === chars[i].c`. The sequence must stay in lockstep. Any
 * normalization (ligature expansion, whitespace collapse) must apply to both
 * sides or neither.
 */
export interface RawChar {
    /** Single Unicode code point (as produced by mupdf's onChar callback) */
    c: string;
    /** 8-float quadrilateral: [ulx,uly,urx,ury,llx,lly,lrx,lry] */
    quad: QuadPoint;
    /** Axis-aligned bbox computed from the quad (convenience) */
    bbox: BoundingBox;
}

/** A line enriched with per-character quads. */
export interface RawLineDetailed extends RawLine {
    /**
     * One RawChar per code point in `text`.
     * INVARIANT: `text.length === chars.length` and `text[i] === chars[i].c`.
     */
    chars: RawChar[];
}

/** A block enriched with detailed lines. */
export interface RawBlockDetailed extends Omit<RawBlock, "lines"> {
    lines?: RawLineDetailed[];
}

/** Page data enriched with detailed blocks. */
export interface RawPageDataDetailed extends Omit<RawPageData, "blocks"> {
    blocks: RawBlockDetailed[];
}

export interface ItemLine {
    text: string;
    bbox: BoundingBox;
    fontSize?: number;
}

export interface DocItemBase {
    /** Stable page-local reading-order id. Kind is intentionally excluded. */
    id: string;
    pageIndex: number;
    /** Page-local reading-order position. */
    index: number;
    /** Merged item bbox in public source MuPDF coordinates. */
    bbox: BoundingBox;
    /** 0-based reading-order column index. Fallback/full-width items use 0. */
    columnIndex: number;
}

export interface TextBearingItem extends DocItemBase {
    text: string;
    /** One entry per visual line. Degraded items carry one synthetic full-item line. */
    lines: ItemLine[];
}

export interface SentenceItem {
    /** Parent `DocItem.id`. */
    parentId: string;
    /** 0-based position within the parent item. */
    index: number;
    text: string;
    /** One bbox per contiguous line-fragment. */
    bboxes: BoundingBox[];
    /** Optional per-fragment detail (line index, per-line text, per-line bbox). */
    fragments?: Array<{
        lineIndex: number;
        text: string;
        bbox: BoundingBox;
    }>;
    /**
     * Hint that this sentence is continued by the *next* sentence in reading
     * order. Omitted means false.
     */
    joinWithNext?: boolean;
}

export interface TextItem extends TextBearingItem {
    kind: "text";
    sentences?: SentenceItem[];
}

export interface SectionHeaderItem extends TextBearingItem {
    kind: "section_header";
    level: number;
}

export interface FootnoteItem extends TextBearingItem {
    kind: "footnote";
    sentences?: SentenceItem[];
}

export interface CaptionItem extends TextBearingItem {
    kind: "caption";
    sentences?: SentenceItem[];
}

export interface ListItemItem extends TextBearingItem {
    kind: "list_item";
    sentences?: SentenceItem[];
}

export interface MarginItem extends TextBearingItem {
    kind: "margin";
}

export interface FormulaItem extends TextBearingItem {
    kind: "formula";
}

export interface TableItem extends DocItemBase {
    kind: "table";
}

export interface PictureItem extends DocItemBase {
    kind: "picture";
}

export type DocItem =
    | TextItem
    | SectionHeaderItem
    | FootnoteItem
    | CaptionItem
    | ListItemItem
    | MarginItem
    | FormulaItem
    | TableItem
    | PictureItem;

export type DegradationReason =
    | "unmapped"
    | "invariant_violation"
    | "empty_split";

export interface DegradationNote {
    itemId: string;
    itemKind: DocItem["kind"];
    reason: DegradationReason;
    message?: string;
}

export interface DegradationSummary {
    count: number;
    notes: DegradationNote[];
}

/**
 * Complete raw document data from extraction pass.
 */
export interface RawDocumentData {
    /** Total page count */
    pageCount: number;
    /** Raw page data for all extracted pages */
    pages: RawPageData[];
}

// ============================================================================
// Style Analysis Types
// ============================================================================

/**
 * Text style key for grouping spans.
 * Based on font properties that define visual appearance.
 */
export interface TextStyle {
    /** Rounded font size */
    size: number;
    /** Font name */
    font: string;
    /** Is bold (from font weight or name) */
    bold: boolean;
    /** Is italic (from font style or name) */
    italic: boolean;
}

/** Create a unique key string for a TextStyle */
export function styleToKey(style: TextStyle): string {
    return `${style.size}-${style.font}-${style.bold}-${style.italic}`;
}

/**
 * Style profile computed from document analysis.
 * Identifies body text styles by character frequency.
 */
export interface StyleProfile {
    /** Primary body text style (highest character count) */
    primaryBodyStyle: TextStyle;
    /** All styles considered "body text" (above threshold) */
    bodyStyles: TextStyle[];
    /** Map of style key -> character count */
    styleCounts: Map<string, { count: number; style: TextStyle }>;
}

// ============================================================================
// Margin Analysis Types
// ============================================================================

/** Position of an element relative to page margins */
export type MarginPosition = "top" | "bottom" | "left" | "right";

/**
 * Element found in a margin zone.
 * Used for smart header/footer detection.
 */
export interface MarginElement {
    /** The text content */
    text: string;
    /** Which margin zone it's in */
    position: MarginPosition;
    /** Bounding box */
    bbox: BoundingBox;
    /** Page index where this appears */
    pageIndex: number;
    /** Full line data for context */
    line: RawLine;
}

/**
 * Margin analysis results.
 */
export interface MarginAnalysis {
    /** Elements found in margin zones, grouped by position */
    elements: Map<MarginPosition, MarginElement[]>;
    /** Total elements found per zone */
    counts: Record<MarginPosition, number>;
}

/**
 * Element identified for removal with metadata.
 */
export interface RemovalCandidate {
    /** Normalized text that should be removed */
    text: string;
    /** Original (non-normalized) text samples */
    originalText: string;
    /** Page indices where this text appears */
    pageIndices: number[];
    /** Reason for removal */
    reason: "repeat" | "page_number" | "identifier";
    /** Which margin zone */
    position: MarginPosition;
}

/**
 * Result of smart margin removal analysis.
 */
export interface MarginRemovalResult {
    /** Candidates identified for removal */
    candidates: RemovalCandidate[];
    /** Set of normalized text strings to remove */
    textsToRemove: Set<string>;
    /** Map of pageIndex -> set of texts to remove on that page */
    removalsByPage: Map<number, Set<string>>;
}

// ============================================================================
// Processed Data Structures
// ============================================================================

/** A fully processed page */
export interface ProcessedPage {
    /** 0-based page index */
    index: number;
    /** Page label (e.g., "iv", "220") if available */
    label?: string;
    /** Page dimensions */
    width: number;
    height: number;
    /** Plain text content (in reading order) */
    content: string;
    /** Detected columns in reading order. Empty when no columns are detected. */
    columns: BoundingBox[];
    /** Page items in reading order. Present in every extraction mode. */
    items: DocItem[];
    /** Structured-mode flattened view over splitter-eligible item sentences. */
    sentences?: SentenceItem[];
    /** Structured-mode fallback diagnostics. Omitted when no items degraded. */
    degradation?: DegradationSummary;
}

// ============================================================================
// Document-Level Analysis
// ============================================================================

/** Information about repeated elements (headers/footers) */
export interface RepeatedElement {
    /** The text content that repeats */
    text: string;
    /** Approximate Y position (top or bottom of page) */
    position: "header" | "footer";
    /** Bounding box pattern */
    bbox: BoundingBox;
    /** Pages where this element appears */
    pageIndices: number[];
}

/** Document analysis results */
export interface DocumentAnalysis {
    /** Total page count */
    pageCount: number;
    /** Whether the document has a text layer */
    hasTextLayer: boolean;
    /** Style profile */
    styleProfile: StyleProfile;
    /** Margin analysis (elements in margin zones) */
    marginAnalysis: MarginAnalysis;
}

// ============================================================================
// Final Extraction Result
// ============================================================================

/**
 * Per-target-page phase breakdown for structured-mode extraction.
 *
 * Lets a profiler attribute the per-page cost to the WASM detailed walk,
 * the font bridge, the filtered-paragraph pipeline (column/line/paragraph
 * detection), and the sentence mapper. `charCount` / `lineCount` /
 * `itemCount` are emitted in the same struct so bottleneck ms can
 * be normalized per 1k chars / per line / per item without a
 * second pass over the result.
 *
 * Only populated by the structured branch of `runExtractFromIndices`.
 * Markdown branches leave `ExtractionTimings.perPagePhases` undefined.
 */
export interface StructuredPagePhaseTimings {
    /**
     * Document-page index this entry describes. Pairs positionally with
     * the same-index entry of `ExtractionTimings.perPageMs` and
     * `ExtractionResult.pages[]`.
     */
    pageIndex: number;
    /**
     * `extractRawPageDetailedFromDoc` for the target page — the WASM
     * per-character walk. Typically the dominant cost on text-dense
     * pages (per-char round-trips through the Emscripten bridge).
     */
    detailedWalkMs: number;
    /**
     * `pagesForFilterWithBridgedFonts` — propagates font metadata from
     * the JSON-walked analysis page onto the detailed target page.
     * O(N_detailed × N_json) today.
     */
    fontBridgeMs: number;
    /** Total `detectFilteredParagraphs` time, including sub-phases below. */
    filteredParagraphsMs: number;
    /** `MarginFilter.filterPageWithSmartRemoval` inside the pipeline. */
    marginFilterMs: number;
    /** `detectColumns` inside the pipeline. */
    columnDetectMs: number;
    /** `detectLinesOnPage` inside the pipeline. */
    lineDetectMs: number;
    /** `detectParagraphs` inside the pipeline. */
    paragraphDetectMs: number;
    /** `extractPageSentences` — item-scoped sentence mapping. */
    sentenceMapMs: number;
    /** Total character count on the target page (post-detailed-walk). */
    charCount: number;
    /** Total line count on the target page (post-detailed-walk). */
    lineCount: number;
    /** Document item count emitted by the structured pipeline. */
    itemCount: number;
    /** Degradation count from the sentence mapper (0 on the happy path). */
    degradationCount: number;
}

/**
 * Per-phase worker timings for a single `extract` call. All values are
 * milliseconds (`performance.now()` deltas measured inside the worker).
 *
 * Recorded for both markdown engines so cross-engine comparisons stay
 * apples-to-apples. Optional on `ExtractionResult.metadata` so older
 * callers and tests that don't need timings don't have to populate them.
 */
export interface ExtractionTimings {
    /** Total worker op duration (entry to return). */
    totalMs: number;
    /**
     * Time inside `acquireDoc`. Cold-cache only — warm-cache hits resolve in
     * microseconds because the doc is reused. Useful as a baseline for the
     * cost of opening a fresh PDF.
     */
    docOpenMs: number;
    /** Walk over `analysisIndices` (`extractRawPageFromDoc` per page). */
    walkMs: number;
    /** `buildPageAnalysisContext` (StyleAnalyzer + cross-page MarginFilter). */
    analysisMs: number;
    /**
     * Per-target-page processing time. `length === pages.length`. Indexed
     * positionally with `pages` (NOT by document-page index). The engines
     * actually diverge inside this loop, so this is the field to compare.
     */
    perPageMs: number[];
    /**
     * Per-target-page phase breakdown. Populated only for structured-mode
     * extracts; undefined for markdown engines. Same length and index
     * convention as `perPageMs` so callers can join the two arrays
     * positionally.
     */
    perPagePhases?: StructuredPagePhaseTimings[];
}

/** The complete extraction result */
export interface ExtractionResult {
    /** Processed pages */
    pages: ProcessedPage[];
    /** Document-level analysis */
    analysis: DocumentAnalysis;
    /** Combined plain text from all pages */
    fullText: string;
    /** Page labels for all pages in the document (0-indexed → label string). Only non-empty labels included. */
    pageLabels?: Record<number, string>;
    /** Extraction metadata */
    metadata: {
        extractedAt: string;
        version: string;
        settings: ExtractionSettings;
        /**
         * Engine that produced the result.
         *  - `"block"` / `"paragraph"`: markdown-mode engines (mode `"markdown"`).
         *  - `"structured"`: sentence-level extraction (mode `"structured"`).
         *
         * Optional so legacy callers / tests don't need to populate it.
         */
        engine?: "block" | "paragraph" | "structured";
        /**
         * Per-phase worker timings. Optional — populated by `opExtract` /
         * `runExtractFromIndices`; absent on direct ExtractionResult literals
         * built in tests or fixtures.
         */
        timings?: ExtractionTimings;
    };
}

// ============================================================================
// Layout Analysis Result (analyzeLayout op)
// ============================================================================

/**
 * Per-phase worker timings for a single `analyzeLayout` call. Subset of
 * `ExtractionTimings` covering the prefix that `opExtract` and
 * `opAnalyzeLayout` share — there is no per-page processing in
 * `analyzeLayout`, so `perPageMs` is intentionally omitted.
 */
export interface LayoutAnalysisTimings {
    /** Total worker op duration (entry to return). */
    totalMs: number;
    /** Time inside `acquireDoc`. Cold-cache only. */
    docOpenMs: number;
    /** Walk over `analysisIndices` (`extractRawPageFromDoc` per page). */
    walkMs: number;
    /** `buildPageAnalysisContext` (StyleAnalyzer + cross-page MarginFilter). */
    analysisMs: number;
}

/**
 * Result of a single `analyzeLayout` call. Mirrors `ExtractionResult`'s
 * field naming where applicable.
 *
 * Output is byte-identical to the analysis context built by
 * `extract({ mode: "structured" })` for the same `settings` +
 * `pageIndices` + `analysisWindow` — the worker prefix is shared via
 * `buildAnalysisFromDoc`.
 *
 * **Map/Set boundary.** `analysis.styleProfile.styleCounts`,
 * `analysis.marginAnalysis.elements`,
 * `analysis.marginRemoval.removalsByPage`, and
 * `analysis.marginRemoval.textsToRemove` carry `Map`/`Set` fields.
 * `postMessage` preserves them via structured clone, but
 * `JSON.stringify` does NOT — flatten before writing HTTP responses.
 */
export interface LayoutAnalysisResult {
    /**
     * Target pages, JSON-walked (pre-filter). Same `RawPageData` shape
     * `extractRawPageFromDoc` produces.
     */
    pages: RawPageData[];
    /** Page count of the source document. */
    pageCount: number;
    /**
     * Full-document page labels. Same shape as `ExtractionResult.pageLabels`
     * — collected via `collectPageLabels(doc)` over all pages so the field
     * is symmetric with extract.
     */
    pageLabels?: Record<number, string>;
    /** Analysis-window indices used (target pages + neighbors). */
    analysisPageIndices: number[];
    /**
     * Document-wide analysis output. Same builders as
     * `extract({ mode: "structured" })` — populated by
     * `buildPageAnalysisContext`.
     */
    analysis: {
        styleProfile: StyleProfile;
        marginAnalysis: MarginAnalysis;
        marginRemoval: MarginRemovalResult;
    };
    metadata: {
        extractedAt: string;
        version: string;
        /**
         * Resolved settings (defaults merged in). Overlay builders read
         * `settings.margins` and `settings.marginZone` from here so
         * custom margins flow through to the rendered overlay.
         */
        settings: ExtractionSettings;
        timings: LayoutAnalysisTimings;
    };
}

// ============================================================================
// OCR Detection Types
// ============================================================================

/** Options for OCR detection analysis */
export interface OCRDetectionOptions {
    /** Minimum text characters per page to consider valid (default: 100) */
    minTextPerPage?: number;
    /** Initial pages to sample for analysis (default: 6) */
    sampleSize?: number;
    /** Expanded sample size when uncertain (default: 20) */
    expandedSampleSize?: number;
    /** Lower bound of "uncertain zone" - expand if issue ratio is above this (default: 0.1 = 10%) */
    expandLowerThreshold?: number;
    /** Upper bound of "uncertain zone" - don't expand if issue ratio is above this (default: 0.8 = 80%) */
    expandUpperThreshold?: number;
    /** Final threshold to confirm OCR needed - requires majority agreement (default: 0.5 = 50%) */
    confirmationThreshold?: number;

    // Text quality thresholds
    /** Max ratio of whitespace to content (default: 0.7) */
    maxWhitespaceRatio?: number;
    /** Max ratio of newlines to content (default: 0.6) */
    maxNewlineRatio?: number;
    /** Min ratio of alphanumeric chars (default: 0.3) */
    minAlphanumericRatio?: number;
    /** Max ratio of invalid/replacement characters before flagging (default: 0.3 = 30%) */
    maxInvalidCharRatio?: number;
    /** Minimum valid characters to accept a page despite invalid chars (default: 1000) */
    minValidCharsToAccept?: number;

    // Image coverage threshold
    /** Image area ratio to page that suggests a scan (default: 0.65) */
    imageCoverageThreshold?: number;

    // Bounding box validation (primarily for word-level accuracy)
    /** Max overlap ratio between lines (default: 0.1) */
    maxLineOverlapRatio?: number;
    /** Margin in points for boundary overflow check (default: 5) */
    boundaryMargin?: number;
    /** Whether to check bounding boxes - useful for word-level accuracy, less so for page-level (default: false) */
    checkBoundingBoxes?: boolean;
}

/** Reasons why a page might need OCR */
export type OCRIssueReason =
    | "no_text_blocks"
    | "insufficient_text"
    | "high_whitespace_ratio"
    | "high_newline_ratio"
    | "low_alphanumeric_ratio"
    | "invalid_characters"
    | "large_image_coverage"
    | "bbox_overflow"
    | "excessive_line_overlap";

/** Result of analyzing a single page for OCR issues */
export interface PageOCRAnalysis {
    /** Page index (0-based) */
    pageIndex: number;
    /** Whether this page has issues */
    hasIssues: boolean;
    /** Detected issues */
    issues: OCRIssueReason[];
    /** Text length found on page */
    textLength: number;
    /** Whether page has images */
    hasImages: boolean;
}

/** Detailed result of document-level OCR detection */
export interface OCRDetectionResult {
    /** Whether the document likely needs OCR */
    needsOCR: boolean;
    /** Primary reason for the decision */
    primaryReason: string;
    /** Ratio of pages with issues (0-1) */
    issueRatio: number;
    /** Breakdown by issue type */
    issueBreakdown: Record<OCRIssueReason, number>;
    /** Per-page analysis (for sampled pages) */
    pageAnalyses: PageOCRAnalysis[];
    /** Total pages in document */
    totalPages: number;
    /** Pages actually sampled */
    sampledPages: number;
}

/** Default OCR detection options */
export const DEFAULT_OCR_DETECTION_OPTIONS: Required<OCRDetectionOptions> = {
    minTextPerPage: 100,
    sampleSize: 6,
    expandedSampleSize: 20,
    expandLowerThreshold: 0.1,   // Expand if >10% issues (uncertain)
    expandUpperThreshold: 0.8,   // Don't expand if >80% issues (clearly bad)
    confirmationThreshold: 0.5,  // Require majority (50%) to confirm OCR needed

    maxWhitespaceRatio: 0.7,
    maxNewlineRatio: 0.6,
    minAlphanumericRatio: 0.3,
    maxInvalidCharRatio: 0.3,      // 30% invalid chars threshold
    minValidCharsToAccept: 1000,   // Accept page if it has >= 1000 valid chars despite issues

    imageCoverageThreshold: 0.65,

    maxLineOverlapRatio: 0.1,
    boundaryMargin: 5,
    checkBoundingBoxes: false, // Disabled by default - only needed for word-level accuracy
};

// ============================================================================
// Error Types
// ============================================================================

/** Error codes for extraction failures */
export enum ExtractionErrorCode {
    NO_TEXT_LAYER = "NO_TEXT_LAYER",
    ENCRYPTED = "ENCRYPTED",
    INVALID_PDF = "INVALID_PDF",
    PAGE_OUT_OF_RANGE = "PAGE_OUT_OF_RANGE",
    WASM_ERROR = "WASM_ERROR",
}

/** Structured error for extraction failures */
export class ExtractionError extends Error {
    constructor(
        public code: ExtractionErrorCode,
        message: string,
        public details?: unknown,
        public pageLabels?: Record<number, string>,
        public pageCount?: number,
    ) {
        super(message);
        this.name = "ExtractionError";
    }
}

// ============================================================================
// PDF Search Types
// ============================================================================

/**
 * A QuadPoint defines a quadrilateral region on a page.
 * Format: [ulx, uly, urx, ury, llx, lly, lrx, lry]
 * - ul = upper-left, ur = upper-right, ll = lower-left, lr = lower-right
 *
 * Quad coordinates use the public source MuPDF page frame: top-left origin,
 * y increasing downward, same page dimensions as the containing result.
 */
export type QuadPoint = [number, number, number, number, number, number, number, number];

/**
 * A single search hit on a page.
 * Each hit represents one occurrence of the search term.
 */
export interface PDFSearchHit {
    /** QuadPoints defining the hit region(s) - one quad per character in match */
    quads: QuadPoint[];
    /** Bounding box enclosing all quads (for convenience) */
    bbox: BoundingBox;
}

/**
 * Search results for a single page.
 */
export interface PDFPageSearchResult {
    /** 0-based page index */
    pageIndex: number;
    /** Page label (e.g., "iv", "220") if available */
    label?: string;
    /** Number of matches on this page */
    matchCount: number;
    /** Individual search hits with positions */
    hits: PDFSearchHit[];
    /** Page dimensions for coordinate conversion */
    width: number;
    height: number;
}

/**
 * Options for PDF search.
 *
 * Page-count gating (`maxPageCount`) is NOT here — it's a pre-flight gate, not
 * a search option. Pass it as the sibling `args.maxPageCount` parameter on
 * `PDFExtractor.search` / `MuPDFWorkerClient.search`.
 */
export interface PDFSearchOptions {
    /** Maximum hits per page (default: 100) */
    maxHitsPerPage?: number;
    /** Pages to search (0-based). If undefined, searches all pages */
    pages?: number[];
    /** Scoring options for ranking results */
    scoring?: SearchScoringOptions;
}

/** Default search options. */
export const DEFAULT_PDF_SEARCH_OPTIONS: Required<Omit<PDFSearchOptions, 'scoring'>> & {
    scoring: SearchScoringOptions;
} = {
    maxHitsPerPage: 100,
    pages: [],
    scoring: {},
};

// ============================================================================
// Search Scoring Types
// ============================================================================

/** Semantic role of text where a match was found */
export type TextRole = "heading" | "body" | "caption" | "footnote" | "unknown";

/** Weights for different text roles in search scoring */
export interface SearchRoleWeights {
    heading: number;
    body: number;
    caption: number;
    footnote: number;
    unknown: number;
}

/** Default role weights - headings are most significant, footnotes least */
export const DEFAULT_SEARCH_ROLE_WEIGHTS: SearchRoleWeights = {
    heading: 3.0,
    body: 1.0,
    caption: 0.7,
    footnote: 0.3,
    unknown: 0.5,
};

/** Options for search scoring */
export interface SearchScoringOptions {
    /** Role weights for scoring (default: DEFAULT_SEARCH_ROLE_WEIGHTS) */
    roleWeights?: Partial<SearchRoleWeights>;
    /** Whether to normalize by page text length (default: true) */
    normalizeByTextLength?: boolean;
    /** Minimum text length for normalization (prevents divide-by-tiny-number) */
    minTextLengthForNormalization?: number;
    /** Base score multiplier (default: 100) */
    baseMultiplier?: number;
}

/** Default scoring options */
export const DEFAULT_SEARCH_SCORING_OPTIONS: Required<SearchScoringOptions> = {
    roleWeights: DEFAULT_SEARCH_ROLE_WEIGHTS,
    normalizeByTextLength: true,
    minTextLengthForNormalization: 200,
    baseMultiplier: 100,
};

/** Extended search hit with scoring information */
export interface ScoredSearchHit extends PDFSearchHit {
    /** Semantic role of the text where match was found */
    role: TextRole;
    /** Weight applied to this hit based on role */
    weight: number;
    /** The matched text (if extracted) */
    matchedText?: string;
}

/** Extended page search result with scoring */
export interface ScoredPageSearchResult extends Omit<PDFPageSearchResult, 'hits'> {
    /** Scored hits with role information */
    hits: ScoredSearchHit[];
    /** Computed relevance score for ranking */
    score: number;
    /** Raw weighted sum before normalization */
    rawScore: number;
    /** Total text length on page (for context) */
    textLength: number;
}

/**
 * Complete PDF search result.
 * 
 * Search Behavior:
 * - Simple phrase search (grep-like) - matches literal text
 * - Case-insensitive matching
 * - No boolean operators (AND/OR) - use multiple searches if needed
 * - Returns whole pages ranked by relevance score (highest first)
 * 
 * Scoring Methodology:
 * - Each hit is weighted by text role (heading=3.0, body=1.0, caption=0.7, footnote=0.3)
 * - Page score = sum of weighted hits, optionally normalized by text length
 * - This prioritizes pages where matches appear in significant content (headings, body)
 */
export interface PDFSearchResult {
    /** Search query used */
    query: string;
    /** Total number of matches across all pages */
    totalMatches: number;
    /** Number of pages with at least one match */
    pagesWithMatches: number;
    /** Total pages in document */
    totalPages: number;
    /**
     * Page results ranked by relevance score (highest first).
     * Only includes pages with at least one match.
     */
    pages: ScoredPageSearchResult[];
    /**
     * Set when the caller provided `args.maxPageCount` AND `totalPages`
     * exceeded it. The worker short-circuits the search; handlers map this
     * to the `too_many_pages` error response.
     */
    exceedsPageCountLimit?: boolean;
    /** Search metadata */
    metadata: {
        searchedAt: string;
        durationMs: number;
        options: PDFSearchOptions;
        scoringOptions: SearchScoringOptions;
    };
}

// ============================================================================
// Page Image Rendering Types
// ============================================================================

/** Image output format for page rendering */
export type ImageFormat = "png" | "jpeg";

/** Options for rendering a page to an image */
export interface PageImageOptions {
    /** Scale factor (1.0 = 72 DPI, 2.0 = 144 DPI, etc.). Default: 1.0 */
    scale?: number;
    /** Target DPI (alternative to scale, takes precedence if provided) */
    dpi?: number;
    /** Whether to render with transparent background. Default: false */
    alpha?: boolean;
    /** Whether to render annotations and widgets. Default: true */
    showExtras?: boolean;
    /** Output format. Default: "png" */
    format?: ImageFormat;
    /** JPEG quality (1-100), only used for format="jpeg". Default: 85 */
    jpegQuality?: number;
}

/** Default page image options */
export const DEFAULT_PAGE_IMAGE_OPTIONS: Required<PageImageOptions> = {
    scale: 1.0,
    dpi: 0, // 0 means use scale instead
    alpha: false,
    showExtras: true,
    format: "png",
    jpegQuality: 85,
};

/** Result of rendering a page to an image */
export interface PageImageResult {
    /** Page index (0-based) */
    pageIndex: number;
    /** Image data as Uint8Array */
    data: Uint8Array;
    /** Image format */
    format: ImageFormat;
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;
    /** Scale factor used */
    scale: number;
    /** Effective DPI */
    dpi: number;
}

// ============================================================================
// Document Metadata
// ============================================================================

/**
 * Document-level PDF metadata returned by `PDFExtractor.getMetadata`.
 *
 * Cheap to collect: pulls the info dictionary and PDF format string via
 * `doc.getMetadata(...)` (string lookups in the trailer/info dict). Page
 * labels require a per-page load and are the only field with non-trivial
 * cost. Info-dict fields are omitted when not present in the document.
 */
export interface PDFMetadata {
    /** Total number of pages */
    pageCount: number;
    /** Custom page labels (0-indexed → label). Empty record if no labels. */
    pageLabels: Record<number, string>;
    /** PDF format string (e.g., "PDF 1.7") */
    format?: string;
    /** info:Title */
    title?: string;
    /** info:Author */
    author?: string;
    /** info:Subject */
    subject?: string;
    /** info:Keywords */
    keywords?: string;
    /** info:Creator (authoring tool, e.g. "Microsoft Word") */
    creator?: string;
    /** info:Producer (PDF generator, e.g. "Adobe Distiller") */
    producer?: string;
    /** info:CreationDate (raw PDF date string, e.g. "D:20240115103000Z") */
    creationDate?: string;
    /** info:ModDate (raw PDF date string) */
    modDate?: string;
}
