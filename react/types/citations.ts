import { ZoteroItemReference } from "./zotero";
import {
    baseCitationKey,
    type CitationRef,
    getRequestedRef,
    getResolvedRef,
    normalizeCitationTag,
    parseRawCitationAttributes,
    parseZoteroId,
    requestedCitationKey,
} from "../utils/citationGrammar";


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

// Adjust bboxes from page/MediaBox origin to viewport (CropBox) origin.
// Expects bottom-left origin; convert with convertBoundingBoxToBottomLeft first
// when the input is top-left (e.g. from the structured-extraction pipeline).
export function toZoteroRectFromBBox(
	bbox: BoundingBox,
	viewBoxLL: [number, number]
): number[] {
	if (bbox.coord_origin !== CoordOrigin.BOTTOMLEFT) {
		throw new Error(`Expected BOTTOMLEFT coordinates, got ${bbox.coord_origin}`);
	}
	const [vx, vy] = viewBoxLL; // CropBox lower-left
	// bbox has bottom-left origin: l, b, r, t
	return [bbox.l + vx, bbox.b + vy, bbox.r + vx, bbox.t + vy];
}

// Convert a top-left-origin bbox to bottom-left using the page height. Returns
// the input unchanged when it is already bottom-left so callers can apply this
// unconditionally to citation bboxes regardless of their producer.
//
// Edge semantics are preserved: `t` is the visual top edge (larger y in BL),
// `b` the visual bottom edge (smaller y in BL). Mirrors `bboxToReaderFrame`
// and `flipOrigin` in src/beaver-extract/types.ts -- do not swap the edges.
export function convertBoundingBoxToBottomLeft(
	bbox: BoundingBox,
	pageHeight: number
): BoundingBox {
	if (bbox.coord_origin === CoordOrigin.BOTTOMLEFT) {
		return bbox;
	}
	return {
		l: bbox.l,
		r: bbox.r,
		t: pageHeight - bbox.t,
		b: pageHeight - bbox.b,
		coord_origin: CoordOrigin.BOTTOMLEFT,
	};
}


export interface PageLocation {
    /** Physical or logical location inside an attachment. */
    page_idx: number; // 0-based page index
    boxes?: BoundingBox[];
    /** PDF /PageLabels label for this page, or null when none is defined. */
    page_label?: string | null;
    /** Per-page cumulative character offset in reading order (Zotero sortIndex offset). */
    reading_order_offset?: number | null;
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
    citation_type?: "item" | "attachment" | "external_reference" | "note" | "annotation";
    /** The display marker, e.g., '1', '2'.. */
    marker?: string;
    /** The author-year of the citation. */
    author_year?: string;
    /** Preview of the cited item. */
    preview?: string;
    /** A list of the specific parts/chunks cited. */
    parts: CitationPart[];
    /** Page numbers cited directly (e.g., [10] or [10, 11, 12] for ranges). */
    pages?: number[];
    requested_ref?: CitationRef;
    resolved_ref?: CitationRef;
    invalid_reason?: string;
    page_labels?: Record<number, string>;
    
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
    loc?: string;   // Unified Beaver Extract locator (e.g., "s343" or "p12")
    sid?: string;   // Sentence ID (e.g., "s343")
    page?: string;  // Page number (e.g., "3")
}

/**
 * Generate a full citation key including location info.
 * 
 * Used for matching in-text citations to their specific metadata.
 * Different locations within the same item get different full keys.
 * 
 * Key format:
 * - Base key only: "zotero:1-ABC123"
 * - With loc: "zotero:1-ABC123:s343"
 * - With sid: "zotero:1-ABC123:s343"
 * - With page: "zotero:1-ABC123:page=3"
 * - With sid and page: "zotero:1-ABC123:s343:page=3"
 * 
 * @param params Full citation key parameters
 * @returns Full citation key string
 */
export function getFullCitationKey(params: FullCitationKeyParams): string {
    const baseKey = getCitationKey(params);
    if (!baseKey) return '';
    
    const parts: string[] = [baseKey];
    if (params.loc) parts.push(params.loc);
    else if (params.sid) parts.push(params.sid);
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
    id?: string;           // Format: "libraryID-itemKey"
    item_id?: string;      // Format: "libraryID-itemKey"
    att_id?: string;       // Format: "libraryID-itemKey"
    external_id?: string;  // External source ID
    loc?: string;          // Unified locator token (e.g., "page10", "s343", "p12")
    sid?: string;          // Sentence ID (e.g., "s343")
    page?: string;         // Page number(s) - e.g., "10" or "10-12"
}

/**
 * Parse and normalize citation attributes from a raw attribute string.
 * 
 * Normalizations:
 * - attachment_id → att_id
 * - Only keeps recognized attributes (id, item_id, att_id, external_id, loc, sid, page)
 * 
 * @param attributesStr Raw attribute string from citation tag
 * @returns Normalized attributes object
 */
export function parseCitationAttributes(attributesStr: string): NormalizedCitationAttrs {
    const attrs: NormalizedCitationAttrs = {};
    const rawAttrs = parseRawCitationAttributes(attributesStr);

    for (const [name, value] of Object.entries(rawAttrs)) {
        if (name === 'id') attrs.id = value;
        else if (name === 'item_id') attrs.item_id = value;
        else if (name === 'att_id') attrs.att_id = value;
        else if (name === 'attachment_id') {
            attrs.att_id = value;
        }
        else if (name === 'external_id') attrs.external_id = value;
        else if (name === 'loc') attrs.loc = value;
        else if (name === 'sid') attrs.sid = value;
        else if (name === 'page') attrs.page = value;
    }

    return attrs;
}

/**
 * Compute a full citation key from normalized citation attributes.
 * Includes loc/sid/page for unique identification of citation instances.
 * Priority: att_id > item_id > external_id
 * 
 * @param attrs Normalized citation attributes
 * @returns Full citation key or empty string if no valid identifier
 */
export function computeCitationKeyFromAttrs(attrs: NormalizedCitationAttrs): string {
    const normalized = normalizeCitationTag(attrs as Record<string, string>);
    return normalized.ok ? requestedCitationKey(normalized.ref) : (normalized.requestedKey || '');
}

/**
 * Compute a base (item-only) citation key from normalized citation attributes.
 * Does NOT include loc/sid/page - used for marker assignment.
 * 
 * @param attrs Normalized citation attributes
 * @returns Base citation key or empty string if no valid identifier
 */
export function computeBaseCitationKeyFromAttrs(attrs: NormalizedCitationAttrs): string {
    const normalized = normalizeCitationTag(attrs as Record<string, string>);
    return normalized.ok ? baseCitationKey(normalized.ref) : (normalized.requestedKey || '');
}

/**
 * Get the identity key for consecutive citation detection.
 * Uses the primary identifier (att_id > item_id > external_id).
 */
export function getCitationIdentityKey(attrs: NormalizedCitationAttrs): string {
    const normalized = normalizeCitationTag(attrs as Record<string, string>);
    return normalized.ok ? baseCitationKey(normalized.ref) : (normalized.requestedKey || '');
}

export { getRequestedRef, getResolvedRef };

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
    
    // Collect pages from parts (sentence-level citations with locations)
    const pagesFromParts = (citation.parts || [])
        .flatMap(p => p.locations || [])  
        .map(l => Number(l.page_idx) + 1)
        .filter((page): page is number => Number.isFinite(page) && page > 0);
    
    // Collect pages from direct pages field (page-level citations)
    const directPages = (citation.pages || [])
        .map(page => Number(page))
        .filter((page): page is number => Number.isFinite(page) && page > 0);
    
    // Combine both sources, removing duplicates
    const allPages = [...new Set([...pagesFromParts, ...directPages])];
    return allPages.sort((a, b) => a - b);
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
