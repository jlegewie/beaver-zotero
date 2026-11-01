import { atom, type Atom, type Getter, type Setter } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { logger } from '@beaver/agent-core/platform/logger';
import { isLibraryReferencePortable, resolveItemReference, resolveLibraryRef } from '../../src/utils/libraryIdentity';
import { checkLibraryExcluded, getLibraryRevocations } from '../../src/services/agentDataProvider/utils';
import { dismissDiffPreview } from '../utils/noteEditorDiffPreview';
import { updateDiffPreviewForNote, noteLibraryIdFromActionData, diffPreviewNoteKeyAtom } from '../utils/diffPreviewCoordinator';
import { agentActionsService, AckActionLink } from '@beaver/agent-core/transport/clients/agentActionsService';
import { assertCredentialGeneration, getCredentialGeneration } from '@beaver/agent-core/transport/credentials';
import { notifyApprovalRequest } from '../../src/services/systemNotifications';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import type { ActionStatus } from '@beaver/agent-core/types/agentActions/base';
import type { WSDeferredApprovalRequest, AgentActionType, ExecutedAction, WSUndeliveredActionsInfo } from '@beaver/agent-core/protocol/agentProtocol';
// Declared in the shared host contract, since the render layer hands it to the
// host's in-stream action UI.
import type { PendingApproval } from '@beaver/agent-ui/host';
import {
    AgentAction,
    CreateItemAgentAction,
    isCreateItemAgentAction,
    isItemCreatingAgentAction,
    itemActionExternalId,
    type ItemCreatingAgentAction,
    isCreateAnnotationsAgentAction,
    isEditAnnotationsAgentAction,
    isAnnotationAgentAction,
    hasAppliedZoteroItem,
    hasAppliedBulkAnnotations,
    getZoteroItemReferenceFromAgentAction,
    toAgentAction,
    isUnconfirmedAction,
} from '@beaver/agent-core/agents/agentActionTypes';
import { activeRunAtom, threadRunsAtom } from '@beaver/agent-core/run-state/atoms';
import { getPendingApprovalIdsCoveredByFullAccess } from '../atoms/runApprovalPolicy';
import { findPendingApprovalForToolcall } from '../components/agentRuns/editNoteShared';

export * from '@beaver/agent-core/agents/agentActionTypes';

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
    mustBeAnnotation: boolean,
    // Actions that only move an item to the trash leave it resolvable, so its
    // existence proves nothing: being trashed *is* the applied state. Restoring
    // it from the trash is the user reverting the action.
    mustBeTrashed: boolean = false
): Promise<AppliedActionValidity> => {
    // Validation reads live Zotero state and can flip the action to "undone"
    // both locally and on the backend, so it stays behind the exclusion
    // boundary — unlike rendering persisted history, which is allowed. An
    // excluded library is simply not checkable; the status is left alone.
    const libraryId = resolveLibraryRef(ref);
    if (libraryId !== null && checkLibraryExcluded(libraryId)) return 'unverifiable';
    const resolved = await resolveItemReference(ref);
    if (resolved.status === 'library_unavailable') return 'unverifiable';
    if (resolved.status === 'not_found') {
        // "Not found" is only decisive when the reference identifies its
        // library portably. A legacy reference (no library_ref) into a group
        // library resolves through a device-local library_id, so a miss may
        // just mean that id maps to a different group on this device — not
        // that the item is gone. Never conclude anything from that.
        if (!isLibraryReferencePortable(ref)) return 'unverifiable';
        // Portable and missing: for an action whose applied state IS deletion,
        // the user emptied the trash and the deletion became permanent, so the
        // action still holds. For anything else, the item being gone is the
        // revert.
        return mustBeTrashed ? 'valid' : 'invalid';
    }
    if (mustBeAnnotation && !resolved.item.isAnnotation()) return 'invalid';
    if (mustBeTrashed && !resolved.item.deleted) return 'invalid';
    return 'valid';
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

    if (isEditAnnotationsAgentAction(action)) {
        const updated = action.result_data?.applied_refs ?? [];
        // A delete keeps its applied_refs pointing at the (soft-deleted)
        // originals, so the applied state is "still in the trash". An edit's
        // applied_refs are live annotations — a move rewrites them in place,
        // so identity is stable there too.
        const mustBeTrashed = action.result_data?.operation === 'delete';
        let unverifiable = false;
        for (const ref of updated) {
            const validity = await checkAppliedReference(ref, true, mustBeTrashed);
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

// =============================================================================
// Scoped selectors
// =============================================================================
//
// A long thread mounts hundreds of cards, and every agent action written —
// streamed, applied, undone — replaces the thread's action list, as every
// pending approval added or answered replaces the approval map. A card that
// subscribes to the whole list or map re-renders on each of those writes. The
// selectors below narrow a subscription to what one card or one run renders and
// hold their previous value while it is unchanged, so jotai skips the update.
//
// The comparisons rely on unchanged entries keeping their object identity: every
// action and approval write replaces only the entries it changes. Selectors are
// cached per key; the caches are dropped with the run selectors when the open
// thread changes (`resetAgentActionSelectorCaches`).

const EMPTY_ACTIONS: AgentAction[] = [];

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
    return left === right
        || (left.length === right.length && left.every((item, index) => item === right[index]));
}

function sameMembers<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
    if (left === right) return true;
    if (left.size !== right.size) return false;
    for (const item of left) if (!right.has(item)) return false;
    return true;
}

function sameNestedItems<T>(left: readonly (readonly T[])[], right: readonly (readonly T[])[]): boolean {
    return left === right
        || (left.length === right.length && left.every((items, index) => sameItems(items, right[index])));
}

const toolcallActionsAtoms = new Map<string, Atom<AgentAction[]>>();
const toolcallsActionsAtoms = new Map<string, Atom<AgentAction[][]>>();
const runsActionsAtoms = new Map<string, Atom<AgentAction[][]>>();
const toolcallApprovalAtoms = new Map<string, Atom<PendingApproval | null>>();
const toolcallsApprovalAtoms = new Map<string, Atom<(PendingApproval | null)[]>>();
const runsLiveApprovalAtoms = new Map<string, Atom<ReadonlySet<string>>>();

function cached<T>(cache: Map<string, Atom<T>>, key: string, create: () => Atom<T>): Atom<T> {
    let value = cache.get(key);
    if (!value) {
        value = create();
        cache.set(key, value);
    }
    return value;
}

/** The agent actions of one tool call, in thread order. */
export function agentActionsForToolcallAtom(toolcallId: string): Atom<AgentAction[]> {
    return cached(toolcallActionsAtoms, toolcallId, () => selectAtom(
        agentActionsByToolcallAtom,
        (byToolcall) => byToolcall.get(toolcallId) ?? EMPTY_ACTIONS,
        sameItems,
    ));
}

/** The agent actions of several tool calls, one array per id, in the order given. */
export function agentActionsForToolcallsAtom(toolcallIds: readonly string[]): Atom<AgentAction[][]> {
    const ids = [...toolcallIds];
    return cached(toolcallsActionsAtoms, ids.join('\n'), () => selectAtom(
        agentActionsByToolcallAtom,
        (byToolcall) => ids.map((id) => byToolcall.get(id) ?? EMPTY_ACTIONS),
        sameNestedItems,
    ));
}

/** The agent actions of several runs, one array per id, in the order given. */
export function agentActionsForRunsAtom(runIds: readonly string[]): Atom<AgentAction[][]> {
    const ids = [...runIds];
    return cached(runsActionsAtoms, ids.join('\n'), () => selectAtom(
        agentActionsByRunAtom,
        (byRun) => ids.map((id) => byRun.get(id) ?? EMPTY_ACTIONS),
        sameNestedItems,
    ));
}

/** The live approval awaiting a decision on one tool call, or null. */
export function pendingApprovalForToolcallAtom(toolcallId: string): Atom<PendingApproval | null> {
    return cached(toolcallApprovalAtoms, toolcallId, () => atom(
        (get) => findPendingApprovalForToolcall(toolcallId, get(pendingApprovalsAtom).values()),
    ));
}

/** The live approvals of several tool calls, one entry per id, in the order given. */
export function pendingApprovalsForToolcallsAtom(toolcallIds: readonly string[]): Atom<(PendingApproval | null)[]> {
    const ids = [...toolcallIds];
    return cached(toolcallsApprovalAtoms, ids.join('\n'), () => selectAtom(
        pendingApprovalsAtom,
        (pending) => ids.map((id) => findPendingApprovalForToolcall(id, pending.values())),
        sameItems,
    ));
}

/** The ids of these runs' actions that a live approval is waiting on. */
export function liveApprovalActionIdsForRunsAtom(runIds: readonly string[]): Atom<ReadonlySet<string>> {
    const ids = [...runIds];
    return cached(runsLiveApprovalAtoms, ids.join('\n'), () => selectAtom(
        atom((get) => {
            const pending = get(pendingApprovalsAtom);
            const live = new Set<string>();
            for (const actions of get(agentActionsForRunsAtom(ids))) {
                for (const action of actions) {
                    if (pending.has(action.id)) live.add(action.id);
                }
            }
            return live as ReadonlySet<string>;
        }),
        (live) => live,
        sameMembers,
    ));
}

/**
 * Drop the scoped selector caches. Call when the open thread changes, with
 * `resetRunSelectorCaches`: the cached atoms are keyed by that thread's ids and
 * hold their last value. Readers still holding a dropped atom keep working.
 */
export function resetAgentActionSelectorCaches(): void {
    toolcallActionsAtoms.clear();
    toolcallsActionsAtoms.clear();
    runsActionsAtoms.clear();
    toolcallApprovalAtoms.clear();
    toolcallsApprovalAtoms.clear();
    runsLiveApprovalAtoms.clear();
}

export const getAgentActionByIdAtom = atom(
    (get) => (actionId: string): AgentAction | null => {
        return get(threadAgentActionsAtom).find((action) => action.id === actionId) ?? null;
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
                        result_data: actionResultData.find((result) => result.action_id === action.id)?.result_data,
                        // A retried apply leaves the failure behind.
                        error_message: undefined,
                        error_details: undefined,
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
 * Delays before re-sending an acknowledgement that did not reach the backend;
 * the last one repeats.
 */
const UNDELIVERED_ACK_RETRY_MS = [2_000, 5_000, 15_000, 30_000];

/**
 * How long to keep re-sending one. A load of the thread re-sends at once, so
 * this only bounds an acknowledgement the backend keeps failing.
 */
const UNDELIVERED_ACK_GIVE_UP_MS = 30 * 60_000;

/** Bound on one acknowledgement, so a stalled request still reaches its retry. */
const UNDELIVERED_ACK_TIMEOUT_MS = 20_000;

/**
 * An action this window applied whose result the server has not recorded:
 * the run's connection was lost before the result reached it, and the
 * acknowledgement has not landed yet.
 */
interface UnrecordedResult {
    runId: string;
    resultData: Record<string, any>;
    /** The request that applied it, to show an action the thread never received. */
    executed?: ExecutedAction;
    /** Credential generation of the account that ran it. */
    generation: number;
    /** `getLibraryRevocations()` when its run started. */
    revocations: number | null;
    /**
     * The server said it has no record of the action, so there is nothing to
     * acknowledge; kept so the card stays as Zotero has it.
     */
    unknownToServer?: boolean;
}

/**
 * Results shown in place of the server's record until it has them, by action
 * id. The server keeps such an action unconfirmed, with no result to undo it
 * by. Window-local: once the window is gone the server's record stands.
 */
const unrecordedResultsAtom = atom<ReadonlyMap<string, UnrecordedResult>>(new Map());

/**
 * Whether an unrecorded result may leave this computer: it belongs to the
 * signed-in account, and no library has been excluded since its run started.
 * A result does not say every library it touched, so after any exclusion
 * none of it is sent.
 */
function mayLeaveComputer(entry: UnrecordedResult): boolean {
    if (entry.generation !== getCredentialGeneration()) return false;
    const revocations = getLibraryRevocations();
    return revocations !== null && revocations === entry.revocations;
}

/** Wakes each acknowledgement waiting to be re-sent. */
const ackRetryWakers = new Set<() => void>();

/** Wait `ms`, or less if `retryUnrecordedActionsNow` is called meanwhile. */
function waitForAckRetry(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const wake = () => {
            clearTimeout(timer);
            ackRetryWakers.delete(wake);
            resolve();
        };
        const timer = setTimeout(wake, ms);
        ackRetryWakers.add(wake);
    });
}

/**
 * Re-send waiting acknowledgements now, e.g. once a read from the backend
 * succeeded, which says it can be reached again.
 */
export function retryUnrecordedActionsNow(): void {
    for (const wake of [...ackRetryWakers]) wake();
}

/** Whether nothing has settled `action` since it was sent to Zotero. */
function isAwaitingRecord(action: AgentAction): boolean {
    return action.status === 'pending' || isUnconfirmedAction(action);
}

function withUnrecordedResult(action: AgentAction, entry: UnrecordedResult): AgentAction {
    return {
        ...action,
        status: 'applied',
        result_data: entry.resultData,
        error_message: undefined,
        error_details: undefined,
    };
}

/** The applied action an execute request describes, for a thread that never received it. */
function actionFromExecute(actionId: string, entry: UnrecordedResult): AgentAction | null {
    const executed = entry.executed;
    if (!executed?.toolcallId) return null;
    return toAgentAction({
        id: actionId,
        run_id: entry.runId,
        toolcall_id: executed.toolcallId,
        action_type: executed.actionType,
        status: 'applied',
        proposed_data: executed.actionData,
        result_data: entry.resultData,
    });
}

/**
 * `actions`, with each action this window applied and the server has yet to
 * record shown as applied, so its card offers Undo instead of nothing; and,
 * for the runs in `runIds`, with one the thread does not have added. An
 * action applied without asking reaches the client only with its result, so
 * one whose result was lost is in the thread only as the server stored it
 * before the execute, or not at all.
 */
function overlayUnrecordedResults(
    actions: AgentAction[],
    entries: ReadonlyMap<string, UnrecordedResult>,
    runIds: ReadonlySet<string>,
): AgentAction[] {
    const generation = getCredentialGeneration();
    const current = (id: string) => {
        const entry = entries.get(id);
        return entry && entry.generation === generation ? entry : null;
    };
    const overlaid = actions.map((action) => {
        const entry = current(action.id);
        return entry && isAwaitingRecord(action) ? withUnrecordedResult(action, entry) : action;
    });
    const known = new Set(actions.map((action) => action.id));
    const added: AgentAction[] = [];
    for (const id of entries.keys()) {
        const entry = current(id);
        if (known.has(id) || !entry || !runIds.has(entry.runId)) continue;
        const action = actionFromExecute(id, entry);
        if (action) added.push(action);
    }
    return [...overlaid, ...added];
}

/**
 * The thread's actions as loaded from the server, with this window's
 * unrecorded results in place (see `overlayUnrecordedResults`). An entry the
 * server has settled since, or one from another account, is dropped.
 * `runIds` are the loaded thread's runs. Follow with
 * `resumeUnrecordedResultsAtom`.
 */
export function withUnrecordedResults(
    get: Getter,
    set: Setter,
    actions: AgentAction[],
    runIds: ReadonlySet<string>,
): AgentAction[] {
    const entries = get(unrecordedResultsAtom);
    if (entries.size === 0) return actions;
    const generation = getCredentialGeneration();
    const settled = actions.filter((action) => entries.has(action.id) && !isAwaitingRecord(action));
    const stale = [...entries].filter(([, entry]) => entry.generation !== generation);
    if (settled.length > 0 || stale.length > 0) {
        set(unrecordedResultsAtom, (prev) => {
            const next = new Map(prev);
            for (const action of settled) next.delete(action.id);
            for (const [id] of stale) next.delete(id);
            return next;
        });
    }
    return overlayUnrecordedResults(actions, get(unrecordedResultsAtom), runIds);
}

/**
 * Re-send unrecorded results now, including ones whose acknowledgement gave
 * up. For after a successful load of the thread, which says the backend can
 * be reached; a load that stages its writes sets this with the rest at commit.
 */
export const resumeUnrecordedResultsAtom = atom(null, (get, set) => {
    retryUnrecordedActionsNow();
    for (const runId of new Set([...get(unrecordedResultsAtom).values()].map((entry) => entry.runId))) {
        void recordRunResults(get, set, runId);
    }
});

/** Stop showing `actionIds` in place of the server's record, e.g. once undone. */
function forgetUnrecordedResults(set: Setter, actionIds: string[]): void {
    set(unrecordedResultsAtom, (prev) => {
        if (!actionIds.some((id) => prev.has(id))) return prev;
        const next = new Map(prev);
        for (const id of actionIds) next.delete(id);
        return next;
    });
}

/**
 * Record actions a run applied whose results never reached the server, e.g.
 * because the connection was lost right after the write and the run could not
 * be reattached. The server would otherwise keep them unconfirmed, with the
 * outcome unknown. Until it has them, the cards show them as applied, since
 * Zotero has them, and offer Undo. Retried, because the connection is often
 * still down, and re-sent at once whenever the thread loads.
 *
 * The server records an action only while nothing has settled it since, so an
 * undo, rejection or newer apply made meanwhile, in any window, stands. An
 * action undone here is not recorded at all.
 */
export const recordUndeliveredActionsAtom = atom(
    null,
    async (get, set, info: WSUndeliveredActionsInfo, revocationsAtRunStart: number | null) => {
        // The actions belong to the account that ran them.
        const generation = getCredentialGeneration();
        set(unrecordedResultsAtom, (prev) => {
            const next = new Map(prev);
            for (const action of info.actions) {
                next.set(action.actionId, {
                    runId: info.runId,
                    resultData: action.resultData,
                    executed: action.executed,
                    generation,
                    revocations: revocationsAtRunStart,
                });
            }
            return next;
        });
        const reported = new Set(info.actions.map((action) => action.actionId));
        set(threadAgentActionsAtom, (prev: AgentAction[]) => overlayUnrecordedResults(
            prev,
            new Map([...get(unrecordedResultsAtom)].filter(([id]) => reported.has(id))),
            isRunInThread(get, info.runId) ? new Set([info.runId]) : new Set(),
        ));
        await recordRunResults(get, set, info.runId);
    }
);

/** Runs whose unrecorded results are being sent, and until when. */
const recordingRuns = new Map<string, Promise<void>>();

/** Send `runId`'s unrecorded results, unless that is already under way. */
function recordRunResults(get: Getter, set: Setter, runId: string): Promise<void> {
    const running = recordingRuns.get(runId);
    if (running) return running;
    const recording = sendRunResults(get, set, runId).finally(() => recordingRuns.delete(runId));
    recordingRuns.set(runId, recording);
    return recording;
}

/**
 * Acknowledge `runId`'s unrecorded results, retrying until it lands, and show
 * each action the way the server then has it. Each attempt sends what is
 * still unrecorded, so an action undone meanwhile is left as the undo
 * recorded it.
 */
async function sendRunResults(get: Getter, set: Setter, runId: string): Promise<void> {
    const startedAt = Date.now();
    for (let attempt = 0; ; attempt++) {
        const entries = [...get(unrecordedResultsAtom)].filter(([, entry]) => entry.runId === runId);
        const generation = getCredentialGeneration();
        const foreign = entries.filter(([, entry]) => entry.generation !== generation).map(([id]) => id);
        if (foreign.length > 0) forgetUnrecordedResults(set, foreign);
        const known = entries.filter(([, entry]) => !entry.unknownToServer);
        const sendable = known.filter(([, entry]) => mayLeaveComputer(entry));
        if (sendable.length < known.length - foreign.length) {
            logger(`recordUndeliveredActionsAtom: a library was excluded since run ${runId} started; not recording its actions`, 1);
        }
        if (sendable.length === 0) return;
        const links: AckActionLink[] = sendable.map(([id, entry]) => ({
            action_id: id,
            result_data: entry.resultData as AckActionLink['result_data'],
        }));
        try {
            const response = await agentActionsService.acknowledgeActions(runId, links, {
                onlyUndecided: true,
                timeoutMs: UNDELIVERED_ACK_TIMEOUT_MS,
                // Checked again right before each dispatch, since a request
                // can wait on authentication.
                assertDispatch: () => {
                    assertCredentialGeneration(generation);
                    if (!sendable.every(([, entry]) => mayLeaveComputer(entry))) {
                        throw new Error('A library was excluded since the run started');
                    }
                },
            });
            if (response.success) {
                // Show each action the way the server now has it: applied by
                // this request, or as it stood when left alone (e.g. applied
                // by an attempt whose response was lost, or undone in another
                // window). One the server has no record of stays as Zotero
                // has it.
                const current = new Map<string, Partial<AgentAction>>(
                    links.map((link) => [link.action_id, {
                        status: 'applied',
                        result_data: link.result_data,
                        error_message: undefined,
                        error_details: undefined,
                    }]),
                );
                for (const skipped of response.skipped ?? []) {
                    if (skipped.status) {
                        current.set(skipped.action_id, {
                            status: skipped.status,
                            result_data: skipped.result_data ?? undefined,
                            error_message: skipped.error_message ?? undefined,
                            error_details: skipped.error_details ?? undefined,
                        });
                    } else {
                        current.delete(skipped.action_id);
                    }
                }
                const missing = new Set((response.skipped ?? [])
                    .filter((skipped) => !skipped.status)
                    .map((skipped) => skipped.action_id));
                // Not over anything done here while the request was out, such
                // as an undo or a failed one.
                const stillUnrecorded = get(unrecordedResultsAtom);
                const untouched = new Set([...current.keys()].filter((id) => stillUnrecorded.has(id)));
                set(threadAgentActionsAtom, (prev: AgentAction[]) => prev.map((action) => {
                    const state = current.get(action.id);
                    const asShown = action.status === 'applied' || isAwaitingRecord(action);
                    return state && asShown && untouched.has(action.id) ? { ...action, ...state } : action;
                }));
                forgetUnrecordedResults(set, links.map((link) => link.action_id).filter((id) => !missing.has(id)));
                if (missing.size > 0) {
                    set(unrecordedResultsAtom, (prev) => {
                        const next = new Map(prev);
                        for (const id of missing) {
                            const entry = next.get(id);
                            if (entry) next.set(id, { ...entry, unknownToServer: true });
                        }
                        return next;
                    });
                }
                await showStoredActions(
                    get,
                    set,
                    runId,
                    [...current.keys()],
                    sendable
                        .filter(([id, entry]) => entry.executed?.toolcallId && untouched.has(id))
                        .map(([id]) => id),
                );
                return;
            }
        } catch (error) {
            logger(`recordUndeliveredActionsAtom: acknowledging run ${runId} failed: ${error}`, 1);
        }
        if (Date.now() - startedAt >= UNDELIVERED_ACK_GIVE_UP_MS) {
            // Kept, so the next load of the thread tries again.
            logger(`recordUndeliveredActionsAtom: giving up on run ${runId} for now`, 1);
            return;
        }
        await waitForAckRetry(
            UNDELIVERED_ACK_RETRY_MS[Math.min(attempt, UNDELIVERED_ACK_RETRY_MS.length - 1)],
        );
    }
}

/** Whether `runId` belongs to the thread this window shows. */
function isRunInThread(get: Getter, runId: string): boolean {
    return get(activeRunAtom)?.id === runId || get(threadRunsAtom).some((run) => run.id === runId);
}

/**
 * Show the stored version of recorded actions: add those the thread lacks,
 * and replace those in `replace`, which were built from their execute
 * request. An action applied without asking is sent to the client only once
 * its result arrives, so one recovered after a lost connection is in the
 * thread at most as this window built it.
 */
async function showStoredActions(
    get: Getter,
    set: Setter,
    runId: string,
    actionIds: string[],
    replace: string[],
): Promise<void> {
    const shown = get(threadAgentActionsAtom);
    const known = new Set(shown.map((action) => action.id));
    const wanted = new Set([...actionIds.filter((id) => !known.has(id)), ...replace]);
    if (wanted.size === 0 || !isRunInThread(get, runId)) return;
    // As built here and still applied; one changed since (e.g. a failed
    // undo, or one undone and applied again while the read was out) is
    // newer than the stored copy.
    const built = new Map(shown
        .filter((action) => replace.includes(action.id) && action.status === 'applied')
        .map((action) => [action.id, action]));
    try {
        const stored = await agentActionsService.getActionsForRun(runId);
        // The user may have opened another thread meanwhile.
        if (!isRunInThread(get, runId)) return;
        const recovered = new Map(
            stored.filter((action) => wanted.has(action.id)).map((action) => [action.id, toAgentAction(action)]),
        );
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            const replaced = prev.map((action) => {
                const update = recovered.get(action.id);
                if (!update) return action;
                recovered.delete(action.id);
                // Built here and not changed since: the stored action is the
                // same change, with the server's own copy of its data.
                return built.get(action.id) === action ? update : action;
            });
            return [...replaced, ...recovered.values()];
        });
    } catch (error) {
        logger(`recordUndeliveredActionsAtom: loading run ${runId}'s actions failed: ${error}`, 1);
    }
}

/**
 * Set agent actions to error status.
 * Updates both UI state and backend.
 */
export const setAgentActionsToErrorAtom = atom(
    null,
    (get, set, actionIds: string[], errorMessage: string, errorDetails?: Record<string, any>) => {
        const unrecorded = get(unrecordedResultsAtom);
        // Frontend: Update UI state
        set(threadAgentActionsAtom, (prev: AgentAction[]) => {
            return prev.map((action) => 
                actionIds.includes(action.id)
                    ? {
                        ...action,
                        status: 'error' as ActionStatus,
                        error_message: errorMessage,
                        // Surfaces read the details (e.g. an import's existing item) before any reload.
                        ...(errorDetails ? { error_details: errorDetails } : {}),
                    }
                    : action
            );
        });
        // Backend: Update each action
        for (const actionId of actionIds) {
            // One whose result is still unrecorded (e.g. its undo failed) is
            // left to its acknowledgement, which records it as applied with
            // the result to retry the undo by. An error recorded first would
            // leave the server without that result.
            const entry = unrecorded.get(actionId);
            if (entry && entry.generation === getCredentialGeneration()) continue;
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
                if (typeof action.result_data?.undo_full_html === 'string' && proposed_data?.undo_full_html == null) {
                    proposed_data = { ...proposed_data, undo_full_html: action.result_data.undo_full_html };
                }
                return { ...action, proposed_data, status: 'undone' as ActionStatus, result_data: undefined, error_message: undefined };
            });
        });
        // Undone before its result was recorded: the undo is all the server
        // needs to hear.
        forgetUnrecordedResults(set, [actionId]);
        // Backend: Update action state
        agentActionsService.updateAction(actionId, {
            status: 'undone',
            clear_result_data: true,
            clear_error_message: true,
            clear_error_details: true,
        }).catch((error) => {
            logger(`undoAgentActionAtom: failed to persist state for action ${actionId}: ${error}`, 1);
        });
    }
);

/**
 * Find an unapplied item-creating action (create_item or import_item) for an external reference.
 * Used to sync external-reference action buttons with pending item proposals.
 */
export const getPendingCreateItemActionBySourceIdAtom = atom(
    (get) => (sourceId: string): ItemCreatingAgentAction | null => {
        const actions = get(threadAgentActionsAtom);
        return actions.find(
            (action): action is ItemCreatingAgentAction =>
                isItemCreatingAgentAction(action) &&
                (action.status === 'pending' || action.status === 'undone' || action.status === 'error' || action.status === 'rejected') &&
                itemActionExternalId(action) === sourceId
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
            // The target may be named portably only, so resolve the library
            // rather than reading the numeric id off the event.
            const libraryId = noteLibraryIdFromActionData(event.action_data);
            const zoteroKey = event.action_data?.zotero_key;
            if (libraryId != null && zoteroKey) {
                updateDiffPreviewForNote(libraryId, zoteroKey);
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
            const libraryId = noteLibraryIdFromActionData(removed.actionData);
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
 * How many pending approvals a switch to full access would answer at once. A
 * number, so its readers re-render only when the count changes.
 */
export const pendingApprovalsCoveredByFullAccessCountAtom = atom(
    (get) => getPendingApprovalIdsCoveredByFullAccess(get(pendingApprovalsAtom).values()).length
);

/** Stands in for the count above on surfaces that show it only while awaiting. */
export const noPendingApprovalsCoveredCountAtom: Atom<number> = atom(() => 0);

/**
 * Check if there are any pending approvals.
 */
export const hasPendingApprovalsAtom = atom(
    (get) => get(pendingApprovalsAtom).size > 0
);

// Note: `pendingApprovalsAtom` means "the backend is blocked waiting on this
// decision". Do not rebuild entries from stored pending actions — an action left
// pending by a timeout has no waiter, so a re-added entry would show an
// "awaiting approval" card whose Approve button sends into the void. Such
// actions are applied locally through the `status === 'pending'` controls
// instead, and `staleApprovalActionIdsAtom` marks approvals whose channel has
// closed.
