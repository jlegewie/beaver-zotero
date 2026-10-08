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
    /**
     * Record per-glyph style runs in the detailed walk (`RawLine.styleRuns`),
     * so heading detection judges a line by its majority styling rather than
     * by its first glyph.
     */
    styleRuns: boolean;
    /**
     * Read hanging-indent blocks (reference lists, footnotes, lists whose
     * wrapped lines sit at an inner edge) as entries with continuations
     * (`ParagraphDetectionSettings.hangingIndentBlocks`).
     */
    hangingIndentBlocks: boolean;
    /**
     * Heading detection demotes run-in label lines ("Keywords: …",
     * "Received: …"), display equations, bare web addresses and
     * supplementary / extended-data figure and table captions
     * (`ParagraphDetectionSettings.headingLabelFilters`).
     */
    headingLabelFilters: boolean;
    /**
     * Isolated headings: two same-style headings stacked a paragraph gap apart
     * are separate headings, and heading gaps are left out of a short column's
     * leading (`ParagraphDetectionSettings.isolatedHeadings`).
     */
    isolatedHeadings: boolean;
    /**
     * A page whose text is mostly set in a style other than the document's
     * body adds that style to its body styles, so lines in it are not
     * headings (`ParagraphDetectionSettings.pageBodyStyles`).
     */
    pageBodyStyles: boolean;
    /**
     * Sentence splitting keeps appendix / supplement-prefixed, panel-suffixed
     * and roman-numeral caption labels ("Table A1.", "Fig. S2", "Table IV.")
     * with their caption (`PostProcessContext.captionLabels`).
     */
    captionLabels: boolean;
    /**
     * Smart margin removal matches text rows rather than single MuPDF lines
     * (`ExtractionSettings.marginTextRows`).
     */
    marginTextRows: boolean;
    /**
     * Classify reference-list entries in structured extraction and emit them
     * as `reference` items (see `references/classify.ts`).
     */
    referenceItems: boolean;
    /** How item and sentence ids are numbered (see `ExtractIdScheme`). */
    idScheme: ExtractIdScheme;
    /**
     * Region detection in structured extraction: tables, figures and display
     * equations become `table` / `picture` / `formula` items, and the text
     * lines they absorb leave the prose (see `regions/regionItems.ts`).
     */
    regions: boolean;
    /**
     * Margin page-number detection also accepts runs of page numbers that
     * advance with the page index, so stray numerals in the zone, numbering
     * restarts, or another zone's matching page numbers don't hide them. See
     * `MarginFilter.identifyElementsToRemove`.
     */
    pageNumberRuns: boolean;
}

const PDF_EXTRACTION_PRESETS: Record<string, PdfExtractionPreset> = {
    "4": { schemaVersion: "4", textRepair: false, styleRuns: false, hangingIndentBlocks: false, headingLabelFilters: false, isolatedHeadings: false, pageBodyStyles: false, captionLabels: false, marginTextRows: false, referenceItems: false, idScheme: "document", regions: false, pageNumberRuns: false },
    "5": { schemaVersion: "5", textRepair: true, styleRuns: true, hangingIndentBlocks: true, headingLabelFilters: true, isolatedHeadings: true, pageBodyStyles: true, captionLabels: true, marginTextRows: true, referenceItems: true, idScheme: "page", regions: true, pageNumberRuns: true },
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
