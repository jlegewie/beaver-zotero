export type DomItemKind =
    | "text"
    | "section_header"
    | "list_item"
    | "caption"
    | "footnote"
    | "table"
    | "picture";

export interface DomSentence {
    id: string;
    text: string;
    pageLabel?: string;
}

export interface DomItem {
    id: string;
    kind: DomItemKind;
    sectionIndex: number;
    order: number;
    text?: string;
    level?: number;
    sentences?: DomSentence[];
    anchorId?: string;
    pageLabel?: string;
}

export interface DomSection {
    index: number;
    rawHref: string;
    label?: string;
    items: DomItem[];
}

export interface DomCitationIndexEntry {
    id: string;
    kind: "item" | "sentence";
    sectionIndex: number;
    itemId: string;
    sentenceId?: string;
    anchorId?: string;
}

export type DomCitationIndex = Record<string, DomCitationIndexEntry>;

/**
 * Extraction-quality signal carried on every DOM document.
 *
 * `textCoverage` is the fraction of the source's visible text that survived into
 * extracted items. A low value means the walk silently dropped body text it did
 * not recognize (e.g. an unanticipated container or table structure), so it is a
 * first-class health metric rather than a test-only diagnostic.
 */
export interface DomExtractionDiagnostics {
    /** Total characters across all extracted item text. */
    extractedTextChars: number;
    /** Total visible-text characters in the source section bodies (whitespace-normalized). */
    sourceTextChars: number;
    /** `extractedTextChars / sourceTextChars` (0–1), or `null` when the source has no text. */
    textCoverage: number | null;
}

export interface DomDocument {
    sectionCount: number;
    sections: DomSection[];
    citationIndex: DomCitationIndex;
    diagnostics: DomExtractionDiagnostics;
}
