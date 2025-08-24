import { ZoteroItemReference } from "./zotero";


export enum CoordOrigin {
    TOPLEFT = "t",
    BOTTOMLEFT = "b"
}

export interface BoundingBox {
    l: number; // left
    t: number; // top
    r: number; // right
    b: number; // bottom

    coord_origin: CoordOrigin;
}

/**
 * Convert BoundingBox to Zotero annotation rect format
 */
export function bboxToZoteroRect(bbox: BoundingBox): number[] {
    if (bbox.coord_origin !== CoordOrigin.BOTTOMLEFT) {
        throw new Error(`Expected BOTTOMLEFT coordinates, got ${bbox.coord_origin}`);
    }
    
    // For BOTTOMLEFT coordinates, direct mapping to Zotero format:
    // bbox.l = left edge (x1)
    // bbox.b = bottom edge (y1) 
    // bbox.r = right edge (x2)
    // bbox.t = top edge (y2)
    return [bbox.l, bbox.b, bbox.r, bbox.t];
}

/**
 * Convert multiple BoundingBox objects to Zotero rects array
 */
export function bboxesToZoteroRects(bboxes: BoundingBox[]): number[][] {
    return bboxes.map(bbox => bboxToZoteroRect(bbox));
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
    locators?: Locator[];
}

export interface CitationMetadata extends ZoteroItemReference {
    /** A unique ID for this specific citation instance. */
    citation_id: string;
    /** The display marker, e.g., '1', '2'.. */
    marker?: string;
    /** The author-year of the citation. */
    author_year?: string;
    /** Preview of the cited item. */
    preview?: string;
    /** A list of the specific parts/chunks cited. */
    parts: CitationPart[];
    /** The message ID of the citation. */
    message_id: string;
}

export interface CitationData extends CitationMetadata {
    parentKey: string | null;    // Key of the parent item
    icon: string | null;         // Icon for the zotero attachment
    name: string | null;         // Display name
    citation: string | null;     // In-text citation
    formatted_citation: string | null;  // Bibliographic reference
    url: string | null;          // URL for the zotero attachment
    numericCitation: string | null;     // Numeric citation
}

export const getCitationPages = (citation: CitationData | CitationMetadata | null | undefined): number[] => {
    if (!citation) return [];
    if (!citation.parts) return [];
    return citation.parts
        .flatMap(p => p.locators || [])  
        .map(l => l.page_number)
        .filter((page): page is number => page !== undefined);
}

export interface CitationBoundingBoxData {
    page: number;
    bboxes: BoundingBox[];
}

export const getCitationBoundingBoxes = (citation: CitationData | CitationMetadata | null | undefined): CitationBoundingBoxData[] => {
    if (!citation) return [];
    if (!citation.parts) return [];
    
    const result: CitationBoundingBoxData[] = [];
    
    for (const part of citation.parts) {
        if (!part.locators) continue;
        
        for (const locator of part.locators) {
            if (locator.page_number && locator.bboxes && locator.bboxes.length > 0) {
                result.push({
                    page: locator.page_number,
                    bboxes: locator.bboxes
                });
            }
        }
    }
    
    return result;
}