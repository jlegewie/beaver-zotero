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
     * Item passes of structured extraction, in order (step 3, see
     * `pipeline/itemPasses.ts`). `itemTypes` runs the item-type model
     * (`itemTypes/pass.ts`): headings, footnotes, references and page
     * furniture come from the model instead of the paragraph detector's
     * heading heuristic. `references` splits and joins the reference items
     * into one item per entry (`references/pass.ts`); it reads the kinds
     * `itemTypes` gave.
     */
    itemPasses: readonly ("itemTypes" | "references")[];
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
     * restarts, or another zone's matching page numbers don't hide them; and a
     * zone's increasing numbers count as page numbers only when they advance
     * with the pages, removing only each page's own number (a contents page
     * keeps its page references). See `MarginFilter.identifyElementsToRemove`.
     */
    pageNumberRuns: boolean;
    /**
     * Line detection reads each raw line in one column only, so text inside
     * two overlapping column boxes is not emitted twice
     * (`ParagraphDetectionSettings.exclusiveColumnLines`).
     */
    exclusiveColumnLines: boolean;
    /**
     * Line breaks inside an item follow `decideLineJoin` (`lineJoins.ts`) in
     * both the structured and the markdown text: line-end hyphens decided
     * from the document's spelling and the word's shape, URLs, DOIs, number
     * ranges and CJK text joined without a space, soft hyphens removed
     * (`ParagraphDetectionSettings.lineJoins`).
     */
    lineJoins: boolean;
    /**
     * Footnote markers glued to text: a footnote's raised lead marker is set
     * off from its text ("1AI" → "1 AI"), a raised marker glued to a word in
     * body text is dropped ("context53"), and a body sentence continues past
     * the footnotes that sit between columns
     * (`ParagraphDetectionSettings.noteMarkers`).
     */
    noteMarkers: boolean;
    /**
     * Item boundaries from the learned boundary model instead of the
     * paragraph detector's line rules, and joins of blocks the column
     * detector cut out of one printed column
     * (`ParagraphDetectionSettings.learnedBoundaries`).
     */
    learnedBoundaries: boolean;
    /**
     * Table rows read from the drawing and layout first: row rules and fill bands, an anchor
     * column; then the text, cell by cell. Column headers are read in levels (spanning headers
     * above the headings under them). Changes how a table's lines form rows, not which tables
     * are emitted (`RegionItemSettings.tableRowEvidence`).
     */
    tableRowEvidence: boolean;
}

const PDF_EXTRACTION_PRESETS: Record<string, PdfExtractionPreset> = {
    "4": { schemaVersion: "4", textRepair: false, styleRuns: false, hangingIndentBlocks: false, headingLabelFilters: false, isolatedHeadings: false, pageBodyStyles: false, captionLabels: false, marginTextRows: false, itemPasses: [], idScheme: "document", regions: false, pageNumberRuns: false, exclusiveColumnLines: false, lineJoins: false, noteMarkers: false, learnedBoundaries: false, tableRowEvidence: false },
    "5": { schemaVersion: "5", textRepair: true, styleRuns: true, hangingIndentBlocks: true, headingLabelFilters: true, isolatedHeadings: true, pageBodyStyles: true, captionLabels: true, marginTextRows: true, itemPasses: ["itemTypes", "references"], idScheme: "page", regions: true, pageNumberRuns: true, exclusiveColumnLines: true, lineJoins: true, noteMarkers: true, learnedBoundaries: true, tableRowEvidence: true },
};

/** Preset for a PDF schema version, or `undefined` when it can't be produced. */
export function pdfExtractionPreset(schemaVersion: string): PdfExtractionPreset | undefined {
    return PDF_EXTRACTION_PRESETS[schemaVersion];
}

/**
 * Preset switches a development caller (the CLI) may override, to compare a
 * switch against its schema's setting (training exports, evaluation). The
 * plugin never overrides presets: the output is no longer the schema version
 * it names.
 */
export const OVERRIDABLE_PRESET_SWITCHES = ["learnedBoundaries", "tableRowEvidence"] as const;

export type PresetOverrides = Partial<Pick<PdfExtractionPreset, (typeof OVERRIDABLE_PRESET_SWITCHES)[number]>>;

/** `preset` with `overrides` applied; throws on a switch that can't be overridden. */
export function applyPresetOverrides(preset: PdfExtractionPreset, overrides: PresetOverrides | undefined): PdfExtractionPreset {
    if (!overrides) return preset;
    for (const [key, value] of Object.entries(overrides)) {
        if (!(OVERRIDABLE_PRESET_SWITCHES as readonly string[]).includes(key) || typeof value !== "boolean") {
            throw new Error(`Preset switch "${key}" can't be overridden (overridable: ${OVERRIDABLE_PRESET_SWITCHES.join(", ")})`);
        }
    }
    return { ...preset, ...overrides };
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
