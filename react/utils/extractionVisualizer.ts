/**
 * Extraction Visualizer
 *
 * Creates temporary annotations to visualize PDF extraction results.
 * Useful for debugging and analyzing column detection, margin filtering, etc.
 */

import { logger } from "../../src/utils/logger";
import { 
    MuPDFService, 
    detectColumns, 
    detectLinesOnPage,
    detectParagraphs,
    lineBBoxToRect,
    logParagraphDetection,
    Rect, 
    RawPageData,
    PageLineResult,
    PageParagraphResult,
    ContentItem,
} from "../../src/services/pdf";
import { getCurrentReaderAndWaitForView } from "./readerUtils";
import { getPageViewportInfo } from "./pdfUtils";
import { BeaverTemporaryAnnotations, ZoteroReader } from "./annotationUtils";
import { ZoteroItemReference } from "../types/zotero";

// Colors for visualization
const COLUMN_COLOR = "#00bbff"; // Blue for columns
const LINE_COLOR = "#ff9500";   // Orange for lines
const PARAGRAPH_COLOR = "#34c759"; // Green for paragraphs
const HEADER_COLOR = "#af52de";    // Purple for headers

/**
 * Convert MuPDF Rect (top-left origin, x/y/w/h) to Zotero rect format (bottom-left origin, [x1, y1, x2, y2])
 * 
 * MuPDF uses top-left origin: y increases downward
 * Zotero/PDF uses bottom-left origin: y increases upward
 * 
 * @param rect MuPDF rectangle {x, y, w, h}
 * @param pageHeight Page height for coordinate inversion
 * @param viewBoxLL View box lower-left offset [vx, vy]
 * @returns Zotero rect format [x1, y1, x2, y2]
 */
function rectToZoteroFormat(
    rect: Rect,
    pageHeight: number,
    viewBoxLL: [number, number] = [0, 0]
): number[] {
    const [vx, vy] = viewBoxLL;
    
    // Convert from top-left origin to bottom-left origin
    // In MuPDF: y is distance from top, so y=0 is top of page
    // In Zotero: y is distance from bottom, so y=0 is bottom of page
    const x1 = rect.x + vx;
    const x2 = rect.x + rect.w + vx;
    const y1 = pageHeight - (rect.y + rect.h) + vy; // Bottom of rect in bottom-left coords
    const y2 = pageHeight - rect.y + vy;             // Top of rect in bottom-left coords
    
    return [x1, y1, x2, y2];
}

/**
 * Create temporary highlight annotations for detected columns
 * 
 * @param columns Array of column rectangles from column detection
 * @param pageIndex 0-based page index
 * @param pageHeight Page height for coordinate conversion
 * @param reader Zotero reader instance
 * @param viewBoxLL Optional view box lower-left offset
 * @returns Array of annotation references for tracking
 */
async function createColumnAnnotations(
    columns: Rect[],
    pageIndex: number,
    pageHeight: number,
    reader: ZoteroReader,
    viewBoxLL: [number, number] = [0, 0]
): Promise<ZoteroItemReference[]> {
    if (columns.length === 0) return [];
    
    const annotationReferences: ZoteroItemReference[] = [];
    const tempAnnotations: any[] = [];
    
    for (let i = 0; i < columns.length; i++) {
        const column = columns[i];
        const readingOrder = i + 1;
        
        // Convert to Zotero coordinate format
        const rect = rectToZoteroFormat(column, pageHeight, viewBoxLL);
        
        // Create unique IDs
        const tempId = `column_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Create annotation object
        const tempAnnotation = {
            id: tempId,
            key: tempId,
            libraryID: (reader as any)._item.libraryID,
            type: "highlight",
            color: COLUMN_COLOR,
            sortIndex: `${pageIndex.toString().padStart(5, "0")}|${String(Math.round(rect[1])).padStart(6, "0")}|${String(Math.round(rect[0])).padStart(5, "0")}`,
            position: {
                pageIndex: pageIndex,
                rects: [rect],
            },
            tags: [],
            comment: `Column ${readingOrder}`,
            text: `Column ${readingOrder} of ${columns.length}`,
            authorName: "Beaver Visualizer",
            pageLabel: (pageIndex + 1).toString(),
            isExternal: false,
            readOnly: false,
            lastModifiedByUser: "",
            dateModified: new Date().toISOString(),
            annotationType: "highlight",
            annotationAuthorName: "Beaver Visualizer",
            annotationText: `Column ${readingOrder}`,
            annotationComment: `Column ${readingOrder}`,
            annotationColor: COLUMN_COLOR,
            annotationPageLabel: (pageIndex + 1).toString(),
            annotationSortIndex: `${pageIndex.toString().padStart(5, "0")}|${String(Math.round(rect[1])).padStart(6, "0")}|${String(Math.round(rect[0])).padStart(5, "0")}`,
            annotationPosition: JSON.stringify({
                pageIndex: pageIndex,
                rects: [rect],
            }),
            annotationIsExternal: false,
            isTemporary: true,
        };
        
        tempAnnotations.push(tempAnnotation);
        annotationReferences.push({
            zotero_key: tempId,
            library_id: (reader as any)._item.libraryID,
        });
    }
    
    // Add annotations to reader
    if (tempAnnotations.length > 0) {
        (reader as any)._internalReader.setAnnotations(
            Components.utils.cloneInto(tempAnnotations, (reader as any)._iframeWindow)
        );
    }
    
    return annotationReferences;
}

/**
 * Create temporary highlight annotations for detected lines
 * 
 * @param lineResult Line detection result for the page
 * @param pageHeight Page height for coordinate conversion
 * @param reader Zotero reader instance
 * @param viewBoxLL Optional view box lower-left offset
 * @returns Array of annotation references for tracking
 */
async function createLineAnnotations(
    lineResult: PageLineResult,
    pageHeight: number,
    reader: ZoteroReader,
    viewBoxLL: [number, number] = [0, 0]
): Promise<ZoteroItemReference[]> {
    const annotationReferences: ZoteroItemReference[] = [];
    const tempAnnotations: any[] = [];
    
    let lineNumber = 0;
    
    for (const colResult of lineResult.columnResults) {
        for (let i = 0; i < colResult.lines.length; i++) {
            lineNumber++;
            const line = colResult.lines[i];
            
            // Convert LineBBox to Rect format, then to Zotero format
            const lineRect = lineBBoxToRect(line.bbox);
            const rect = rectToZoteroFormat(lineRect, pageHeight, viewBoxLL);
            
            // Create unique IDs
            const tempId = `line_${Date.now()}_${lineNumber}_${Math.random().toString(36).substr(2, 9)}`;
            
            // Truncate text for display
            const textPreview = line.text.length > 50 
                ? line.text.slice(0, 50) + "..." 
                : line.text;
            
            // Create annotation object
            const tempAnnotation = {
                id: tempId,
                key: tempId,
                libraryID: (reader as any)._item.libraryID,
                type: "highlight",
                color: LINE_COLOR,
                sortIndex: `${lineResult.pageIndex.toString().padStart(5, "0")}|${String(Math.round(rect[1])).padStart(6, "0")}|${String(Math.round(rect[0])).padStart(5, "0")}`,
                position: {
                    pageIndex: lineResult.pageIndex,
                    rects: [rect],
                },
                tags: [],
                comment: `Line ${lineNumber} (Col ${colResult.columnIndex + 1}): ${textPreview}`,
                text: textPreview,
                authorName: "Beaver Visualizer",
                pageLabel: (lineResult.pageIndex + 1).toString(),
                isExternal: false,
                readOnly: false,
                lastModifiedByUser: "",
                dateModified: new Date().toISOString(),
                annotationType: "highlight",
                annotationAuthorName: "Beaver Visualizer",
                annotationText: textPreview,
                annotationComment: `Line ${lineNumber} (Col ${colResult.columnIndex + 1})`,
                annotationColor: LINE_COLOR,
                annotationPageLabel: (lineResult.pageIndex + 1).toString(),
                annotationSortIndex: `${lineResult.pageIndex.toString().padStart(5, "0")}|${String(Math.round(rect[1])).padStart(6, "0")}|${String(Math.round(rect[0])).padStart(5, "0")}`,
                annotationPosition: JSON.stringify({
                    pageIndex: lineResult.pageIndex,
                    rects: [rect],
                }),
                annotationIsExternal: false,
                isTemporary: true,
            };
            
            tempAnnotations.push(tempAnnotation);
            annotationReferences.push({
                zotero_key: tempId,
                library_id: (reader as any)._item.libraryID,
            });
        }
    }
    
    // Add annotations to reader
    if (tempAnnotations.length > 0) {
        (reader as any)._internalReader.setAnnotations(
            Components.utils.cloneInto(tempAnnotations, (reader as any)._iframeWindow)
        );
    }
    
    return annotationReferences;
}

/**
 * Visualize column detection results for the current page in the reader
 * 
 * Creates temporary blue highlight annotations showing detected columns,
 * with reading order numbers in the comment field.
 * 
 * @returns Object with success status and details
 */
export async function visualizeCurrentPageColumns(): Promise<{
    success: boolean;
    message: string;
    columns?: number;
    pageIndex?: number;
}> {
    try {
        // 1. Get the current reader
        const reader = await getCurrentReaderAndWaitForView(undefined, true);
        if (!reader || !reader._internalReader) {
            return {
                success: false,
                message: "No active PDF reader found",
            };
        }
        
        if (reader.type !== "pdf") {
            return {
                success: false,
                message: "Current reader is not a PDF",
            };
        }
        
        // Get current page (0-based)
        const pdfViewer = reader._internalReader._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
        if (!pdfViewer) {
            return {
                success: false,
                message: "Could not access PDF viewer",
            };
        }
        const currentPageIndex = pdfViewer.currentPageNumber - 1;
        
        // 2. Get the PDF item and file path
        const item = Zotero.Items.get(reader.itemID);
        if (!item) {
            return {
                success: false,
                message: "Could not find Zotero item",
            };
        }
        
        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            return {
                success: false,
                message: "Could not find PDF file",
            };
        }
        
        // 3. Clean up any existing temporary annotations
        await BeaverTemporaryAnnotations.cleanupAll(reader as ZoteroReader);
        
        // 4. Load PDF and extract raw page data
        logger(`[Visualizer] Loading PDF and extracting page ${currentPageIndex + 1}...`);
        const pdfData = await IOUtils.read(filePath);
        
        const mupdf = new MuPDFService();
        await mupdf.open(pdfData);
        
        let rawPage: RawPageData;
        try {
            rawPage = mupdf.extractRawPage(currentPageIndex);
        } finally {
            mupdf.close();
        }
        
        // 5. Run column detection
        logger(`[Visualizer] Detecting columns on page ${currentPageIndex + 1}...`);
        const columnResult = detectColumns(rawPage);
        
        if (columnResult.columns.length === 0) {
            return {
                success: true,
                message: `No columns detected on page ${currentPageIndex + 1}`,
                columns: 0,
                pageIndex: currentPageIndex,
            };
        }
        
        // 6. Get viewport info for coordinate conversion
        const { viewBox, height } = await getPageViewportInfo(reader as ZoteroReader, currentPageIndex);
        const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];
        
        // Use the page height from MuPDF for coordinate conversion
        // (should match viewport height for non-rotated pages)
        const pageHeight = rawPage.height;
        
        // 7. Create annotations
        logger(`[Visualizer] Creating ${columnResult.columns.length} column annotations...`);
        
        // Log column details
        for (let i = 0; i < columnResult.columns.length; i++) {
            const col = columnResult.columns[i];
            logger(`  Column ${i + 1}: x=${col.x.toFixed(0)}, y=${col.y.toFixed(0)}, w=${col.w.toFixed(0)}, h=${col.h.toFixed(0)}`);
        }
        
        const annotationRefs = await createColumnAnnotations(
            columnResult.columns,
            currentPageIndex,
            pageHeight,
            reader as ZoteroReader,
            viewBoxLL
        );
        
        // Track annotations for cleanup
        BeaverTemporaryAnnotations.addToTracking(annotationRefs);
        
        const message = columnResult.isBroken
            ? `Page ${currentPageIndex + 1}: ${columnResult.columns.length} column(s) detected [BROKEN PAGE]`
            : `Page ${currentPageIndex + 1}: ${columnResult.columns.length} column(s) detected`;
        
        logger(`[Visualizer] ${message}`);
        
        return {
            success: true,
            message,
            columns: columnResult.columns.length,
            pageIndex: currentPageIndex,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[Visualizer] Error: ${errorMessage}`);
        return {
            success: false,
            message: `Visualization failed: ${errorMessage}`,
        };
    }
}

/**
 * Visualize line detection results for the current page in the reader
 * 
 * Creates temporary orange highlight annotations showing detected lines,
 * with line numbers and text preview in the comment field.
 * 
 * @returns Object with success status and details
 */
export async function visualizeCurrentPageLines(): Promise<{
    success: boolean;
    message: string;
    lines?: number;
    columns?: number;
    pageIndex?: number;
}> {
    // Import MarginFilter here to avoid circular dependencies
    const { MarginFilter, DEFAULT_MARGINS, logLineDetection } = await import("../../src/services/pdf");
    
    try {
        // 1. Get the current reader
        const reader = await getCurrentReaderAndWaitForView(undefined, true);
        if (!reader || !reader._internalReader) {
            return {
                success: false,
                message: "No active PDF reader found",
            };
        }
        
        if (reader.type !== "pdf") {
            return {
                success: false,
                message: "Current reader is not a PDF",
            };
        }
        
        // Get current page (0-based)
        const pdfViewer = reader._internalReader._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
        if (!pdfViewer) {
            return {
                success: false,
                message: "Could not access PDF viewer",
            };
        }
        const currentPageIndex = pdfViewer.currentPageNumber - 1;
        
        // 2. Get the PDF item and file path
        const item = Zotero.Items.get(reader.itemID);
        if (!item) {
            return {
                success: false,
                message: "Could not find Zotero item",
            };
        }
        
        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            return {
                success: false,
                message: "Could not find PDF file",
            };
        }
        
        // 3. Clean up any existing temporary annotations
        await BeaverTemporaryAnnotations.cleanupAll(reader as ZoteroReader);
        
        // 4. Load PDF and extract raw page data
        logger(`[Visualizer] Loading PDF and detecting lines on page ${currentPageIndex + 1}...`);
        const pdfData = await IOUtils.read(filePath);
        
        const mupdf = new MuPDFService();
        await mupdf.open(pdfData);
        
        let rawPage: RawPageData;
        try {
            rawPage = mupdf.extractRawPage(currentPageIndex);
        } finally {
            mupdf.close();
        }
        
        // 5. Apply margin filtering
        const filteredPage = MarginFilter.filterPageByMargins(rawPage, DEFAULT_MARGINS);
        
        // 6. Run column detection first
        logger(`[Visualizer] Detecting columns on page ${currentPageIndex + 1}...`);
        const columnResult = detectColumns(filteredPage);
        
        if (columnResult.columns.length === 0) {
            return {
                success: true,
                message: `No columns detected on page ${currentPageIndex + 1}`,
                lines: 0,
                columns: 0,
                pageIndex: currentPageIndex,
            };
        }
        
        // 7. Run line detection
        logger(`[Visualizer] Detecting lines in ${columnResult.columns.length} column(s)...`);
        const lineResult = detectLinesOnPage(filteredPage, columnResult.columns);
        
        // Log results
        logLineDetection(lineResult);
        
        if (lineResult.allLines.length === 0) {
            return {
                success: true,
                message: `No lines detected on page ${currentPageIndex + 1}`,
                lines: 0,
                columns: columnResult.columns.length,
                pageIndex: currentPageIndex,
            };
        }
        
        // 8. Get viewport info for coordinate conversion
        const { viewBox } = await getPageViewportInfo(reader as ZoteroReader, currentPageIndex);
        const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];
        
        // Use the page height from MuPDF for coordinate conversion
        const pageHeight = rawPage.height;
        
        // 9. Create annotations
        logger(`[Visualizer] Creating ${lineResult.allLines.length} line annotations...`);
        
        const annotationRefs = await createLineAnnotations(
            lineResult,
            pageHeight,
            reader as ZoteroReader,
            viewBoxLL
        );
        
        // Track annotations for cleanup
        BeaverTemporaryAnnotations.addToTracking(annotationRefs);
        
        const message = `Page ${currentPageIndex + 1}: ${lineResult.allLines.length} lines in ${columnResult.columns.length} column(s)`;
        
        logger(`[Visualizer] ${message}`);
        
        return {
            success: true,
            message,
            lines: lineResult.allLines.length,
            columns: columnResult.columns.length,
            pageIndex: currentPageIndex,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[Visualizer] Error: ${errorMessage}`);
        return {
            success: false,
            message: `Line visualization failed: ${errorMessage}`,
        };
    }
}

/**
 * Create temporary highlight annotations for detected paragraphs/headers
 */
async function createParagraphAnnotations(
    paragraphResult: PageParagraphResult,
    pageHeight: number,
    reader: ZoteroReader,
    viewBoxLL: [number, number] = [0, 0]
): Promise<ZoteroItemReference[]> {
    const annotationReferences: ZoteroItemReference[] = [];
    const tempAnnotations: any[] = [];
    
    for (let i = 0; i < paragraphResult.items.length; i++) {
        const item = paragraphResult.items[i];
        
        // Convert LineBBox to Rect format, then to Zotero format
        const itemRect: Rect = {
            x: item.bbox.l,
            y: item.bbox.t,
            w: item.bbox.width,
            h: item.bbox.height,
        };
        const rect = rectToZoteroFormat(itemRect, pageHeight, viewBoxLL);
        
        // Create unique IDs
        const tempId = `${item.type}_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Choose color based on type
        const color = item.type === "header" ? HEADER_COLOR : PARAGRAPH_COLOR;
        const typeLabel = item.type === "header" ? "Header" : "Paragraph";
        
        // Truncate text for display
        const textPreview = item.text.length > 50 
            ? item.text.slice(0, 50) + "..." 
            : item.text;
        
        // Create annotation object
        const tempAnnotation = {
            id: tempId,
            key: tempId,
            libraryID: (reader as any)._item.libraryID,
            type: "highlight",
            color: color,
            sortIndex: `${paragraphResult.pageIndex.toString().padStart(5, "0")}|${String(Math.round(rect[1])).padStart(6, "0")}|${String(Math.round(rect[0])).padStart(5, "0")}`,
            position: {
                pageIndex: paragraphResult.pageIndex,
                rects: [rect],
            },
            tags: [],
            comment: `${typeLabel} ${item.idx + 1} (Col ${item.columnIndex + 1}): ${textPreview}`,
            text: textPreview,
            authorName: "Beaver Visualizer",
            pageLabel: (paragraphResult.pageIndex + 1).toString(),
            isExternal: false,
            readOnly: false,
            lastModifiedByUser: "",
            dateModified: new Date().toISOString(),
            annotationType: "highlight",
            annotationAuthorName: "Beaver Visualizer",
            annotationText: textPreview,
            annotationComment: `${typeLabel} ${item.idx + 1}`,
            annotationColor: color,
            annotationPageLabel: (paragraphResult.pageIndex + 1).toString(),
            annotationSortIndex: `${paragraphResult.pageIndex.toString().padStart(5, "0")}|${String(Math.round(rect[1])).padStart(6, "0")}|${String(Math.round(rect[0])).padStart(5, "0")}`,
            annotationPosition: JSON.stringify({
                pageIndex: paragraphResult.pageIndex,
                rects: [rect],
            }),
            annotationIsExternal: false,
            isTemporary: true,
        };
        
        tempAnnotations.push(tempAnnotation);
        annotationReferences.push({
            zotero_key: tempId,
            library_id: (reader as any)._item.libraryID,
        });
    }
    
    // Add annotations to reader
    if (tempAnnotations.length > 0) {
        (reader as any)._internalReader.setAnnotations(
            Components.utils.cloneInto(tempAnnotations, (reader as any)._iframeWindow)
        );
    }
    
    return annotationReferences;
}

/**
 * Visualize paragraph detection results for the current page in the reader
 * 
 * Creates temporary highlight annotations showing detected paragraphs (green)
 * and headers (purple).
 * 
 * @returns Object with success status and details
 */
export async function visualizeCurrentPageParagraphs(): Promise<{
    success: boolean;
    message: string;
    paragraphs?: number;
    headers?: number;
    pageIndex?: number;
}> {
    // Import MarginFilter and StyleAnalyzer here to avoid circular dependencies
    const { MarginFilter, DEFAULT_MARGINS, StyleAnalyzer } = await import("../../src/services/pdf");
    
    try {
        // 1. Get the current reader
        const reader = await getCurrentReaderAndWaitForView(undefined, true);
        if (!reader || !reader._internalReader) {
            return {
                success: false,
                message: "No active PDF reader found",
            };
        }
        
        if (reader.type !== "pdf") {
            return {
                success: false,
                message: "Current reader is not a PDF",
            };
        }
        
        // Get current page (0-based)
        const pdfViewer = reader._internalReader._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
        if (!pdfViewer) {
            return {
                success: false,
                message: "Could not access PDF viewer",
            };
        }
        const currentPageIndex = pdfViewer.currentPageNumber - 1;
        
        // 2. Get the PDF item and file path
        const item = Zotero.Items.get(reader.itemID);
        if (!item) {
            return {
                success: false,
                message: "Could not find Zotero item",
            };
        }
        
        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            return {
                success: false,
                message: "Could not find PDF file",
            };
        }
        
        // 3. Clean up any existing temporary annotations
        await BeaverTemporaryAnnotations.cleanupAll(reader as ZoteroReader);
        
        // 4. Load PDF and extract raw page data
        logger(`[Visualizer] Loading PDF for paragraph detection on page ${currentPageIndex + 1}...`);
        const pdfData = await IOUtils.read(filePath);
        
        const mupdf = new MuPDFService();
        await mupdf.open(pdfData);
        
        let rawPage: RawPageData;
        try {
            rawPage = mupdf.extractRawPage(currentPageIndex);
        } finally {
            mupdf.close();
        }
        
        // 5. Apply margin filtering
        const filteredPage = MarginFilter.filterPageByMargins(rawPage, DEFAULT_MARGINS);
        
        // 6. Run column detection
        logger(`[Visualizer] Detecting columns...`);
        const columnResult = detectColumns(filteredPage);
        
        if (columnResult.columns.length === 0) {
            return {
                success: true,
                message: `No columns detected on page ${currentPageIndex + 1}`,
                paragraphs: 0,
                headers: 0,
                pageIndex: currentPageIndex,
            };
        }
        
        // 7. Run line detection
        logger(`[Visualizer] Detecting lines...`);
        const lineResult = detectLinesOnPage(filteredPage, columnResult.columns);
        
        if (lineResult.allLines.length === 0) {
            return {
                success: true,
                message: `No lines detected on page ${currentPageIndex + 1}`,
                paragraphs: 0,
                headers: 0,
                pageIndex: currentPageIndex,
            };
        }
        
        // 8. Quick style analysis on this page for body styles
        // Note: For single page, we just use the page's dominant styles
        const styleAnalyzer = new StyleAnalyzer();
        const styleProfile = styleAnalyzer.analyze([filteredPage], 4, 0.15, 0);
        const bodyStyles = styleProfile?.bodyStyles || null;
        
        // 9. Run paragraph detection
        logger(`[Visualizer] Detecting paragraphs...`);
        const paragraphResult = detectParagraphs(lineResult, bodyStyles);
        
        // Log results
        logParagraphDetection(paragraphResult);
        
        if (paragraphResult.items.length === 0) {
            return {
                success: true,
                message: `No paragraphs detected on page ${currentPageIndex + 1}`,
                paragraphs: 0,
                headers: 0,
                pageIndex: currentPageIndex,
            };
        }
        
        // 10. Get viewport info for coordinate conversion
        const { viewBox } = await getPageViewportInfo(reader as ZoteroReader, currentPageIndex);
        const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];
        
        // Use the page height from MuPDF for coordinate conversion
        const pageHeight = rawPage.height;
        
        // 11. Create annotations
        logger(`[Visualizer] Creating ${paragraphResult.items.length} paragraph/header annotations...`);
        
        const annotationRefs = await createParagraphAnnotations(
            paragraphResult,
            pageHeight,
            reader as ZoteroReader,
            viewBoxLL
        );
        
        // Track annotations for cleanup
        BeaverTemporaryAnnotations.addToTracking(annotationRefs);
        
        const message = `Page ${currentPageIndex + 1}: ${paragraphResult.paragraphCount} paragraphs, ${paragraphResult.headerCount} headers`;
        
        logger(`[Visualizer] ${message}`);
        
        return {
            success: true,
            message,
            paragraphs: paragraphResult.paragraphCount,
            headers: paragraphResult.headerCount,
            pageIndex: currentPageIndex,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[Visualizer] Error: ${errorMessage}`);
        return {
            success: false,
            message: `Paragraph visualization failed: ${errorMessage}`,
        };
    }
}

/**
 * Clear all visualization annotations
 */
export async function clearVisualizationAnnotations(): Promise<void> {
    try {
        const reader = await getCurrentReaderAndWaitForView(undefined, false);
        if (reader) {
            await BeaverTemporaryAnnotations.cleanupAll(reader as ZoteroReader);
        }
    } catch (error) {
        logger(`[Visualizer] Error clearing annotations: ${error}`);
    }
}

/**
 * Result from extracting a single page's content
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
 * Extract content from the current page in reading order using column detection
 * 
 * @returns Object with extracted content and metadata
 */
export async function extractCurrentPageContent(): Promise<PageExtractionResult> {
    // Import PageExtractor here to avoid circular dependencies
    const { PageExtractor } = await import("../../src/services/pdf/PageExtractor");
    const { MarginFilter, DEFAULT_MARGINS, DEFAULT_MARGIN_ZONE } = await import("../../src/services/pdf");

    try {
        // 1. Get the current reader
        const reader = await getCurrentReaderAndWaitForView(undefined, true);
        if (!reader || !reader._internalReader) {
            return {
                success: false,
                message: "No active PDF reader found",
            };
        }
        
        if (reader.type !== "pdf") {
            return {
                success: false,
                message: "Current reader is not a PDF",
            };
        }
        
        // Get current page (0-based)
        const pdfViewer = reader._internalReader._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
        if (!pdfViewer) {
            return {
                success: false,
                message: "Could not access PDF viewer",
            };
        }
        const currentPageIndex = pdfViewer.currentPageNumber - 1;
        
        // 2. Get the PDF item and file path
        const item = Zotero.Items.get(reader.itemID);
        if (!item) {
            return {
                success: false,
                message: "Could not find Zotero item",
            };
        }
        
        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            return {
                success: false,
                message: "Could not find PDF file",
            };
        }
        
        // 3. Load PDF and extract raw page data
        logger(`[Extractor] Loading PDF and extracting page ${currentPageIndex + 1}...`);
        const pdfData = await IOUtils.read(filePath);
        
        const mupdf = new MuPDFService();
        await mupdf.open(pdfData);
        
        let rawPage: RawPageData;
        try {
            rawPage = mupdf.extractRawPage(currentPageIndex);
        } finally {
            mupdf.close();
        }
        
        // 4. Apply margin filtering (both simple and smart removal for this page)
        // Note: For single page, we can't do smart removal (needs document-level analysis)
        // So we just apply simple margin filtering
        const filteredPage = MarginFilter.filterPageByMargins(rawPage, DEFAULT_MARGINS);
        
        // 5. Run column detection
        logger(`[Extractor] Detecting columns on page ${currentPageIndex + 1}...`);
        const columnResult = detectColumns(filteredPage);
        
        logger(`[Extractor] Found ${columnResult.columns.length} column(s)`);
        for (let i = 0; i < columnResult.columns.length; i++) {
            const col = columnResult.columns[i];
            logger(`  Column ${i + 1}: x=${col.x.toFixed(0)}, y=${col.y.toFixed(0)}, w=${col.w.toFixed(0)}, h=${col.h.toFixed(0)}`);
        }
        
        // 6. Extract content using column-aware extraction
        const pageExtractor = new PageExtractor({});
        const processedPage = pageExtractor.extractPageWithColumns(
            filteredPage,
            columnResult,
            true // include column bboxes
        );
        
        logger(`[Extractor] Page ${currentPageIndex + 1} content extracted (${processedPage.content.length} chars)`);
        
        return {
            success: true,
            message: `Extracted ${processedPage.content.length} characters from page ${currentPageIndex + 1}`,
            pageIndex: currentPageIndex,
            pageNumber: currentPageIndex + 1,
            content: processedPage.content,
            columnCount: columnResult.columns.length,
            columns: processedPage.columns,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger(`[Extractor] Error: ${errorMessage}`);
        return {
            success: false,
            message: `Extraction failed: ${errorMessage}`,
        };
    }
}

