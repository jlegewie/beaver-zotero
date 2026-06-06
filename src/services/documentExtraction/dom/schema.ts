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

export interface DomDocument {
    sectionCount: number;
    sections: DomSection[];
    citationIndex: DomCitationIndex;
}
