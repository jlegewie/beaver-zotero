/**
 * MuPDF Service
 *
 * Low-level bridge to the MuPDF WASM module.
 * Handles initialization, caching, and provides typed access to raw PDF data.
 */

import type { 
    RawPageData, 
    RawBlock, 
    RawDocumentData, 
    PageImageOptions, 
    PageImageResult, 
    ImageFormat,
    PDFPageSearchResult,
    PDFSearchHit,
    QuadPoint,
    RawBBox,
} from "./types";
import { ExtractionError, ExtractionErrorCode, DEFAULT_PAGE_IMAGE_OPTIONS } from "./types";

// ============================================================================
// Structured Text Options
// ============================================================================

/**
 * Options for toStructuredText() - passed as comma-separated string.
 *
 * MuPDF.js options (corresponding to FZ_STEXT_* flags):
 * - "preserve-whitespace": Preserve whitespace characters
 * - "preserve-ligatures": Preserve ligature information
 * - "preserve-images": Include image blocks in output
 * - "preserve-spans": Preserve individual span data
 *
 * Note: Python flags like FZ_STEXT_CLIP, FZ_STEXT_ACCURATE_BBOXES
 * may not have direct JS equivalents - behavior varies by MuPDF version.
 */
const STRUCTURED_TEXT_OPTIONS = "preserve-whitespace";
const STRUCTURED_TEXT_OPTIONS_WITH_IMAGES = "preserve-whitespace,preserve-images";

// ============================================================================
// MuPDF API Types
// ============================================================================

/** MuPDF API returned by the loader */
interface MuPDFAPI {
    Document: {
        openDocument: (data: Uint8Array | ArrayBuffer, magic?: string) => MuPDFDocument;
    };
    ColorSpace: MuPDFColorSpaceStatic;
    Matrix: MuPDFMatrix;
    _libmupdf: unknown;
}

interface MuPDFDocument {
    pointer: number;
    needsPassword(): boolean;
    authenticatePassword(password: string): number;
    countPages(): number;
    getMetadata(key: string): string | undefined;
    loadPage(index: number): MuPDFPage;
    destroy(): void;
}

interface MuPDFPixmap {
    pointer: number;
    getWidth(): number;
    getHeight(): number;
    getStride(): number;
    getNumberOfComponents(): number;
    getAlpha(): number;
    getSamples(): Uint8Array;
    asPNG(): Uint8Array;
    asJPEG(quality?: number, invertCmyk?: boolean): Uint8Array;
    destroy(): void;
}

interface MuPDFColorSpace {
    pointer: number;
}

interface MuPDFColorSpaceStatic {
    DeviceGray: MuPDFColorSpace;
    DeviceRGB: MuPDFColorSpace;
    DeviceBGR: MuPDFColorSpace;
    DeviceCMYK: MuPDFColorSpace;
}

interface MuPDFMatrix {
    identity: number[];
    scale(sx: number, sy: number): number[];
    translate(tx: number, ty: number): number[];
    rotate(degrees: number): number[];
    concat(one: number[], two: number[]): number[];
}

interface MuPDFPage {
    pointer: number;
    getBounds(box?: string): [number, number, number, number];
    getLabel(): string;
    toStructuredText(options?: string): MuPDFStructuredText;
    toPixmap(matrix: number[], colorspace: MuPDFColorSpace, alpha?: boolean, showExtras?: boolean): MuPDFPixmap;
    /** Search for text on the page. Returns array of QuadPoint arrays (one per hit). */
    search(needle: string, maxHits?: number): QuadPoint[][];
    destroy(): void;
}

interface MuPDFStructuredText {
    pointer: number;
    asJSON(scale?: number): string;
    asText(): string;
    destroy(): void;
}

// ============================================================================
// Module Cache
// ============================================================================

/** Cached MuPDF module promise */
let mupdfPromise: Promise<MuPDFAPI> | null = null;

/**
 * Get the MuPDF API, initializing if needed.
 * The module is cached for the session.
 */
export async function getMuPDFAPI(): Promise<MuPDFAPI> {
    if (mupdfPromise) {
        return mupdfPromise;
    }

    mupdfPromise = (async () => {
        const { MuPDFLoader } = ChromeUtils.importESModule(
            "chrome://beaver/content/modules/mupdf-loader.mjs"
        );
        return MuPDFLoader.init("chrome://beaver/content/") as Promise<MuPDFAPI>;
    })();

    return mupdfPromise;
}

/**
 * Dispose the cached MuPDF module.
 * Call during plugin shutdown.
 */
export async function disposeMuPDF(): Promise<void> {
    if (!mupdfPromise) return;

    try {
        const { MuPDFLoader } = ChromeUtils.importESModule(
            "chrome://beaver/content/modules/mupdf-loader.mjs"
        );
        await MuPDFLoader.dispose();
    } catch {
        // Silently fail if loader is already gone
    }

    mupdfPromise = null;
}

// ============================================================================
// MuPDF Service Class
// ============================================================================

/**
 * MuPDF Service class for working with PDF documents.
 * Wraps the low-level WASM calls and provides typed interfaces.
 */
export class MuPDFService {
    private api: MuPDFAPI | null = null;
    private doc: MuPDFDocument | null = null;

    /**
     * Initialize the service with PDF data.
     * @throws ExtractionError with ENCRYPTED code if document is password-protected
     */
    async open(pdfData: Uint8Array | ArrayBuffer): Promise<void> {
        this.api = await getMuPDFAPI();

        try {
            this.doc = this.api.Document.openDocument(pdfData, "application/pdf");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.toLowerCase().includes("password") || message.toLowerCase().includes("encrypted")) {
                throw new ExtractionError(
                    ExtractionErrorCode.ENCRYPTED,
                    "Document is encrypted and requires a password"
                );
            }
            throw new ExtractionError(
                ExtractionErrorCode.INVALID_PDF,
                `Failed to open PDF: ${message}`
            );
        }

        // Check if document is encrypted
        if (typeof this.doc.needsPassword === "function") {
            try {
                if (this.doc.needsPassword()) {
                    this.doc.destroy();
                    this.doc = null;
                    throw new ExtractionError(
                        ExtractionErrorCode.ENCRYPTED,
                        "Document is encrypted and requires a password"
                    );
                }
            } catch (error) {
                if (error instanceof ExtractionError) {
                    throw error;
                }
                console.warn("[MuPDFService] Encryption check failed, continuing:", error);
            }
        } else {
            // Fallback: check encryption metadata
            const encryption = this.doc.getMetadata("encryption");
            if (encryption && encryption !== "" && encryption !== "None") {
                this.doc.destroy();
                this.doc = null;
                throw new ExtractionError(
                    ExtractionErrorCode.ENCRYPTED,
                    "Document is encrypted and requires a password"
                );
            }
        }
    }

    /** Close the document and release resources */
    close(): void {
        if (this.doc) {
            this.doc.destroy();
            this.doc = null;
        }
    }

    /** Get the number of pages */
    getPageCount(): number {
        this.ensureOpen();
        return this.doc!.countPages();
    }

    /** Get document metadata */
    getMetadata(key: string): string | undefined {
        this.ensureOpen();
        return this.doc!.getMetadata(key);
    }

    /** Get page dimensions [x0, y0, x1, y1] */
    getPageBounds(pageIndex: number): { width: number; height: number; bounds: [number, number, number, number] } {
        this.ensureOpen();
        const page = this.doc!.loadPage(pageIndex);
        try {
            const bounds = page.getBounds("CropBox");
            return {
                width: bounds[2] - bounds[0],
                height: bounds[3] - bounds[1],
                bounds,
            };
        } finally {
            page.destroy();
        }
    }

    /** Get page label (e.g., "iv", "220") */
    getPageLabel(pageIndex: number): string {
        this.ensureOpen();
        const page = this.doc!.loadPage(pageIndex);
        try {
            return page.getLabel();
        } finally {
            page.destroy();
        }
    }

    /**
     * Extract raw structured text data from a single page.
     * Returns complete page data including dimensions.
     * @param pageIndex - Page index (0-based)
     * @param options - Extraction options
     * @param options.includeImages - Include image blocks (for text layer detection)
     */
    extractRawPage(pageIndex: number, options?: { includeImages?: boolean }): RawPageData {
        this.ensureOpen();
        const page = this.doc!.loadPage(pageIndex);

        try {
            // Get page dimensions
            const pageBounds = page.getBounds("CropBox");
            const width = pageBounds[2] - pageBounds[0];
            const height = pageBounds[3] - pageBounds[1];

            // Get page label
            let label: string | undefined;
            try {
                label = page.getLabel();
            } catch {
                // Label not available
            }

            // Extract structured text
            const stextOptions = options?.includeImages
                ? STRUCTURED_TEXT_OPTIONS_WITH_IMAGES
                : STRUCTURED_TEXT_OPTIONS;
            const stext = page.toStructuredText(stextOptions);
            try {
                const json = JSON.parse(stext.asJSON());
                return {
                    pageIndex,
                    pageNumber: pageIndex + 1,
                    width,
                    height,
                    label,
                    blocks: (json.blocks || []) as RawBlock[],
                };
            } finally {
                stext.destroy();
            }
        } finally {
            page.destroy();
        }
    }

    /**
     * Extract raw structured text from multiple pages.
     * @param pageIndices - Pages to extract (0-based). If empty/undefined, extracts all.
     * @returns Complete raw document data with all pages
     */
    extractRawPages(pageIndices?: number[]): RawDocumentData {
        this.ensureOpen();
        const pageCount = this.getPageCount();

        const indices = pageIndices?.length
            ? pageIndices.filter(i => i >= 0 && i < pageCount)
            : Array.from({ length: pageCount }, (_, i) => i);

        const pages = indices.map(i => this.extractRawPage(i));

        return {
            pageCount,
            pages,
        };
    }

    /**
     * Extract plain text from a page (fast, no structure).
     * Useful for text layer detection.
     */
    extractPlainText(pageIndex: number): string {
        this.ensureOpen();
        const page = this.doc!.loadPage(pageIndex);

        try {
            const stext = page.toStructuredText(STRUCTURED_TEXT_OPTIONS);
            try {
                return stext.asText();
            } finally {
                stext.destroy();
            }
        } finally {
            page.destroy();
        }
    }

    /**
     * Render a page to an image.
     * @param pageIndex - Page index (0-based)
     * @param options - Rendering options
     * @returns PageImageResult with image data and metadata
     */
    renderPageToImage(pageIndex: number, options: PageImageOptions = {}): PageImageResult {
        this.ensureOpen();
        const opts = { ...DEFAULT_PAGE_IMAGE_OPTIONS, ...options };

        // Calculate scale from DPI if provided (72 DPI = scale 1.0)
        const scale = opts.dpi > 0 ? opts.dpi / 72 : opts.scale;
        const effectiveDpi = opts.dpi > 0 ? opts.dpi : opts.scale * 72;

        const page = this.doc!.loadPage(pageIndex);

        try {
            // Create scale matrix
            const matrix = this.api!.Matrix.scale(scale, scale);

            // Render to pixmap using DeviceRGB colorspace
            const pixmap = page.toPixmap(
                matrix,
                this.api!.ColorSpace.DeviceRGB,
                opts.alpha,
                opts.showExtras
            );

            try {
                const width = pixmap.getWidth();
                const height = pixmap.getHeight();

                // Convert to requested format
                let data: Uint8Array;
                let format: ImageFormat = opts.format;
                if (opts.format === "jpeg") {
                    data = pixmap.asJPEG(opts.jpegQuality);
                } else {
                    data = pixmap.asPNG();
                    format = "png";
                }

                return {
                    pageIndex,
                    data,
                    format,
                    width,
                    height,
                    scale,
                    dpi: effectiveDpi,
                };
            } finally {
                pixmap.destroy();
            }
        } finally {
            page.destroy();
        }
    }

    /**
     * Render multiple pages to images.
     * @param pageIndices - Pages to render (0-based). If undefined, renders all.
     * @param options - Rendering options
     * @returns Array of PageImageResult
     */
    renderPagesToImages(pageIndices?: number[], options: PageImageOptions = {}): PageImageResult[] {
        this.ensureOpen();
        const pageCount = this.getPageCount();

        const indices = pageIndices?.length
            ? pageIndices.filter(i => i >= 0 && i < pageCount)
            : Array.from({ length: pageCount }, (_, i) => i);

        return indices.map(i => this.renderPageToImage(i, options));
    }

    /**
     * Search for text on a single page.
     * 
     * Uses MuPDF's built-in search which performs:
     * - Case-insensitive matching
     * - Literal phrase search (no regex, no boolean operators)
     * 
     * @param pageIndex - Page index (0-based)
     * @param query - Text to search for
     * @param maxHits - Maximum number of hits to return (default: 100)
     * @returns PDFPageSearchResult with hits and their positions
     */
    searchPage(pageIndex: number, query: string, maxHits: number = 100): PDFPageSearchResult {
        this.ensureOpen();
        const page = this.doc!.loadPage(pageIndex);

        try {
            // Get page dimensions
            const pageBounds = page.getBounds("CropBox");
            const width = pageBounds[2] - pageBounds[0];
            const height = pageBounds[3] - pageBounds[1];

            // Get page label
            let label: string | undefined;
            try {
                label = page.getLabel();
            } catch {
                // Label not available
            }

            // Perform search
            // MuPDF returns: QuadPoint[][] where each inner array is one hit
            const searchResults = page.search(query, maxHits);

            // Convert to PDFSearchHit format
            const hits: PDFSearchHit[] = searchResults.map(quads => {
                // Calculate bounding box from all quads in this hit
                const bbox = this.computeBBoxFromQuads(quads);
                return { quads, bbox };
            });

            return {
                pageIndex,
                label,
                matchCount: hits.length,
                hits,
                width,
                height,
            };
        } finally {
            page.destroy();
        }
    }

    /**
     * Search for text across multiple pages.
     * @param query - Text to search for
     * @param pageIndices - Pages to search (0-based). If undefined, searches all.
     * @param maxHitsPerPage - Maximum hits per page (default: 100)
     * @returns Array of PDFPageSearchResult for pages with matches
     */
    searchPages(
        query: string, 
        pageIndices?: number[], 
        maxHitsPerPage: number = 100
    ): PDFPageSearchResult[] {
        this.ensureOpen();
        const pageCount = this.getPageCount();

        const indices = pageIndices?.length
            ? pageIndices.filter(i => i >= 0 && i < pageCount)
            : Array.from({ length: pageCount }, (_, i) => i);

        const results: PDFPageSearchResult[] = [];

        for (const pageIndex of indices) {
            const pageResult = this.searchPage(pageIndex, query, maxHitsPerPage);
            if (pageResult.matchCount > 0) {
                results.push(pageResult);
            }
        }

        return results;
    }

    /**
     * Compute bounding box from an array of QuadPoints.
     * QuadPoint format: [ulx, uly, urx, ury, llx, lly, lrx, lry]
     */
    private computeBBoxFromQuads(quads: QuadPoint[]): RawBBox {
        if (quads.length === 0) {
            return { x: 0, y: 0, w: 0, h: 0 };
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const quad of quads) {
            // QuadPoint: [ulx, uly, urx, ury, llx, lly, lrx, lry]
            const [ulx, uly, urx, ury, llx, lly, lrx, lry] = quad;
            
            minX = Math.min(minX, ulx, urx, llx, lrx);
            minY = Math.min(minY, uly, ury, lly, lry);
            maxX = Math.max(maxX, ulx, urx, llx, lrx);
            maxY = Math.max(maxY, uly, ury, lly, lry);
        }

        return {
            x: minX,
            y: minY,
            w: maxX - minX,
            h: maxY - minY,
        };
    }

    /** Ensure the document is open */
    private ensureOpen(): void {
        if (!this.doc) {
            throw new Error("MuPDFService: No document is open. Call open() first.");
        }
    }
}
