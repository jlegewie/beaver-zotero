import React from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import PdfIcon from '../../icons/PdfIcon';
import SearchIcon from '../../icons/SearchIcon';
import MoreHorizontalIcon from '../../icons/MoreHorizontalIcon';
import { 
    extractByLinesFromZoteroItem,
    ExtractionError, 
    ExtractionErrorCode,
    PDFExtractor,
    searchFromZoteroItem,
} from '../../../../src/services/pdf';
import { 
    visualizeCurrentPageColumns, 
    visualizeCurrentPageLines,
    visualizeCurrentPageParagraphs,
    clearVisualizationAnnotations,
    extractCurrentPageContent
} from '../../../utils/extractionVisualizer';
import { getCurrentReaderAndWaitForView } from '../../../utils/readerUtils';
import { semanticSearchService } from '../../../../src/services/semanticSearchService';
import { BeaverDB } from '../../../../src/services/database';

interface DevToolsMenuButtonProps {
    className?: string;
    ariaLabel?: string;
    currentMessageContent?: string;
}

/**
 * TEMPORARY: Button component for dev testing functions - REMOVE BEFORE RELEASE
 * Shows PDF extraction testing and semantic search options in a dropdown menu
 */
const DevToolsMenuButton: React.FC<DevToolsMenuButtonProps> = ({ 
    className = '',
    ariaLabel = 'Dev Tools Menu',
    currentMessageContent = '',
}) => {
    // Test semantic search
    const handleTestSemanticSearch = async () => {
        try {
            const query = currentMessageContent;
            if (!query || query.trim().length === 0) {
                console.log('[Semantic Search Test] No query text provided');
                return;
            }

            console.log('[Semantic Search Test] Testing with query:', query);
            
            // Get database instance from global addon
            const db = Zotero.Beaver?.db as BeaverDB | null;
            if (!db) {
                console.error('[Semantic Search Test] Database not available');
                return;
            }

            // Create search service instance
            const searchService = new semanticSearchService(db, 512);
            
            // Run search
            const results = await searchService.search(query, {
                topK: 20,
                minSimilarity: 0.3
            });

            console.log('[Semantic Search Test] Results:', results);
            console.log(`[Semantic Search Test] Found ${results.length} results`);
            
            // Log top results with item details
            const topResults = results.slice(0, 20);
            const itemIds = topResults.map(r => r.itemId);
            const items = await Zotero.Items.getAsync(itemIds);
            const validItems = items.filter((item): item is Zotero.Item => item !== null);
            
            // Load itemData for title access
            if (validItems.length > 0) {
                await Zotero.Items.loadDataTypes(validItems, ["itemData"]);
            }
            
            // Create a map for quick lookup
            const itemMap = new Map(validItems.map(item => [item.id, item]));
            
            console.group('[Semantic Search Test] Top Results');
            for (let i = 0; i < topResults.length; i++) {
                const result = topResults[i];
                const item = itemMap.get(result.itemId);
                console.log(`${i + 1}. [${result.similarity.toFixed(3)}] ${item?.getField('title') || 'Unknown'}`);
            }
            console.groupEnd();
        } catch (error) {
            console.error('[Semantic Search Test] Failed:', error);
        }
    };

    // Test PDF extraction on selected item
    const handleTestPdfExtraction = async () => {
        const selectedItems: Zotero.Item[] = Zotero.getActiveZoteroPane().getSelectedItems() || [];
        
        if (selectedItems.length === 0) {
            console.log("[PDF Test] No item selected");
            return;
        }

        let pdfItem = selectedItems[0];

        // If it's a parent item, try to get the first PDF attachment
        if (!pdfItem.isPDFAttachment()) {
            const attachmentIDs = pdfItem.getAttachments();
            const pdfAttachment = attachmentIDs
                .map(id => Zotero.Items.get(id))
                .find(item => item.isPDFAttachment());
            
            if (!pdfAttachment) {
                console.log("[PDF Test] Selected item is not a PDF and has no PDF attachments");
                return;
            }
            pdfItem = pdfAttachment;
        }

        console.log("[PDF Test] Starting line-based extraction for:", pdfItem.getField("title") || pdfItem.getDisplayTitle());

        try {
            const result = await extractByLinesFromZoteroItem(pdfItem);
            
            if (!result) {
                console.log("[PDF Test] File not found");
                return;
            }

            console.log("[PDF Test] ✓ Extraction complete!");
            console.log(`[PDF Test] Document: ${result.analysis.pageCount} pages, ${result.fullText.length} chars total`);
            
            // Log structured results for all pages
            console.group("[PDF Test] Pages");
            for (const page of result.pages) {
                const lineCount = page.lines?.length || 0;
                const columnCount = page.columns?.length || 0;
                
                console.group(`Page ${page.index + 1}${page.label ? ` (${page.label})` : ''}`);
                console.log(`  Dimensions: ${page.width.toFixed(0)} × ${page.height.toFixed(0)} pt`);
                console.log(`  Columns: ${columnCount}`);
                console.log(`  Lines: ${lineCount}`);
                console.log(`  Text length: ${page.content.length} chars`);
                
                if (page.lines && page.lines.length > 0) {
                    console.group("Lines");
                    for (let i = 0; i < Math.min(page.lines.length, 10); i++) {
                        const line = page.lines[i];
                        const preview = line.text.length > 80 
                            ? line.text.slice(0, 80) + "..." 
                            : line.text;
                        console.log(`    [${i + 1}] Col ${line.columnIndex + 1}: "${preview}"`);
                    }
                    if (page.lines.length > 10) {
                        console.log(`    ... ${page.lines.length - 10} more lines`);
                    }
                    console.groupEnd();
                }
                
                console.groupEnd();
            }
            console.groupEnd();
            
            // Log full result object for inspection
            console.log("[PDF Test] Full result object:", result);
        } catch (error) {
            // Handle specific extraction errors
            if (error instanceof ExtractionError) {
                switch (error.code) {
                    case ExtractionErrorCode.ENCRYPTED:
                        console.warn("[PDF Test] Document is encrypted:", error.message);
                        break;
                    case ExtractionErrorCode.NO_TEXT_LAYER:
                        console.warn("[PDF Test] Document has no text layer (needs OCR):", error.message);
                        // Log detailed OCR analysis if available
                        if (error.details) {
                            console.log("[PDF Test] OCR Analysis Details:", error.details);
                        }
                        break;
                    case ExtractionErrorCode.INVALID_PDF:
                        console.error("[PDF Test] Invalid PDF:", error.message);
                        break;
                    default:
                        console.error("[PDF Test] Extraction error:", error.code, error.message);
                }
            } else {
                console.error("[PDF Test] Extraction failed:", error);
            }
        }
    };

    // Visualize PDF extraction columns on current page
    const handleVisualizeColumns = async () => {
        console.log("[PDF Visualizer] Visualizing columns on current page...");
        const result = await visualizeCurrentPageColumns();
        if (result.success) {
            console.log(`[PDF Visualizer] ${result.message}`);
        } else {
            console.warn(`[PDF Visualizer] ${result.message}`);
        }
    };

    // Visualize detected lines on current page
    const handleVisualizeLines = async () => {
        console.log("[PDF Visualizer] Visualizing lines on current page...");
        const result = await visualizeCurrentPageLines();
        if (result.success) {
            console.log(`[PDF Visualizer] ${result.message}`);
        } else {
            console.warn(`[PDF Visualizer] ${result.message}`);
        }
    };

    // Visualize detected paragraphs on current page
    const handleVisualizeParagraphs = async () => {
        console.log("[PDF Visualizer] Visualizing paragraphs on current page...");
        const result = await visualizeCurrentPageParagraphs();
        if (result.success) {
            console.log(`[PDF Visualizer] ${result.message}`);
        } else {
            console.warn(`[PDF Visualizer] ${result.message}`);
        }
    };

    // Clear visualization annotations
    const handleClearVisualization = async () => {
        console.log("[PDF Visualizer] Clearing visualization annotations...");
        await clearVisualizationAnnotations();
        console.log("[PDF Visualizer] Annotations cleared");
    };

    // Reset embedding index (clear all embedding tables)
    const handleResetEmbeddingIndex = async () => {
        console.log("[Embedding Reset] Starting embedding index reset...");
        
        try {
            // Get database instance
            const db = Zotero.Beaver?.db as BeaverDB | null;
            if (!db) {
                console.error("[Embedding Reset] Database not available");
                return;
            }

            // Get library IDs from all three tables (there might be orphaned records)
            const embeddingLibraryIds = await db.getEmbeddedLibraryIds();
            
            // Get total counts before deletion
            const totalEmbeddings = await db.getEmbeddingCount();
            const totalFailed = await db.getFailedEmbeddingCount();
            
            console.log(`[Embedding Reset] Found ${embeddingLibraryIds.length} libraries with embeddings`);
            console.log(`[Embedding Reset] Total records: ${totalEmbeddings} embeddings, ${totalFailed} failed records`);

            // Clear all records from each table (per library to track progress)
            for (const libraryId of embeddingLibraryIds) {
                const embeddingCount = await db.getEmbeddingCount(libraryId);
                const failedCount = await db.getFailedEmbeddingCount(libraryId);

                await db.deleteEmbeddingsByLibrary(libraryId);
                await db.deleteFailedEmbeddingsByLibrary(libraryId);
                await db.deleteEmbeddingIndexState(libraryId);

                console.log(`[Embedding Reset] Cleared library ${libraryId}: ${embeddingCount} embeddings, ${failedCount} failed records`);
            }

            // Clean up any orphaned records in failed_embeddings and embedding_index_state
            // by using raw SQL to delete all remaining records
            const remainingFailed = await db.getFailedEmbeddingCount();
            if (remainingFailed > 0) {
                console.log(`[Embedding Reset] Cleaning up ${remainingFailed} orphaned failed_embeddings records...`);
                await (db as any).conn.queryAsync('DELETE FROM failed_embeddings');
            }
            
            await (db as any).conn.queryAsync('DELETE FROM embedding_index_state');

            console.log("[Embedding Reset] ✓ Reset complete!");
            console.log(`[Embedding Reset] Total cleared: ${totalEmbeddings} embeddings, ${totalFailed} failed records`);
            console.log("[Embedding Reset] Plugin is now in fresh user state - restart required for re-indexing");
            
        } catch (error) {
            console.error("[Embedding Reset] Reset failed:", error);
        }
    };

    // Extract current page content with line detection
    const handleExtractCurrentPage = async () => {
        console.log("[PDF Extractor] Extracting current page content...");
        
        try {
            // Get the current reader and page
            const reader = await getCurrentReaderAndWaitForView(undefined, true);
            if (!reader || !reader._internalReader) {
                console.warn("[PDF Extractor] No active PDF reader found");
                return;
            }
            
            if (reader.type !== "pdf") {
                console.warn("[PDF Extractor] Current reader is not a PDF");
                return;
            }
            
            // Get current page (0-based)
            const pdfViewer = reader._internalReader._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer;
            if (!pdfViewer) {
                console.warn("[PDF Extractor] Could not access PDF viewer");
                return;
            }
            const currentPageIndex = pdfViewer.currentPageNumber - 1;
            
            // Get the PDF item
            const item = Zotero.Items.get(reader.itemID);
            if (!item) {
                console.warn("[PDF Extractor] Could not find Zotero item");
                return;
            }
            
            // Extract with line detection for current page only (skip OCR check for testing)
            const result = await extractByLinesFromZoteroItem(item, {
                pages: [currentPageIndex],
                checkTextLayer: false,
            });
            
            if (!result || result.pages.length === 0) {
                console.warn("[PDF Extractor] Extraction failed");
                return;
            }
            
            const page = result.pages[0];
            const lineCount = page.lines?.length || 0;
            const columnCount = page.columns?.length || 0;
            
            console.log(`[PDF Extractor] ✓ Page ${page.index + 1}${page.label ? ` (${page.label})` : ''} extracted`);
            console.group(`Page ${page.index + 1} Details`);
            console.log(`  Dimensions: ${page.width.toFixed(0)} × ${page.height.toFixed(0)} pt`);
            console.log(`  Columns: ${columnCount}`);
            console.log(`  Lines: ${lineCount}`);
            console.log(`  Text length: ${page.content.length} chars`);
            
            if (page.columns && page.columns.length > 0) {
                console.group("Columns");
                page.columns.forEach((col, i) => {
                    const width = col.r - col.l;
                    const height = col.b - col.t;
                    console.log(`  [${i + 1}] Position: (${col.l.toFixed(0)}, ${col.t.toFixed(0)}), Size: ${width.toFixed(0)} × ${height.toFixed(0)} pt`);
                });
                console.groupEnd();
            }
            
            if (page.lines && page.lines.length > 0) {
                console.group("Lines");
                page.lines.forEach((line, i) => {
                    const preview = line.text.length > 100 
                        ? line.text.slice(0, 100) + "..." 
                        : line.text;
                    const fontSize = line.fontSize ? `${line.fontSize.toFixed(1)}pt` : "?";
                    console.log(`  [${i + 1}] Col ${line.columnIndex + 1}, ${fontSize}: "${preview}"`);
                });
                console.groupEnd();
            }
            
            console.groupEnd();
            
            // Log full page object
            console.log("[PDF Extractor] Page object:", page);
        } catch (error) {
            console.error("[PDF Extractor] Extraction failed:", error);
        }
    };

    // Test OCR detection on selected item
    const handleTestOCRDetection = async () => {
        const selectedItems: Zotero.Item[] = Zotero.getActiveZoteroPane().getSelectedItems() || [];
        
        if (selectedItems.length === 0) {
            console.log("[OCR Detection Test] No item selected");
            return;
        }

        let pdfItem = selectedItems[0];

        // If it's a parent item, try to get the first PDF attachment
        if (!pdfItem.isPDFAttachment()) {
            const attachmentIDs = pdfItem.getAttachments();
            const pdfAttachment = attachmentIDs
                .map(id => Zotero.Items.get(id))
                .find(item => item.isPDFAttachment());
            
            if (!pdfAttachment) {
                console.log("[OCR Detection Test] Selected item is not a PDF and has no PDF attachments");
                return;
            }
            pdfItem = pdfAttachment;
        }

        const title = pdfItem.getField("title") || pdfItem.getDisplayTitle();
        console.log(`[OCR Detection Test] Analyzing: ${title}`);

        try {
            // Get PDF file path and read data
            const path = await pdfItem.getFilePathAsync();
            if (!path) {
                console.log("[OCR Detection Test] File not found");
                return;
            }

            const pdfData = await IOUtils.read(path);
            const extractor = new PDFExtractor();
            
            console.time("[OCR Detection Test] Analysis time");
            const result = await extractor.analyzeOCRNeeds(pdfData);
            console.timeEnd("[OCR Detection Test] Analysis time");

            // Log summary
            console.log("\n" + "=".repeat(60));
            console.log("[OCR Detection Test] RESULT:", result.needsOCR ? "❌ NEEDS OCR" : "✅ TEXT LAYER OK");
            console.log("=".repeat(60));
            
            console.group("[OCR Detection Test] Summary");
            console.log(`Primary Reason: ${result.primaryReason}`);
            console.log(`Issue Ratio: ${(result.issueRatio * 100).toFixed(1)}% of sampled pages have issues`);
            console.log(`Pages Sampled: ${result.sampledPages} of ${result.totalPages} total`);
            console.groupEnd();

            // Log issue breakdown
            const issuesWithCounts = Object.entries(result.issueBreakdown)
                .filter(([, count]) => count > 0)
                .sort((a, b) => b[1] - a[1]);
            
            if (issuesWithCounts.length > 0) {
                console.group("[OCR Detection Test] Issue Breakdown");
                for (const [issue, count] of issuesWithCounts) {
                    console.log(`  ${issue}: ${count} pages`);
                }
                console.groupEnd();
            } else {
                console.log("[OCR Detection Test] No issues detected");
            }

            // Log per-page analysis
            console.group("[OCR Detection Test] Per-Page Analysis");
            for (const pageAnalysis of result.pageAnalyses) {
                const status = pageAnalysis.hasIssues ? "⚠️" : "✓";
                const issueList = pageAnalysis.issues.length > 0 
                    ? ` [${pageAnalysis.issues.join(", ")}]` 
                    : "";
                console.log(
                    `  Page ${pageAnalysis.pageIndex + 1}: ${status} ` +
                    `text=${pageAnalysis.textLength} chars, ` +
                    `images=${pageAnalysis.hasImages ? "yes" : "no"}` +
                    issueList
                );
            }
            console.groupEnd();

            // Log full result object
            console.log("[OCR Detection Test] Full result object:", result);
            
        } catch (error) {
            console.error("[OCR Detection Test] Analysis failed:", error);
        }
    };

    // Test PDF text search on selected item
    const handleTestPdfSearch = async () => {
        const query = currentMessageContent?.trim();
        if (!query || query.length === 0) {
            console.log("[PDF Search Test] No search query provided. Enter text in the message input.");
            return;
        }

        const selectedItems: Zotero.Item[] = Zotero.getActiveZoteroPane().getSelectedItems() || [];
        
        if (selectedItems.length === 0) {
            console.log("[PDF Search Test] No item selected");
            return;
        }

        let pdfItem = selectedItems[0];

        // If it's a parent item, try to get the first PDF attachment
        if (!pdfItem.isPDFAttachment()) {
            const attachmentIDs = pdfItem.getAttachments();
            const pdfAttachment = attachmentIDs
                .map(id => Zotero.Items.get(id))
                .find(item => item.isPDFAttachment());
            
            if (!pdfAttachment) {
                console.log("[PDF Search Test] Selected item is not a PDF and has no PDF attachments");
                return;
            }
            pdfItem = pdfAttachment;
        }

        const title = pdfItem.getField("title") || pdfItem.getDisplayTitle();
        console.log(`[PDF Search Test] Searching in: ${title}`);
        console.log(`[PDF Search Test] Query: "${query}"`);

        try {
            const result = await searchFromZoteroItem(pdfItem, query);
            
            if (!result) {
                console.log("[PDF Search Test] File not found");
                return;
            }

            // Log summary
            console.log("\n" + "=".repeat(60));
            console.log(`[PDF Search Test] RESULTS: "${query}"`);
            console.log("=".repeat(60));
            
            console.group("[PDF Search Test] Summary");
            console.log(`Total matches: ${result.totalMatches}`);
            console.log(`Pages with matches: ${result.pagesWithMatches} of ${result.totalPages}`);
            console.log(`Search duration: ${result.metadata.durationMs}ms`);
            console.groupEnd();

            if (result.pages.length === 0) {
                console.log("[PDF Search Test] No matches found");
                return;
            }

            // Log page results (ranked by score)
            console.group("[PDF Search Test] Page Results (ranked by relevance score)");
            for (const page of result.pages) {
                const labelStr = page.label ? ` (${page.label})` : '';
                console.group(`Page ${page.pageIndex + 1}${labelStr}: score=${page.score.toFixed(2)}, ${page.matchCount} match${page.matchCount !== 1 ? 'es' : ''}`);
                console.log(`  Raw score: ${page.rawScore.toFixed(2)}`);
                console.log(`  Text length: ${page.textLength} chars`);
                console.log(`  Dimensions: ${page.width.toFixed(0)} × ${page.height.toFixed(0)} pt`);
                
                // Count hits by role
                const roleCount: Record<string, number> = {};
                for (const hit of page.hits) {
                    roleCount[hit.role] = (roleCount[hit.role] || 0) + 1;
                }
                console.log(`  Hits by role: ${Object.entries(roleCount).map(([r, c]) => `${r}=${c}`).join(', ')}`);
                
                // Show first few hits with role and weight
                const hitsToShow = Math.min(page.hits.length, 5);
                for (let i = 0; i < hitsToShow; i++) {
                    const hit = page.hits[i];
                    const bbox = hit.bbox;
                    const text = hit.matchedText ? ` "${hit.matchedText.slice(0, 50)}${hit.matchedText.length > 50 ? '...' : ''}"` : '';
                    console.log(`  Hit ${i + 1}: [${hit.role}] weight=${hit.weight}${text}`);
                }
                if (page.hits.length > hitsToShow) {
                    console.log(`  ... ${page.hits.length - hitsToShow} more hits`);
                }
                console.groupEnd();
            }
            console.groupEnd();

            // Log full result object
            console.log("[PDF Search Test] Full result object:", result);
            
        } catch (error) {
            console.error("[PDF Search Test] Search failed:", error);
        }
    };

    // Create menu items for dev testing functions
    const menuItems: MenuItem[] = [
        {
            label: "Test Semantic Search",
            onClick: handleTestSemanticSearch,
            icon: SearchIcon,
            disabled: false,
        },
        {
            label: "Test PDF Search",
            onClick: handleTestPdfSearch,
            icon: SearchIcon,
            disabled: false,
        },
        {
            label: "Test OCR Detection",
            onClick: handleTestOCRDetection,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Test PDF Extraction",
            onClick: handleTestPdfExtraction,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Extract Current Page",
            onClick: handleExtractCurrentPage,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Visualize Columns",
            onClick: handleVisualizeColumns,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Visualize Lines",
            onClick: handleVisualizeLines,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Visualize Paragraphs",
            onClick: handleVisualizeParagraphs,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Clear Visualization",
            onClick: handleClearVisualization,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Reset Embedding Index",
            onClick: handleResetEmbeddingIndex,
            icon: SearchIcon,
            disabled: false,
        }
    ];

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost"
            icon={MoreHorizontalIcon}
            className={className}
            ariaLabel={ariaLabel}
            tooltipContent="Development Tools"
            showArrow={true}
        />
    );
};

export default DevToolsMenuButton;

