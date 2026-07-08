import type { ReadableContentKind } from "../../src/services/documentExtraction/shared/contentKinds";
import {
    baseCitationKey,
    type CitationRef,
    type ExternalCitationSource,
    getRequestedRef,
    getResolvedRef,
    normalizeCitationTag,
    parseRawCitationAttributes,
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


// Citable content kinds: extractable documents plus user-attached image files.
export type ContentKind = ReadableContentKind;

/**
 * Bounding-box page location used by annotation locators (agent actions),
 * mirroring the backend PageLocation model. Citations themselves use the
 * compact PartLocation format below.
 */
export interface PageLocation {
    /** 0-based page index. */
    page_idx: number;
    boxes?: BoundingBox[];
    /** PDF /PageLabels label for this page, or null when none is defined. */
    page_label?: string | null;
    /** Per-page cumulative character offset in reading order (Zotero sortIndex offset). */
    reading_order_offset?: number | null;
}

/**
 * Compact, self-contained location of one cited document part (citation v2).
 *
 * Mirrors the backend PartLocation model. Which fields are set depends on the
 * attachment's content kind, carried by the surrounding Citation:
 * - PDF: `page_idx` + `boxes` (integer [l, t, r, b] quads in PDF points,
 *   top-left origin unless `origin === 'b'`)
 * - EPUB: `section_href` (+ `anchor_id`, `text`)
 * - snapshot: `selector` (+ `anchor_id`, `text`)
 * - text documents: `line` (+ `line_end`, `text`)
 *
 * None-valued fields are omitted on the wire.
 */
export interface PartLocation {
    /** Citation anchor of the part, e.g. 's33', 'p12', or 'l12'. */
    part_id: string;
    /** 0-based page index (PDF). */
    page_idx?: number;
    /** Bounding boxes as [l, t, r, b] integer quads. */
    boxes?: number[][];
    /** Coordinate origin of boxes: omitted = top-left, 'b' = bottom-left (legacy rows). */
    origin?: 'b';
    /** Section href (EPUB). */
    section_href?: string;
    /** HTML anchor id nearest the part (EPUB). */
    anchor_id?: string;
    /** Part text, for locating the passage in the live reader DOM. */
    text?: string;
    /** DOM selector locating the part (snapshot). */
    selector?: string;
    /** 1-based line number (text documents). */
    line?: number;
    /** Last line of a line range (text documents). */
    line_end?: number;
}

export type CitationType =
    | "item"
    | "attachment"
    | "note"
    | "annotation"
    | "collection"
    | "external_reference"
    | "external_file";

/**
 * V2 self-contained citation (mirrors the backend Citation model).
 *
 * Renders without live Zotero access: identity lives exclusively in
 * `requested_ref`/`resolved_ref`, and `display_name`/`formatted_citation`/
 * `item_type` carry everything needed for display. The backend converts
 * legacy stored rows to this shape before they reach the client.
 *
 * None-valued and empty-collection fields are omitted on the wire.
 */
export interface Citation {
    /** A unique ID for this specific citation instance. */
    citation_id: string;
    /** Identity as cited by the model (absent when unparseable). */
    requested_ref?: CitationRef;
    /** Canonical resolved identity (absent only when invalid). */
    resolved_ref?: CitationRef;
    /** Kind of object the citation resolved to. */
    citation_type?: CitationType;
    content_kind?: ContentKind;
    /** Inline display text: author-year for items, title for attachments/notes, filename for external files. */
    display_name?: string;
    /** Formatted bibliographic reference. */
    formatted_citation?: string;
    /** Zotero item type of the resolved object for icon rendering. */
    item_type?: string;
    /** Filename of the cited attachment */
    filename?: string;
    /** Preview of the cited passage. */
    preview?: string;
    /** 1-based cited page numbers (EPUB: section ordinals). */
    pages?: number[];
    /** Sparse 0-based page index -> printed label map for cited pages. */
    page_labels?: Record<number, string>;
    /** Compact locations of the cited parts. */
    locations?: PartLocation[];
    /** The original citation tag from the LLM response. */
    raw_tag?: string;
    /** True when the citation could not be resolved. */
    invalid?: boolean;
    invalid_reason?: string;

    /** The agent run ID of the citation (stamped client-side). */
    run_id?: string;
}

/** A citation entry in the cited-sources list, with its thread-scoped marker. */
export type CitedSource = Citation & { numericCitation: string | null };

/**
 * Helper functions for Citation
 */
export const isExternalCitation = (citation: Citation): boolean => {
    const ref = getCitationIdentityRef(citation);
    return ref?.kind === 'external';
};

export const isZoteroCitation = (citation: Citation): boolean => {
    const ref = getCitationIdentityRef(citation);
    return ref?.kind === 'zotero';
};

export const isExternalFileCitation = (citation: Citation): boolean => {
    const ref = getCitationIdentityRef(citation);
    return ref?.kind === 'external_file';
};

/**
 * Parameters for generating a citation key (refs + raw_tag only — v2 carries
 * no flat identity fields).
 */
export interface CitationKeyParams {
    requested_ref?: CitationRef;
    resolved_ref?: CitationRef;
    raw_tag?: string;
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
 * - Structured external citations: "external:{source}:{external_id}"
 * - Legacy external citations: "external:{external_source_id}"
 * - External files: "extfile:{ext_key}"
 * - Unknown: "" (empty string)
 */
export function getCitationKey(params: CitationKeyParams): string {
    const ref = getCitationIdentityRef(params);
    if (ref) {
        return baseCitationKey(ref);
    }
    const rawRef = getRequestedRef({ raw_tag: params.raw_tag });
    if (rawRef) {
        return baseCitationKey(rawRef);
    }
    return '';
}

function getCitationIdentityRef(params: CitationKeyParams): CitationRef | null {
    if (params.resolved_ref) {
        return getResolvedRef(params);
    }
    if (params.requested_ref) {
        return getRequestedRef(params);
    }
    return null;
}

/**
 * Normalized citation attributes from LLM output.
 * All attribute names are normalized (e.g., attachment_id → att_id).
 */
export interface NormalizedCitationAttrs {
    id?: string;           // Format: "libraryID-itemKey" or "ext-KEY"
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

export const getContentKind = (citation: Citation | null | undefined): ContentKind => {
    return citation?.content_kind ?? 'pdf';
};

/**
 * Symbolic (non-geometric) location derived from a citation's part locations.
 * Discriminated by the citation's content kind, mirroring the legacy
 * symbolic_location shape the navigation utilities consume.
 */
export type SymbolicLocation =
    | { content_kind: 'epub'; section_href: string; anchor_id?: string; text?: string }
    | { content_kind: 'snapshot'; selector?: string; anchor_id?: string; text?: string }
    | { content_kind: 'text'; line: number; line_end?: number; text?: string };

export const getSymbolicLocation = (
    citation: Citation | null | undefined,
): SymbolicLocation | undefined => {
    // Snapshot citations carry anchor_id/text and (usually) no stored selector —
    // the selector is computed at click/annotation time — so they are matched by
    // content kind rather than field presence, unlike EPUB/text.
    const isSnapshot = getContentKind(citation) === 'snapshot';
    for (const location of citation?.locations || []) {
        if (location.section_href != null) {
            return {
                content_kind: 'epub',
                section_href: location.section_href,
                ...(location.anchor_id != null ? { anchor_id: location.anchor_id } : {}),
                ...(location.text != null ? { text: location.text } : {}),
            };
        }
        if (location.line != null) {
            return {
                content_kind: 'text',
                line: location.line,
                ...(location.line_end != null ? { line_end: location.line_end } : {}),
                ...(location.text != null ? { text: location.text } : {}),
            };
        }
        if (isSnapshot && (location.selector != null || location.anchor_id != null || location.text != null)) {
            return {
                content_kind: 'snapshot',
                ...(location.selector != null ? { selector: location.selector } : {}),
                ...(location.anchor_id != null ? { anchor_id: location.anchor_id } : {}),
                ...(location.text != null ? { text: location.text } : {}),
            };
        }
    }
    return undefined;
};

export const getCitationPages = (citation: Citation | null | undefined): number[] => {
    if (!citation) return [];

    // Collect pages from part locations (sentence-level citations)
    const pagesFromLocations = (citation.locations || [])
        .map(location => location.page_idx)
        .filter((pageIdx): pageIdx is number => Number.isFinite(pageIdx))
        .map(pageIdx => pageIdx! + 1)
        .filter((page) => page > 0);

    // Collect pages from direct pages field (page-level citations)
    const directPages = (citation.pages || [])
        .map(page => Number(page))
        .filter((page): page is number => Number.isFinite(page) && page > 0);

    // Combine both sources, removing duplicates
    const allPages = [...new Set([...pagesFromLocations, ...directPages])];
    return allPages.sort((a, b) => a - b);
}

export interface CitationBoundingBoxData {
    page: number;
    bboxes: BoundingBox[];
    /** PDF /PageLabels label for this page, when available. */
    pageLabel?: string | null;
}

export const getCitationBoundingBoxes = (citation: Citation | null | undefined): CitationBoundingBoxData[] => {
    if (!citation?.locations) return [];

    const result: CitationBoundingBoxData[] = [];

    for (const location of citation.locations) {
        if (location.page_idx === undefined || !location.boxes || location.boxes.length === 0) continue;
        const pageIndex = Number(location.page_idx);
        if (!Number.isFinite(pageIndex) || pageIndex < 0) continue;
        const coordOrigin = location.origin === 'b' ? CoordOrigin.BOTTOMLEFT : CoordOrigin.TOPLEFT;
        result.push({
            page: pageIndex + 1,
            bboxes: location.boxes.map(([l, t, r, b]) => ({
                l, t, r, b, coord_origin: coordOrigin,
            })),
            pageLabel: citation.page_labels?.[pageIndex] ?? null,
        });
    }

    return result;
}

/**
 * CSS item-type icon name for a citation, derived from metadata alone.
 *
 * Mirrors Zotero's `item.getItemTypeIconName()` for the cases citations can
 * resolve to, without requiring a live item. Regular item types pass through
 * (their type name is the icon name); attachments branch on content kind.
 *
 * `content_kind` is set only for attachments and pins the exact attachment
 * glyph, so it is honored whenever present — including when `item_type` is
 * absent. Some tool-result rows carry `content_kind` but no `item_type`; without
 * this, a known attachment kind would fall back to the generic document icon.
 */
export function itemTypeToIconName(
    itemType: string | undefined,
    contentKind: string | undefined,
): string {
    if (itemType === 'attachment' || (!itemType && contentKind)) {
        switch (contentKind) {
            case 'pdf': return 'attachmentPDF';
            case 'epub': return 'attachmentEPUB';
            case 'snapshot': return 'attachmentSnapshot';
            case 'image': return 'attachmentImage';
            case 'video': return 'attachmentVideo';
            case 'linked_url': return 'attachmentWebLink';
            // 'text', office/audio/archive kinds, and any unrecognized 
            // kind fall back to the generic file glyph.
            default: return 'attachmentFile';
        }
    }
    if (!itemType) return 'document';
    return itemType;
}
