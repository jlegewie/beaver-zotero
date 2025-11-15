import { atom } from 'jotai';
import { proposedActionsService, AckLink } from '../../src/services/proposedActionsService';
import { logger } from '../../src/utils/logger';
import {
    ProposedAction,
} from '../types/chat/proposedActions';


/*
 * Proposed actions for the current thread.
 */
export const threadProposedActionsAtom = atom<ProposedAction[]>([]);


/*
 * Proposed actions by toolcall.
 */
function groupActionsByToolcall(actions: ProposedAction[]): Map<string, ProposedAction[]> {
    const grouped = new Map<string, ProposedAction[]>();
    actions.forEach((action) => {
        const targetId = action.toolcall_id;
        if (!targetId) {
            return;
        }
        if (!grouped.has(targetId)) {
            grouped.set(targetId, []);
        }
        grouped.get(targetId)!.push(action);
    });
    return grouped;
}

export const proposedActionsByToolcallAtom = atom<Map<string, ProposedAction[]>>((get) => {
    const actions = get(threadProposedActionsAtom);
    return groupActionsByToolcall(actions);
});

export const getProposedActionsByToolcallAtom = atom(
    (get) => (toolcallId: string, filter: (action: ProposedAction) => boolean = () => true) => get(proposedActionsByToolcallAtom).get(toolcallId)?.filter(filter) || []
);

/*
 * Proposed actions by message.
 */
function groupActionsByMessage(actions: ProposedAction[]): Map<string, ProposedAction[]> {
    const grouped = new Map<string, ProposedAction[]>();
    actions.forEach((action) => {
        const targetId = action.message_id;
        if (!targetId) {
            return;
        }
        if (!grouped.has(targetId)) {
            grouped.set(targetId, []);
        }
        grouped.get(targetId)!.push(action);
    });
    return grouped;
}

export const proposedActionsByMessageAtom = atom<Map<string, ProposedAction[]>>((get) => {
    const actions = get(threadProposedActionsAtom);
    return groupActionsByMessage(actions);
});

export const getProposedActionsByMessageAtom = atom(
    (get) => (messageId: string, filter: (action: ProposedAction) => boolean = () => true) => get(proposedActionsByMessageAtom).get(messageId)?.filter(filter) || []
);

/*
 * Add, delete, and update proposed actions in the thread.
 */
export const addProposedActionsAtom = atom(
    null,
    (_, set, actions: ProposedAction[]) => {
        set(threadProposedActionsAtom, (prev: ProposedAction[]) => [...prev, ...actions]);
    }
);

export const deleteProposedActionsAtom = atom(
    null,
    (_, set, actionIds: string[]) => {
        set(threadProposedActionsAtom, (prev: ProposedAction[]) => prev.filter((action) => !actionIds.includes(action.id)));
    }
);

export type ProposedActionUpdate = Partial<ProposedAction> & { id: string };

export const updateProposedActionsAtom = atom(
    null,
    (_, set, updates: ProposedActionUpdate[]) => {
        set(threadProposedActionsAtom, (prev: ProposedAction[]) => {
            const updateMap = new Map(updates.map((update) => [update.id, update]));
            return prev.map((action) => updateMap.has(action.id) ? { ...action, ...updateMap.get(action.id)! } : action);
        });
    }
);

export const ackProposedActionsAtom = atom(
    null,
    async (_, set, messageId: string, actionResultData: AckLink[]) => {

        // Frontend: Update UI state
        set(threadProposedActionsAtom, (prev: ProposedAction[]) => {
            const actionIds = actionResultData.map((result) => result.action_id);
            return prev
                .map((action) => actionIds.includes(action.id)
                    ? {
                        ...action,
                        status: 'applied',
                        result_data: actionResultData.find((result) => result.action_id === action.id)?.result_data
                    }
                    : action
                );
        });

        // Backend: Acknowledge annotations
        const response = await proposedActionsService.acknowledgeActions(
            messageId,
            actionResultData
        );
        // TODO: Reset if backend update fails!?
        if (!response.success) {
            logger(`ackProposedActionsAtom: failed to acknowledge actions for message ${messageId}: ${response.errors.map((error) => error.detail).join(', ')}`, 1);
            return;
        }
        return response;
    }
);

export const setProposedActionsToErrorAtom = atom(
    null,
    (_, set, actionIds: string[], errorMessage: string) => {
        set(threadProposedActionsAtom, (prev: ProposedAction[]) => {
            return prev
                .map((action) => actionIds.includes(action.id)
                    ? { ...action, status: 'error', error_message: errorMessage }
                    : action
                );
        });
        for (const actionId of actionIds) {
            proposedActionsService.updateAction(actionId, {
                status: 'error',
                error_message: errorMessage,
            }).catch((error) => {
                logger(`setProposedActionsToErrorAtom: failed to persist error status for action ${actionId}: ${error}`, 1);
            })
        }
    }
);

export const rejectProposedActionStateAtom = atom(
    null,
    (_, set, actionId: string) => {
        // Update UI state
        set(threadProposedActionsAtom, (prev: ProposedAction[]) => {
            return prev.map((action) => action.id === actionId
                ? { ...action, status: 'rejected', result_data: undefined, error_message: undefined }
                : action
            );
        });
        // Update backend state
        proposedActionsService.updateAction(actionId, {
            status: 'rejected',
            result_data: undefined,
            error_message: undefined,
        }).catch((error) => {
            logger(`rejectProposedActionAtom: failed to persist state for action ${actionId}: ${error}`, 1);
        });

    }
);

export const undoProposedActionAtom = atom(
    null,
    (_, set, actionId: string) => {
        // Update UI state
        set(threadProposedActionsAtom, (prev: ProposedAction[]) => {
            return prev.map((action) => action.id === actionId
                ? { ...action, status: 'undone', result_data: undefined, error_message: undefined }
                : action
            );
        });
        // Update backend state
        proposedActionsService.updateAction(actionId, {
            status: 'undone',
            result_data: undefined,
            error_message: undefined,
        }).catch((error) => {
            logger(`undoProposedActionStateAtom: failed to persist state for action ${actionId}: ${error}`, 1);
        });

    }
);


// export const addProposedActionsAtom = atom(
//     null,
//     (get, set, { toolcallId, actions }: { toolcallId?: string | null; actions: ProposedAction[] }) => {
//         if (actions.length === 0) {
//             return;
//         }
//         set(proposedActionsByToolcallAtom, (prevMap) => {
//             const newMap = new Map(prevMap);
//             const grouped = groupActionsByToolcall(actions, toolcallId);
//             grouped.forEach((groupActions, groupId) => {
//                 const existing = newMap.get(groupId) || [];
//                 const merged = mergeProposedActions(existing, groupActions);
//                 newMap.set(groupId, merged);
//             });
//             return newMap;
//         });
//     }
// );


// export const upsertProposedActionsAtom = atom(
//     null,
//     (get, set, { toolcallId, actions }: { toolcallId?: string | null; actions: ProposedAction[] }) => {
//         if (actions.length === 0) {
//             return;
//         }
//         set(proposedActionsByToolcallAtom, (prevMap) => {
//             const newMap = new Map(prevMap);
//             const grouped = groupActionsByToolcall(actions, toolcallId);
//             grouped.forEach((groupActions, groupId) => {
//                 const existing = newMap.get(groupId) || [];
//                 const merged = mergeProposedActions(existing, groupActions);
//                 newMap.set(groupId, merged);
//             });
//             return newMap;
//         });
//     }
// );

// export const updateProposedActionAtom = atom(
//     null,
//     (
//         get,
//         set,
//         {
//             toolcallId,
//             actionId,
//             updates,
//         }: { toolcallId?: string | null; actionId?: string; updates: Partial<ProposedAction> }
//     ) => {
//         const targetId = normalizeToolcallId(toolcallId);
//         set(proposedActionsByToolcallAtom, (prevMap) => {
//             const existing = prevMap.get(targetId);
//             if (!existing) return prevMap;
//             const updated = existing.map((action) =>
//                 !actionId || action.id === actionId ? { ...action, ...updates } : action
//             );
//             const newMap = new Map(prevMap);
//             newMap.set(targetId, updated);
//             return newMap;
//         });
//     }
// );

// export interface ProposedActionUpdates {
//     actionId: string;
//     updates: Partial<ProposedAction>;
// }

// export const updateProposedActionsAtom = atom(
//     null,
//     (
//         get,
//         set,
//         {
//             toolcallId,
//             updates,
//         }: { toolcallId?: string | null; updates: ProposedActionUpdates[] }
//     ) => {
//         const targetId = normalizeToolcallId(toolcallId);
//         set(proposedActionsByToolcallAtom, (prevMap) => {
//             const existing = prevMap.get(targetId);
//             if (!existing) return prevMap;
//             const updatesById = new Map(updates.map((u) => [u.actionId, u.updates]));
//             const updated = existing.map((action) => {
//                 const actionUpdates = updatesById.get(action.id);
//                 return actionUpdates ? { ...action, ...actionUpdates } : action;
//             });
//             const newMap = new Map(prevMap);
//             newMap.set(targetId, updated);
//             return newMap;
//         });
//     }
// );

