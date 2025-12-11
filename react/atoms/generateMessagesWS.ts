/**
 * WebSocket-based message generation atoms
 * 
 * This module provides Jotai atoms for WebSocket-based chat completion,
 * using AgentRun for structured run management.
 */

import { atom, Getter, Setter } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import {
    agentService,
    WSCallbacks,
    AgentRunRequest,
    WSReadyData,
    AgentRunOptions,
    WSPartEvent,
    WSToolReturnEvent,
    WSRunCompleteEvent,
    WSErrorEvent,
    WSWarningEvent,
    WSCitationEvent,
    WSAgentActionEvent,
    WSToolCallProgressEvent,
} from '../../src/services/agentService';
import { logger } from '../../src/utils/logger';
import { selectedModelAtom, FullModelConfig } from './models';
import { getPref } from '../../src/utils/prefs';
import { MessageAttachment, ReaderState, SourceAttachment } from '../types/attachments/apiTypes';
import { toMessageAttachment } from '../types/attachments/converters';
import { search_external_references_request, MessageSearchFilters } from '../../src/services/chatService';
import { serializeCollection, serializeZoteroLibrary } from '../../src/utils/zoteroSerializers';
import {
    currentMessageItemsAtom,
    currentReaderAttachmentAtom,
    currentMessageFiltersAtom,
    readerTextSelectionAtom,
    currentMessageContentAtom,
} from './messageComposition';
import { isWebSearchEnabledAtom, isLibraryTabAtom, removePopupMessagesByTypeAtom } from './ui';
import { processImageAnnotations } from './generateMessages';
import { getCurrentPage } from '../utils/readerUtils';
import { AgentRun, BeaverAgentPrompt } from '../agents/types';
import {
    threadRunsAtom,
    activeRunAtom,
    currentThreadIdAtom,
    updateRunWithPart,
    updateRunWithToolReturn,
    updateRunComplete,
    updateRunWithToolCallProgress,
} from '../agents/atoms';
import { userIdAtom } from './auth';
import { citationMetadataAtom, updateCitationDataAtom } from './citations';
import {
    addAgentActionsAtom,
    toAgentAction,
    clearAgentActionsAtom,
    threadAgentActionsAtom,
    isAnnotationAgentAction,
    hasAppliedZoteroItem,
    AgentAction,
} from '../agents/agentActions';
import { processToolReturnResults } from '../agents/toolResultProcessing';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the user's API key for a model.
 * 
 * Returns a key in these cases:
 * - Custom models: Use the API key from the custom model config
 * - User-key models (not app-key): Use the user's configured API key for the provider
 * - App-key models: No user API key needed (returns undefined)
 */
function getUserApiKey(model: FullModelConfig): string | undefined {
    // App-key models don't need user API keys
    if (model.use_app_key) return undefined;

    // Custom models use the API key from their config
    if (model.is_custom && model.custom_model?.api_key) {
        return model.custom_model.api_key;
    }

    // Non-custom, non-app-key models use the user's configured provider key
    if (model.provider === 'google') {
        return getPref('googleGenerativeAiApiKey') || undefined;
    } else if (model.provider === 'openai') {
        return getPref('openAiApiKey') || undefined;
    } else if (model.provider === 'anthropic') {
        return getPref('anthropicApiKey') || undefined;
    }
    return undefined;
}

/**
 * Build connection options for WebSocket based on the selected model.
 * - Custom models: no access_id/api_key in query params (use custom_model payload)
 * - Non-custom models: access_id from plan, api_key for user-key models
 */
function buildConnectOptions(model: FullModelConfig | null): AgentRunOptions {
    if (!model) return {};

    // Custom models rely on the payload, not query params
    if (model.is_custom) return {};

    const options: AgentRunOptions = {};

    // Include access_id for non-custom models
    if (!model.is_custom) {
        options.accessId = model.access_id;
    }

    // Include api_key for user-key models
    const apiKey = getUserApiKey(model);
    if (apiKey) {
        options.apiKey = apiKey;
    }

    return options;
}

/**
 * Build reader state for the current reader attachment.
 */
function getReaderState(get: Getter): ReaderState | null {
    const readerAttachment = get(currentReaderAttachmentAtom);
    if (!readerAttachment) return null;

    const currentTextSelection = get(readerTextSelectionAtom);
    return {
        library_id: readerAttachment.libraryID,
        zotero_key: readerAttachment.key,
        current_page: getCurrentPage() || null,
        ...(currentTextSelection && { text_selection: currentTextSelection })
    } as ReaderState;
}

/**
 * Create the initial AgentRun shell when user presses send.
 * This happens BEFORE WebSocket connection.
 */
function createAgentRunShell(
    userPrompt: BeaverAgentPrompt,
    threadId: string | null,
    userId: string,
    modelName: string,
    providerName?: string,
    customInstructions?: string,
    customModel?: FullModelConfig['custom_model'],
    rewriteFromRunId?: string,
): { run: AgentRun; request: AgentRunRequest } {
    const runId = uuidv4();

    // Create the request that will be sent to the backend
    // thread_id is null for new threads - backend generates the ID
    const request: AgentRunRequest = {
        type: 'chat',
        run_id: runId,
        thread_id: threadId,
        user_prompt: userPrompt,
        ...(rewriteFromRunId ? { retry_run_id: rewriteFromRunId } : {}),
        custom_instructions: customInstructions,
        custom_model: customModel,
    };

    // Create the shell AgentRun for immediate UI rendering
    // thread_id will be updated when we receive the 'thread' event from backend
    const run: AgentRun = {
        id: runId,
        user_id: userId,
        thread_id: threadId,
        agent_name: 'beaver',
        user_prompt: userPrompt,
        status: 'in_progress',
        model_messages: [],
        model_name: modelName,
        provider_name: providerName,
        created_at: new Date().toISOString(),
        consent_to_share: false,
    };

    return { run, request };
}

/**
 * Delete applied Zotero items (annotations, notes) from agent actions.
 * Returns the number of items successfully deleted.
 */
async function deleteAppliedZoteroItems(actions: AgentAction[]): Promise<number> {
    let deletedCount = 0;
    for (const action of actions) {
        if (hasAppliedZoteroItem(action)) {
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                    action.result_data!.library_id,
                    action.result_data!.zotero_key
                );
                if (item) {
                    await item.eraseTx();
                    deletedCount++;
                }
            } catch (error) {
                logger(`deleteAppliedZoteroItems: Failed to delete item for action ${action.id}: ${error}`, 1);
            }
        }
    }
    return deletedCount;
}

/**
 * Prompt user to confirm deletion of applied agent actions.
 * Returns true if user confirms deletion, false otherwise.
 */
function confirmDeleteAppliedActions(actions: AgentAction[]): boolean {
    const allAreAnnotations = actions.every(isAnnotationAgentAction);
    const title = allAreAnnotations ? 'Delete annotations?' : 'Undo changes?';
    const message = allAreAnnotations
        ? 'Do you want to delete the annotations created by the assistant messages that will be regenerated?'
        : 'Do you want to undo the changes created by the assistant messages that will be regenerated?';

    const buttonIndex = Zotero.Prompt.confirm({
        window: Zotero.getMainWindow(),
        title,
        text: message,
        button0: Zotero.Prompt.BUTTON_TITLE_YES,
        button1: Zotero.Prompt.BUTTON_TITLE_NO,
        defaultButton: 1,
    });

    return buttonIndex === 0;
}

// =============================================================================
// State Atoms
// =============================================================================

/** Whether a WebSocket chat request is currently in progress */
export const isWSChatPendingAtom = atom(false);

/** Whether the WebSocket is currently connected */
export const isWSConnectedAtom = atom(false);

/** Whether the server has sent the ready event (validation complete) */
export const isWSReadyAtom = atom(false);

/** Ready event data from server (model, subscription, processing info) */
export const wsReadyDataAtom = atom<WSReadyData | null>(null);

/** Last error from WebSocket */
export const wsErrorAtom = atom<WSErrorEvent | null>(null);

/** Last warning from WebSocket */
export const wsWarningAtom = atom<WSWarningEvent | null>(null);

// =============================================================================
// Action Atoms
// =============================================================================

/**
 * Reset all WebSocket state atoms
 */
export const resetWSStateAtom = atom(null, (_get, set) => {
    set(isWSChatPendingAtom, false);
    set(isWSConnectedAtom, false);
    set(isWSReadyAtom, false);
    set(wsReadyDataAtom, null);
    set(wsErrorAtom, null);
    set(wsWarningAtom, null);
});

/**
 * Create WebSocket callbacks for handling streaming events.
 * Shared between sendWSMessageAtom and regenerateFromRunAtom.
 */
function createWSCallbacks(set: Setter): WSCallbacks {
    return {
        onReady: (data: WSReadyData) => {
            logger(`WS onReady: model=${data.modelName}, charge=${data.chargeType}, ` +
                   `mode=${data.processingMode}, indexing=${data.indexingComplete}`, 1);
            console.log('[WS] Ready event received:', data);
            set(isWSReadyAtom, true);
            set(wsReadyDataAtom, data);
        },

        onPart: (event: WSPartEvent) => {
            const partKind = event.part.part_kind;
            console.log('[WS] Part event:', {
                runId: event.run_id,
                messageIndex: event.message_index,
                partIndex: event.part_index,
                partKind,
            });
            set(activeRunAtom, (prev) => prev ? updateRunWithPart(prev, event) : prev);
        },

        onToolReturn: async (event: WSToolReturnEvent) => {
            console.log('[WS] Tool return event:', {
                runId: event.run_id,
                messageIndex: event.message_index,
                toolName: event.part.tool_name,
                toolCallId: event.part.tool_call_id,
            });

            // Process tool return results
            if (event.part.part_kind === "tool-return") await processToolReturnResults(event.part, set);

            // Update run with tool return
            set(activeRunAtom, (prev) => prev ? updateRunWithToolReturn(prev, event) : prev);
        },

        onToolCallProgress: (event: WSToolCallProgressEvent) => {
            logger(`WS onToolCallProgress: ${event.run_id} - ${event.tool_call_id} - ${event.progress}`, 1);
            set(activeRunAtom, (prev) => prev ? updateRunWithToolCallProgress(prev, event) : prev);
        },

        onRunComplete: (event: WSRunCompleteEvent) => {
            logger(`WS onRunComplete: ${event.run_id}`, 1);
            console.log('[WS] Run complete event:', {
                runId: event.run_id,
                usage: event.usage,
                cost: event.cost,
            });
            set(activeRunAtom, (prev) => prev ? updateRunComplete(prev, event) : prev);
        },

        onThread: (newThreadId: string) => {
            logger(`WS onThread: ${newThreadId}`, 1);
            console.log('[WS] Thread event:', { threadId: newThreadId });
            set(currentThreadIdAtom, newThreadId);
            set(activeRunAtom, (prev) => prev ? { ...prev, thread_id: newThreadId } : prev);
        },

        onDone: () => {
            logger('WS onDone: Request fully complete', 1);
            console.log('[WS] Done event: Full request finished');

            // Move active run to completed runs
            set(activeRunAtom, (prev) => {
                if (prev) {
                    const finalRun: AgentRun = {
                        ...prev,
                        status: prev.status === 'in_progress' ? 'completed' : prev.status,
                        completed_at: prev.completed_at || new Date().toISOString(),
                    };
                    set(threadRunsAtom, (runs) => [...runs, finalRun]);
                }
                return null;
            });

            agentService.close();
            set(isWSChatPendingAtom, false);
        },

        onError: (event: WSErrorEvent) => {
            logger(`WS onError: ${event.type} - ${event.message}`, 1);
            console.error('[WS] Error event:', event);
            set(wsErrorAtom, event);
            set(activeRunAtom, (prev) => prev ? { ...prev, status: 'error' } : prev);
            set(isWSChatPendingAtom, false);
        },

        onWarning: (event: WSWarningEvent) => {
            logger(`WS onWarning: ${event.type} - ${event.message}`, 1);
            console.warn('[WS] Warning event:', event);
            set(wsWarningAtom, event);
        },

        onCitation: (event: WSCitationEvent) => {
            logger(`WS onCitation: ${event.citation.citation_id} for run ${event.run_id}`, 1);
            console.log('[WS] Citation event:', {
                runId: event.run_id,
                citationId: event.citation.citation_id,
                authorYear: event.citation.author_year,
            });
            set(citationMetadataAtom, (prev) => [...prev, { ...event.citation, run_id: event.run_id }]);
            set(updateCitationDataAtom);
        },

        onAgentAction: (event: WSAgentActionEvent) => {
            logger(`WS onAgentAction: ${event.action.id} (${event.action.action_type}) for run ${event.run_id}`, 1);
            console.log('[WS] Agent action event:', {
                runId: event.run_id,
                actionId: event.action.id,
                actionType: event.action.action_type,
                status: event.action.status,
            });
            const agentAction = toAgentAction(event.action);
            set(addAgentActionsAtom, [agentAction]);
        },

        onOpen: () => {
            logger('WS onOpen: Connection established, waiting for ready...', 1);
            console.log('[WS] Connection opened, awaiting server validation...');
            set(isWSConnectedAtom, true);
        },

        onClose: (code: number, reason: string, wasClean: boolean) => {
            logger(`WS onClose: code=${code}, reason=${reason}, clean=${wasClean}`, 1);
            console.log('[WS] Connection closed:', { code, reason, wasClean });
            set(isWSConnectedAtom, false);
            set(isWSReadyAtom, false);
            set(isWSChatPendingAtom, false);
        }
    };
}

/**
 * Execute a WebSocket request with the given run and request.
 * Handles connection, callbacks, and error handling.
 */
async function executeWSRequest(
    run: AgentRun,
    request: AgentRunRequest,
    connectOptions: AgentRunOptions,
    set: Setter
): Promise<void> {
    const callbacks = createWSCallbacks(set);

    try {
        console.log('[WS] Starting connection for run:', run.id);
        await agentService.connect(request, callbacks, connectOptions);
        console.log('[WS] Connection established and ready');
    } catch (error) {
        logger(`WS connection error: ${error}`, 1);
        console.error('[WS] Connection failed:', error);
        set(wsErrorAtom, {
            event: 'error',
            type: 'connection_error',
            message: error instanceof Error ? error.message : 'Connection failed',
        });
        set(activeRunAtom, (prev) => prev ? { ...prev, status: 'error' } : prev);
        set(isWSChatPendingAtom, false);
    }
}

/**
 * Send a chat message via WebSocket
 * 
 * Flow:
 * 1. Create AgentRun shell → set activeRunAtom → UI shows user message + spinner
 * 2. Connect WebSocket with auth params
 * 3. Receive "ready" event → send AgentRunRequest
 * 4. "part" events → update model_messages with text/thinking/tool_call
 * 5. "tool_return" events → add ToolReturnPart to model_messages
 * 6. "run_complete" event → update usage, set status="completed"
 * 7. "done" event → move activeRun to threadRuns, close connection
 */
export const sendWSMessageAtom = atom(
    null,
    async (get, set, message: string) => {
        // Reset state
        set(resetWSStateAtom);
        set(isWSChatPendingAtom, true);

        // Get current model and build connection options
        const model = get(selectedModelAtom);
        const connectOptions = buildConnectOptions(model);

        // Log model and connection info
        console.log('[WS] Selected model:', model ? {
            id: model.id,
            access_id: model.access_id,
            name: model.name,
            provider: model.provider,
            is_custom: model.is_custom,
            use_app_key: model.use_app_key,
        } : null);
        console.log('[WS] Connection options:', {
            accessId: connectOptions.accessId || '(not set - will use plan default)',
            hasApiKey: !!connectOptions.apiKey,
        });

        // Custom instructions (if any)
        const customInstructions = getPref('customInstructions') || undefined;

        // Build attachments from current message items
        const selectedItems = get(currentMessageItemsAtom);
        let attachments: MessageAttachment[] =
            selectedItems
                .map(item => toMessageAttachment(item))
                .filter((attachment): attachment is MessageAttachment => attachment !== null);
        attachments = await processImageAnnotations(attachments);

        // Add current reader attachment as source if not already present
        const readerState = getReaderState(get);
        const readerAttachment = get(currentReaderAttachmentAtom);
        if (readerAttachment && readerState) {
            const existingKeys = new Set(attachments.map(att => `${att.library_id}-${att.zotero_key}`));
            const readerKey = `${readerAttachment.libraryID}-${readerAttachment.key}`;
            if (!existingKeys.has(readerKey)) {
                attachments.push({
                    library_id: readerAttachment.libraryID,
                    zotero_key: readerAttachment.key,
                    type: 'source',
                    include: 'fulltext'
                } as SourceAttachment);
            }
        }

        // Build filters payload
        const filterState = get(currentMessageFiltersAtom);
        const filterLibraries = filterState.libraryIds.length > 0
            ? filterState.libraryIds
                .map(id => Zotero.Libraries.get(id))
                .filter((l): l is Zotero.Library => !!l)
                .map(serializeZoteroLibrary)
            : null;
        const filterCollections = filterState.collectionIds.length > 0
            ? (await Promise.all(filterState.collectionIds.map(id => serializeCollection(Zotero.Collections.get(id))))).filter(Boolean)
            : null;
        const filterTags = filterState.tagSelections.length > 0
            ? filterState.tagSelections.map(tag => ({ ...tag }))
            : null;
        const filtersPayload: MessageSearchFilters = {
            libraries: filterLibraries,
            collections: filterCollections,
            tags: filterTags
        };

        // Tool requests (web search)
        const toolRequests = get(isWebSearchEnabledAtom)
            ? [search_external_references_request]
            : undefined;

        // Application state
        const currentView: 'library' | 'file_reader' = get(isLibraryTabAtom) ? 'library' : 'file_reader';
        const applicationState = {
            current_view: currentView,
            ...(readerState ? { reader_state: readerState } : {})
        };

        // Build the message
        const userPrompt: BeaverAgentPrompt = {
            content: message,
            ...(attachments.length > 0 ? { attachments } : {}),
            application_state: applicationState,
            filters: filtersPayload,
            ...(toolRequests ? { tool_requests: toolRequests } : {})
        };

        // Get current thread ID (null for new thread)
        const threadId = get(currentThreadIdAtom);

        // Get user ID for the run
        const userId = get(userIdAtom);
        if (!userId) {
            console.error('[WS] User ID not found');
            return;
        }

        // Create AgentRun shell and request
        const { run, request } = createAgentRunShell(
            userPrompt,
            threadId,
            userId,
            model?.name ?? 'unknown',
            model?.provider,
            customInstructions,
            model?.is_custom ? model.custom_model : undefined,
        );

        // Set active run - UI now shows user message + spinner
        set(activeRunAtom, run);

        // Reset user message input after creating the run
        set(currentMessageContentAtom, '');
        set(removePopupMessagesByTypeAtom, ['items_summary']);
        set(currentMessageItemsAtom, []);

        // Execute the WebSocket request
        await executeWSRequest(run, request, connectOptions, set);
    }
);

/**
 * Regenerate a response from a specific run.
 * 
 * Flow:
 * 1. Find the run to regenerate from
 * 2. Optionally delete applied agent actions (annotations, notes) if user confirms
 * 3. Remove runs from that point forward
 * 4. Clear related agent actions and citations
 * 5. Create new run with the same user_prompt
 * 6. Execute via WebSocket
 */
export const regenerateFromRunAtom = atom(
    null,
    async (get, set, runId: string) => {
        logger(`regenerateFromRunAtom: Regenerating from run ${runId}`, 1);

        // Get current model
        const model = get(selectedModelAtom);
        if (!model) {
            logger('regenerateFromRunAtom: No model selected', 1);
            return;
        }

        // Get current thread ID
        const threadId = get(currentThreadIdAtom);
        if (!threadId) {
            logger('regenerateFromRunAtom: No thread ID found', 1);
            return;
        }

        // Get user ID
        const userId = get(userIdAtom);
        if (!userId) {
            logger('regenerateFromRunAtom: No user ID found', 1);
            return;
        }

        // Find the run index in threadRuns
        const threadRuns = get(threadRunsAtom);
        const runIndex = threadRuns.findIndex(r => r.id === runId);
        if (runIndex < 0) {
            logger(`regenerateFromRunAtom: Run ${runId} not found in threadRuns`, 1);
            return;
        }

        // Get the run to regenerate from
        const targetRun = threadRuns[runIndex];

        // Collect run IDs that will be removed (target run and all subsequent)
        const runIdsToRemove = threadRuns.slice(runIndex).map(r => r.id);

        // Find applied agent actions for runs being removed
        const allAgentActions = get(threadAgentActionsAtom);
        const actionsToDelete = allAgentActions
            .filter(a => runIdsToRemove.includes(a.run_id))
            .filter(hasAppliedZoteroItem);

        // Prompt user to confirm deletion of applied actions
        if (actionsToDelete.length > 0) {
            const shouldDelete = confirmDeleteAppliedActions(actionsToDelete);
            if (shouldDelete) {
                await deleteAppliedZoteroItems(actionsToDelete);
            }
        }

        // Truncate runs - keep only runs before the target
        const truncatedRuns = threadRuns.slice(0, runIndex);
        set(threadRunsAtom, truncatedRuns);

        // Clear agent actions for removed runs
        set(threadAgentActionsAtom, (prev) => 
            prev.filter(a => !runIdsToRemove.includes(a.run_id))
        );

        // Clear citations for removed runs
        set(citationMetadataAtom, (prev) => 
            prev.filter(c => !runIdsToRemove.includes(c.run_id ?? ''))
        );
        set(updateCitationDataAtom);

        // Reset WS state and set pending
        set(resetWSStateAtom);
        set(isWSChatPendingAtom, true);

        // Build connection options
        const connectOptions = buildConnectOptions(model);
        const customInstructions = getPref('customInstructions') || undefined;

        // Create new AgentRun shell with the same user_prompt
        const { run: newRun, request } = createAgentRunShell(
            targetRun.user_prompt,
            threadId,
            userId,
            model.name,
            model.provider,
            customInstructions,
            model.is_custom ? model.custom_model : undefined,
            targetRun.id, // ask backend to rewrite thread from this run forward
        );

        // Set active run - UI now shows user message + spinner
        set(activeRunAtom, newRun);

        // Execute the WebSocket request
        await executeWSRequest(newRun, request, connectOptions, set);
    }
);

/**
 * Close the WebSocket connection
 */
export const closeWSConnectionAtom = atom(null, (_get, set) => {
    agentService.close();
    set(isWSConnectedAtom, false);
    set(isWSReadyAtom, false);
    set(isWSChatPendingAtom, false);
});

/**
 * Clear the current thread and start fresh
 */
export const clearThreadAtom = atom(null, (_get, set) => {
    set(threadRunsAtom, []);
    set(activeRunAtom, null);
    set(currentThreadIdAtom, null);
    set(resetWSStateAtom);
    // Clear agent actions and citations for the thread
    set(clearAgentActionsAtom);
    set(citationMetadataAtom, []);
});
