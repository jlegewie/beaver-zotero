export const EPUB_CONTENT_KIND = "epub" as const;
export const EPUB_SCHEMA_VERSION = "1" as const;

export type EpubContentKind = typeof EPUB_CONTENT_KIND;

export type EpubItemKind =
    | "text"
    | "section_header"
    | "list_item"
    | "caption"
    | "footnote"
    | "table"
    | "picture";

export interface EpubSentence {
    id: string;
    text: string;
}

export interface EpubItem {
    id: string;
    kind: EpubItemKind;
    sectionIndex: number;
    order: number;
    text?: string;
    level?: number;
    sentences?: EpubSentence[];
    anchorId?: string;
}

export interface EpubSection {
    index: number;
    rawHref: string;
    label?: string;
    items: EpubItem[];
}

export interface EpubCitationIndexEntry {
    id: string;
    kind: "item" | "sentence";
    sectionIndex: number;
    itemId: string;
    sentenceId?: string;
    anchorId?: string;
}

export type EpubCitationIndex = Record<string, EpubCitationIndexEntry>;

export interface EpubDocument {
    content_kind: typeof EPUB_CONTENT_KIND;
    schemaVersion: typeof EPUB_SCHEMA_VERSION;
    sectionCount: number;
    sections: EpubSection[];
    citationIndex: EpubCitationIndex;
}
