import { releaseWriter } from '../runtime/threadWriter';
import { viewedHistoryRevisionAtom } from '../runtime/threadProjection';
import { atom } from "jotai";
import { readerActionContextAtom, currentMessageItemsAtom, clearComposerAtom, currentMessageCollectionsAtom, currentMessageExternalFilesAtom, updateMessageItemsFromZoteroSelectionAtom, updateMessageCollectionsFromZoteroSelectionAtom, updateReaderAttachmentAtom } from "./messageComposition";
import { isAtBottomAtom, isLibraryTabAtom, isWebSearchEnabledAtom, removePopupMessagesByTypeAtom, userScrolledAtom, windowIsAtBottomAtom, windowUserScrolledAtom } from "./ui";

import { citationsAtom, citationMapAtom, processCitationsAtom, resetCitationMarkersAtom, mergePageLabelsByAttachmentIdAtom } from "@beaver/agent-core/citations/atoms";
import { maybeShowCitationTipAtom } from "./citationTip";
import { preloadPageLabelsForCitations } from "../utils/pageLabels";
import { agentService } from "@beaver/agent-core/transport/agentService";
import { threadService, ZoteroInstanceRef } from "@beaver/agent-core/transport/threadService";
import { getPref } from "../../src/utils/prefs";
import { loadFullItemDataWithAllTypes, currentZoteroInstanceRef } from "../../src/utils/zoteroUtils";
import { isThreadInstanceMismatch, threadModelToThreadData } from "../utils/threadMatches";
import { upsertThreadsAtom, threadWriteStampAtom } from "./threadList";
import { getHost } from '@beaver/agent-ui/host';
import { logger } from "@beaver/agent-core/platform/logger";
import { isApiError } from "@beaver/agent-core/types/apiErrors";
import { resetMessageUIStateAtom } from "./messageUIState";
import { checkExternalReferencesAtom } from "./externalReferences";
import { clearExternalReferenceCacheAtom, addExternalReferencesToMappingAtom } from "@beaver/agent-core/citations/externalReferences";
import { ExternalReference } from "@beaver/agent-core/types/externalReferences";
import { threadRunsAtom, activeRunAtom, currentThreadIdAtom, currentThreadNameAtom, isLoadingThreadAtom, resetRunSelectorCaches } from "@beaver/agent-core/run-state/atoms";
import { loadThreadRuns } from "@beaver/agent-core/run-state/loadThreadRuns";
import { retryPendingRunIdAtom, isWSChatPendingAtom, isWSConnectedAtom, isWSReadyAtom } from "./agentRunAtoms";
import { AgentRun, isRunActive } from "@beaver/agent-core/agents/types";
import { 
    threadAgentActionsAtom, 
    isCreateItemAgentAction, 
    AgentAction, 
    validateAppliedAgentAction, 
    undoAgentActionAtom,
    clearAllPendingApprovalsAtom,
} from "../agents/agentActions";
import { clearAllPendingQuestionsAtom } from "@beaver/agent-core/run-state/pendingQuestions";
import { clearAllPendingCreditConfirmationsAtom } from "@beaver/agent-core/run-state/pendingCreditConfirmations";
import { clearAllPendingBatchApprovalsAtom } from "@beaver/agent-core/run-state/pendingBatchApprovals";
import { processToolReturnResults } from "../agents/toolResultProcessing";
import { upgradeToolReturn } from "../compat/legacyToolResults";
import { loadItemDataForAgentActions } from "../utils/agentActionUtils";
import { BeaverTemporaryAnnotations } from "../utils/annotationUtils";
import { enrichMessageAttachmentStub } from "../types/attachments/converters";
import { zoteroReferenceKey } from "@beaver/agent-core/types/attachments/apiTypes";
import { resolveItemReference } from "../../src/utils/libraryIdentity";
import type { ZoteroItemReference } from "@beaver/agent-core/types/zotero";
import { flushPendingPartEvents } from "../utils/streamingPartQueue";

/**
 * Stores a run ID that ThreadView should scroll to after a thread finishes loading.
 * Set by the protocol handler hook, cleared by ThreadView after scrolling.
 */
export const pendingScrollToRunAtom = atom<string | null>(null);

/**
 * Normalize a tool_call_id to a common base form for matching.
 *
 * Different model providers use different tool_call_id formats:
 * - Some providers: "functions.edit_note:0" (dots + colon separator)
 * - pydantic-ai modified: "functions_edit_note_0_8929eef7" (underscores + hash suffix)
 *
 * This normalizes both to "functions_edit_note_0" so they can be matched.
 */
function normalizeToolCallId(id: string): string {
    // Replace dots and colons with underscores
    let normalized = id.replace(/[.:]/g, '_');
    // Strip dedup suffix added by sanitize_tool_call_ids (e.g., "_d1", "_d2")
    normalized = normalized.replace(/_d\d+$/, '');
    // Strip trailing hex hash suffix added by pydantic-ai (e.g., "_8929eef7").
    // Only strip if the remaining prefix still contains an underscore,
    // to avoid collapsing unique provider IDs like "call_<hex>" (e.g., Fireworks/Kimi
    // fixed IDs) down to just "call", which would make all IDs in a run identical.
    const stripped = normalized.replace(/_[0-9a-f]{8,}$/i, '');
    if (stripped.includes('_')) {
        normalized = stripped;
    }
    return normalized;
}

/**
 * Reconcile toolcall_id mismatches between agent actions (from REST API)
 * and tool call parts (from model messages in runs).
 *
 * This is primarily needed for **legacy data** where Kimi raw IDs like
 * "functions.edit_note:0" were stored in agent_actions, while pydantic-ai's
 * sanitize_tool_call_ids rewrote model messages to "functions_edit_note_0_8929eef7".
 *
 * For newer data, the backend generates unique call_<hex> IDs that are consistent
 * between agent_actions and model messages, so no reconciliation is needed.
 */
function reconcileToolcallIds(runs: AgentRun[], actions: AgentAction[]): void {
    if (actions.length === 0 || runs.length === 0) return;

    // Collect all tool_call_ids from model messages, indexed by normalized form
    const normalizedToFull = new Map<string, string>();
    for (const run of runs) {
        for (const msg of run.model_messages) {
            if (msg.kind === 'response') {
                for (const part of msg.parts) {
                    if (part.part_kind === 'tool-call' && part.tool_call_id) {
                        normalizedToFull.set(normalizeToolCallId(part.tool_call_id), part.tool_call_id);
                    }
                }
            }
        }
    }

    // Fix agent actions whose toolcall_id doesn't match any model message tool_call_id
    const fullIds = new Set(normalizedToFull.values());
    let fixedCount = 0;
    for (const action of actions) {
        if (!action.toolcall_id || fullIds.has(action.toolcall_id)) continue;

        const normalized = normalizeToolCallId(action.toolcall_id);
        const fullId = normalizedToFull.get(normalized);
        if (fullId) {
            action.toolcall_id = fullId;
            fixedCount++;
        }
    }
    if (fixedCount > 0) {
        logger(`reconcileToolcallIds: Fixed ${fixedCount} mismatched toolcall_ids`, 1);
    }
}

// Thread types
import type { ThreadData } from '../../src/services/threads/types';
export type { ThreadData } from '../../src/services/threads/types';

// Thread messages and attachments
// These are defined alongside the run state in the shared core and re-exported
// here so thread consumers can import them from either module.
export { currentThreadIdAtom, currentThreadNameAtom, isLoadingThreadAtom };

/**
 * Where the reader is in each thread, by thread id: the offset they scrolled
 * back to. A thread with no entry is reopened at its bottom — the reader was
 * following the response when they left it, or has never opened it — and the
 * bottom is recorded by dropping the entry rather than storing an offset.
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
 * The same, for the separate window, which scrolls independently of the sidebars.
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
 * Ask the user to confirm interrupting the currently streaming run.
 * Returns true if the user confirmed (or there was nothing to confirm).
 */
function confirmInterruptActiveRun(title: string, text: string, confirmLabel: string, window?: Window): boolean {
    // Hosts without a dialogs slice proceed as confirmed.
    return getHost().dialogs?.confirm({ title, text, confirmLabel, window }) ?? true;
}

/**
 * Thread ids whose instance-mismatch warning the user has already confirmed
 * this session — don't re-prompt when switching back and forth.
 */
const confirmedMismatchedThreadIds = new Set<string>();

function confirmOpenMismatchedThread(window?: Window): boolean {
    return getHost().dialogs?.confirm({
        window,
        title: 'Open chat from another Zotero?',
        text: 'This chat was created with a different Zotero account or database. '
            + 'Cited items and links may not work here. Any library changes like '
            + 'editing metadata, adding PDF annotations, or organizing items '
            + 'may not apply or even change the incorrect Zotero items.',
        confirmLabel: 'Open Chat',
    }) ?? true;
}

/**
 * Cancel any active run when switching threads.
 * This ensures the WebSocket connection is closed and UI state is consistent.
 */
async function cancelActiveRunIfNeeded(get: (atom: any) => any, set: (atom: any, value?: any) => void, isCurrent = () => true): Promise<void> {
    // A run canceled mid-response is archived as it stands, so it has to
    // include the streamed text still sitting in the frame queue.
    flushPendingPartEvents();
    releaseWriter();
    if (Zotero.Beaver?.presence) set(retryPendingRunIdAtom, null);
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
        if (!isCurrent()) return;
        set(isWSConnectedAtom, false);
        set(isWSReadyAtom, false);
    }
}

/**
 * Counts chat navigations, so work started in one chat can tell it has been
 * left behind.
 */
export const threadNavigationSeqAtom = atom(0);
const threadLoadRequestSeqAtom = atom(0);

/**
 * Atom to create a new thread
 */
export const newThreadAtom = atom(
    null,
    async (
        get,
        set,
        options?: {
            window?: Window;
            skipAutoPopulate?: boolean;
            skipActiveRunConfirm?: boolean;
            /** Keep the composer's text and pills; attachments are still reset. */
            preserveDraft?: boolean;
        },
    ): Promise<number | undefined> => {
        // Show loading state immediately if there's an active run to cancel.
        // Gated on run status, not presence: a run that failed keeps sitting in
        // activeRunAtom, and prompting over it claims Beaver is still working.
        const hasActiveWork = get(isWSChatPendingAtom) || isRunActive(get(activeRunAtom));
        if (hasActiveWork) {
            if (!options?.skipActiveRunConfirm && !confirmInterruptActiveRun(
                'Start new chat?',
                'Beaver is still generating a response in this chat. Starting a new chat will stop it.',
                'Start New Chat',
                options?.window,
            )) {
                return;
            }
            set(isLoadingThreadAtom, true);
        }
        // The user has committed to leaving. See threadNavigationSeqAtom.
        const navigation = get(threadNavigationSeqAtom) + 1;
        set(threadNavigationSeqAtom, navigation);
        const isCurrent = () => get(threadNavigationSeqAtom) === navigation;

        try {
            // Cancel any active run before switching threads
            await cancelActiveRunIfNeeded(get, set, isCurrent);
            if (!isCurrent()) return;
            
            // Clean up any temporary annotations from previous thread
            await BeaverTemporaryAnnotations.cleanupAll().catch(error => {
                logger(`newThreadAtom: Error cleaning up temporary annotations: ${error}`);
            });
            
            if (!isCurrent()) return;
            const isLibraryTab = get(isLibraryTabAtom);
            set(currentThreadIdAtom, null);
            set(currentThreadNameAtom, null);

            // Clear agent-based atoms
            set(threadRunsAtom, []);
            set(activeRunAtom, null);
            set(threadAgentActionsAtom, []);
            set(clearAllPendingApprovalsAtom);
            set(clearAllPendingQuestionsAtom);
            set(clearAllPendingCreditConfirmationsAtom);
            set(clearAllPendingBatchApprovalsAtom);
            
            set(isWebSearchEnabledAtom, false);
            
            set(currentMessageItemsAtom, []);
            set(readerActionContextAtom, null);
            set(currentMessageCollectionsAtom, []);
            set(currentMessageExternalFilesAtom, []);
            set(removePopupMessagesByTypeAtom, ['items_summary']);
            set(citationsAtom, []);
            set(resetCitationMarkersAtom);
            resetRunSelectorCaches();
            if (!options?.preserveDraft) set(clearComposerAtom);
            set(resetMessageUIStateAtom);
            set(clearExternalReferenceCacheAtom);
            // Update message items from Zotero selection or reader
            if (!options?.skipAutoPopulate) {
                const addSelectedItemsOnNewThread = getPref('addSelectedItemsOnNewThread');
                if (isLibraryTab && addSelectedItemsOnNewThread) {
                    const maxAddAttachmentToMessage = getPref('maxAddAttachmentToMessage');
                    set(updateMessageItemsFromZoteroSelectionAtom, maxAddAttachmentToMessage);
                    set(updateMessageCollectionsFromZoteroSelectionAtom);
                }
                if (!isLibraryTab) {
                    await set(updateReaderAttachmentAtom);
                }
            }
            if (!isCurrent()) return;
            // Reset scroll state for both sidebar and window. The measured
            // position is reset with the intent: the thread being opened has
            // not been measured yet, and the previous thread's reading would
            // otherwise decide whether the scroll-down button shows.
            set(userScrolledAtom, false);
            set(windowUserScrolledAtom, false);
            set(isAtBottomAtom, true);
            set(windowIsAtBottomAtom, true);
            return navigation;
        } finally {
            // A superseding navigation owns its loading state.
            if (isCurrent()) set(isLoadingThreadAtom, false);
        }
    }
);

/**
 * Atom to load a thread
 */
export const loadThreadAtom = atom(
    null,
    async (
        get,
        set,
        { user_id, threadId, threadName, threadIdentity, skipInstanceMismatchConfirm, window, preserveDraft = false }: {
            window?: Window;
            user_id: string;
            threadId: string;
            threadName?: string;
            /**
             * The thread's stamped instance identity when the caller already has
             * it (thread-list rows). Omit to have the atom fetch it. Only pass
             * identities from sources that carry the identity fields — a
             * fabricated `{null, null}` reads as unattributed and skips the
             * mismatch confirm.
             */
            threadIdentity?: ZoteroInstanceRef;
            /** Skip the instance-mismatch confirm (headless test drivers). */
            skipInstanceMismatchConfirm?: boolean;
            preserveDraft?: boolean;
        }
    ): Promise<boolean> => {
        // Confirm before interrupting a run that's actively streaming in the
        // current thread. Status, not presence — see newThreadAtom.
        const hasActiveWork = get(isWSChatPendingAtom) || isRunActive(get(activeRunAtom));
        if (hasActiveWork && !confirmInterruptActiveRun(
            'Switch chat?',
            'Beaver is still generating a response in this chat. Switching chats will stop it.',
            'Switch Chat',
            window,
        )) {
            // A canceled load can't fulfill a pending deep-link scroll target.
            set(pendingScrollToRunAtom, null);
            return false;
        }

        // Show loading state immediately for instant UI feedback
        set(isLoadingThreadAtom, true);
        // Preflight can still be cancelled. Keep the committed navigation generation
        // intact so in-flight retries are not abandoned unless a switch is accepted.
        const loadedHistoryRevision = Zotero.Beaver?.presence?.getSnapshot().history[threadId] ?? 0;
        const previousNavigation = get(threadNavigationSeqAtom);
        const request = get(threadLoadRequestSeqAtom) + 1;
        set(threadLoadRequestSeqAtom, request);
        const navigation = previousNavigation + 1;
        let committed = false;
        const isCurrent = () => !committed
            ? get(threadNavigationSeqAtom) === previousNavigation && get(threadLoadRequestSeqAtom) === request
            : get(threadNavigationSeqAtom) === navigation;
        // Hydration callbacks can finish after this navigation is superseded.
        const guardedSet = ((...args: any[]) => isCurrent() ? (set as any)(...args) : undefined) as typeof set;

        // Resolve the thread's instance identity (and name, from the same
        // request) BEFORE any thread-state mutation, so a canceled mismatch
        // confirm or a failed identity fetch aborts without side effects.
        const statefulChat = getPref('statefulChat');
        let identity = threadIdentity;
        let resolvedName = threadName ?? null;
        // Captured before the fetch: a response that lands after a sign-out
        // must not repopulate the store for the previous account, and one that
        // predates a pin toggle must not write its stale flag back.
        const threadWriteStamp = get(threadWriteStampAtom);
        if (identity === undefined && statefulChat) {
            try {
                const thread = await Zotero.Beaver.threads.getThread(threadId);
                if (!isCurrent()) return false;
                identity = {
                    zoteroUserId: thread.zotero_user_id ?? null,
                    zoteroLocalId: thread.zotero_local_id ?? null,
                };
                resolvedName = resolvedName ?? (thread.name || null);
                // Feed the thread store: this is the one fetch a deep-linked
                // chat gets, and the chat lists and the header's pin entry all
                // read their state from there.
                set(upsertThreadsAtom, { threads: [threadModelToThreadData(thread)], stamp: threadWriteStamp });
            } catch (error) {
                if (!isCurrent()) return false;
                // An unknown identity must abort rather than degrade to
                // "matching": without it we cannot decide whether applied
                // actions are safe to validate against this library.
                logger(`loadThreadAtom: Failed to fetch thread ${threadId}: ${error}`, 1);
                set(pendingScrollToRunAtom, null);
                set(isLoadingThreadAtom, false);
                return false;
            }
        }
        // Legacy non-stateful threads live in this install's local DB — always matching.

        // Mismatched threads keep applied-action status unchanged on load:
        // personal-library refs resolve to *this* install's library, so a miss
        // would look like a user revert and auto-undo would corrupt history.
        const isMismatchedInstance = identity !== undefined
            && isThreadInstanceMismatch(currentZoteroInstanceRef(), identity);

        if (
            isMismatchedInstance
            && !skipInstanceMismatchConfirm
            && !confirmedMismatchedThreadIds.has(threadId)
        ) {
            const confirmed = confirmOpenMismatchedThread(window);
            if (!isCurrent()) return false;
            if (!confirmed) {
                set(pendingScrollToRunAtom, null);
                set(isLoadingThreadAtom, false);
                return false;
            }
            confirmedMismatchedThreadIds.add(threadId);
        }

        if (!isCurrent()) return false;
        committed = true;
        set(threadNavigationSeqAtom, navigation);

        let loaded = false;
        try {
            // Cancel any active run before loading a different thread
            await cancelActiveRunIfNeeded(get, set, isCurrent);
            if (!isCurrent()) return false;
            // Clean up any temporary annotations from previous thread
            await BeaverTemporaryAnnotations.cleanupAll().catch(error => {
                logger(`loadThreadAtom: Error cleaning up temporary annotations: ${error}`);
            });

            if (!isCurrent()) return false;
            // Reset scroll state for both sidebar and window. The measured
            // position is reset with the intent: the thread being opened has
            // not been measured yet, and the previous thread's reading would
            // otherwise decide whether the scroll-down button shows.
            set(userScrolledAtom, false);
            set(windowUserScrolledAtom, false);
            set(isAtBottomAtom, true);
            set(windowIsAtBottomAtom, true);
            // Set the current thread ID and name
            set(currentThreadIdAtom, threadId);
            set(currentThreadNameAtom, resolvedName);
            set(clearExternalReferenceCacheAtom);
            set(isWebSearchEnabledAtom, false);
            set(resetCitationMarkersAtom);

            // Clear all pending approvals/questions when loading a different thread
            set(clearAllPendingApprovalsAtom);
            set(clearAllPendingQuestionsAtom);
            set(clearAllPendingCreditConfirmationsAtom);
            set(clearAllPendingBatchApprovalsAtom);
            // Legacy non-stateful path: fetch the name from the local DB when
            // not provided (the stateful path already resolved it above).
            const threadNamePromise = !resolvedName && !statefulChat
                ? (async () => {
                    const cached = get(recentThreadsAtom).find(t => t.id === threadId);
                    if (cached?.name) return cached.name;
                    try {
                        const thread = await Zotero.Beaver.db.getThread(user_id, threadId);
                        return thread?.name || null;
                    } catch (error) {
                        logger(`loadThreadAtom: Failed to fetch thread name: ${error}`);
                        return null;
                    }
                })()
                : null;

            // Load agent runs with actions from the backend, and hydrate each
            // tool return as the shared loader walks the runs.
            const {
                runs: processedRuns,
                citations: citationMetadata,
                agentActions: agent_actions,
            } = await loadThreadRuns(threadId, {
                onToolReturn: async (part, toolCallArgs) => {
                    if (!isCurrent()) return;
                    await processToolReturnResults(part, guardedSet);
                    if (!isCurrent()) return;
                    // Synthesize a hydrated `view` for legacy results that lack
                    // one, so the shared render layer can render old threads
                    // from `metadata.view`.
                    await upgradeToolReturn(part, toolCallArgs);
                },
            });

            if (!isCurrent()) return false;
            // Protocol deep-links can request a run that does not exist in the target thread.
            // Clear the pending scroll target deterministically once thread data is loaded.
            const pendingRunId = get(pendingScrollToRunAtom);
            if (pendingRunId && !processedRuns.some(run => run.id === pendingRunId)) {
                logger(`loadThreadAtom: Pending run ${pendingRunId} not found in thread ${threadId}, clearing target`, 1);
                set(pendingScrollToRunAtom, null);
            }
            
            if (processedRuns.length > 0) {
                // Load item data for user attachments. Citations no longer
                // need item preloading: they render from backend metadata
                // alone (citation v2).
                const allItemReferences = new Map<string, ZoteroItemReference>();

                // From user attachments in runs (external files have no Zotero
                // reference to preload)
                for (const run of processedRuns) {
                    const attachments = run.user_prompt.attachments || [];
                    attachments
                        .filter(att => att.type !== 'external_file')
                        .filter(att => !!att.zotero_key)
                        .forEach(att => allItemReferences.set(zoteroReferenceKey(att), {
                            library_id: att.library_id,
                            zotero_key: att.zotero_key,
                            library_ref: att.library_ref,
                        }));
                }

                const refToItem = new Map<string, Zotero.Item>();
                const itemsPromises = Array.from(allItemReferences.entries()).map(async ([refKey, ref]) => {
                    const resolved = await resolveItemReference(ref);
                    if (resolved.status !== 'found') return null;
                    refToItem.set(refKey, resolved.item);
                    return resolved.item;
                });
                await Promise.all(itemsPromises);
                if (!isCurrent()) return false;
                const itemsToLoad = Array.from(refToItem.values());

                if (itemsToLoad.length > 0) {
                    await loadFullItemDataWithAllTypes(itemsToLoad);
                    if (!Zotero.Styles.initialized()) {
                        await Zotero.Styles.init();
                    }
                }

                if (!isCurrent()) return false;
                for (const run of processedRuns) {
                    for (const att of run.user_prompt.attachments || []) {
                        if (att.type !== 'item' && att.type !== 'source') continue;
                        const item = refToItem.get(zoteroReferenceKey(att));
                        if (item) enrichMessageAttachmentStub(att, item);
                    }
                }

                // Update citation state (synchronous: markers + citation tip)
                set(citationsAtom, citationMetadata);
                set(processCitationsAtom);
                set(maybeShowCitationTipAtom);

                // Preload PDF page labels in the background so subsequent
                // renders can resolve page locators to their display labels.
                preloadPageLabelsForCitations(citationMetadata)
                    .then((labelsByAttachmentId) => {
                        if (isCurrent()) set(mergePageLabelsByAttachmentIdAtom, labelsByAttachmentId);
                    })
                    .catch((err) =>
                        logger(`loadThreadAtom: Failed to preload page labels: ${err}`, 1)
                    );

                // Set agent runs. The scoped run selectors are dropped in the
                // same breath: reset any earlier and the old thread's runs, still
                // in the store while this load ran, would populate them again.
                resetRunSelectorCaches();
                set(threadRunsAtom, processedRuns);

                // Reconcile toolcall_id mismatches between REST API and model messages
                if (agent_actions && agent_actions.length > 0) {
                    reconcileToolcallIds(processedRuns, agent_actions);
                }

                // Set agent actions
                set(threadAgentActionsAtom, agent_actions || []);

                // Load item data for agent actions
                if (agent_actions && agent_actions.length > 0) {
                    await loadItemDataForAgentActions(agent_actions);
                    if (!isCurrent()) return false;
                }

                // Validate agent actions and undo those verifiably reverted in
                // Zotero. Skip on mismatched-instance threads — misses there are
                // not proof of revert (see isMismatchedInstance above).
                // 'unverifiable' means the reference points at a library this
                // device can't check (group libraryIDs are device-local).
                if (agent_actions && agent_actions.length > 0) {
                    if (isMismatchedInstance) {
                        logger(
                            `loadThreadAtom: skipping applied-action validation for mismatched-instance thread ${threadId}`,
                            1
                        );
                    } else {
                        await Promise.all(agent_actions.map(async (action: AgentAction) => {
                            const validity = await validateAppliedAgentAction(action);
                            if (!isCurrent()) return validity;
                            if (validity === 'invalid') {
                                logger(`loadThreadAtom: undoing agent action ${action.id} because it is not valid`, 1);
                                set(undoAgentActionAtom, action.id);
                            } else if (validity === 'unverifiable') {
                                logger(`loadThreadAtom: agent action ${action.id} references a library not available on this device; leaving status unchanged`, 1);
                            }
                            return validity;
                        }));
                    }
                }
                
                if (!isCurrent()) return false;
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
                resetRunSelectorCaches();
                set(threadRunsAtom, []);
                set(threadAgentActionsAtom, []);
                set(citationsAtom, []);
            }

            // Resolve thread name if fetched asynchronously
            if (threadNamePromise) {
                const fetchedName = await threadNamePromise;
                if (!isCurrent()) return false;
                if (fetchedName) {
                    set(currentThreadNameAtom, fetchedName);
                }
            }
            loaded = true;
        } catch (error) {
            if (!isCurrent()) return false;
            // Load failed, so any pending deep-link target can no longer be fulfilled.
            set(pendingScrollToRunAtom, null);

            if (isApiError(error) && error.status === 404) {
                logger(`loadThreadAtom: Thread ${threadId} not found, resetting to empty thread state`, 1);
                set(currentThreadIdAtom, null);
                resetRunSelectorCaches();
                set(threadRunsAtom, []);
                set(activeRunAtom, null);
                set(threadAgentActionsAtom, []);
                set(citationsAtom, []);
            } else {
                console.error('Error loading thread:', error);
            }
        } finally {
            if (isCurrent()) set(isLoadingThreadAtom, false);
        }
        if (!isCurrent()) return false;
        if (loaded) set(viewedHistoryRevisionAtom, loadedHistoryRevision);
        if (preserveDraft) return loaded;
        // Clear sources for now
        set(currentMessageItemsAtom, []);
        set(readerActionContextAtom, null);
        set(currentMessageCollectionsAtom, []);
        set(currentMessageExternalFilesAtom, []);
        set(removePopupMessagesByTypeAtom, ['items_summary']);
        set(clearComposerAtom);
        return loaded;
    }
);
