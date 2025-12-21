/**
 * Extraction Visualizer
 *
 * Creates temporary annotations to visualize PDF extraction results.
 * Useful for debugging and analyzing column detection, margin filtering, etc.
 */

import { logger } from "../../src/utils/logger";
import { MuPDFService, detectColumns, Rect, RawPageData } from "../../src/services/pdf";
import { getCurrentReaderAndWaitForView } from "./readerUtils";
import { getPageViewportInfo } from "./pdfUtils";
import { BeaverTemporaryAnnotations, ZoteroReader } from "./annotationUtils";
import { ZoteroItemReference } from "../types/zotero";

// Colors for visualization
const COLUMN_COLOR = "#00bbff"; // Blue for columns

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

