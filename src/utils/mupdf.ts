/**
 * MuPDF Utilities
 *
 * Re-exports from the PDF extraction service for backward compatibility.
 * For new code, prefer importing directly from `src/services/pdf`.
 */

export {
    PDFExtractor,
    disposeMuPDF,
    disposeMuPDFWorker,
    MuPDFService,
} from "../services/pdf";

// Re-export getMuPDF for any code that needs the raw API
export { getMuPDFAPI as getMuPDF } from "../services/pdf/MuPDFService";
