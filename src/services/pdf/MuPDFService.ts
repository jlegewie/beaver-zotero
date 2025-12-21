/**
 * MuPDF Service
 *
 * Low-level bridge to the MuPDF WASM module.
 * Handles initialization, caching, and provides typed access to raw PDF data.
 */

import type { RawPageData, RawBlock } from "./types";

/** MuPDF API returned by the loader */
interface MuPDFAPI {
    Document: {
        openDocument: (data: Uint8Array | ArrayBuffer, magic?: string) => MuPDFDocument;
    };
    _libmupdf: unknown;
}

interface MuPDFDocument {
    pointer: number;
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
        // Use ChromeUtils.import for legacy JSM format (EXPORTED_SYMBOLS)
        // not ChromeUtils.importESModule which is for ES modules
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
        // Use ChromeUtils.import for legacy JSM format
        const { MuPDFLoader } = win.ChromeUtils.import(
            "chrome://beaver/content/modules/mupdf-loader.js"
        );
        await MuPDFLoader.dispose();
    } catch {
        // Silently fail if loader is already gone
    }

    mupdfPromise = null;
}

/**
 * MuPDF Service class for working with PDF documents.
 * Wraps the low-level WASM calls and provides typed interfaces.
 */
export class MuPDFService {
    private api: MuPDFAPI | null = null;
    private doc: MuPDFDocument | null = null;

    /** Initialize the service with PDF data */
    async open(pdfData: Uint8Array | ArrayBuffer): Promise<void> {
        this.api = await getMuPDFAPI();
        this.doc = this.api.Document.openDocument(pdfData, "application/pdf");
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

    /** Get page dimensions */
    getPageBounds(pageIndex: number): { width: number; height: number } {
        this.ensureOpen();
        const page = this.doc!.loadPage(pageIndex);
        try {
            const bounds = page.getBounds("CropBox");
            return {
                width: bounds[2] - bounds[0],
                height: bounds[3] - bounds[1],
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
     * Extract raw structured text data from a page.
     * This is the primary method for getting text content.
     */
    extractRawPage(pageIndex: number): RawPageData {
        this.ensureOpen();
        const page = this.doc!.loadPage(pageIndex);

        try {
            const stext = page.toStructuredText("preserve-whitespace");
            try {
                const json = JSON.parse(stext.asJSON());
                return {
                    pageNumber: pageIndex + 1,
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
     * @param pageIndices - Pages to extract (0-based). If empty, extracts all.
     */
    extractRawPages(pageIndices?: number[]): RawPageData[] {
        this.ensureOpen();
        const pageCount = this.getPageCount();

        const indices = pageIndices?.length
            ? pageIndices.filter(i => i >= 0 && i < pageCount)
            : Array.from({ length: pageCount }, (_, i) => i);

        return indices.map(i => this.extractRawPage(i));
    }

    /** Ensure the document is open */
    private ensureOpen(): void {
        if (!this.doc) {
            throw new Error("MuPDFService: No document is open. Call open() first.");
        }
    }
}

