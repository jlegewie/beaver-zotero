/**
 * MuPDF Service
 *
 * Low-level bridge to the MuPDF WASM module.
 * Handles initialization, caching, and provides typed access to raw PDF data.
 */

import type { RawPageData, RawBlock, RawDocumentData } from "./types";
import { ExtractionError, ExtractionErrorCode } from "./types";

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

// ============================================================================
// MuPDF API Types
// ============================================================================

/** MuPDF API returned by the loader */
interface MuPDFAPI {
    Document: {
        openDocument: (data: Uint8Array | ArrayBuffer, magic?: string) => MuPDFDocument;
    };
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

interface MuPDFPage {
    pointer: number;
    getBounds(box?: string): [number, number, number, number];
    getLabel(): string;
    toStructuredText(options?: string): MuPDFStructuredText;
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
        const win = Zotero.getMainWindow();
        const { MuPDFLoader } = win.ChromeUtils.import(
            "chrome://beaver/content/modules/mupdf-loader.js"
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
        const win = Zotero.getMainWindow();
        const { MuPDFLoader } = win.ChromeUtils.import(
            "chrome://beaver/content/modules/mupdf-loader.js"
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
     */
    extractRawPage(pageIndex: number): RawPageData {
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
            const stext = page.toStructuredText(STRUCTURED_TEXT_OPTIONS);
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

    /** Ensure the document is open */
    private ensureOpen(): void {
        if (!this.doc) {
            throw new Error("MuPDFService: No document is open. Call open() first.");
        }
    }
}
