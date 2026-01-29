import { atom } from 'jotai';
import { logger } from '../../src/utils/logger';
import { agentActionsService, AckActionLink } from '../../src/services/agentActionsService';
import { ZoteroItemReference } from '../types/zotero';
import {
    ActionStatus,
    ActionType,
    NoteProposedData,
    EditMetadataProposedData,
} from '../types/agentActions/base';
import {
    normalizePageLocations,
    normalizeSentenceIdList,
    normalizeNotePosition,
} from '../types/agentActions/annotations';
import type { CreateItemProposedData, CreateItemResultData } from '../types/agentActions/items';
import type { WSDeferredApprovalRequest, AgentActionType } from '../../src/services/agentProtocol';

// =============================================================================
// Agent Action Types
// =============================================================================

/**
 * Agent action model
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
export const isCreateItemAgentAction = (action: AgentAction): action is CreateItemAgentAction => {
    return action.action_type === 'create_item';
};

/**
 * Type guard for edit metadata actions
 */
export const isEditMetadataAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'edit_metadata';
};

/**
 * Type guard for create collection actions
 */
export const isCreateCollectionAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'create_collection';
};

/**
 * Type guard for organize items actions
 */
export const isOrganizeItemsAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'organize_items';
};

/**
 * Typed agent action for create_item actions
 */
export type CreateItemAgentAction = AgentAction & {
    action_type: 'create_item';
    proposed_data: CreateItemProposedData;
    result_data?: CreateItemResultData;
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

/**
 * Validates that an applied agent action is still valid.
 * @param action - The agent action to validate
 * @returns True if the action is valid, false otherwise
 */
export const validateAppliedAgentAction = async (action: AgentAction): Promise<boolean> => {
    // If action doesn't have an applied Zotero item, it's valid (nothing to check)
    if (!hasAppliedZoteroItem(action)) return true;

    // Get the Zotero item from the agent action
    const item = await getZoteroItemFromAgentAction(action);
    if (!item) return false;

    // For annotation actions, verify the item is still an annotation
    if (isAnnotationAgentAction(action) && !item.isAnnotation()) return false;

    return true;
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
    } else if (actionType === 'edit_metadata') {
        // Normalize edit_metadata proposed data
        const edits = Array.isArray(proposedData.edits) ? proposedData.edits : [];
        proposedData = {
            library_id: typeof proposedData.library_id === 'number' 
                ? proposedData.library_id 
                : Number(proposedData.library_id ?? proposedData.libraryId ?? 0),
            zotero_key: proposedData.zotero_key ?? proposedData.zoteroKey ?? '',
            edits: edits.map((edit: any) => ({
                field: edit.field ?? '',
                old_value: edit.old_value ?? edit.oldValue ?? null,
                new_value: edit.new_value ?? edit.newValue ?? null,
            })),
        } as EditMetadataProposedData;
    } else if (actionType === 'create_collection') {
        // Normalize create_collection proposed data
        proposedData = {
            library_id: typeof proposedData.library_id === 'number' 
                ? proposedData.library_id 
                : Number(proposedData.library_id ?? proposedData.libraryId ?? 0),
            name: proposedData.name ?? '',
            parent_key: proposedData.parent_key ?? proposedData.parentKey ?? null,
            item_ids: proposedData.item_ids ?? proposedData.itemIds ?? [],
        };
    } else if (actionType === 'organize_items') {
        // Normalize organize_items proposed data
        proposedData = {
            item_ids: proposedData.item_ids ?? proposedData.itemIds ?? [],
            tags: proposedData.tags ?? null,
            collections: proposedData.collections ?? null,
            current_state: proposedData.current_state ?? proposedData.currentState ?? null,
        };
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
 * Compare two raw tag strings for equality.
 * Used to match against the raw_tag from agent actions.
 */
function tagsMatch(tag1: string, tag2: string): boolean {
    const parseTag = (tag: string) => {
        const match = tag.match(/<(\w+)([^>]*)>/);
        if (!match) return null;
        
        const tagName = match[1];
        const attrsString = match[2];
        
        // Extract attributes
        const attrs: Record<string, string> = {};
        const attrRegex = /(\w+)="([^"]*)"/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attrsString)) !== null) {
            attrs[attrMatch[1]] = attrMatch[2];
        }
        
        return { tagName, attrs };
    };
    
    const parsed1 = parseTag(tag1);
    const parsed2 = parseTag(tag2);
    
    if (!parsed1 || !parsed2) return false;
    if (parsed1.tagName !== parsed2.tagName) return false;
    
    // Compare attributes
    const keys1 = Object.keys(parsed1.attrs).sort();
    const keys2 = Object.keys(parsed2.attrs).sort();
    
    if (keys1.length !== keys2.length) return false;
    
    return keys1.every((key, i) => 
        key === keys2[i] && parsed1.attrs[key] === parsed2.attrs[key]
    );
}

/**
 * Get a note agent action by matching raw_tag within a specific run.
 * Used for streaming when note tags don't have an id attribute.
 */
export const getAgentNoteActionByRawTagAtom = atom(
    (get) => (runId: string, rawTag: string): AgentAction | null => {
        return get(threadAgentActionsAtom).find((action) => 
            action.run_id === runId &&
            action.action_type === 'zotero_note' &&
            tagsMatch(action.proposed_data?.raw_tag ?? '', rawTag)
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
 * Upsert agent actions - updates existing actions (by id) or adds new ones.
 * Used when receiving agent_actions events which may contain updates to existing actions.
 */
export const upsertAgentActionsAtom = atom(
    null,
    (_, set, newActions: AgentAction[]) => {
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            const newActionsById = new Map(newActions.map(a => [a.id, a]));
            
            // Update existing actions if they match
            const updated = prev.map(existing => {
                const update = newActionsById.get(existing.id);
                if (update) {
                    newActionsById.delete(existing.id); // Mark as processed
                    return { ...existing, ...update };
                }
                return existing;
            });
            
            // Add remaining new actions (those not already in the list)
            const additions = Array.from(newActionsById.values());
            return [...updated, ...additions];
        });
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
 * Acknowledge agent actions as applied with result data.
 * Updates both UI state and backend.
 */
export const ackAgentActionsAtom = atom(
    null,
    async (_, set, runId: string, actionResultData: AckActionLink[]) => {
        // Frontend: Update UI state
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            const actionIds = actionResultData.map((result) => result.action_id);
            return prev.map((action) => 
                actionIds.includes(action.id)
                    ? {
                        ...action,
                        status: 'applied' as ActionStatus,
                        result_data: actionResultData.find((result) => result.action_id === action.id)?.result_data
                    }
                    : action
            );
        });

        // Backend: Acknowledge actions
        const response = await agentActionsService.acknowledgeActions(
            runId,
            actionResultData
        );
        if (!response.success) {
            logger(`ackAgentActionsAtom: failed to acknowledge actions for run ${runId}: ${response.errors.map((error) => error.detail).join(', ')}`, 1);
            return;
        }
        return response;
    }
);

/**
 * Set agent actions to error status.
 * Updates both UI state and backend.
 */
export const setAgentActionsToErrorAtom = atom(
    null,
    (_, set, actionIds: string[], errorMessage: string) => {
        // Frontend: Update UI state
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => 
                actionIds.includes(action.id)
                    ? { ...action, status: 'error' as ActionStatus, error_message: errorMessage }
                    : action
            );
        });
        // Backend: Update each action
        for (const actionId of actionIds) {
            agentActionsService.updateAction(actionId, {
                status: 'error',
                error_message: errorMessage,
            }).catch((error) => {
                logger(`setAgentActionsToErrorAtom: failed to persist error status for action ${actionId}: ${error}`, 1);
            });
        }
    }
);

/**
 * Reject an agent action.
 * Updates both UI state and backend.
 */
export const rejectAgentActionAtom = atom(
    null,
    (_, set, actionId: string) => {
        // Frontend: Update UI state
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => action.id === actionId
                ? { ...action, status: 'rejected' as ActionStatus, result_data: undefined, error_message: undefined }
                : action
            );
        });
        // Backend: Update action state
        agentActionsService.updateAction(actionId, {
            status: 'rejected',
            clear_result_data: true,
            clear_error_message: true,
        }).catch((error) => {
            logger(`rejectAgentActionAtom: failed to persist state for action ${actionId}: ${error}`, 1);
        });
    }
);

/**
 * Undo an applied agent action.
 * Updates both UI state and backend.
 */
export const undoAgentActionAtom = atom(
    null,
    (_, set, actionId: string) => {
        // Frontend: Update UI state
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => action.id === actionId
                ? { ...action, status: 'undone' as ActionStatus, result_data: undefined, error_message: undefined }
                : action
            );
        });
        // Backend: Update action state
        agentActionsService.updateAction(actionId, {
            status: 'undone',
            clear_result_data: true,
            clear_error_message: true,
        }).catch((error) => {
            logger(`undoAgentActionAtom: failed to persist state for action ${actionId}: ${error}`, 1);
        });
    }
);

/**
 * Find a pending create_item agent action by source_id
 * Used to sync imports from ExternalSearchResultView with agent actions
 */
export const getPendingCreateItemActionBySourceIdAtom = atom(
    (get) => (sourceId: string): CreateItemAgentAction | null => {
        const actions = get(threadAgentActionsAtom);
        return actions.find(
            (action): action is CreateItemAgentAction =>
                isCreateItemAgentAction(action) &&
                (action.status === 'pending' || action.status === 'undone' || action.status === 'error' || action.status === 'rejected') &&
                action.proposed_data.item.source_id === sourceId
        ) ?? null;
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


// =============================================================================
// Deferred Tool Approval State
// =============================================================================

/**
 * Pending approval request from the backend.
 * When set, the UI should show an approval dialog for this action.
 * Multiple approvals can be pending simultaneously for parallel tool calls.
 */
export interface PendingApproval {
    actionId: string;
    /** Tool call ID for UI matching (always provided by backend) */
    toolcallId: string;
    actionType: AgentActionType;
    actionData: Record<string, any>;
    currentValue?: any;
}

/**
 * Atom storing all pending approval requests, keyed by actionId.
 * Supports multiple parallel approvals for parallel tool calls.
 */
export const pendingApprovalsAtom = atom<Map<string, PendingApproval>>(new Map());

/**
 * Add a pending approval from a WS event.
 * Supports multiple concurrent approvals for parallel tool calls.
 */
export const addPendingApprovalAtom = atom(
    null,
    (_, set, event: WSDeferredApprovalRequest) => {
        set(pendingApprovalsAtom, (prev) => {
            const next = new Map(prev);
            next.set(event.action_id, {
                actionId: event.action_id,
                toolcallId: event.toolcall_id,
                actionType: event.action_type as AgentActionType,
                actionData: event.action_data,
                currentValue: event.current_value,
            });
            return next;
        });
    }
);

/**
 * Remove a specific pending approval by actionId (after user responds).
 */
export const removePendingApprovalAtom = atom(
    null,
    (_, set, actionId: string) => {
        set(pendingApprovalsAtom, (prev) => {
            const next = new Map(prev);
            next.delete(actionId);
            return next;
        });
    }
);

/**
 * Clear all pending approvals (e.g., when switching threads or on run complete).
 */
export const clearAllPendingApprovalsAtom = atom(
    null,
    (_, set) => {
        set(pendingApprovalsAtom, new Map());
    }
);

/**
 * Get pending approval for a specific toolcall_id.
 * Searches the map for an approval matching the toolcall_id.
 */
export const getPendingApprovalForToolcallAtom = atom(
    (get) => (toolcallId: string): PendingApproval | null => {
        const pendingMap = get(pendingApprovalsAtom);
        for (const pending of pendingMap.values()) {
            if (pending.toolcallId === toolcallId) {
                return pending;
            }
        }
        return null;
    }
);

/**
 * Check if there are any pending approvals.
 */
export const hasPendingApprovalsAtom = atom(
    (get) => get(pendingApprovalsAtom).size > 0
);

/**
 * Build a PendingApproval from an AgentAction.
 * Fetches current field values for edit_metadata actions.
 */
export async function buildPendingApprovalFromAction(action: AgentAction): Promise<PendingApproval | null> {
    if (!action.toolcall_id) {
        return null;
    }

    const actionType = action.action_type as AgentActionType;
    const actionData = action.proposed_data ?? {};
    let currentValue: Record<string, string | null> | undefined;

    if (actionType === 'edit_metadata') {
        const libraryId = typeof actionData.library_id === 'number'
            ? actionData.library_id
            : Number(actionData.library_id ?? 0);
        const zoteroKey = typeof actionData.zotero_key === 'string'
            ? actionData.zotero_key
            : '';
        const edits = Array.isArray(actionData.edits) ? actionData.edits : [];

        if (libraryId && zoteroKey && edits.length > 0) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
            if (item) {
                const values: Record<string, string | null> = {};
                for (const edit of edits) {
                    const field = typeof edit?.field === 'string' ? edit.field : null;
                    if (!field) continue;
                    const value = item.getField(field);
                    values[field] = value ? String(value) : null;
                }
                currentValue = values;
            }
        }
    } else if (actionType === 'create_collection') {
        const libraryId = typeof actionData.library_id === 'number'
            ? actionData.library_id
            : Number(actionData.library_id ?? 0);

        if (libraryId) {
            const library = Zotero.Libraries.get(libraryId);
            currentValue = {
                library_name: library ? library.name : 'Unknown Library',
                parent_key: actionData.parent_key ?? null,
                item_count: actionData.item_ids?.length ?? 0,
            };
        }
    } else if (actionType === 'organize_items') {
        // For organize_items, current_state contains the current tags/collections for each item
        // We can use it directly from the proposed data if available
        currentValue = actionData.current_state ?? null;
    }

    return {
        actionId: action.id,
        toolcallId: action.toolcall_id,
        actionType,
        actionData,
        currentValue,
    };
}

