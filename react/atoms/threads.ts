import { atom } from "jotai";
import { currentMessageItemsAtom, currentMessageContentAtom, updateMessageItemsFromZoteroSelectionAtom, updateReaderAttachmentAtom } from "./messageComposition";
import { isLibraryTabAtom, isPreferencePageVisibleAtom, isWebSearchEnabledAtom, removePopupMessagesByTypeAtom, userScrolledAtom, windowUserScrolledAtom } from "./ui";

import { citationMetadataAtom, citationDataMapAtom, updateCitationDataAtom, resetCitationMarkersAtom } from "./citations";
import { isExternalCitation } from "../types/citations";
import { agentRunService, agentService } from "../../src/services/agentService";
import { getPref } from "../../src/utils/prefs";
import { loadFullItemDataWithAllTypes } from "../../src/utils/zoteroUtils";
import { logger } from "../../src/utils/logger";
import { resetMessageUIStateAtom } from "./messageUIState";
import { checkExternalReferencesAtom, clearExternalReferenceCacheAtom, addExternalReferencesToMappingAtom } from "./externalReferences";
import { ExternalReference } from "../types/externalReferences";
import { threadRunsAtom, activeRunAtom } from "../agents/atoms";
import { isWSChatPendingAtom, isWSConnectedAtom, isWSReadyAtom } from "./agentRunAtoms";
import { AgentRun } from "../agents/types";
import { 
    threadAgentActionsAtom, 
    isCreateItemAgentAction, 
    AgentAction, 
    validateAppliedAgentAction, 
    undoAgentActionAtom,
    clearAllPendingApprovalsAtom,
} from "../agents/agentActions";
import { processToolReturnResults } from "../agents/toolResultProcessing";
import { loadItemDataForAgentActions } from "../utils/agentActionUtils";
import { BeaverTemporaryAnnotations } from "../utils/annotationUtils";

// Thread types
export interface ThreadData {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
}

// Thread messages and attachments
export const currentThreadIdAtom = atom<string | null>(null);

/**
 * Atom to store the scroll position of the current thread
 */
export const threadScrollPositionsAtom = atom<Record<string, number>>({});

/**
 * Atom to get the scroll position of the current thread (for library/reader sidebars)
 */
export const currentThreadScrollPositionAtom = atom(
    (get) => {
        const threadId = get(currentThreadIdAtom);
        if (!threadId) {
            return undefined;
        }
        const positions = get(threadScrollPositionsAtom);
        return positions[threadId];
    },
    (get, set, scrollTop: number | null) => {
        const threadId = get(currentThreadIdAtom);
        if (!threadId) {
            return;
        }
        set(threadScrollPositionsAtom, (prevPositions) => {
            const nextPositions = { ...prevPositions };
            if (scrollTop === null) {
                delete nextPositions[threadId];
            } else {
                nextPositions[threadId] = scrollTop;
            }
            return nextPositions;
        });
    }
);

/**
 * Atom to store scroll positions for the separate window (independent from sidebar)
 */
export const windowScrollPositionsAtom = atom<Record<string, number>>({});

/**
 * Atom to get the scroll position of the current thread for separate window
 */
export const windowScrollPositionAtom = atom(
    (get) => {
        const threadId = get(currentThreadIdAtom);
        if (!threadId) {
            return undefined;
        }
        const positions = get(windowScrollPositionsAtom);
        return positions[threadId];
    },
    (get, set, scrollTop: number | null) => {
        const threadId = get(currentThreadIdAtom);
        if (!threadId) {
            return;
        }
        set(windowScrollPositionsAtom, (prevPositions) => {
            const nextPositions = { ...prevPositions };
            if (scrollTop === null) {
                delete nextPositions[threadId];
            } else {
                nextPositions[threadId] = scrollTop;
            }
            return nextPositions;
        });
    }
);


// Atom to store recent threads
export const recentThreadsAtom = atom<ThreadData[]>([]);

/**
 * Cancel any active run when switching threads.
 * This ensures the WebSocket connection is closed and UI state is consistent.
 */
async function cancelActiveRunIfNeeded(get: (atom: any) => any, set: (atom: any, value?: any) => void): Promise<void> {
    const isPending = get(isWSChatPendingAtom);
    const activeRun = get(activeRunAtom);
    
    if (isPending || activeRun) {
        logger('cancelActiveRunIfNeeded: Canceling active run before switching threads', 1);
        
        // Set pending to false immediately for responsive UI
        set(isWSChatPendingAtom, false);
        
        // Mark active run as canceled if it exists
        if (activeRun && activeRun.status === 'in_progress') {
            const canceledRun: AgentRun = {
                ...activeRun,
                status: 'canceled',
                completed_at: new Date().toISOString(),
            };
            // Move canceled run to completed runs before clearing
            set(threadRunsAtom, (runs: AgentRun[]) => [...runs, canceledRun]);
        }
        set(activeRunAtom, null);
        
        // Cancel the WebSocket connection
        await agentService.cancel();
        set(isWSConnectedAtom, false);
        set(isWSReadyAtom, false);
    }
}

/**
 * Atom to create a new thread
 */
export const newThreadAtom = atom(
    null,
    async (get, set) => {
        // Show loading state immediately if there's an active run to cancel
        const hasActiveWork = get(isWSChatPendingAtom) || get(activeRunAtom);
        if (hasActiveWork) {
            set(isLoadingThreadAtom, true);
        }
        
        try {
            // Cancel any active run before switching threads
            await cancelActiveRunIfNeeded(get, set);
            
            // Clean up any temporary annotations from previous thread
            await BeaverTemporaryAnnotations.cleanupAll().catch(error => {
                logger(`newThreadAtom: Error cleaning up temporary annotations: ${error}`);
            });
            
            const isLibraryTab = get(isLibraryTabAtom);
            set(currentThreadIdAtom, null);
            
            // Clear agent-based atoms
            set(threadRunsAtom, []);
            set(activeRunAtom, null);
            set(threadAgentActionsAtom, []);
            set(clearAllPendingApprovalsAtom);
            
            set(isWebSearchEnabledAtom, false);
            
            set(currentMessageItemsAtom, []);
            set(removePopupMessagesByTypeAtom, ['items_summary']);
            set(citationMetadataAtom, []);
            set(resetCitationMarkersAtom);
            set(citationDataMapAtom, {});
            set(currentMessageContentAtom, '');
            set(resetMessageUIStateAtom);
            set(isPreferencePageVisibleAtom, false);
            set(clearExternalReferenceCacheAtom);
            // Update message items from Zotero selection or reader
            const addSelectedItemsOnNewThread = getPref('addSelectedItemsOnNewThread');
            if (isLibraryTab && addSelectedItemsOnNewThread) {
                const maxAddAttachmentToMessage = getPref('maxAddAttachmentToMessage');
                set(updateMessageItemsFromZoteroSelectionAtom, maxAddAttachmentToMessage);
            }
            if (!isLibraryTab) {
                await set(updateReaderAttachmentAtom);
            }
            // Reset scroll state for both sidebar and window
            set(userScrolledAtom, false);
            set(windowUserScrolledAtom, false);
        } finally {
            // Always clear loading state
            set(isLoadingThreadAtom, false);
        }
    }
);

/**
 * Atom to check if a thread is loading
 */
export const isLoadingThreadAtom = atom<boolean>(false);

/**
 * Atom to load a thread
 */
export const loadThreadAtom = atom(
    null,
    async (get, set, { user_id, threadId }: { user_id: string; threadId: string }) => {
        // Show loading state immediately for instant UI feedback
        set(isLoadingThreadAtom, true);
        
        try {
            // Cancel any active run before loading a different thread
            await cancelActiveRunIfNeeded(get, set);
            // Clean up any temporary annotations from previous thread
            await BeaverTemporaryAnnotations.cleanupAll().catch(error => {
                logger(`loadThreadAtom: Error cleaning up temporary annotations: ${error}`);
            });
            
            // Reset scroll state for both sidebar and window
            set(userScrolledAtom, false);
            set(windowUserScrolledAtom, false);
            // Set the current thread ID
            set(currentThreadIdAtom, threadId);
            set(isPreferencePageVisibleAtom, false);
            set(clearExternalReferenceCacheAtom);
            set(isWebSearchEnabledAtom, false);
            set(resetCitationMarkersAtom);
            
            // Clear all pending approvals when loading a different thread
            set(clearAllPendingApprovalsAtom);
            
            // Load agent runs with actions from the backend
            const { runs, agent_actions } = await agentRunService.getThreadRuns(threadId, true);
            
            // Mark any in_progress runs as canceled since they're no longer active
            const processedRuns = runs.map(run => {
                if (run.status === 'in_progress') {
                    logger(`loadThreadAtom: Marking in_progress run ${run.id} as canceled`, 1);
                    return {
                        ...run,
                        status: 'canceled' as const,
                        completed_at: run.completed_at || new Date().toISOString(),
                    };
                }
                return run;
            });
            
            if (processedRuns.length > 0) {
                // Extract citations from runs
                const citationMetadata = processedRuns.flatMap(run => 
                    (run.metadata?.citations || []).map(citation => ({
                        ...citation,
                        run_id: run.id
                    }))
                );
                
                // Process tool return results
                const externalReferences: ExternalReference[] = [];
                for (const run of processedRuns) {
                    for (const message of run.model_messages) {
                        if (message.kind === 'request') {
                            for (const part of message.parts) {
                                if (part.part_kind === "tool-return") await processToolReturnResults(part, set);
                            }
                        }
                    }
                }
                
                // Load item data for citations and attachments
                const allItemReferences = new Set<string>();
                
                // From citations (filter out external citations)
                const zoteroCitations = citationMetadata.filter(citation => !isExternalCitation(citation));
                zoteroCitations
                    .filter(c => c.library_id && c.zotero_key)
                    .forEach(c => allItemReferences.add(`${c.library_id}-${c.zotero_key}`));
                
                // From user attachments in runs
                for (const run of processedRuns) {
                    const attachments = run.user_prompt.attachments || [];
                    attachments
                        .filter(att => att.library_id && att.zotero_key)
                        .forEach(att => allItemReferences.add(`${att.library_id}-${att.zotero_key}`));
                }

                const itemsPromises = Array.from(allItemReferences).map(ref => {
                    const [libraryId, key] = ref.split('-');
                    return Zotero.Items.getByLibraryAndKeyAsync(parseInt(libraryId), key);
                });
                const itemsToLoad = (await Promise.all(itemsPromises)).filter(Boolean) as Zotero.Item[];

                if (itemsToLoad.length > 0) {
                    await loadFullItemDataWithAllTypes(itemsToLoad);
                    if (!Zotero.Styles.initialized()) {
                        await Zotero.Styles.init();
                    }
                }

                // Update citation state
                set(citationMetadataAtom, citationMetadata);
                await set(updateCitationDataAtom);

                // Set agent runs
                set(threadRunsAtom, processedRuns);
                
                // Set agent actions
                set(threadAgentActionsAtom, agent_actions || []);

                // Load item data for agent actions
                if (agent_actions && agent_actions.length > 0) {
                    await loadItemDataForAgentActions(agent_actions);
                }

                // Validate agent actions and undo if not valid
                if (agent_actions && agent_actions.length > 0) {
                    await Promise.all(agent_actions.map(async (action: AgentAction) => {
                        const isValid = await validateAppliedAgentAction(action);
                        if (!isValid) {
                            logger(`loadThreadAtom: undoing agent action ${action.id} because it is not valid`, 1);
                            set(undoAgentActionAtom, action.id);
                        }
                        return isValid;
                    }));
                }
                
                // Check for create_item agent actions and populate external reference cache
                const createItemActions = (agent_actions || []).filter(isCreateItemAgentAction);
                if (createItemActions.length > 0) {
                    logger(`loadThreadAtom: Adding external references from agent actions to mapping`, 1);
                    const references = createItemActions
                        .map((action: AgentAction) => action.proposed_data?.item)
                        .filter(Boolean) as ExternalReference[];
                    set(addExternalReferencesToMappingAtom, references);
                    set(checkExternalReferencesAtom, references);
                }
            } else {
                // No runs found, clear state
                set(threadRunsAtom, []);
                set(threadAgentActionsAtom, []);
                set(citationMetadataAtom, []);
            }
        } catch (error) {
            console.error('Error loading thread:', error);
        } finally {
            set(isLoadingThreadAtom, false);
        }
        // Clear sources for now
        set(currentMessageItemsAtom, []);
        set(removePopupMessagesByTypeAtom, ['items_summary']);
        set(currentMessageContentAtom, '');
    }
);
