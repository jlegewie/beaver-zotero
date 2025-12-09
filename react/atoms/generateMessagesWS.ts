/**
 * WebSocket-based message generation atoms
 * 
 * This module provides Jotai atoms for WebSocket-based chat completion,
 * using AgentRun for structured run management.
 */

import { atom, Getter } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import {
    chatServiceWS,
    WSCallbacks,
    WSChatRequest,
    WSReadyData,
    WSConnectOptions,
    WSPartEvent,
    WSToolReturnEvent,
    WSRunCompleteEvent,
    WSErrorEvent,
    WSWarningEvent,
} from '../../src/services/chatServiceWS';
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
} from '../agents/atoms';
import { userIdAtom } from './auth';

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
function buildConnectOptions(model: FullModelConfig | null): WSConnectOptions {
    if (!model) return {};

    // Custom models rely on the payload, not query params
    if (model.is_custom) return {};

    const options: WSConnectOptions = {};

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
): { run: AgentRun; request: WSChatRequest } {
    const runId = uuidv4();

    // Create the request that will be sent to the backend
    // thread_id is null for new threads - backend generates the ID
    const request: WSChatRequest = {
        type: 'chat',
        run_id: runId,
        thread_id: threadId,
        user_prompt: userPrompt,
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
 * Send a chat message via WebSocket
 * 
 * Flow:
 * 1. Create AgentRun shell → set activeRunAtom → UI shows user message + spinner
 * 2. Connect WebSocket with auth params
 * 3. Receive "ready" event → send WSChatRequest
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
        // Note: thread_id may be null for new threads; it will be set when we receive 'thread' event
        set(activeRunAtom, run);

        // Reset user message input after creating the run
        set(currentMessageContentAtom, '');
        set(removePopupMessagesByTypeAtom, ['items_summary']);
        set(currentMessageItemsAtom, []);

        // Define callbacks
        const callbacks: WSCallbacks = {
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

            onToolReturn: (event: WSToolReturnEvent) => {
                console.log('[WS] Tool return event:', {
                    runId: event.run_id,
                    messageIndex: event.message_index,
                    toolName: event.part.tool_name,
                    toolCallId: event.part.tool_call_id,
                });
                set(activeRunAtom, (prev) => prev ? updateRunWithToolReturn(prev, event) : prev);
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
                // Update the current thread ID atom
                set(currentThreadIdAtom, newThreadId);
                // Update the active run with the thread ID (important for new threads)
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

                // Connection-per-request policy: close after each completed request
                chatServiceWS.close();
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

        try {
            console.log('[WS] Starting connection for message:', message.substring(0, 100));
            await chatServiceWS.connect(request, callbacks, connectOptions);
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
);

/**
 * Close the WebSocket connection
 */
export const closeWSConnectionAtom = atom(null, (_get, set) => {
    chatServiceWS.close();
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
});
