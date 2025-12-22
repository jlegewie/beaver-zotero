import React from 'react';
import MenuButton from '../MenuButton';
import { MenuItem } from '../menu/ContextMenu';
import PdfIcon from '../../icons/PdfIcon';
import { PDFExtractor, ExtractionError, ExtractionErrorCode } from '../../../../src/services/pdf';
import { 
    visualizeCurrentPageColumns, 
    clearVisualizationAnnotations,
    extractCurrentPageContent
} from '../../../utils/extractionVisualizer';

interface PdfTestMenuButtonProps {
    className?: string;
    ariaLabel?: string;
}

/**
 * TEMPORARY: Button component for PDF testing functions - REMOVE BEFORE RELEASE
 * Shows PDF extraction testing options in a dropdown menu
 */
const PdfTestMenuButton: React.FC<PdfTestMenuButtonProps> = ({ 
    className = '',
    ariaLabel = 'PDF Test Menu',
}) => {
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

        console.log("[PDF Test] Starting extraction for:", pdfItem.getField("title") || pdfItem.getDisplayTitle());

        try {
            const filePath = await pdfItem.getFilePathAsync();
            if (!filePath) {
                console.log("[PDF Test] File path not found");
                return;
            }

            const pdfData = await IOUtils.read(filePath);
            const extractor = new PDFExtractor();
            const result = await extractor.extract(pdfData, { checkTextLayer: true });

            console.log("[PDF Test] Extraction complete!");
            console.log("[PDF Test] Page count:", result.analysis.pageCount);
            console.log("[PDF Test] Has text layer:", result.analysis.hasTextLayer);
            console.log("[PDF Test] Full text (first 2000 chars):", result.fullText.slice(0, 2000));
            console.log("[PDF Test] Full result:", result);
        } catch (error) {
            // Handle specific extraction errors
            if (error instanceof ExtractionError) {
                switch (error.code) {
                    case ExtractionErrorCode.ENCRYPTED:
                        console.warn("[PDF Test] Document is encrypted:", error.message);
                        break;
                    case ExtractionErrorCode.NO_TEXT_LAYER:
                        console.warn("[PDF Test] Document has no text layer (needs OCR):", error.message);
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

    // Clear visualization annotations
    const handleClearVisualization = async () => {
        console.log("[PDF Visualizer] Clearing visualization annotations...");
        await clearVisualizationAnnotations();
        console.log("[PDF Visualizer] Annotations cleared");
    };

    // Extract current page content
    const handleExtractCurrentPage = async () => {
        console.log("[PDF Extractor] Extracting current page content...");
        const result = await extractCurrentPageContent();
        
        if (result.success) {
            console.log(`[PDF Extractor] ${result.message}`);
            console.log(`[PDF Extractor] Page ${result.pageNumber}: ${result.columnCount} column(s)`);
            console.log("[PDF Extractor] Columns:", result.columns);
            console.log("[PDF Extractor] === CONTENT START ===");
            console.log(result.content);
            console.log("[PDF Extractor] === CONTENT END ===");
        } else {
            console.warn(`[PDF Extractor] ${result.message}`);
        }
    };

    // Create menu items for PDF testing functions
    const menuItems: MenuItem[] = [
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
            label: "Visualize Columns (current page)",
            onClick: handleVisualizeColumns,
            icon: PdfIcon,
            disabled: false,
        },
        {
            label: "Clear Visualization",
            onClick: handleClearVisualization,
            icon: PdfIcon,
            disabled: false,
        }
    ];

    return (
        <MenuButton
            menuItems={menuItems}
            variant="ghost"
            icon={PdfIcon}
            className={className}
            ariaLabel={ariaLabel}
            tooltipContent="[DEV] PDF Testing Tools"
            showArrow={true}
        />
    );
};

export default PdfTestMenuButton;

