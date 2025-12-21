/**
 * PDF Extraction Types
 *
 * Core type definitions for the PDF text extraction pipeline.
 */

// ============================================================================
// Settings & Options
// ============================================================================

/** Options for text extraction */
export interface ExtractionSettings {
    /** Page indices to extract (0-based). If undefined, extracts all pages. */
    pages?: number[];
    /** Whether to remove detected headers/footers */
    removeRepeatedElements?: boolean;
    /** Whether to check for text layer before processing */
    checkTextLayer?: boolean;
    /** Minimum text per page to consider it has a text layer */
    minTextPerPage?: number;
}

/** Default extraction settings */
export const DEFAULT_EXTRACTION_SETTINGS: Required<ExtractionSettings> = {
    pages: [],
    removeRepeatedElements: true,
    checkTextLayer: true,
    minTextPerPage: 100,
};

// ============================================================================
// Raw MuPDF Data Structures (from WASM)
// ============================================================================

/** Bounding box [x0, y0, x1, y1] */
export type BBox = [number, number, number, number];

/** Raw line data from MuPDF */
export interface RawLine {
    text: string;
    bbox: BBox;
    /** Font can be string, object, or undefined depending on PDF structure */
    font?: unknown;
    size?: number;
}

/** Raw block data from MuPDF */
export interface RawBlock {
    type: "text" | "image";
    bbox: BBox;
    lines?: RawLine[];
}

/** Raw page data from MuPDF */
export interface RawPageData {
    pageNumber: number;
    blocks: RawBlock[];
}

// ============================================================================
// Processed Data Structures
// ============================================================================

/** Style information for a text element */
export interface TextStyle {
    fontName: string;
    fontSize: number;
    isBold: boolean;
    isItalic: boolean;
}

/** A processed text line with style information */
export interface ProcessedLine {
    text: string;
    bbox: BBox;
    style: TextStyle;
}

/** A processed text block */
export interface ProcessedBlock {
    type: "text" | "image";
    bbox: BBox;
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
    bbox: BBox;
    /** Pages where this element appears */
    pageIndices: number[];
}

/** Style statistics across the document */
export interface StyleProfile {
    /** Most common font size (likely body text) */
    bodyFontSize: number;
    /** Detected heading font sizes (larger than body) */
    headingFontSizes: number[];
    /** Most common font name */
    primaryFont: string;
    /** All fonts used in the document */
    fonts: Map<string, number>;
}

/** Document analysis results */
export interface DocumentAnalysis {
    /** Total page count */
    pageCount: number;
    /** Whether the document has a text layer */
    hasTextLayer: boolean;
    /** Detected repeated elements */
    repeatedElements: RepeatedElement[];
    /** Style profile */
    styleProfile: StyleProfile;
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

