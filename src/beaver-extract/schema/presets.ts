import { SCHEMA_VERSION } from "@beaver/agent-core/extract/schema";
import type { ExtractIdScheme } from "@beaver/agent-core/extract/ids";

/**
 * Extraction switches selected by PDF schema version. Anything that changes
 * extracted text or ids belongs in a preset, so that every producible schema
 * version can still be extracted with the same WASM.
 */
export interface PdfExtractionPreset {
    schemaVersion: string;
    /**
     * Text repair: the stext options `use-known-glyph-outlines` and
     * `space-after-symbols` (fork-local), and control-character replacement
     * on the final result.
     */
    textRepair: boolean;
    /** How item and sentence ids are numbered (see `ExtractIdScheme`). */
    idScheme: ExtractIdScheme;
}

const PDF_EXTRACTION_PRESETS: Record<string, PdfExtractionPreset> = {
    "4": { schemaVersion: "4", textRepair: false, idScheme: "document" },
    "5": { schemaVersion: "5", textRepair: true, idScheme: "page" },
};

/** Preset for a PDF schema version, or `undefined` when it can't be produced. */
export function pdfExtractionPreset(schemaVersion: string): PdfExtractionPreset | undefined {
    return PDF_EXTRACTION_PRESETS[schemaVersion];
}

/** Preset for the current PDF schema version (`SCHEMA_VERSION`). */
export const CURRENT_PDF_EXTRACTION_PRESET: PdfExtractionPreset = (() => {
    const preset = pdfExtractionPreset(SCHEMA_VERSION);
    if (!preset) throw new Error(`No extraction preset for PDF schema ${SCHEMA_VERSION}`);
    return preset;
})();

/**
 * PDF schema versions the plugin serves on request and declares to the
 * backend. Every entry needs a preset; a preset alone does not make a version
 * producible.
 *
 * Schema 4 is served on demand so document-wide ids from earlier threads
 * (`s243`) still resolve; it is never cached or background-processed.
 */
export const PRODUCIBLE_PDF_SCHEMA_VERSIONS: readonly string[] = ["4", SCHEMA_VERSION];
