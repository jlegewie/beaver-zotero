/**
 * MuPDF Utilities
 *
 * Re-exports from the PDF extraction service for backward compatibility.
 * For new code, prefer importing directly from `src/services/pdf`.
 */

export {
    PDFExtractor,
    extractFromZoteroItem,
    extractTextFromZoteroItem,
    disposeMuPDF,
    MuPDFService,
} from "../services/pdf";

// Legacy alias for backward compatibility
export { extractTextFromZoteroItem as extractPdfTextFromItem } from "../services/pdf";

// Re-export getMuPDF for any code that needs the raw API
export { getMuPDFAPI as getMuPDF } from "../services/pdf/MuPDFService";
