import type {
    DegradationSummary,
    ExtractionSettings,
    ExtractionTimings,
} from "../types";

export const SCHEMA_VERSION = "4";

export type Rect = [number, number, number, number];
export type BBoxOrigin = "top-left";

export interface ExtractResultBase {
    schemaVersion: string;
    createdAt?: string;
    diagnostics?: ExtractionDiagnostics;
}

export interface ExtractionDiagnostics {
    timings?: ExtractionTimings;
    settings?: ExtractionSettings;
    engine?: "block" | "paragraph" | "structured";
    degradation?: {
        totalCount: number;
        pageCount: number;
    };
}

export interface MarkdownExtractResult extends ExtractResultBase {
    mode: "markdown";
    document: MarkdownDocument;
}

export interface StructuredExtractResult extends ExtractResultBase {
    mode: "structured";
    document: StructuredDocument;
    debug?: ExtractionDebug;
}

export interface StructuredExtractWithDebugResult {
    result: StructuredExtractResult;
    debug: ExtractionDebug;
}

export type BeaverExtractResult =
    | MarkdownExtractResult
    | StructuredExtractResult;

export interface MarkdownDocument {
    pageCount: number;
    pageLabels?: Record<string, string>;
    pages: MarkdownPage[];
}

export interface MarkdownPage {
    index: number;
    label?: string;
    width: number;
    height: number;
    viewBox: Rect;
    rotation: 0 | 90 | 180 | 270;
    markdown: string;
}

export interface StructuredDocument {
    pageCount: number;
    pageLabels?: Record<string, string>;
    /**
     * Origin for all public extraction rects on `pages[].items[].bbox` and
     * `pages[].items[].sentences[].bboxes`.
     */
    bboxOrigin: BBoxOrigin;
    bboxPrecision: number;
    pages: StructuredPage[];
    citationIndex: CitationIndex;
}

export interface StructuredPage {
    index: number;
    label?: string;
    /**
     * `width`/`height` define the public extraction bbox frame for this page.
     * On rotated PDF pages, this frame may differ from the unrotated PDF user
     * space in `viewBox`. `rotation` is the normalized raw `/Rotate` value.
     */
    width: number;
    height: number;
    /** Effective CropBox intersected with MediaBox in unrotated PDF user space. */
    viewBox: Rect;
    rotation: 0 | 90 | 180 | 270;
    items: DocumentItem[];
}

export type DocumentItemKind =
    | "text"
    | "section_header"
    | "list_item"
    | "caption"
    | "footnote"
    | "formula"
    | "table"
    | "picture"
    | "margin";

export const ID_PREFIXES = {
    sentence: "s",
    line: "l",
    text: "p",
    section_header: "heading",
    list_item: "list",
    caption: "caption",
    footnote: "footnote",
    formula: "eq",
    table: "table",
    picture: "fig",
    margin: "margin",
} as const satisfies Record<DocumentItemKind | "sentence" | "line", string>;

export interface DocumentItemBase {
    id: string;
    kind: DocumentItemKind;
    pageIndex: number;
    order: number;
    /** Rect in the document's public extraction bbox frame. */
    bbox: Rect;
}

export interface TextBearingItem extends DocumentItemBase {
    /**
     * Exact paragraph reconstruction in reading order. For sentence-bearing
     * kinds (`text` / `caption` / `footnote` / `list_item`) this overlaps with
     * `sentences[].text` but is NOT byte-equal to `sentences.map(s => s.text).join(' ')`:
     * the splitter only emits ranges over the sentence-bearing characters, so
     * inter-sentence whitespace and inter-line filler (footnote runs, etc.)
     * live on `text` only. Use `text` for the canonical paragraph string and
     * `sentences[].text` for citation-aligned spans.
     */
    text: string;
}

export interface TextItem extends TextBearingItem {
    kind: "text";
    sentences?: Sentence[];
}

export interface SectionHeaderItem extends TextBearingItem {
    kind: "section_header";
    level: number;
}

export interface ListItem extends TextBearingItem {
    kind: "list_item";
    sentences?: Sentence[];
}

export interface CaptionItem extends TextBearingItem {
    kind: "caption";
    sentences?: Sentence[];
}

export interface FootnoteItem extends TextBearingItem {
    kind: "footnote";
    sentences?: Sentence[];
}

export interface FormulaItem extends TextBearingItem {
    kind: "formula";
}

export interface MarginItem extends TextBearingItem {
    kind: "margin";
}

export interface TableItem extends DocumentItemBase {
    kind: "table";
}

export interface PictureItem extends DocumentItemBase {
    kind: "picture";
}

export type DocumentItem =
    | TextItem
    | SectionHeaderItem
    | ListItem
    | CaptionItem
    | FootnoteItem
    | FormulaItem
    | TableItem
    | PictureItem
    | MarginItem;

export interface Sentence {
    id: string;
    order: number;
    text: string;
    /** Sentence fragment rects in the document's public extraction bbox frame. */
    bboxes: Rect[];
    joinWithNext?: boolean;
}

export interface DebugSentence extends Sentence {
    itemId: string;
    fragments?: DebugSentenceFragment[];
}

export type CitationKind = "item" | "sentence";

export interface CitationIndexEntry {
    id: string;
    kind: CitationKind;
    pageIndex: number;
    pageLabel?: string;
    itemId: string;
    sentenceId?: string;
}

export type CitationIndex = Record<string, CitationIndexEntry>;

export interface ExtractionDebug {
    pages?: Record<string, PageDebugData>;
    degradation?: Record<string, DegradationSummary>;
}

export interface PageDebugData {
    pageIndex: number;
    pageLabel?: string;
    width: number;
    height: number;
    counts: {
        items: number;
        sentences: number;
        columns?: number;
        lines?: number;
    };
    columns?: Rect[];
    lines?: DebugLine[];
    items?: DocumentItem[];
    sentences?: DebugSentence[];
    sentenceFragments?: DebugSentenceFragment[];
    droppedLineIds?: string[];
    marginCandidates?: unknown[];
    styleProfile?: unknown;
    marginDecisions?: unknown[];
    degradation?: DegradationSummary;
}

export interface DebugLine {
    id?: string;
    text?: string;
    bbox: Rect;
    columnIndex?: number;
}

export interface DebugSentenceFragment {
    lineIndex: number;
    text: string;
    bbox: Rect;
}
