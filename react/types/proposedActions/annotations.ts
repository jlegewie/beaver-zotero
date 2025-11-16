import { PageLocation, BoundingBox, CoordOrigin } from "../citations";
import type { ProposedAction } from "./base";

export type ToolAnnotationColor =
    | 'red'
    | 'orange'
    | 'yellow'
    | 'green'
    | 'blue'
    | 'purple'
    | 'gray'
    | 'pink'
    | 'brown'
    | 'cyan'
    | 'lime'
    | 'mint'
    | 'coral'
    | 'navy'
    | 'olive'
    | 'teal';

/**
 * Position for a note annotation in a PDF
 */
export interface NotePosition {
    page_index: number;
    side: 'left' | 'right';
    /** Absolute X coordinate in PDF points */
    x: number;
    /** Absolute Y coordinate in PDF points */
    y: number;
}

/**
 * Proposed data for a highlight annotation action
 */
export interface HighlightAnnotationProposedData {
    title: string;
    comment?: string;
    color?: ToolAnnotationColor;
    text: string; // The highlighted text
    raw_sentence_ids: string; // e.g., "s1-s3,s5"
    sentence_ids: string[]; // e.g., ["s1", "s2", "s3", "s5"]
    highlight_locations: PageLocation[]; // Bounding boxes
    library_id: number;
    attachment_key: string;
}

/**
 * Proposed data for a note annotation action
 */
export interface NoteAnnotationProposedData {
    title: string;
    comment: string;
    raw_sentence_ids: string; // e.g., "s42"
    sentence_ids: string[]; // e.g., ["s42"]
    note_position: NotePosition; // Page position
    library_id: number;
    attachment_key: string;
}

/**
 * Union type for all proposed data types
 */
export type AnnotationProposedData = HighlightAnnotationProposedData | NoteAnnotationProposedData;

/**
 * Result data after applying an annotation action
 */
export interface AnnotationResultData {
    zotero_key: string; // The Zotero key assigned to the annotation
    library_id: number;
    attachment_key: string;
}

/**
 * Typed proposed action for annotations
 */
export type AnnotationProposedAction = ProposedAction & {
    action_type: 'highlight_annotation' | 'note_annotation';
    proposed_data: AnnotationProposedData;
    result_data: AnnotationResultData;
};

/**
 * Type guard to check if an action is a highlight annotation
 */
export function isHighlightAnnotationAction(action: ProposedAction): action is ProposedAction & {
    proposed_data: HighlightAnnotationProposedData;
} {
    return action.action_type === 'highlight_annotation';
}

/**
 * Type guard to check if an action is a note annotation
 */
export function isNoteAnnotationAction(action: ProposedAction): action is ProposedAction & {
    proposed_data: NoteAnnotationProposedData;
} {
    return action.action_type === 'note_annotation';
}

/**
 * Type guard to check if an action is any annotation type
 */
export function isAnnotationAction(action: ProposedAction): boolean {
    return action.action_type === 'highlight_annotation' || action.action_type === 'note_annotation';
}

/**
 * Check if a function name corresponds to an annotation tool
 */
export function isAnnotationTool(functionName: string | undefined): boolean {
    if (!functionName) return false;
    return (
        functionName === 'add_highlight_annotations' ||
        functionName === 'add_note_annotations' ||
        functionName === 'add_annotations'
    );
}

/**
 * Normalize a bounding box from various formats
 */
export function normalizeBoundingBox(raw: any): BoundingBox | null {
    if (!raw) return null;
    const l = typeof raw.l === 'number' ? raw.l : Number(raw.l);
    const t = typeof raw.t === 'number' ? raw.t : Number(raw.t);
    const r = typeof raw.r === 'number' ? raw.r : Number(raw.r);
    const b = typeof raw.b === 'number' ? raw.b : Number(raw.b);
    if ([l, t, r, b].some((value) => Number.isNaN(value))) {
        return null;
    }

    let coordOrigin: CoordOrigin;
    const rawOrigin = raw.coord_origin || raw.coordOrigin;
    if (rawOrigin === CoordOrigin.TOPLEFT || rawOrigin === 't') {
        coordOrigin = CoordOrigin.TOPLEFT;
    } else {
        coordOrigin = CoordOrigin.BOTTOMLEFT;
    }

    return {
        l,
        t,
        r,
        b,
        coord_origin: coordOrigin,
    };
}

/**
 * Normalize highlight locations from various formats
 */
export function normalizePageLocations(raw: any): PageLocation[] | undefined {
    const locations = raw?.highlightLocations ?? raw?.highlight_locations ?? raw?.locations;
    if (!Array.isArray(locations) || locations.length === 0) {
        return undefined;
    }

    return locations
        .map((loc: any) => {
            const rawPageIndex =
                loc?.pageIndex ??
                loc?.page_index ??
                loc?.pageIdx ??
                loc?.page_idx ??
                loc?.page;
            if (rawPageIndex === undefined || rawPageIndex === null) {
                return null;
            }
            const pageIndex = typeof rawPageIndex === 'number' ? rawPageIndex : Number(rawPageIndex);
            if (Number.isNaN(pageIndex)) {
                return null;
            }

            const rawBoxes =
                loc?.boxes ??
                loc?.boundingBoxes ??
                loc?.bboxes ??
                loc?.rects ??
                [];
            const boxes = Array.isArray(rawBoxes)
                ? (rawBoxes
                      .map(normalizeBoundingBox)
                      .filter(Boolean) as BoundingBox[])
                : [];

            return {
                page_idx: pageIndex,
                boxes,
            } as PageLocation;
        })
        .filter(Boolean) as PageLocation[];
}

/**
 * Normalize sentence ID list from various formats
 */
export function normalizeSentenceIdList(value: any): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.filter((id): id is string => typeof id === 'string');
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);
    }
    return [];
}

/**
 * Normalize note position from various formats
 */
export function normalizeNotePosition(raw: any): NotePosition | undefined {
    const notePosition = raw?.notePosition ?? raw?.note_position;
    if (!notePosition) return undefined;

    const rawPageIndex = notePosition.pageIndex ?? notePosition.page_index ?? notePosition.page_idx;
    const rawSide = notePosition.side;
    if (rawPageIndex === undefined || rawPageIndex === null || !rawSide) {
        return undefined;
    }

    const pageIndex = typeof rawPageIndex === 'number' ? rawPageIndex : Number(rawPageIndex);
    if (Number.isNaN(pageIndex)) {
        return undefined;
    }

    const x = typeof notePosition.x === 'number' ? notePosition.x : Number(notePosition.x ?? 0);
    const y = typeof notePosition.y === 'number' ? notePosition.y : Number(notePosition.y ?? 0);

    const side = rawSide === 'left' ? 'left' : 'right';

    return {
        page_index: pageIndex,
        side,
        x,
        y,
    };
}