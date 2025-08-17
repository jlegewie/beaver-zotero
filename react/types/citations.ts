import { ZoteroItemReference } from "./zotero";

export interface BoundingBox {
    l: number; // left
    t: number; // top
    r: number; // right
    b: number; // bottom
}

export interface Locator {
    /** Physical or logical location inside an attachment. */
    page_number?: number; // 1-based page number
    bboxes?: BoundingBox[];
    // character offsets for text-exact mapping
    char_start?: number;
    char_end?: number;
}

export interface CitationPart {
    /**
     * Represents a single chunk or block of text that is being cited.
     * e.g., "BLOCK_12"
     */
    /** The unique identifier for this specific chunk of text. */
    part_id: string;
    /** Physical location of the part in the document. */
    locators?: Locator;
}

export interface CitationMetadata extends ZoteroItemReference {
    /** A unique ID for this specific citation instance. */
    citation_id: string;
    /** The display marker, e.g., '1', '2'.. */
    marker?: string;
    /** The author-year of the citation. */
    author_year?: string;
    /** A list of the specific parts/chunks cited. */
    parts: CitationPart[];
}