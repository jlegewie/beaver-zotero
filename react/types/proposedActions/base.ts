import type {
    AnnotationProposedData,
    AnnotationResultData
} from './annotations';
import {
    normalizePageLocations,
    normalizeSentenceIdList,
    normalizeNotePosition
} from './annotations';
import { ZoteroItemReference } from '../zotero';

/**
 * Status of a proposed action in its lifecycle
 */
export type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error';

/**
 * Types of actions that can be proposed by the AI
 */
export type ActionType = 'highlight_annotation' | 'note_annotation' | 'zotero_note';

/**
 * Union type for all proposed data types
 */
export interface NoteProposedData {
    title: string;
    content?: string | null;
    library_id?: number | null;
    zotero_key?: string | null;
}

export interface NoteResultData {
    library_id: number;
    zotero_key: string;
    parent_key?: string;
}

export type ProposedData = AnnotationProposedData | NoteProposedData;

/**
 * Type of result data after applying an action
 */
export type ActionResultDataType = AnnotationResultData | NoteResultData;

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

export type NoteProposedAction = ProposedAction & {
    action_type: 'zotero_note';
    proposed_data: NoteProposedData;
    result_data?: NoteResultData;
};

export const isZoteroNoteAction = (action: ProposedAction): action is NoteProposedAction => {
    return action.action_type === 'zotero_note';
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
    // proposed_data: ProposedData;
    // result_data?: ActionResultDataType; // Populated after application

    // Timestamps
    created_at: string;
    updated_at: string;
}

// Re-export annotation types for convenience
export type {
    AnnotationProposedAction,
    AnnotationProposedData,
    AnnotationResultData,
    HighlightAnnotationProposedData,
    NoteAnnotationProposedData,
    NotePosition,
    ToolAnnotationColor
} from './annotations';

/**
 * SSE event for proposed actions
 */
export interface ProposedActionStreamEvent {
    event: 'proposed_action';
    messageId: string;
    toolcallId: string;
    action: ProposedAction;
}

// Re-export annotation type guards and utilities for convenience
export {
    isHighlightAnnotationAction,
    isNoteAnnotationAction,
    isAnnotationAction,
    isAnnotationTool
} from './annotations';

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
    } else if (actionType === 'zotero_note') {
        const libraryIdRaw = proposedData.library_id ?? proposedData.libraryId;
        const zoteroKeyRaw = proposedData.zotero_key ?? proposedData.zoteroKey;

        let normalizedLibraryId: number | undefined;
        if (libraryIdRaw !== undefined && libraryIdRaw !== null) {
            const parsed = typeof libraryIdRaw === 'number' ? libraryIdRaw : Number(libraryIdRaw);
            normalizedLibraryId = Number.isNaN(parsed) ? undefined : parsed;
        }

        proposedData = {
            title: proposedData.title ?? '',
            content: typeof proposedData.content === 'string' || proposedData.content === null
                ? proposedData.content
                : (proposedData.content ?? null),
            library_id: normalizedLibraryId,
            zotero_key: typeof zoteroKeyRaw === 'string'
                ? zoteroKeyRaw
                : (zoteroKeyRaw !== undefined && zoteroKeyRaw !== null ? String(zoteroKeyRaw) : undefined),
        } as NoteProposedData;
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
    } else if (resultData && actionType === 'zotero_note') {
        const zoteroKey = resultData.zotero_key ?? resultData.zoteroKey;
        const libraryId = resultData.library_id ?? resultData.libraryId;
        const parentKey = resultData.parent_key ?? resultData.parentKey;
        if (zoteroKey) {
            resultData = {
                zotero_key: String(zoteroKey),
                library_id: typeof libraryId === 'number' ? libraryId : Number(libraryId ?? 0),
                ...(parentKey ? { parent_key: String(parentKey) } : {})
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
