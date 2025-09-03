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
    return [bbox.l - 1, bbox.b - 1, bbox.r + 1, bbox.t + 1];
}

/**
 * Convert multiple BoundingBox objects to Zotero rects array
 */
export function bboxesToZoteroRects(bboxes: BoundingBox[]): number[][] {
    return bboxes.map(bbox => bboxToZoteroRect(bbox));
}


export interface PageLocation {
    /** Physical or logical location inside an attachment. */
    page_idx: number; // 1-based page number
    boxes?: BoundingBox[];
}

export interface CitationPart {
    /**
     * Represents a single chunk or block of text that is being cited.
     * e.g., "BLOCK_12"
     */
    /** The unique identifier for this specific chunk of text. */
    part_id: string;
    /** Physical location of the part in the document. */
    locations?: PageLocation[];
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
        .flatMap(p => p.locations || [])  
        .map(l => l.page_idx + 1)
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
        if (!part.locations) continue;
        
        for (const locator of part.locations) {
            if (locator.page_idx !== undefined && locator.boxes && locator.boxes.length > 0) {
                result.push({
                    page: locator.page_idx + 1,
                    bboxes: locator.boxes
                });
            }
        }
    }
    
    return result;
}