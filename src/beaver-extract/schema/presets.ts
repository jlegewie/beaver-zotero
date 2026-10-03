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
     * Text repair: ligature expansion in the detailed walk, the fork-local
     * stext options `use-known-glyph-outlines`, `map-symbol-private-use`,
     * `use-glyph-name-for-garbage` and `space-after-symbols`, and
     * control-character replacement on the final result.
     */
    textRepair: boolean;
    /** How item and sentence ids are numbered (see `ExtractIdScheme`). */
    idScheme: ExtractIdScheme;
    /**
     * Region detection in structured extraction: tables, figures and display
     * equations become `table` / `picture` / `formula` items, and the text
     * lines they absorb leave the prose (see `regions/regionItems.ts`).
     */
    regions: boolean;
}

const PDF_EXTRACTION_PRESETS: Record<string, PdfExtractionPreset> = {
    "4": { schemaVersion: "4", textRepair: false, idScheme: "document", regions: false },
    "5": { schemaVersion: "5", textRepair: true, idScheme: "page", regions: true },
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
