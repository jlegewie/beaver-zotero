import { atom } from 'jotai';
import { logger } from '../../src/utils/logger';
import { ZoteroItemReference } from '../types/zotero';
import {
    ActionStatus,
    ActionType,
    NoteProposedData,
} from '../types/proposedActions/base';
import {
    normalizePageLocations,
    normalizeSentenceIdList,
    normalizeNotePosition,
} from '../types/proposedActions/annotations';
import type { CreateItemProposedData } from '../types/proposedActions/items';

// =============================================================================
// Agent Action Types
// =============================================================================

/**
 * Agent action model - parallel to ProposedAction but uses run_id instead of message_id.
 * Created during agent runs via WebSocket streaming.
 */
export interface AgentAction {
    // Identity
    id: string;
    run_id: string;
    toolcall_id?: string;
    user_id?: string;

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
    created_at?: string;
    updated_at?: string;
}

/**
 * Type guard for highlight annotation actions
 */
export const isHighlightAnnotationAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'highlight_annotation';
};

/**
 * Type guard for note annotation actions
 */
export const isNoteAnnotationAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'note_annotation';
};

/**
 * Type guard for any annotation action
 */
export const isAnnotationAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'highlight_annotation' || action.action_type === 'note_annotation';
};

/**
 * Type guard for zotero note actions
 */
export const isZoteroNoteAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'zotero_note';
};

/**
 * Type guard for create item actions
 */
export const isCreateItemAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'create_item';
};

/**
 * Check if an agent action has been applied and has a Zotero item reference
 */
export const hasAppliedZoteroItem = (action: AgentAction): boolean => {
    return action.status === 'applied' && 
           !!action.result_data?.zotero_key && 
           !!action.result_data?.library_id;
};

/**
 * Get Zotero item reference from an applied agent action
 */
export const getZoteroItemReferenceFromAgentAction = (action: AgentAction): ZoteroItemReference | null => {
    if (!hasAppliedZoteroItem(action)) {
        return null;
    }
    return {
        library_id: action.result_data!.library_id,
        zotero_key: action.result_data!.zotero_key
    } as ZoteroItemReference;
};

/**
 * Get Zotero item from an applied agent action
 */
export const getZoteroItemFromAgentAction = async (action: AgentAction): Promise<Zotero.Item | null> => {
    const ref = getZoteroItemReferenceFromAgentAction(action);
    if (!ref) return null;
    return (await Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key)) || null;
};

// =============================================================================
// Deserialization
// =============================================================================

/**
 * Deserializes and normalizes a raw agent action object from the backend
 * into a typed AgentAction object.
 */
export function toAgentAction(raw: Record<string, any>): AgentAction {
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
        const rawTag = proposedData.raw_tag ?? proposedData.rawTag;

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
            raw_tag: typeof rawTag === 'string' ? rawTag : undefined,
        } as NoteProposedData;
    } else if (actionType === 'create_item') {
        proposedData = {
            item: proposedData.item ?? {},
            reason: proposedData.reason,
            relevance_score: proposedData.relevance_score ?? proposedData.relevanceScore,
            file_available: proposedData.file_available ?? proposedData.fileAvailable ?? false,
            downloaded_url: proposedData.downloaded_url ?? proposedData.downloadedUrl,
            storage_path: proposedData.storage_path ?? proposedData.storagePath,
            text_path: proposedData.text_path ?? proposedData.textPath,
            collection_keys: proposedData.collection_keys ?? proposedData.collectionKeys,
            suggested_tags: proposedData.suggested_tags ?? proposedData.suggestedTags,
        } as CreateItemProposedData;
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
    } else if (resultData && actionType === 'create_item') {
        const zoteroKey = resultData.zotero_key ?? resultData.zoteroKey ?? resultData.item_key ?? resultData.itemKey;
        const libraryId = resultData.library_id ?? resultData.libraryId;
        
        if (zoteroKey) {
            resultData = {
                zotero_key: String(zoteroKey),
                library_id: typeof libraryId === 'number' ? libraryId : Number(libraryId ?? 0),
                attachment_keys: resultData.attachment_keys ?? resultData.attachmentKeys,
                file_hash: resultData.file_hash ?? resultData.fileHash,
                storage_path: resultData.storage_path ?? resultData.storagePath,
            };
        }
    }

    return {
        id: raw.id,
        run_id: raw.run_id ?? raw.runId,
        toolcall_id: raw.toolcall_id ?? raw.toolcallId,
        user_id: raw.user_id ?? raw.userId,
        action_type: actionType,
        status: raw.status ?? 'pending',
        error_message: raw.error_message ?? raw.errorMessage,
        proposed_data: proposedData,
        error_details: raw.error_details ?? raw.validationErrors,
        result_data: resultData,
        created_at: raw.created_at ?? raw.createdAt,
        updated_at: raw.updated_at ?? raw.updatedAt,
    };
}

// =============================================================================
// State Atoms
// =============================================================================

/**
 * All agent actions for the current thread/session.
 */
export const threadAgentActionsAtom = atom<AgentAction[]>([]);

// =============================================================================
// Derived Atoms - Group by toolcall_id
// =============================================================================

function groupActionsByToolcall(actions: AgentAction[]): Map<string, AgentAction[]> {
    const grouped = new Map<string, AgentAction[]>();
    actions.forEach((action) => {
        const targetId = action.toolcall_id;
        if (!targetId) return;
        if (!grouped.has(targetId)) {
            grouped.set(targetId, []);
        }
        grouped.get(targetId)!.push(action);
    });
    return grouped;
}

export const agentActionsByToolcallAtom = atom<Map<string, AgentAction[]>>((get) => {
    const actions = get(threadAgentActionsAtom);
    return groupActionsByToolcall(actions);
});

export const getAgentActionsByToolcallAtom = atom(
    (get) => (toolcallId: string, filter: (action: AgentAction) => boolean = () => true) => 
        get(agentActionsByToolcallAtom).get(toolcallId)?.filter(filter) || []
);

// =============================================================================
// Derived Atoms - Group by run_id
// =============================================================================

function groupActionsByRun(actions: AgentAction[]): Map<string, AgentAction[]> {
    const grouped = new Map<string, AgentAction[]>();
    actions.forEach((action) => {
        const targetId = action.run_id;
        if (!targetId) return;
        if (!grouped.has(targetId)) {
            grouped.set(targetId, []);
        }
        grouped.get(targetId)!.push(action);
    });
    return grouped;
}

export const agentActionsByRunAtom = atom<Map<string, AgentAction[]>>((get) => {
    const actions = get(threadAgentActionsAtom);
    return groupActionsByRun(actions);
});

export const getAgentActionsByRunAtom = atom(
    (get) => (runId: string, filter: (action: AgentAction) => boolean = () => true) => 
        get(agentActionsByRunAtom).get(runId)?.filter(filter) || []
);

export const getAgentActionByIdAtom = atom(
    (get) => (actionId: string): AgentAction | null => {
        return get(threadAgentActionsAtom).find((action) => action.id === actionId) ?? null;
    }
);

/**
 * Get a note agent action by matching raw_tag within a specific run.
 * Used for streaming when note tags don't have an id attribute.
 */
export const getAgentNoteActionByRawTagAtom = atom(
    (get) => (runId: string, rawTag: string): AgentAction | null => {
        return get(threadAgentActionsAtom).find((action) => 
            action.run_id === runId &&
            action.action_type === 'zotero_note' &&
            action.proposed_data?.raw_tag === rawTag
        ) ?? null;
    }
);

// =============================================================================
// Mutation Atoms
// =============================================================================

/**
 * Add agent actions to the thread state
 */
export const addAgentActionsAtom = atom(
    null,
    (_, set, actions: AgentAction[]) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => [...prev, ...actions]);
    }
);

/**
 * Delete agent actions by IDs
 */
export const deleteAgentActionsAtom = atom(
    null,
    (_, set, actionIds: string[]) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => 
            prev.filter((action) => !actionIds.includes(action.id))
        );
    }
);

export type AgentActionUpdate = Partial<AgentAction> & { id: string };

/**
 * Update multiple agent actions
 */
export const updateAgentActionsAtom = atom(
    null,
    (_, set, updates: AgentActionUpdate[]) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            const updateMap = new Map(updates.map((update) => [update.id, update]));
            return prev.map((action) => 
                updateMap.has(action.id) 
                    ? { ...action, ...updateMap.get(action.id)! } 
                    : action
            );
        });
    }
);

/**
 * Set agent actions to applied status with result data
 */
export const applyAgentActionsAtom = atom(
    null,
    (_, set, results: Array<{ action_id: string; result_data: Record<string, any> }>) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            const resultMap = new Map(results.map((r) => [r.action_id, r.result_data]));
            return prev.map((action) => {
                const resultData = resultMap.get(action.id);
                return resultData
                    ? { ...action, status: 'applied' as ActionStatus, result_data: resultData }
                    : action;
            });
        });
    }
);

/**
 * Set agent actions to error status
 */
export const setAgentActionsToErrorAtom = atom(
    null,
    (_, set, actionIds: string[], errorMessage: string) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => 
                actionIds.includes(action.id)
                    ? { ...action, status: 'error' as ActionStatus, error_message: errorMessage }
                    : action
            );
        });
        // Note: Backend persistence for agent actions will be added when the API endpoints are available
        for (const actionId of actionIds) {
            logger(`setAgentActionsToErrorAtom: Set action ${actionId} to error: ${errorMessage}`, 1);
        }
    }
);

/**
 * Reject an agent action
 */
export const rejectAgentActionAtom = atom(
    null,
    (_, set, actionId: string) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => action.id === actionId
                ? { ...action, status: 'rejected' as ActionStatus, result_data: undefined, error_message: undefined }
                : action
            );
        });
        // Note: Backend persistence for agent actions will be added when the API endpoints are available
        logger(`rejectAgentActionAtom: Rejected action ${actionId}`, 1);
    }
);

/**
 * Undo an applied agent action
 */
export const undoAgentActionAtom = atom(
    null,
    (_, set, actionId: string) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => action.id === actionId
                ? { ...action, status: 'undone' as ActionStatus, result_data: undefined, error_message: undefined }
                : action
            );
        });
        // Note: Backend persistence for agent actions will be added when the API endpoints are available
        logger(`undoAgentActionAtom: Undone action ${actionId}`, 1);
    }
);

/**
 * Clear all agent actions (e.g., when switching threads)
 */
export const clearAgentActionsAtom = atom(
    null,
    (_, set) => {
        set(threadAgentActionsAtom, []);
    }
);

