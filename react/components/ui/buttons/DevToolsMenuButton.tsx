import React from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import PdfIcon from '../../icons/PdfIcon';
import SearchIcon from '../../icons/SearchIcon';
import ToolsIcon from '../../icons/ToolsIcon';
import {
    ExtractionError,
    ExtractionErrorCode,
    BeaverExtractor,
} from '../../../../src/beaver-extract';
import {
    visualizeCurrentPageColumns,
    visualizeCurrentPageItems,
    visualizeCurrentPageLines,
    visualizeCurrentPageSentences,
    clearVisualizationAnnotations,
    extractCurrentPageContent
} from '../../../utils/extractionVisualizer';
import { getCurrentReaderAndWaitForView } from '../../../utils/readerUtils';
import { semanticSearchService } from '../../../../src/services/semanticSearchService';
import { BeaverDB } from '../../../../src/services/database';
import { threadService } from '../../../../src/services/threadService';
import { useAtomValue, useSetAtom } from 'jotai';
import { zoteroContextAtom } from '../../../atoms/zoteroContext';
import { firstRunReturnRequestedAtom } from '../../../atoms/firstRun';
import { whereToStartVisibleAtom } from '../../../atoms/whereToStart';
import { logger } from '../../../../src/utils/logger';

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
    const zoteroContext = useAtomValue(zoteroContextAtom);
    const setFirstRunReturnRequested = useSetAtom(firstRunReturnRequestedAtom);
    const setWhereToStartVisible = useSetAtom(whereToStartVisibleAtom);

    // Log Zotero context state
    const handleLogZoteroContext = () => {
        const ctx = zoteroContext;
        const data = {
            type: ctx.type,
            isLibraryTab: ctx.isLibraryTab,
            selectedItemCount: ctx.selectedItemCount,
            selectedItems: ctx.selectedItems.map(i => ({
                key: i.key,
                title: i.getDisplayTitle(),
                type: i.itemType,
            })),
            libraryView: ctx.libraryView,
            selectedTags: ctx.selectedTags,
            readerAttachment: ctx.readerAttachment ? {
                key: ctx.readerAttachment.key,
                title: ctx.readerAttachment.getDisplayTitle(),
                libraryID: ctx.readerAttachment.libraryID,
            } : null,
            noteItem: ctx.noteItem ? {
                key: ctx.noteItem.key,
                title: ctx.noteItem.getDisplayTitle(),
                libraryID: ctx.noteItem.libraryID,
                parentKey: ctx.noteItem.parentItem?.key ?? null,
                parentTitle: ctx.noteItem.parentItem?.getDisplayTitle() ?? null,
            } : null,
            recentlyAddedTodayCount: ctx.recentlyAddedTodayCount,
        };
        logger('[Zotero Context]', data);
    };

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
            const path = await pdfItem.getFilePathAsync();
            if (!path) {
                console.log("[PDF Test] File not found");
                return;
            }
            const pdfData = await IOUtils.read(path);
            const result = await new BeaverExtractor().extract(pdfData, {
                mode: "structured",
            });

            console.log("[PDF Test] ✓ Extraction complete!");
            if (result.mode !== "structured") {
                console.log("[PDF Test] Expected structured extraction result");
                return;
            }
            const totalTextLength = result.document.pages.reduce(
                (sum, page) =>
                    sum + page.items.reduce(
                        (itemSum, item) => itemSum + ("text" in item ? item.text.length : 0),
                        0,
                    ),
                0,
            );
            console.log(`[PDF Test] Document: ${result.document.pageCount} pages, ${totalTextLength} chars total`);
            
            // Log structured results for all pages
            console.group("[PDF Test] Pages");
            for (const page of result.document.pages) {
                const sentences = page.items.flatMap((item) => ("sentences" in item ? item.sentences ?? [] : []));
                const textLength = page.items.reduce(
                    (sum, item) => sum + ("text" in item ? item.text.length : 0),
                    0,
                );
                
                console.group(`Page ${page.index + 1}${page.label ? ` (${page.label})` : ''}`);
                console.log(`  Dimensions: ${page.width.toFixed(0)} × ${page.height.toFixed(0)} pt`);
                console.log(`  Items: ${page.items.length}`);
                console.log(`  Sentences: ${sentences.length}`);
                console.log(`  Text length: ${textLength} chars`);
                
                if (sentences.length > 0) {
                    console.group("Sentences");
                    for (let i = 0; i < Math.min(sentences.length, 10); i++) {
                        const sentence = sentences[i];
                        console.log(`  [${i + 1}] "${sentence.text}"`);
                    }
                    if (sentences.length > 10) {
                        console.log(`    ... ${sentences.length - 10} more sentences`);
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

    // Visualize detected document items on current page
    const handleVisualizeItems = async () => {
        console.log("[PDF Visualizer] Visualizing items on current page...");
        const result = await visualizeCurrentPageItems();
        if (result.success) {
            console.log(`[PDF Visualizer] ${result.message}`);
        } else {
            console.warn(`[PDF Visualizer] ${result.message}`);
        }
    };

    // Visualize detected sentences on current page
    const handleVisualizeSentences = async () => {
        console.log("[PDF Visualizer] Visualizing sentences on current page...");
        const result = await visualizeCurrentPageSentences();
        if (result.success) {
            console.log(`[PDF Visualizer] ${result.message}`);
            if (result.degradation) {
                console.warn(
                    `[PDF Visualizer] Degradation: ${result.degradation} items fell back to whole-item bboxes (shown in gray)`,
                );
            }
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

    // Find threads by Zotero item (attachments mode)
    const handleFindThreadsByAttachments = async () => {
        const selectedItems: Zotero.Item[] = Zotero.getActiveZoteroPane().getSelectedItems() || [];
        if (selectedItems.length === 0) {
            console.log('[Find Threads by Item] No item selected');
            return;
        }
        const keys = new Set<string>();
        const first = selectedItems[0];
        const libraryId = first.libraryID;
        for (const item of selectedItems) {
            keys.add(item.key);
            for (const attId of item.getAttachments()) {
                const att = Zotero.Items.get(attId);
                if (att) keys.add(att.key);
            }
        }
        console.log('[Find Threads by Item] attachments mode, libraryId:', libraryId, 'keys:', Array.from(keys));
        try {
            const results = await threadService.findThreadsByItem(libraryId, Array.from(keys), 'attachments');
            console.log('[Find Threads by Item] attachments results:', results);
        } catch (err) {
            console.error('[Find Threads by Item] attachments failed:', err);
        }
    };

    // Find threads by Zotero item (citations mode)
    const handleFindThreadsByCitations = async () => {
        const selectedItems: Zotero.Item[] = Zotero.getActiveZoteroPane().getSelectedItems() || [];
        if (selectedItems.length === 0) {
            console.log('[Find Threads by Item] No item selected');
            return;
        }
        const keys = new Set<string>();
        const first = selectedItems[0];
        const libraryId = first.libraryID;
        for (const item of selectedItems) {
            keys.add(item.key);
            for (const attId of item.getAttachments()) {
                const att = Zotero.Items.get(attId);
                if (att) keys.add(att.key);
            }
        }
        console.log('[Find Threads by Item] citations mode, libraryId:', libraryId, 'keys:', Array.from(keys));
        try {
            const results = await threadService.findThreadsByItem(libraryId, Array.from(keys), 'citations');
            console.log('[Find Threads by Item] citations results:', results);
        } catch (err) {
            console.error('[Find Threads by Item] citations failed:', err);
        }
    };

    // Clear the document cache (metadata + payload files on disk)
    const handleClearDocumentCache = async () => {
        console.log("[Document Cache Reset] Starting...");
        try {
            const documentCache = Zotero.Beaver?.documentCache;
            if (documentCache) {
                const { metadataRows, payloadRows } = await documentCache.clearAll();
                console.log(`[Document Cache Reset] Done: ${metadataRows} metadata rows, ${payloadRows} payload rows`);
            } else {
                console.warn("[Document Cache Reset] DocumentCache not available");
            }
        } catch (error) {
            console.error("[Document Cache Reset] Failed:", error);
        }
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
            
            // Extract structured (sentence-level) for current page only (skip OCR check for testing)
            const path = await item.getFilePathAsync();
            if (!path) {
                console.warn("[PDF Extractor] File not found");
                return;
            }
            const pdfData = await IOUtils.read(path);
            const result = await new BeaverExtractor().extract(pdfData, {
                mode: "structured",
                settings: { checkTextLayer: false },
            });

            if (result.mode !== "structured") {
                console.warn("[PDF Extractor] Extraction failed");
                return;
            }
            
            const page = result.document.pages.find((p) => p.index === currentPageIndex);
            if (!page) {
                console.warn("[PDF Extractor] Current page missing from structured result");
                return;
            }
            const sentences = page.items.flatMap((item) => ("sentences" in item ? item.sentences ?? [] : []));
            const textLength = page.items.reduce(
                (sum, item) => sum + ("text" in item ? item.text.length : 0),
                0,
            );
            
            console.log(`[PDF Extractor] ✓ Page ${page.index + 1}${page.label ? ` (${page.label})` : ''} extracted`);
            console.group(`Page ${page.index + 1} Details`);
            console.log(`  Dimensions: ${page.width.toFixed(0)} × ${page.height.toFixed(0)} pt`);
            console.log(`  Items: ${page.items.length}`);
            console.log(`  Sentences: ${sentences.length}`);
            console.log(`  Text length: ${textLength} chars`);
            
            if (sentences.length > 0) {
                console.group("Sentences");
                sentences.forEach((sentence, i) => {
                    const preview = sentence.text.length > 100
                        ? sentence.text.slice(0, 100) + "..."
                        : sentence.text;
                    console.log(`  [${i + 1}]: "${preview}"`);
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
            const extractor = new BeaverExtractor();
            
            console.time("[OCR Detection Test] Analysis time");
            const result = await extractor.analyzeOCRNeeds(pdfData);
            console.timeEnd("[OCR Detection Test] Analysis time");

            // Log summary
            console.log("\n" + "=".repeat(60));
            console.log("[OCR Detection Test] RESULT:", result.needsOCR ? "❌ NEEDS OCR" : "✅ TEXT LAYER OK");
            console.log("=".repeat(60));
            
            console.group("[OCR Detection Test] Summary");
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
            const path = await pdfItem.getFilePathAsync();
            if (!path) {
                console.log("[PDF Search Test] File not found");
                return;
            }
            const pdfData = await IOUtils.read(path);
            const result = await new BeaverExtractor().search(pdfData, query);

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

    // Show the first-run suggestions page via the routing atom
    const handleShowFirstRunPage = () => {
        setFirstRunReturnRequested(true);
    };

    // Show the "Where should we start?" action launcher
    const handleShowWhereToStartPage = () => {
        setWhereToStartVisible(true);
    };

    // Create menu items for dev testing functions
    const menuItems: MenuItem[] = [
        {
            label: "Log Zotero Context",
            onClick: handleLogZoteroContext,
            icon: SearchIcon,
            disabled: false,
        },
        {
            label: "Test Semantic Search",
            onClick: handleTestSemanticSearch,
            icon: SearchIcon,
            disabled: false,
        },
        {
            label: "Show First Run Page",
            onClick: handleShowFirstRunPage,
            icon: SearchIcon,
            disabled: false,
        },
        {
            label: "Show 'Where to start' Page",
            onClick: handleShowWhereToStartPage,
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
            label: "Visualize Items",
            onClick: handleVisualizeItems,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Visualize Sentences",
            onClick: handleVisualizeSentences,
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
            label: "Clear Document Cache",
            onClick: handleClearDocumentCache,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Reset Embedding Index",
            onClick: handleResetEmbeddingIndex,
            icon: SearchIcon,
            disabled: false,
        },
        {
            label: "Find Threads by Item (attachments)",
            onClick: handleFindThreadsByAttachments,
            icon: SearchIcon,
            disabled: false,
        },
        {
            label: "Find Threads by Item (citations)",
            onClick: handleFindThreadsByCitations,
            icon: SearchIcon,
            disabled: false,
        }
    ];

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost"
            icon={ToolsIcon}
            className={className}
            ariaLabel={ariaLabel}
            tooltipContent="Development Tools"
            showArrow={true}
        />
    );
};

export default DevToolsMenuButton;
