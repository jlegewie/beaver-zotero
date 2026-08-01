import { atom } from 'jotai';
import { logger } from '../../src/utils/logger';
import { isLibraryReferencePortable, resolveItemReference } from '../../src/utils/libraryIdentity';
import { dismissDiffPreview } from '../utils/noteEditorDiffPreview';
import { updateDiffPreviewForNote, diffPreviewNoteKeyAtom } from '../utils/diffPreviewCoordinator';
import { agentActionsService, AckActionLink } from '../../src/services/agentActionsService';
import { notifyApprovalRequest } from '../../src/services/systemNotifications';
import type { ZoteroItemReference } from '../types/zotero';
import type { ActionStatus } from '../types/agentActions/base';
import type { WSDeferredApprovalRequest, AgentActionType } from '../../src/services/agentProtocol';
import {
    AgentAction,
    CreateItemAgentAction,
    isCreateItemAgentAction,
    isCreateAnnotationsAgentAction,
    isAnnotationAgentAction,
    hasAppliedZoteroItem,
    hasAppliedBulkAnnotations,
    getZoteroItemReferenceFromAgentAction,
} from './agentActionTypes';

export * from './agentActionTypes';

// =============================================================================
// Applied Action Validation
// =============================================================================

/**
 * Get Zotero item from an applied agent action
 */
export const getZoteroItemFromAgentAction = async (action: AgentAction): Promise<Zotero.Item | null> => {
    const ref = getZoteroItemReferenceFromAgentAction(action);
    if (!ref) return null;
    const resolved = await resolveItemReference(ref);
    return resolved.status === 'found' ? resolved.item : null;
};

/**
 * Validation result for an applied agent action.
 *
 * - 'valid': the applied item was found and matches expectations.
 * - 'invalid': the item is verifiably gone (or has the wrong type). The user
 *   reverted the action in Zotero.
 * - 'unverifiable': the reference cannot be checked on this device.
 */
export type AppliedActionValidity = 'valid' | 'invalid' | 'unverifiable';

const checkAppliedReference = async (
    ref: ZoteroItemReference,
    mustBeAnnotation: boolean
): Promise<AppliedActionValidity> => {
    const resolved = await resolveItemReference(ref);
    if (resolved.status === 'library_unavailable') return 'unverifiable';
    if (resolved.status === 'not_found') {
        // "Not found" is only proof of deletion when the reference identifies
        // its library portably. A legacy reference (no library_ref) into a
        // group library resolves through a device-local library_id, so a miss
        // may just mean that id maps to a different group on this device — not
        // that the item is gone. Treat that as unverifiable, never a revert.
        return isLibraryReferencePortable(ref) ? 'invalid' : 'unverifiable';
    }
    return mustBeAnnotation && !resolved.item.isAnnotation() ? 'invalid' : 'valid';
};

/**
 * Validates that an applied agent action is still valid on this device.
 * @param action - The agent action to validate
 * @returns 'valid', 'invalid' (verifiably reverted), or 'unverifiable'
 */
export const validateAppliedAgentAction = async (action: AgentAction): Promise<AppliedActionValidity> => {
    if (isCreateAnnotationsAgentAction(action)) {
        if (!hasAppliedBulkAnnotations(action)) return 'valid';
        const created = action.result_data?.created ?? [];
        let unverifiable = false;
        for (const ref of created) {
            const validity = await checkAppliedReference(ref, true);
            if (validity === 'invalid') return 'invalid';
            if (validity === 'unverifiable') unverifiable = true;
        }
        return unverifiable ? 'unverifiable' : 'valid';
    }

    // If action doesn't have an applied Zotero item, it's valid (nothing to check)
    if (!hasAppliedZoteroItem(action)) return 'valid';

    const ref = getZoteroItemReferenceFromAgentAction(action);
    if (!ref) return 'valid';

    // For annotation actions, the resolved item must still be an annotation
    return checkAppliedReference(ref, isAnnotationAgentAction(action));
};

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
                    const merged = { ...existing, ...update };
                    // Preserve existing proposed_data when update has empty proposed_data
                    // (backend may send status updates without full proposed_data)
                    if (existing.proposed_data && Object.keys(existing.proposed_data).length > 0 &&
                        (!update.proposed_data || Object.keys(update.proposed_data).length === 0)) {
                        merged.proposed_data = existing.proposed_data;
                    }
                    // Same for result_data
                    if (existing.result_data && Object.keys(existing.result_data).length > 0 &&
                        (!update.result_data || Object.keys(update.result_data).length === 0)) {
                        merged.result_data = existing.result_data;
                    }
                    return merged;
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
    (_, set, actionIds: string[], errorMessage: string, errorDetails?: Record<string, any>) => {
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
                error_details: errorDetails,
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
            return prev.map((action) => {
                if (action.id !== actionId) return action;
                // Preserve undo-critical fields from result_data into proposed_data before
                // clearing, so the preview can show the before/after diff in the "undone" state.
                let proposed_data = action.proposed_data;
                if (action.result_data?.old_creators && !proposed_data?.old_creators) {
                    proposed_data = { ...proposed_data, old_creators: action.result_data.old_creators };
                }
                if (action.result_data?.undo_full_html && !proposed_data?.undo_full_html) {
                    proposed_data = { ...proposed_data, undo_full_html: action.result_data.undo_full_html };
                }
                return { ...action, proposed_data, status: 'undone' as ActionStatus, result_data: undefined, error_message: undefined };
            });
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
 * Find a pending create_item agent action by source_id.
 * Used to sync external-reference action buttons with pending create-item actions.
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

        // Trigger in-editor diff preview for edit_note / edit_note_batch approvals
        if (event.action_type === 'edit_note' || event.action_type === 'edit_note_batch') {
            const { library_id, zotero_key } = event.action_data || {};
            if (library_id != null && zotero_key) {
                updateDiffPreviewForNote(library_id, zotero_key);
            }
        }

        // Surface an OS-native notification if the user can't currently see
        // the approval UI (e.g. working in another app).
        notifyApprovalRequest(event);
    }
);

/**
 * Remove pending approvals in one map update, then refresh any affected note
 * previews from the final state. This avoids briefly re-showing a preview while
 * a same-group approval batch is being removed.
 */
export const removePendingApprovalsAtom = atom(
    null,
    (get, set, actionIds: Iterable<string>) => {
        const ids = new Set(actionIds);
        if (ids.size === 0) return;

        const prev = get(pendingApprovalsAtom);
        const affectedNotes = new Map<string, { libraryId: number; zoteroKey: string }>();
        for (const actionId of ids) {
            const removed = prev.get(actionId);
            if (removed?.actionType !== 'edit_note' && removed?.actionType !== 'edit_note_batch') continue;
            const libraryId = removed.actionData?.library_id;
            const zoteroKey = removed.actionData?.zotero_key;
            if (libraryId == null || !zoteroKey) continue;
            affectedNotes.set(`${libraryId}-${zoteroKey}`, { libraryId, zoteroKey });
        }

        set(pendingApprovalsAtom, (p) => {
            const next = new Map(p);
            for (const actionId of ids) next.delete(actionId);
            return next;
        });

        for (const { libraryId, zoteroKey } of affectedNotes.values()) {
            updateDiffPreviewForNote(libraryId, zoteroKey);
        }
    }
);

/** Remove a specific pending approval by actionId (after user responds). */
export const removePendingApprovalAtom = atom(
    null,
    (_get, set, actionId: string) => {
        set(removePendingApprovalsAtom, [actionId]);
    },
);

/**
 * Clear all pending approvals (e.g., when switching threads or on run complete).
 */
export const clearAllPendingApprovalsAtom = atom(
    null,
    (_, set) => {
        dismissDiffPreview();
        set(diffPreviewNoteKeyAtom, null);
        set(pendingApprovalsAtom, new Map());
    }
);

// Note: the run-blocking ask_user_question state (PendingQuestion,
// pendingQuestionsAtom, ...) lives in `./pendingQuestions.ts` — questions are
// deliberately NOT agent actions (no apply/undo/validate lifecycle).

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
    let currentValue: Record<string, any> | undefined;

    if (actionType === 'edit_metadata') {
        const libraryId = typeof actionData.library_id === 'number'
            ? actionData.library_id
            : Number(actionData.library_id ?? 0);
        const zoteroKey = typeof actionData.zotero_key === 'string'
            ? actionData.zotero_key
            : '';
        const edits = Array.isArray(actionData.edits) ? actionData.edits : [];
        const hasCreators = Array.isArray(actionData.creators) && actionData.creators.length > 0;

        if (libraryId && zoteroKey && (edits.length > 0 || hasCreators)) {
            const resolved = await resolveItemReference({
                library_id: libraryId,
                library_ref: typeof actionData.library_ref === 'string' ? actionData.library_ref : undefined,
                zotero_key: zoteroKey,
            });
            if (resolved.status === 'found') {
                const item = resolved.item;
                const values: Record<string, any> = {};
                for (const edit of edits) {
                    const field = typeof edit?.field === 'string' ? edit.field : null;
                    if (!field) continue;
                    const value = item.getField(field);
                    values[field] = value ? String(value) : null;
                }
                // Always include current creators for before/after tracking
                values.current_creators = item.getCreatorsJSON();
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
                library_id: libraryId,
                library_name: library ? library.name : 'Unknown Library',
                parent_key: actionData.parent_key ?? null,
                item_count: actionData.item_ids?.length ?? 0,
            };
        }
    } else if (actionType === 'organize_items') {
        // For organize_items, current_state contains the current tags/collections for each item
        // We can use it directly from the proposed data if available
        currentValue = actionData.current_state ?? null;
    } else if (actionType === 'confirm_extraction') {
        // No Zotero data fetching needed — cost info is entirely in proposed_data
        currentValue = undefined;
    } else if (actionType === 'confirm_external_search') {
        // No Zotero data fetching needed — cost info is entirely in proposed_data
        currentValue = undefined;
    } else if (actionType === 'edit_note' || actionType === 'edit_note_batch') {
        // No extra Zotero data fetching needed — old_string/new_string are in proposed_data
        currentValue = undefined;
    }

    return {
        actionId: action.id,
        toolcallId: action.toolcall_id,
        actionType,
        actionData,
        currentValue,
    };
}
