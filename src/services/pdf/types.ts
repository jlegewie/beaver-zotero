/**
 * PDF Extraction Types
 *
 * Core type definitions for the PDF text extraction pipeline.
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

/** Default margin settings (in PDF points) */
export const DEFAULT_MARGINS: MarginSettings = {
    left: 25,
    top: 40,
    right: 25,
    bottom: 40,
};

/** Margin zone for smart filtering (larger area to collect candidates) */
export const DEFAULT_MARGIN_ZONE: MarginSettings = {
    left: 50,
    top: 72,   // ~1 inch
    right: 50,
    bottom: 72,
};

/** Options for text extraction */
export interface ExtractionSettings {
    /** Page indices to extract (0-based). If undefined, extracts all pages. */
    pages?: number[];
    /** Whether to check for text layer before processing */
    checkTextLayer?: boolean;
    /** Minimum text per page to consider it has a text layer */
    minTextPerPage?: number;
    /** Simple margin filtering thresholds (exclude content outside these) */
    margins?: MarginSettings;
    /** Margin zone for smart filtering (collect elements for analysis) */
    marginZone?: MarginSettings;
    /** Number of pages to sample for style analysis (0 = all pages) */
    styleSampleSize?: number;
}

/** Default extraction settings */
export const DEFAULT_EXTRACTION_SETTINGS: Required<ExtractionSettings> = {
    pages: [],
    checkTextLayer: true,
    minTextPerPage: 100,
    margins: DEFAULT_MARGINS,
    marginZone: DEFAULT_MARGIN_ZONE,
    styleSampleSize: 100,
};

// ============================================================================
// Raw MuPDF Data Structures (from WASM JSON output)
// ============================================================================

/**
 * Bounding box from MuPDF structured text JSON.
 * Format: { x, y, w, h } where x,y is top-left corner
 */
export interface RawBBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Convert RawBBox to tuple format [x0, y0, x1, y1] */
export function bboxToTuple(bbox: RawBBox): [number, number, number, number] {
    return [bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h];
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
    bbox: RawBBox;
    /** Font information */
    font: RawFont;
    /** Baseline X coordinate */
    x: number;
    /** Baseline Y coordinate */
    y: number;
    /** Text content */
    text: string;
}

/**
 * Raw block data from MuPDF structured text JSON.
 */
export interface RawBlock {
    /** Block type: "text" or "image" */
    type: "text" | "image";
    /** Bounding box */
    bbox: RawBBox;
    /** Lines (only for text blocks) */
    lines?: RawLine[];
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
    /** Structured text blocks */
    blocks: RawBlock[];
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
    bbox: RawBBox;
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

// ============================================================================
// Processed Data Structures
// ============================================================================

/** A processed text line with style information */
export interface ProcessedLine {
    text: string;
    bbox: RawBBox;
    style: TextStyle;
}

/** A processed text block */
export interface ProcessedBlock {
    type: "text" | "image";
    bbox: RawBBox;
    lines: ProcessedLine[];
    text: string;
    /** Semantic role detected by style analysis */
    role?: "heading" | "body" | "caption" | "footnote";
}

/** A fully processed page */
export interface ProcessedPage {
    /** 0-based page index */
    index: number;
    /** Page label (e.g., "iv", "220") if available */
    label?: string;
    /** Page dimensions */
    width: number;
    height: number;
    /** Processed text blocks */
    blocks: ProcessedBlock[];
    /** Plain text content */
    content: string;
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
    bbox: RawBBox;
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

/** The complete extraction result */
export interface ExtractionResult {
    /** Processed pages */
    pages: ProcessedPage[];
    /** Document-level analysis */
    analysis: DocumentAnalysis;
    /** Combined plain text from all pages */
    fullText: string;
    /** Extraction metadata */
    metadata: {
        extractedAt: string;
        version: string;
        settings: ExtractionSettings;
    };
}

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
        public details?: unknown
    ) {
        super(message);
        this.name = "ExtractionError";
    }
}
