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

// Adjust bboxes from page/MediaBox origin to viewport (CropBox) origin
export function toZoteroRectFromBBox(
	bbox: BoundingBox,
	viewBoxLL: [number, number]
): number[] {
	const [vx, vy] = viewBoxLL; // CropBox lower-left
	// bbox has bottom-left origin: l, b, r, t
	return [bbox.l + vx, bbox.b + vy, bbox.r + vx, bbox.t + vy];
}


export interface PageLocation {
    /** Physical or logical location inside an attachment. */
    page_idx: number; // 0-based page index
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

export interface CitationMetadata {
    /** A unique ID for this specific citation instance. */
    citation_id: string;
    
    // Zotero reference fields (for items and attachments)
    library_id?: number;
    zotero_key?: string;
    
    // External reference fields (for external references)
    external_source?: "semantic_scholar" | "openalex";
    external_source_id?: string;
    
    // Common fields for all citation types
    /** Citation type discriminator */
    citation_type?: "item" | "attachment" | "external_reference";
    /** The display marker, e.g., '1', '2'.. */
    marker?: string;
    /** The author-year of the citation. */
    author_year?: string;
    /** Preview of the cited item. */
    preview?: string;
    /** A list of the specific parts/chunks cited. */
    parts: CitationPart[];
    
    /** The agent run ID of the citation. */
    run_id: string;
    /** The original citation tag from the LLM response. */
    raw_tag?: string;
    /** True when the citation could not be resolved (attachment/item not found, invalid key format). */
    invalid?: boolean;
}

/**
 * Helper functions for CitationMetadata
 */
export const isExternalCitation = (citation: CitationMetadata): boolean => {
    return !!(citation.external_source && citation.external_source_id);
};

export const isZoteroCitation = (citation: CitationMetadata): boolean => {
    return !!(citation.library_id && citation.zotero_key);
};

/**
 * Parameters for generating a citation key.
 * Accepts either CitationMetadata fields or component props.
 */
export interface CitationKeyParams {
    // Zotero reference (from metadata or parsed from props)
    library_id?: number;
    zotero_key?: string;
    // External reference
    external_source_id?: string;
}

/**
 * Generate a base key for a citation (item-level, without location info).
 * 
 * Used for:
 * - Marker assignment (same item = same marker number)
 * - Base identification of the cited item
 * 
 * Key format:
 * - Zotero citations: "zotero:{library_id}-{zotero_key}"
 * - External citations: "external:{external_source_id}"
 * - Unknown: "" (empty string)
 * 
 * @param params Citation key parameters
 * @returns Base citation key string
 */
export function getCitationKey(params: CitationKeyParams): string {
    if (params.library_id && params.zotero_key) {
        return `zotero:${params.library_id}-${params.zotero_key}`;
    }
    if (params.external_source_id) {
        return `external:${params.external_source_id}`;
    }
    return '';
}

/**
 * Parameters for generating a full citation key (includes location info).
 */
export interface FullCitationKeyParams extends CitationKeyParams {
    sid?: string;   // Sentence ID (e.g., "s0-s8")
    page?: string;  // Page number (e.g., "3")
}

/**
 * Generate a full citation key including location info (sid, page).
 * 
 * Used for matching in-text citations to their specific metadata.
 * Different locations within the same item get different full keys.
 * 
 * Key format:
 * - Base key only: "zotero:1-ABC123"
 * - With sid: "zotero:1-ABC123:sid=s0-s8"
 * - With page: "zotero:1-ABC123:page=3"
 * - With both: "zotero:1-ABC123:sid=s0-s8:page=3"
 * 
 * @param params Full citation key parameters
 * @returns Full citation key string
 */
export function getFullCitationKey(params: FullCitationKeyParams): string {
    const baseKey = getCitationKey(params);
    if (!baseKey) return '';
    
    const parts: string[] = [baseKey];
    if (params.sid) parts.push(`sid=${params.sid}`);
    if (params.page) parts.push(`page=${params.page}`);
    
    return parts.join(':');
}

/**
 * Parse a "libraryID-itemKey" reference string.
 * Handles optional 'user-content-' prefix added by rehype-sanitize.
 * 
 * @param ref Reference string in format "libraryID-itemKey"
 * @returns Parsed reference or null if invalid
 */
export function parseItemReference(ref: string | undefined): { libraryID: number; itemKey: string } | null {
    if (!ref) return null;
    const clean = ref.replace('user-content-', '');
    const dashIndex = clean.indexOf('-');
    if (dashIndex > 0) {
        const libraryID = parseInt(clean.substring(0, dashIndex), 10);
        const itemKey = clean.substring(dashIndex + 1);
        if (libraryID > 0 && itemKey) {
            return { libraryID, itemKey };
        }
    }
    return null;
}

/**
 * Normalized citation attributes from LLM output.
 * All attribute names are normalized (e.g., attachment_id → att_id).
 */
export interface NormalizedCitationAttrs {
    item_id?: string;      // Format: "libraryID-itemKey"
    att_id?: string;       // Format: "libraryID-itemKey"
    external_id?: string;  // External source ID
    sid?: string;          // Sentence ID (e.g., "s0-s8")
    page?: string;         // Page number (e.g., "3")
}

/**
 * Parse and normalize citation attributes from a raw attribute string.
 * 
 * Normalizations:
 * - attachment_id → att_id
 * - Only keeps recognized attributes (item_id, att_id, external_id, sid, page)
 * 
 * @param attributesStr Raw attribute string from citation tag
 * @returns Normalized attributes object
 */
export function parseCitationAttributes(attributesStr: string): NormalizedCitationAttrs {
    const attrs: NormalizedCitationAttrs = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let match: RegExpExecArray | null;
    
    while ((match = attrRegex.exec(attributesStr)) !== null) {
        let name = match[1];
        const value = match[2];
        
        // Normalize attribute names
        if (name === 'attachment_id') {
            name = 'att_id';
        }
        
        // Only keep recognized citation attributes
        if (name === 'item_id') attrs.item_id = value;
        else if (name === 'att_id') attrs.att_id = value;
        else if (name === 'external_id') attrs.external_id = value;
        else if (name === 'sid') attrs.sid = value;
        else if (name === 'page') attrs.page = value;
    }
    
    return attrs;
}

/**
 * Compute a full citation key from normalized citation attributes.
 * Includes sid and page for unique identification of citation instances.
 * Priority: att_id > item_id > external_id
 * 
 * @param attrs Normalized citation attributes
 * @returns Full citation key or empty string if no valid identifier
 */
export function computeCitationKeyFromAttrs(attrs: NormalizedCitationAttrs): string {
    // att_id takes priority (attachment reference)
    const zoteroRef = parseItemReference(attrs.att_id) || parseItemReference(attrs.item_id);
    
    if (zoteroRef) {
        return getFullCitationKey({
            library_id: zoteroRef.libraryID,
            zotero_key: zoteroRef.itemKey,
            sid: attrs.sid,
            page: attrs.page
        });
    }
    
    if (attrs.external_id) {
        return getFullCitationKey({ 
            external_source_id: attrs.external_id,
            sid: attrs.sid,
            page: attrs.page
        });
    }
    
    return '';
}

/**
 * Compute a base (item-only) citation key from normalized citation attributes.
 * Does NOT include sid/page - used for marker assignment.
 * 
 * @param attrs Normalized citation attributes
 * @returns Base citation key or empty string if no valid identifier
 */
export function computeBaseCitationKeyFromAttrs(attrs: NormalizedCitationAttrs): string {
    const zoteroRef = parseItemReference(attrs.att_id) || parseItemReference(attrs.item_id);
    
    if (zoteroRef) {
        return getCitationKey({
            library_id: zoteroRef.libraryID,
            zotero_key: zoteroRef.itemKey
        });
    }
    
    if (attrs.external_id) {
        return getCitationKey({ external_source_id: attrs.external_id });
    }
    
    return '';
}

/**
 * Get the identity key for consecutive citation detection.
 * Uses the primary identifier (att_id > item_id > external_id).
 */
export function getCitationIdentityKey(attrs: NormalizedCitationAttrs): string {
    return attrs.att_id || attrs.item_id || attrs.external_id || '';
}

export interface CitationData extends CitationMetadata {
    type: "item" | "attachment" | "note" | "annotation" | "external";
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