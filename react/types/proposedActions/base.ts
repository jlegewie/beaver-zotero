import { PageLocation, BoundingBox, CoordOrigin } from '../citations';
import { ZoteroItemReference } from '../zotero';

/**
 * Status of a proposed action in its lifecycle
 */
export type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error';

/**
 * Types of actions that can be proposed by the AI
 */
export type ActionType = 'highlight_annotation' | 'note_annotation';













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
export type ProposedData = AnnotationProposedData;


/**
 * Result data after applying an annotation action
 */
export interface AnnotationResultData {
    zotero_key: string; // The Zotero key assigned to the annotation
    library_id: number;
    attachment_key: string;
}

/**
 * Type of result data after applying an action
 */
export type ActionResultDataType = AnnotationResultData;


/**
 * Get a Zotero item or item reference from a ProposedAction if it has been applied
 */
export const hasAppliedZoteroItem = (proposedAction: ProposedAction): boolean => {
    return proposedAction.status === 'applied' && proposedAction.result_data?.zotero_key && proposedAction.result_data?.library_id;
};


export const getZoteroItemReferenceFromProposedAction = (proposedAction: ProposedAction): ZoteroItemReference | null => {
    if(proposedAction.status !== 'applied' || !proposedAction.result_data?.zotero_key || !proposedAction.result_data?.library_id) {
        return null;
    }
    return {
        library_id: proposedAction.result_data.library_id,
        zotero_key: proposedAction.result_data.zotero_key
    } as ZoteroItemReference;
};

export const getZoteroItemFromProposedAction = async (proposedAction: ProposedAction): Promise<Zotero.Item | null> => {
    const zoteroItemReference = getZoteroItemReferenceFromProposedAction(proposedAction);
    if(!zoteroItemReference) {
        return null;
    }
    return (await Zotero.Items.getByLibraryAndKeyAsync(zoteroItemReference.library_id, zoteroItemReference.zotero_key)) || null;
};

/**
 * Core proposed action model matching the backend schema
 */
export interface ProposedAction {
    // Identity
    id: string;
    message_id: string;
    toolcall_id?: string;
    user_id: string;

    // Action type
    action_type: ActionType;

    // Status
    status: ActionStatus;
    error_message?: string;
    error_details?: Record<string, any>;

    // Action-specific proposed data and result data
    proposed_data: Record<string, any>; // Will be cast to specific types based on action_type
    result_data?: Record<string, any>; // Populated after application

    // Timestamps
    created_at: string;
    updated_at: string;
}

export type AnnotationProposedAction = ProposedAction & {
    action_type: 'highlight_annotation' | 'note_annotation';
    proposed_data: AnnotationProposedData;
    result_data: AnnotationResultData;
};

/**
 * SSE event for proposed actions
 */
export interface ProposedActionStreamEvent {
    event: 'proposed_action';
    messageId: string;
    toolcallId: string;
    action: ProposedAction;
}

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
function normalizeBoundingBox(raw: any): BoundingBox | null {
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
function normalizePageLocations(raw: any): PageLocation[] | undefined {
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
 * Normalize note position from various formats
 */
function normalizeNotePosition(raw: any): NotePosition | undefined {
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

/**
 * Normalize sentence ID list from various formats
 */
function normalizeSentenceIdList(value: any): string[] {
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
 * Deserializes and normalizes a raw proposed action object from the backend
 * into a typed ProposedAction object.
 */
export function toProposedAction(raw: Record<string, any>): ProposedAction {
    const actionType = (raw.action_type ?? raw.actionType) as ActionType;
    
    // Normalize proposed_data based on action type
    let proposedData: Record<string, any> = raw.proposed_data ?? raw.proposedData ?? {};
    
    if (actionType === 'highlight_annotation' || actionType === 'note_annotation') {
        const libraryIdRaw = proposedData.library_id ?? proposedData.libraryId;
        const attachmentKeyRaw = proposedData.attachment_key ?? proposedData.attachmentKey;
        const sentenceIds = normalizeSentenceIdList(proposedData.sentence_ids ?? proposedData.sentenceIds);
        
        const normalizedData: any = {
            title: proposedData.title ?? '',
            comment: proposedData.comment ?? '',
            library_id: typeof libraryIdRaw === 'number' ? libraryIdRaw : Number(libraryIdRaw ?? 0),
            attachment_key: typeof attachmentKeyRaw === 'string' ? attachmentKeyRaw : String(attachmentKeyRaw ?? ''),
            raw_sentence_ids: proposedData.raw_sentence_ids ?? proposedData.rawSentenceIds ?? null,
            sentence_ids: sentenceIds,
        };
        
        if (actionType === 'highlight_annotation') {
            normalizedData.text = proposedData.text ?? '';
            normalizedData.color = proposedData.color ?? proposedData.highlight_color ?? null;
            normalizedData.highlight_locations = normalizePageLocations(proposedData);
        } else if (actionType === 'note_annotation') {
            normalizedData.note_position = normalizeNotePosition(proposedData);
        }
        
        proposedData = normalizedData;
    }
    
    // Normalize result_data if present
    let resultData: Record<string, any> | undefined = raw.result_data ?? raw.resultData;
    if (resultData && (actionType === 'highlight_annotation' || actionType === 'note_annotation')) {
        const zoteroKey = resultData.zotero_key ?? resultData.zoteroKey;
        const libraryId = resultData.library_id ?? resultData.libraryId;
        const attachmentKey = resultData.attachment_key ?? resultData.attachmentKey;
        
        if (zoteroKey) {
            resultData = {
                zotero_key: zoteroKey,
                library_id: typeof libraryId === 'number' ? libraryId : Number(libraryId ?? 0),
                attachment_key: typeof attachmentKey === 'string' ? attachmentKey : String(attachmentKey ?? ''),
            };
        }
    }

    return {
        id: raw.id,
        message_id: raw.message_id ?? raw.messageId,
        toolcall_id: raw.toolcall_id ?? raw.toolcallId,
        user_id: raw.user_id ?? raw.userId,
        action_type: actionType,
        status: raw.status ?? 'pending',
        error_message: raw.error_message ?? raw.errorMessage,
        proposed_data: proposedData,
        error_details: raw.error_details ?? raw.validationErrors,
        result_data: resultData,
        created_at: raw.created_at ?? raw.createdAt ?? new Date().toISOString(),
        updated_at: raw.updated_at ?? raw.updatedAt ?? new Date().toISOString(),
    };
}

/**
 * Normalize raw actions from various formats
 */
function normalizeRawActions(value: any): Record<string, any>[] {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.filter(
            (candidate): candidate is Record<string, any> =>
                typeof candidate === 'object' &&
                candidate !== null &&
                typeof candidate.id === 'string'
        );
    }
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return normalizeRawActions(parsed);
        } catch (_error) {
            return [];
        }
    }
    if (typeof value === 'object') {
        const candidate = value as Record<string, any>;
        if (typeof candidate.id === 'string') {
            return [candidate];
        }
    }
    return [];
}

