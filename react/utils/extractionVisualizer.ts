/**
 * Extraction Visualizer
 *
 * Creates temporary Zotero annotations to visualize PDF extraction results
 * (columns / lines / paragraphs / sentences) on the live reader. Useful
 * for dev-time inspection of the detection pipeline.
 *
 * Bbox computation is delegated to `extractionOverlay.ts` so the
 * visualizer and the headless `/beaver/test/pdf-render-overlay` endpoint
 * always show the same boxes.
 */

import { logger } from "../../src/utils/logger";
import {
    getMuPDFWorkerClient,
    PDFExtractor,
    Rect,
} from "../../src/services/pdf";
import type { SentenceBBoxTraceResult } from "../../src/services/pdf";
import { getItemLanguage } from "../../src/utils/zoteroUtils";
import { getCurrentReaderAndWaitForView } from "./readerUtils";
import { getPageViewportInfo } from "./pdfUtils";
import { BeaverTemporaryAnnotations, ZoteroReader } from "./annotationUtils";
import { ZoteroItemReference } from "../types/zotero";
import {
    buildColumnOverlayFromTrace,
    buildLineOverlayFromTrace,
    buildParagraphOverlayFromTrace,
    buildSentenceOverlayFromResult,
    OverlayResult,
} from "./extractionOverlay";

/**
 * Convert MuPDF Rect (top-left origin, x/y/w/h) to Zotero rect format
 * (bottom-left origin, [x1, y1, x2, y2]).
 */
function rectToZoteroFormat(
    rect: Rect,
    pageHeight: number,
    viewBoxLL: [number, number] = [0, 0],
): number[] {
    const [vx, vy] = viewBoxLL;
    const x1 = rect.x + vx;
    const x2 = rect.x + rect.w + vx;
    const y1 = pageHeight - (rect.y + rect.h) + vy;
    const y2 = pageHeight - rect.y + vy;
    return [x1, y1, x2, y2];
}

/**
 * Bundle the boilerplate every visualizer entry-point needs:
 * resolve the active PDF reader, current page, item, and file path. Also
 * clears any prior overlay annotations so repeated runs don't stack up.
 *
 * Returns `null` when no PDF reader is available — callers convert that
 * into a user-facing error message.
 */
export async function resolveActiveReaderContext(): Promise<
    | {
        reader: ZoteroReader;
        item: Zotero.Item;
        filePath: string;
        pageIndex: number;
    }
    | { error: string }
> {
    const reader = await getCurrentReaderAndWaitForView(undefined, true);
    if (!reader || !reader._internalReader) return { error: "No active PDF reader found" };
    if (reader.type !== "pdf") return { error: "Current reader is not a PDF" };

    const pdfViewer =
        reader._internalReader._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
    if (!pdfViewer) return { error: "Could not access PDF viewer" };
    const pageIndex = pdfViewer.currentPageNumber - 1;

    const item = Zotero.Items.get(reader.itemID);
    if (!item) return { error: "Could not find Zotero item" };

    const filePath = await item.getFilePathAsync();
    if (!filePath) return { error: "Could not find PDF file" };

    await BeaverTemporaryAnnotations.cleanupAll(reader as ZoteroReader);

    return { reader: reader as ZoteroReader, item, filePath, pageIndex };
}

/**
 * Convert an `OverlayResult` (page-space rects) into Zotero annotations
 * and push them into the reader. Sentences get one annotation per group
 * (multiple rects per annotation), so multi-line sentences render as one
 * coherent highlight; everything else is one annotation per rect.
 */
async function pushOverlayToReader(
    overlay: OverlayResult,
    reader: ZoteroReader,
    viewBoxLL: [number, number],
): Promise<ZoteroItemReference[]> {
    if (overlay.rects.length === 0) return [];

    const libraryId = (reader as any)._item.libraryID;
    const pageHeight = overlay.pageHeight;
    const pageIndex = overlay.pageIndex;

    // Group rects by their `group` index so multi-rect sentences become a
    // single annotation. Single-rect levels (columns/lines/paragraphs)
    // collapse to one entry per group naturally.
    const groups = new Map<number, typeof overlay.rects>();
    for (const r of overlay.rects) {
        const list = groups.get(r.group);
        if (list) list.push(r);
        else groups.set(r.group, [r]);
    }

    const tempAnnotations: any[] = [];
    const annotationReferences: ZoteroItemReference[] = [];

    for (const [groupIdx, groupRects] of groups.entries()) {
        const head = groupRects[0];
        const zoteroRects = groupRects.map((r) =>
            rectToZoteroFormat(r.rect, pageHeight, viewBoxLL),
        );
        // Sort index uses the topmost rect so the annotations sidebar
        // roughly matches reading order.
        const topRect = zoteroRects.reduce(
            (acc, r) => (r[1] > acc[1] ? r : acc),
            zoteroRects[0],
        );
        const sortIndex = `${pageIndex.toString().padStart(5, "0")}|${String(
            Math.round(topRect[1]),
        ).padStart(6, "0")}|${String(Math.round(topRect[0])).padStart(5, "0")}`;

        const tempId = `${overlay.level}_${Date.now()}_${groupIdx}_${Math.random()
            .toString(36)
            .substr(2, 9)}`;

        // Pull a comment-friendly label out of the head rect; fall back to
        // the level name when none was set (shouldn't happen).
        const label = head.label ?? `${overlay.level} ${groupIdx + 1}`;
        // Sentence overlays attach a richer comment (address + full text) so
        // hovering the annotation surfaces the sentence body; other levels
        // fall back to the short label.
        const comment = head.annotationText ?? label;

        const tempAnnotation = {
            id: tempId,
            key: tempId,
            libraryID: libraryId,
            type: "highlight",
            color: head.color,
            sortIndex,
            position: { pageIndex, rects: zoteroRects },
            tags: [],
            comment,
            text: label,
            authorName: "Beaver Visualizer",
            pageLabel: (pageIndex + 1).toString(),
            isExternal: false,
            readOnly: false,
            lastModifiedByUser: "",
            dateModified: new Date().toISOString(),
            annotationType: "highlight",
            annotationAuthorName: "Beaver Visualizer",
            annotationText: label,
            annotationComment: comment,
            annotationColor: head.color,
            annotationPageLabel: (pageIndex + 1).toString(),
            annotationSortIndex: sortIndex,
            annotationPosition: JSON.stringify({ pageIndex, rects: zoteroRects }),
            annotationIsExternal: false,
            isTemporary: true,
        };
        tempAnnotations.push(tempAnnotation);
        annotationReferences.push({ zotero_key: tempId, library_id: libraryId });
    }

    (reader as any)._internalReader.setAnnotations(
        Components.utils.cloneInto(tempAnnotations, (reader as any)._iframeWindow),
    );
    return annotationReferences;
}

/**
 * Run the worker `extractSentenceBBoxesDebug` op for the given page and
 * return `{ result, trace }`. Single round-trip that drives every
 * visualizer level (columns / lines / paragraphs / sentences) — the
 * pure builders in `extractionOverlay.ts` then turn the returned trace
 * into rects.
 *
 * Best-effort language lookup feeds sentencex; the worker falls back to
 * the regex splitter on init failure, so this never throws on splitter
 * issues.
 */
async function loadSentenceTrace(
    filePath: string,
    pageIndex: number,
    item: Zotero.Item,
): Promise<SentenceBBoxTraceResult & { pdfData: Uint8Array }> {
    const pdfData = await IOUtils.read(filePath);
    let language: string | undefined;
    try {
        const raw = await getItemLanguage(item.libraryID, item.key);
        if (raw) language = raw;
    } catch {
        // Best effort.
    }
    const out = await getMuPDFWorkerClient().extractSentenceBBoxesDebug(
        pdfData,
        pageIndex,
        { splitterConfig: { type: "sentencex", language } },
    );
    return { ...out, pdfData };
}

/**
 * Visualize column detection results for the current page in the reader.
 */
export async function visualizeCurrentPageColumns(): Promise<{
    success: boolean;
    message: string;
    columns?: number;
    pageIndex?: number;
}> {
    try {
        const ctx = await resolveActiveReaderContext();
        if ("error" in ctx) return { success: false, message: ctx.error };
        const { reader, item, filePath, pageIndex } = ctx;

        logger(`[Visualizer] Loading PDF and extracting page ${pageIndex + 1}...`);
        const { trace } = await loadSentenceTrace(filePath, pageIndex, item);

        const overlay = buildColumnOverlayFromTrace(trace);
        if (overlay.rects.length === 0) {
            return {
                success: true,
                message: `No columns detected on page ${pageIndex + 1}`,
                columns: 0,
                pageIndex,
            };
        }

        const { viewBox } = await getPageViewportInfo(reader, pageIndex);
        const refs = await pushOverlayToReader(overlay, reader, [viewBox[0], viewBox[1]]);
        BeaverTemporaryAnnotations.addToTracking(refs);

        const message =
            overlay.stats.broken === 1
                ? `Page ${pageIndex + 1}: ${overlay.groupCount} column(s) detected [BROKEN PAGE]`
                : `Page ${pageIndex + 1}: ${overlay.groupCount} column(s) detected`;
        logger(`[Visualizer] ${message}`);
        return { success: true, message, columns: overlay.groupCount, pageIndex };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[Visualizer] Error: ${errorMessage}`);
        return { success: false, message: `Visualization failed: ${errorMessage}` };
    }
}

/**
 * Visualize line detection results for the current page in the reader.
 */
export async function visualizeCurrentPageLines(): Promise<{
    success: boolean;
    message: string;
    lines?: number;
    columns?: number;
    pageIndex?: number;
}> {
    try {
        const ctx = await resolveActiveReaderContext();
        if ("error" in ctx) return { success: false, message: ctx.error };
        const { reader, item, filePath, pageIndex } = ctx;

        logger(`[Visualizer] Loading PDF and detecting lines on page ${pageIndex + 1}...`);
        const { trace } = await loadSentenceTrace(filePath, pageIndex, item);

        const overlay = buildLineOverlayFromTrace(trace);
        if (overlay.rects.length === 0) {
            return {
                success: true,
                message: `No lines detected on page ${pageIndex + 1}`,
                lines: 0,
                columns: Number(overlay.stats.columns ?? 0),
                pageIndex,
            };
        }

        const { viewBox } = await getPageViewportInfo(reader, pageIndex);
        const refs = await pushOverlayToReader(overlay, reader, [viewBox[0], viewBox[1]]);
        BeaverTemporaryAnnotations.addToTracking(refs);

        const lineCount = Number(overlay.stats.lines ?? 0);
        const colCount = Number(overlay.stats.columns ?? 0);
        const message = `Page ${pageIndex + 1}: ${lineCount} lines in ${colCount} column(s)`;
        logger(`[Visualizer] ${message}`);
        return {
            success: true,
            message,
            lines: lineCount,
            columns: colCount,
            pageIndex,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[Visualizer] Error: ${errorMessage}`);
        return { success: false, message: `Line visualization failed: ${errorMessage}` };
    }
}

/**
 * Visualize paragraph detection results for the current page in the reader.
 */
export async function visualizeCurrentPageParagraphs(): Promise<{
    success: boolean;
    message: string;
    paragraphs?: number;
    headers?: number;
    pageIndex?: number;
}> {
    try {
        const ctx = await resolveActiveReaderContext();
        if ("error" in ctx) return { success: false, message: ctx.error };
        const { reader, item, filePath, pageIndex } = ctx;

        logger(`[Visualizer] Loading PDF for paragraph detection on page ${pageIndex + 1}...`);
        const { trace } = await loadSentenceTrace(filePath, pageIndex, item);

        const overlay = buildParagraphOverlayFromTrace(trace);
        if (overlay.rects.length === 0) {
            return {
                success: true,
                message: `No paragraphs detected on page ${pageIndex + 1}`,
                paragraphs: 0,
                headers: 0,
                pageIndex,
            };
        }

        const { viewBox } = await getPageViewportInfo(reader, pageIndex);
        const refs = await pushOverlayToReader(overlay, reader, [viewBox[0], viewBox[1]]);
        BeaverTemporaryAnnotations.addToTracking(refs);

        const paragraphs = Number(overlay.stats.paragraphs ?? 0);
        const headers = Number(overlay.stats.headers ?? 0);
        const message = `Page ${pageIndex + 1}: ${paragraphs} paragraphs, ${headers} headers`;
        logger(`[Visualizer] ${message}`);
        return { success: true, message, paragraphs, headers, pageIndex };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[Visualizer] Error: ${errorMessage}`);
        return { success: false, message: `Paragraph visualization failed: ${errorMessage}` };
    }
}

/**
 * Visualize sentence-level bbox results for the current page in the reader.
 *
 * Each sentence renders as one multi-rect highlight so multi-line
 * sentences stay coherent. Adjacent sentences alternate pink/yellow;
 * degraded fallbacks render in gray.
 */
export async function visualizeCurrentPageSentences(): Promise<{
    success: boolean;
    message: string;
    sentences?: number;
    headings?: number;
    paragraphs?: number;
    degradedParagraphs?: number;
    unmappedParagraphs?: number;
    pageIndex?: number;
}> {
    try {
        const ctx = await resolveActiveReaderContext();
        if ("error" in ctx) return { success: false, message: ctx.error };
        const { reader, item, filePath, pageIndex } = ctx;

        logger(`[Visualizer] Loading PDF and mapping sentences on page ${pageIndex + 1}...`);
        const { result, trace } = await loadSentenceTrace(filePath, pageIndex, item);

        const overlay = buildSentenceOverlayFromResult(
            result,
            trace.analysisPageIndices.length,
        );
        if (overlay.rects.length === 0) {
            return {
                success: true,
                message: `No sentences detected on page ${pageIndex + 1}`,
                sentences: 0,
                paragraphs: 0,
                pageIndex,
            };
        }

        // Sentence mapper coords share the page space, but the visualizer
        // historically used the rawPage height (from the JSON-walked
        // analysis window) for coordinate conversion; they're equal for
        // non-rotated pages, but stick with rawPage for exact byte-for-byte
        // parity with prior behavior.
        const rawPage = trace.rawDoc.pages.find(
            (p) => p.pageIndex === pageIndex,
        );
        const overlayWithRawHeight: OverlayResult = rawPage
            ? { ...overlay, pageHeight: rawPage.height }
            : overlay;

        const { viewBox } = await getPageViewportInfo(reader, pageIndex);
        const refs = await pushOverlayToReader(overlayWithRawHeight, reader, [
            viewBox[0],
            viewBox[1],
        ]);
        BeaverTemporaryAnnotations.addToTracking(refs);

        const sentences = Number(overlay.stats.sentences ?? 0);
        const headings = Number(overlay.stats.headings ?? 0);
        const paragraphs = Number(overlay.stats.paragraphs ?? 0);
        const degraded = Number(overlay.stats.degradedParagraphs ?? 0);
        const unmapped = Number(overlay.stats.unmappedParagraphs ?? 0);
        const tail = degraded > 0 || unmapped > 0
            ? ` (degraded: ${degraded}, unmapped: ${unmapped})`
            : "";
        const headingTail = headings > 0 ? ` (${headings} heading${headings === 1 ? "" : "s"})` : "";
        const message = `Page ${pageIndex + 1}: ${sentences} sentences${headingTail} in ${paragraphs} paragraphs${tail}`;
        logger(`[Visualizer] ${message}`);
        return {
            success: true,
            message,
            sentences,
            headings,
            paragraphs,
            degradedParagraphs: degraded,
            unmappedParagraphs: unmapped,
            pageIndex,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[Visualizer] Error: ${errorMessage}`);
        return { success: false, message: `Sentence visualization failed: ${errorMessage}` };
    }
}

/**
 * Clear all visualization annotations.
 */
export async function clearVisualizationAnnotations(): Promise<void> {
    try {
        const reader = await getCurrentReaderAndWaitForView(undefined, false);
        if (reader) await BeaverTemporaryAnnotations.cleanupAll(reader as ZoteroReader);
    } catch (error) {
        logger(`[Visualizer] Error clearing annotations: ${error}`);
    }
}

/**
 * Result from extracting a single page's content.
 */
export interface PageExtractionResult {
    success: boolean;
    message: string;
    pageIndex?: number;
    pageNumber?: number;
    content?: string;
    columnCount?: number;
    columns?: Array<{ l: number; t: number; r: number; b: number }>;
}

/**
 * Extract content from the current page in reading order using column detection.
 */
export async function extractCurrentPageContent(): Promise<PageExtractionResult> {
    try {
        const reader = await getCurrentReaderAndWaitForView(undefined, true);
        if (!reader || !reader._internalReader) {
            return { success: false, message: "No active PDF reader found" };
        }
        if (reader.type !== "pdf") {
            return { success: false, message: "Current reader is not a PDF" };
        }
        const pdfViewer =
            reader._internalReader._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
        if (!pdfViewer) return { success: false, message: "Could not access PDF viewer" };
        const pageIndex = pdfViewer.currentPageNumber - 1;

        const item = Zotero.Items.get(reader.itemID);
        if (!item) return { success: false, message: "Could not find Zotero item" };
        const filePath = await item.getFilePathAsync();
        if (!filePath) return { success: false, message: "Could not find PDF file" };

        logger(`[Extractor] Loading PDF and extracting page ${pageIndex + 1}...`);
        const pdfData = await IOUtils.read(filePath);

        const result = await new PDFExtractor().extract(pdfData, {
            pageIndices: [pageIndex],
        });
        const processedPage = result.pages[0];
        if (!processedPage) {
            return {
                success: false,
                message: `Page ${pageIndex + 1} not extracted`,
            };
        }

        const columns = processedPage.columns ?? [];
        logger(`[Extractor] Found ${columns.length} column(s)`);
        logger(
            `[Extractor] Page ${pageIndex + 1} content extracted (${processedPage.content.length} chars)`,
        );

        return {
            success: true,
            message: `Extracted ${processedPage.content.length} characters from page ${pageIndex + 1}`,
            pageIndex,
            pageNumber: pageIndex + 1,
            content: processedPage.content,
            columnCount: columns.length,
            columns,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[Extractor] Error: ${errorMessage}`);
        return { success: false, message: `Extraction failed: ${errorMessage}` };
    }
}
