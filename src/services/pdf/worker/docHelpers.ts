/**
 * Shared helpers used by every worker op. Extracted so orchestration ops
 * compose them within a single doc-open.
 *
 * The structured-text option strings mirror `src/services/pdf/MuPDFService.ts`.
 */

import type {
    RawBBox,
    RawBlock,
    RawPageData,
    RawPageDataDetailed,
    RawLineDetailed,
    RawChar,
    PDFPageSearchResult,
    PageImageOptions,
    PageImageResult,
} from "../types";
import type { RawPageProvider } from "../DocumentAnalyzer";
import type {
    DocumentLike,
    MuPDFApi,
    QuadTuple,
    RectTuple,
} from "./mupdfApi";
import { ERROR_CODES, postLog, workerError } from "./errors";
import { ensureApi } from "./wasmInit";

const STRUCTURED_TEXT_OPTIONS = "preserve-whitespace";
const STRUCTURED_TEXT_OPTIONS_WITH_IMAGES = "preserve-whitespace,preserve-images";
const STRUCTURED_TEXT_OPTIONS_DETAILED = "preserve-whitespace,preserve-ligatures";
const STRUCTURED_TEXT_OPTIONS_DETAILED_WITH_IMAGES =
    "preserve-whitespace,preserve-ligatures,preserve-images";

export interface RenderOptionsResolved {
    scale: number;
    dpi: number;
    alpha: boolean;
    showExtras: boolean;
    format: "png" | "jpeg";
    jpegQuality: number;
}

export const DEFAULT_PAGE_IMAGE_OPTIONS: RenderOptionsResolved = {
    scale: 1.0,
    dpi: 0,
    alpha: false,
    showExtras: true,
    format: "png",
    jpegQuality: 85,
};

/** Convert a [x0, y0, x1, y1] tuple (from walk() bboxes) to RawBBox. */
export function tupleToBBox(t: RectTuple): RawBBox {
    return { x: t[0], y: t[1], w: t[2] - t[0], h: t[3] - t[1] };
}

/** Compute an axis-aligned RawBBox from a QuadPoint's four corners. */
export function bboxFromQuad(q: QuadTuple): RawBBox {
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Compute an axis-aligned bbox from an array of quads. */
export function bboxFromQuads(quads: QuadTuple[]): RawBBox {
    if (!quads.length) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const q of quads) {
        const [ulx, uly, urx, ury, llx, lly, lrx, lry] = q;
        minX = Math.min(minX, ulx, urx, llx, lrx);
        minY = Math.min(minY, uly, ury, lly, lry);
        maxX = Math.max(maxX, ulx, urx, llx, lrx);
        maxY = Math.max(maxY, uly, ury, lly, lry);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Open a PDF document and run the encryption check, mirroring
 * MuPDFService.open() semantics. Throws workerError on encrypted /
 * invalid input. Returns the open `doc` on success.
 */
export async function openDocSafe(pdfData: Uint8Array | ArrayBuffer): Promise<DocumentLike> {
    const { Document } = await ensureApi();

    let doc: DocumentLike;
    try {
        doc = Document.openDocument(pdfData, "application/pdf");
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const lower = message.toLowerCase();
        if (lower.includes("password") || lower.includes("encrypted")) {
            throw workerError(
                ERROR_CODES.ENCRYPTED,
                "Document is encrypted and requires a password",
            );
        }
        throw workerError(
            ERROR_CODES.INVALID_PDF,
            `Failed to open PDF: ${message}`,
        );
    }

    // Encryption check — mirrors the swallow-and-continue at MuPDFService.ts:267-272.
    try {
        if (typeof doc.needsPassword === "function") {
            if (doc.needsPassword()) {
                doc.destroy();
                throw workerError(
                    ERROR_CODES.ENCRYPTED,
                    "Document is encrypted and requires a password",
                );
            }
        } else {
            const enc = doc.getMetadata("encryption");
            if (enc && enc !== "" && enc !== "None") {
                doc.destroy();
                throw workerError(
                    ERROR_CODES.ENCRYPTED,
                    "Document is encrypted and requires a password",
                );
            }
        }
    } catch (e) {
        if (e && (e as { code?: string }).code === ERROR_CODES.ENCRYPTED) {
            throw e;
        }
        postLog(
            "warn",
            `[mupdf-worker] Encryption check failed, continuing: ${e}`,
        );
    }

    return doc;
}

/**
 * Extract a single page's structured-text JSON. Mirrors
 * `MuPDFService.extractRawPage(pageIndex, options)` exactly — including the
 * `includeImages` switch to STRUCTURED_TEXT_OPTIONS_WITH_IMAGES.
 *
 * Critical: `DocumentAnalyzer.getDetailedOCRAnalysis` calls with
 * `{ includeImages: true }` and inspects image blocks to detect scanned-page
 * coverage. Without this branch the worker-side OCR detection silently
 * over-counts text density and misses the scanned-page case.
 */
export function extractRawPageFromDoc(
    doc: DocumentLike,
    pageIndex: number,
    opts?: { includeImages?: boolean },
): RawPageData {
    const page = doc.loadPage(pageIndex);
    try {
        const pb = page.getBounds("CropBox");
        const width = pb[2] - pb[0];
        const height = pb[3] - pb[1];

        let label: string | undefined;
        try {
            label = page.getLabel();
        } catch (_) {
            // label not available
        }

        const stextOptions = opts?.includeImages
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
 * Extract detailed (character-level) page data. Mirrors
 * `MuPDFService.extractRawPageDetailed(pageIndex, options)`.
 */
export function extractRawPageDetailedFromDoc(
    doc: DocumentLike,
    pageIndex: number,
    includeImages: boolean,
): RawPageDataDetailed {
    const page = doc.loadPage(pageIndex);
    try {
        const pb = page.getBounds("CropBox");
        const width = pb[2] - pb[0];
        const height = pb[3] - pb[1];

        let label: string | undefined;
        try {
            label = page.getLabel();
        } catch (_) {
            // label not available
        }

        const stextOptions = includeImages
            ? STRUCTURED_TEXT_OPTIONS_DETAILED_WITH_IMAGES
            : STRUCTURED_TEXT_OPTIONS_DETAILED;
        const stext = page.toStructuredText(stextOptions);

        const blocks: RawBlock[] = [];
        let currentBlock: (RawBlock & { type: "text"; lines: RawLineDetailed[] }) | null = null;
        let currentLine: RawLineDetailed | null = null;

        try {
            stext.walk({
                beginTextBlock: (bbox) => {
                    currentBlock = {
                        type: "text",
                        bbox: tupleToBBox(bbox),
                        lines: [],
                    };
                },
                endTextBlock: () => {
                    if (currentBlock) {
                        blocks.push(currentBlock);
                        currentBlock = null;
                    }
                },
                beginLine: (bbox, wmode) => {
                    currentLine = {
                        wmode,
                        bbox: tupleToBBox(bbox),
                        font: {
                            name: "",
                            family: "",
                            weight: "normal",
                            style: "normal",
                            size: 0,
                        },
                        x: bbox[0],
                        y: bbox[1],
                        text: "",
                        chars: [] as RawChar[],
                    } as RawLineDetailed;
                },
                endLine: () => {
                    if (currentLine && currentBlock) {
                        currentBlock.lines.push(currentLine);
                    }
                    currentLine = null;
                },
                onChar: (rune, _origin, _font, _size, quad) => {
                    if (!currentLine) return;
                    currentLine.text += rune;
                    currentLine.chars.push({
                        c: rune,
                        quad,
                        bbox: bboxFromQuad(quad),
                    } as RawChar);
                },
                onImageBlock: (bbox) => {
                    if (includeImages) {
                        blocks.push({
                            type: "image",
                            bbox: tupleToBBox(bbox),
                        } as RawBlock);
                    }
                },
            });
        } finally {
            stext.destroy();
        }

        return {
            pageIndex,
            pageNumber: pageIndex + 1,
            width,
            height,
            label,
            blocks,
        } as RawPageDataDetailed;
    } finally {
        page.destroy();
    }
}

/** Render a single page to PNG/JPEG. Mirrors MuPDFService.renderPageToImage internals. */
export function renderOnePage(
    api: MuPDFApi,
    doc: DocumentLike,
    pageIndex: number,
    opts: RenderOptionsResolved,
): PageImageResult {
    const { Matrix, ColorSpace } = api;
    const scale = opts.dpi > 0 ? opts.dpi / 72 : opts.scale;
    const effectiveDpi = opts.dpi > 0 ? opts.dpi : opts.scale * 72;

    const page = doc.loadPage(pageIndex);
    try {
        const matrix = Matrix.scale(scale, scale);
        const pixmap = page.toPixmap(
            matrix,
            ColorSpace.DeviceRGB,
            opts.alpha,
            opts.showExtras,
        );
        try {
            const width = pixmap.getWidth();
            const height = pixmap.getHeight();
            let data: Uint8Array;
            let format: "png" | "jpeg" = opts.format;
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

/** Search a single page. Mirrors MuPDFService.searchPage internals. */
export function searchPageInDoc(
    doc: DocumentLike,
    pageIndex: number,
    query: string,
    maxHits: number,
): PDFPageSearchResult {
    const page = doc.loadPage(pageIndex);
    try {
        const pb = page.getBounds("CropBox");
        const width = pb[2] - pb[0];
        const height = pb[3] - pb[1];

        let label: string | undefined;
        try {
            label = page.getLabel();
        } catch (_) {
            // label not available
        }

        const searchResults = page.search(query, maxHits);
        const hits = searchResults.map((quads) => ({
            quads,
            bbox: bboxFromQuads(quads),
        }));

        return {
            pageIndex,
            label,
            matchCount: hits.length,
            hits,
            width,
            height,
        } as PDFPageSearchResult;
    } finally {
        page.destroy();
    }
}

/** Collect every page's label into a record. Mirrors MuPDFService.getAllPageLabels. */
export function collectPageLabels(doc: DocumentLike): Record<number, string> {
    const count = doc.countPages();
    const labels: Record<number, string> = {};
    for (let i = 0; i < count; i++) {
        const page = doc.loadPage(i);
        try {
            const label = page.getLabel();
            if (label) labels[i] = label;
        } catch (_) {
            // label not available
        } finally {
            page.destroy();
        }
    }
    return labels;
}

/** Resolve `pageIndices` to a concrete in-bounds list. Mirrors filter semantics in MuPDFService. */
export function resolvePageIndices(pageCount: number, pageIndices?: number[]): number[] {
    return pageIndices && pageIndices.length
        ? pageIndices.filter((i) => i >= 0 && i < pageCount)
        : Array.from({ length: pageCount }, (_, i) => i);
}

/**
 * Build a RawPageProvider over an open Document. Lets DocumentAnalyzer run
 * inside the worker without a MuPDFService dependency.
 */
export function rawPageProviderFromDoc(doc: DocumentLike): RawPageProvider {
    return {
        getPageCount: () => doc.countPages(),
        extractRawPage: (i, opts) => extractRawPageFromDoc(doc, i, opts),
    };
}
