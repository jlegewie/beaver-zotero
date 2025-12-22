/**
 * WebSocket-based message generation atoms
 * 
 * This module provides Jotai atoms for WebSocket-based chat completion,
 * using AgentRun for structured run management.
 */

import { atom, Getter, Setter } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { agentService } from '../../src/services/agentService';
import {
    WSCallbacks,
    AgentRunRequest,
    WSReadyData,
    WSRequestAckData,
    WSPartEvent,
    WSToolReturnEvent,
    WSRunCompleteEvent,
    WSErrorEvent,
    WSWarningEvent,
    WSRetryEvent,
    WSAgentActionsEvent,
    WSToolCallProgressEvent,
    WSMissingZoteroDataEvent,
} from '../../src/services/agentProtocol';
import { logger } from '../../src/utils/logger';
import { selectedModelAtom, FullModelConfig } from './models';
import { getPref } from '../../src/utils/prefs';
import { MessageAttachment, ReaderState, SourceAttachment } from '../types/attachments/apiTypes';
import { toMessageAttachment } from '../types/attachments/converters';
import { serializeCollection, serializeZoteroLibrary } from '../../src/utils/zoteroSerializers';
import {
    currentMessageItemsAtom,
    currentReaderAttachmentAtom,
    currentMessageFiltersAtom,
    readerTextSelectionAtom,
    currentMessageContentAtom,
} from './messageComposition';
import { isWebSearchEnabledAtom, isLibraryTabAtom, removePopupMessagesByTypeAtom } from './ui';
import { isAnnotationAttachment } from '../types/attachments/apiTypes';
import { getCurrentPage } from '../utils/readerUtils';
import { uint8ArrayToBase64 } from '../utils/fileUtils';
import { isAttachmentOnServer } from '../../src/utils/webAPI';
import { AgentRun, BeaverAgentPrompt, MessageSearchFilters, ToolRequest } from '../agents/types';
import {
    threadRunsAtom,
    activeRunAtom,
    currentThreadIdAtom,
    updateRunWithPart,
    updateRunWithToolReturn,
    updateRunComplete,
    updateRunWithToolCallProgress,
    allUserAttachmentKeysAtom,
    resetRunMessages,
} from '../agents/atoms';
import { userIdAtom } from './auth';
import { citationMetadataAtom, updateCitationDataAtom, resetCitationMarkersAtom } from './citations';
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
import { addWarningAtom, clearWarningsAtom } from './warnings';
import { loadItemDataForAgentActions, autoApplyAnnotationAgentActions } from '../utils/agentActionUtils';
import { store } from '../store';
import { syncLibraryIdsAtom, syncWithZoteroAtom } from './profile';
import { syncingItemFilterAsync } from '../../src/utils/sync';
import { safeIsInTrash } from '../../src/utils/zoteroUtils';
import { wasItemAddedBeforeLastSync } from '../utils/sourceUtils';
import { ZoteroItemReference } from '../types/zotero';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Processes annotation attachments of type image to add base64 data.
 * 
 * @param attachments - Array of MessageAttachment objects to process
 * @returns Array of MessageAttachment objects with base64 data
 */
export async function processImageAnnotations(attachments: MessageAttachment[]): Promise<MessageAttachment[]> {
    // Process image annotations to add base64 data
    const processedAttachments = await Promise.all(
        attachments.map(async (attachment) => {
            // Only process AnnotationAttachment of type image
            if (!isAnnotationAttachment(attachment)) return attachment;
            if (attachment.annotation_type !== 'image') return attachment;

            // Create a reference to the Zotero item
            const item = {
                libraryID: attachment.library_id,
                key: attachment.zotero_key
            };

            // Check if image exists in cache
            const hasCachedImage = await Zotero.Annotations.hasCacheImage(item);
            if (!hasCachedImage) {
                logger(`processImageAnnotations: No cached image found for attachment ${attachment.zotero_key}`);
                return attachment;
            }

            try {
                // Get image path
                const imagePath = Zotero.Annotations.getCacheImagePath(item);
                
                // Read the image file and convert to base64
                const imageData = await IOUtils.read(imagePath);
                const image_base64 = uint8ArrayToBase64(imageData);
                
                // Return attachment with image data
                return {
                    ...attachment,
                    image_base64: image_base64
                };
            } catch (error) {
                logger(`processImageAnnotations: Failed to process image for attachment ${attachment.zotero_key}: ${error}`);
                return attachment;
            }
        })
    );
    return processedAttachments;
}

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

/** Model selection options to be included in the AgentRunRequest */
interface ModelSelectionOptions {
    access_id?: string;
    api_key?: string;
}

/**
 * Build model selection options to include in the AgentRunRequest.
 * - Custom models: Use the custom_model field in the request (no access_id/api_key)
 * - Non-custom models: access_id from plan, api_key for BYOK models
 */
function buildModelSelectionOptions(model: FullModelConfig | null): ModelSelectionOptions {
    if (!model) return {};

    // Custom models use the custom_model field in the request, not access_id/api_key
    if (model.is_custom) return {};

    const options: ModelSelectionOptions = {};

    // Include access_id for non-custom models
    options.access_id = model.access_id;

    // Include api_key for user-key models (BYOK)
    const apiKey = getUserApiKey(model);
    if (apiKey) {
        options.api_key = apiKey;
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
    modelSelectionOptions: ModelSelectionOptions,
    providerName?: string,
    customInstructions?: string,
    customModel?: FullModelConfig['custom_model'],
    rewriteFromRunId?: string,
): { run: AgentRun; request: AgentRunRequest } {
    const runId = uuidv4();

    // Create the request that will be sent to the backend
    // thread_id is null for new threads - backend generates the ID
    // Model selection is included in the request (access_id/api_key for plan models, custom_model for custom)
    const request: AgentRunRequest = {
        type: 'chat',
        run_id: runId,
        thread_id: threadId,
        user_prompt: userPrompt,
        ...(modelSelectionOptions.access_id ? { access_id: modelSelectionOptions.access_id } : {}),
        ...(modelSelectionOptions.api_key ? { api_key: modelSelectionOptions.api_key } : {}),
        ...(customModel ? { custom_model: customModel } : {}),
        ...(rewriteFromRunId ? { retry_run_id: rewriteFromRunId } : {}),
        ...(customInstructions ? { custom_instructions: customInstructions } : {}),
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
// Missing Zotero Data Handling
// =============================================================================

/** Reason why an item might be missing from the backend */
type MissingItemReason = 
    | 'not_found'           // Item doesn't exist in Zotero
    | 'in_trash'            // Item is in trash
    | 'library_not_synced'  // Library not configured to sync
    | 'filtered_from_sync'  // Doesn't pass sync filters (e.g., not a PDF)
    | 'pending_sync'        // Added after last sync
    | 'file_unavailable_locally_and_on_server' // File unavailable locally and on server
    | 'unknown';            // Unknown reason

/**
 * Determine why an item is missing from the backend.
 * Returns the most likely reason based on item status checks.
 */
async function determineMissingReason(ref: ZoteroItemReference, userId: string | null): Promise<MissingItemReason> {
    try {
        // Get sync configuration from store
        const syncLibraryIds = store.get(syncLibraryIdsAtom);
        const syncWithZotero = store.get(syncWithZoteroAtom);

        // Check if library is synced
        if (!syncLibraryIds.includes(ref.library_id)) {
            return 'library_not_synced';
        }

        // Try to get the item from Zotero
        const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key);
        if (!item) {
            return 'not_found';
        }

        // Load item and parent item data for proper status checks
        await Zotero.Items.loadDataTypes([item], ["primaryData"]);
        if (item.parentID) {
            const parentItem = await Zotero.Items.getAsync(item.parentID);
            if (parentItem) {
                await Zotero.Items.loadDataTypes([parentItem], ["primaryData"]);
            }
        }

        // Check if in trash
        const trashState = safeIsInTrash(item);
        if (trashState === true) {
            return 'in_trash';
        }

        // Check if passes sync filters
        const passesSyncFilters = await syncingItemFilterAsync(item);
        if (!passesSyncFilters) {
            return 'filtered_from_sync';
        }

        // Check if available locally or on server
        const availableLocallyOrOnServer = !item.isAttachment() || (await item.fileExists()) || isAttachmentOnServer(item);
        if (!availableLocallyOrOnServer) {
            return 'file_unavailable_locally_and_on_server';
        }

        // Check if pending sync (added after last sync)
        if (userId) {
            try {
                const wasAddedBeforeSync = await wasItemAddedBeforeLastSync(item, syncWithZotero, userId);
                if (!wasAddedBeforeSync) {
                    return 'pending_sync';
                }
            } catch {
                // Unable to determine pending status
            }
        }

        // If we get here and item exists but wasn't found in backend, it's unknown
        return 'unknown';
    } catch (error) {
        logger(`determineMissingReason: Error checking item ${ref.library_id}-${ref.zotero_key}: ${error}`, 1);
        return 'unknown';
    }
}

/** Human-readable messages for each missing reason */
const MISSING_REASON_MESSAGES: Record<MissingItemReason, string> = {
    'not_found': 'Item not found in your Zotero library',
    'in_trash': 'Item is in trash',
    'library_not_synced': 'Library is not configured to sync with Beaver',
    'filtered_from_sync': 'Item type not supported',
    'pending_sync': 'Item was added after the last sync. Please wait for sync to complete or sync manually in settings',
    'file_unavailable_locally_and_on_server': 'File is unavailable',
    'unknown': `Unexpected error. Please read about <a href="${process.env.WEBAPP_BASE_URL + '/docs/trouble-file-sync'}" className="text-link">sync issues</a> in the documentation and contact support if the issue persists.`,
};

/**
 * Process missing Zotero data event and generate a warning message.
 * Determines reasons for all items and creates a warning with a list of reasons and counts.
 */
async function handleMissingZoteroData(
    event: WSMissingZoteroDataEvent,
    userId: string | null,
    addWarning: (params: { run_id: string; type: string; message: string; data?: Record<string, unknown> }) => void
): Promise<void> {
    if (event.items.length === 0) return;

    // Determine reasons for each item
    const reasons = await Promise.all(
        event.items.map(async (item) => ({
            item,
            reason: await determineMissingReason(item, userId)
        }))
    );
    logger('handleMissingZoteroData: reasons', reasons, 1);

    // Count reasons
    const reasonCounts = new Map<MissingItemReason, number>();
    for (const { reason } of reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }

    // Sort reasons by count (descending) for better readability
    const sortedReasons = Array.from(reasonCounts.entries())
        .sort((a, b) => b[1] - a[1]);

    // Determine the primary reason to show
    // Prioritize 'unknown' as it's most severe, otherwise show the most common reason
    const unknownEntry = sortedReasons.find(([reason]) => reason === 'unknown');
    const [primaryReason, primaryCount] = unknownEntry || sortedReasons[0];
    
    // Build user-friendly message
    const itemCount = event.items.length;
    const itemWord = itemCount === 1 ? 'attachment' : 'attachments';
    const otherCount = itemCount - primaryCount;
    
    let message = `Unable to process ${itemCount} ${itemWord}: ${MISSING_REASON_MESSAGES[primaryReason]}`;
    
    // Add count if not all items have the same reason
    if (primaryCount < itemCount) {
        message += ` (${primaryCount}/${itemCount})`;
    }
    
    // Mention other reasons exist without listing them all
    if (otherCount > 0) {
        message += `\n\n${otherCount} other ${itemWord} ${otherCount === 1 ? 'has a' : 'have'} different reason.`;
    }
    
    // Add sync documentation link if any sync-related reasons are present
    const syncRelatedReasons: MissingItemReason[] = ['pending_sync'];
    const hasSyncRelatedReason = sortedReasons.some(([reason]) => syncRelatedReasons.includes(reason));
    if (hasSyncRelatedReason) {
        const syncDocUrl = process.env.WEBAPP_BASE_URL + '/docs/trouble-file-sync';
        message += `\n\n<a href="${syncDocUrl}" className="text-link">Learn more</a> about fixing sync issues.`;
    }

    // Add warning
    addWarning({
        run_id: event.run_id,
        type: 'missing_zotero_data',
        message,
        data: {
            items: event.items,
            reason_counts: Object.fromEntries(reasonCounts),
        },
    });
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

/** Ready event data from server (subscription, processing info) */
export const wsReadyDataAtom = atom<WSReadyData | null>(null);

/** Request acknowledgment data from server (model, charge type info) */
export const wsRequestAckDataAtom = atom<WSRequestAckData | null>(null);

/** Last error from WebSocket */
export const wsErrorAtom = atom<WSErrorEvent | null>(null);

/** Last warning from WebSocket */
export const wsWarningAtom = atom<WSWarningEvent | null>(null);

/** Retry state from WebSocket (when backend is retrying a failed request) */
export interface RetryState {
    runId: string;
    attempt: number;
    maxAttempts: number;
    reason: string;
    waitSeconds?: number | null;
}
export const wsRetryAtom = atom<RetryState | null>(null);

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
    set(wsRequestAckDataAtom, null);
    set(wsErrorAtom, null);
    set(wsWarningAtom, null);
    set(wsRetryAtom, null);
});

/**
 * Create WebSocket callbacks for handling streaming events.
 * Shared between sendWSMessageAtom and regenerateFromRunAtom.
 */
function createWSCallbacks(set: Setter): WSCallbacks {
    return {
        onReady: (data: WSReadyData) => {
            logger('WS onReady:', data, 1);
            set(isWSReadyAtom, true);
            set(wsReadyDataAtom, data);
        },

        onRequestAck: (data: WSRequestAckData) => {
            logger('WS onRequestAck:', data, 1);
            set(wsRequestAckDataAtom, data);
        },

        onPart: (event: WSPartEvent) => {
            logger('WS onPart:', {
                runId: event.run_id,
                messageIndex: event.message_index,
                partIndex: event.part_index,
                partKind: event.part.part_kind,
            });
            set(activeRunAtom, (prev) => prev ? updateRunWithPart(prev, event) : prev);
        },

        onToolReturn: async (event: WSToolReturnEvent) => {
            logger('WS onToolReturn:', {
                runId: event.run_id,
                messageIndex: event.message_index,
                toolName: event.part.part_kind === "tool-return" ? event.part.tool_name : undefined,
                toolCallId: event.part.part_kind === "tool-return" ? event.part.tool_call_id : undefined,
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
            logger('WS onRunComplete:', {
                runId: event.run_id,
                usage: event.usage,
                cost: event.cost,
                citationsCount: event.citations?.length ?? 0,
                actionsCount: event.agent_actions?.length ?? 0,
            }, 1);
            set(activeRunAtom, (prev) => prev ? updateRunComplete(prev, event) : prev);
            // Clear retry state when run completes
            set(wsRetryAtom, null);

            // Process citations from run complete event
            if (event.citations && event.citations.length > 0) {
                logger(`WS onRunComplete: Processing ${event.citations.length} citations`, 1);
                set(citationMetadataAtom, (prev) => [
                    ...prev,
                    ...event.citations!.map(c => ({ ...c, run_id: event.run_id }))
                ]);
                set(updateCitationDataAtom);
            }

            // Process agent actions from run complete event
            if (event.agent_actions && event.agent_actions.length > 0) {
                logger(`WS onRunComplete: Processing ${event.agent_actions.length} agent actions`, 1);
                const actions = event.agent_actions.map(toAgentAction);
                set(addAgentActionsAtom, actions);
                // Load item data for agent actions (fire and forget)
                loadItemDataForAgentActions(actions).catch(err => 
                    logger(`WS onRunComplete: Failed to load item data for agent actions: ${err}`, 1)
                );
                // Auto-apply annotations if enabled
                autoApplyAnnotationAgentActions(event.run_id, actions);
            }
        },

        onThread: (newThreadId: string) => {
            logger('WS onThread:', { threadId: newThreadId }, 1);
            set(currentThreadIdAtom, newThreadId);
            set(activeRunAtom, (prev) => prev ? { ...prev, thread_id: newThreadId } : prev);
        },

        onDone: () => {
            logger('WS onDone: Request fully complete', 1);

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
            logger('WS onError:', event, 1);
            set(wsErrorAtom, event);
            set(activeRunAtom, (prev) => prev ? {
                ...prev,
                status: 'error',
                error: {
                    type: event.type,
                    message: event.message,
                    details: event.details,
                    is_retryable: event.is_retryable,
                    retry_after: event.retry_after,
                    is_resumable: event.is_resumable,
                }
            } : prev);
            set(isWSChatPendingAtom, false);
            // Clear retry state on error
            set(wsRetryAtom, null);
        },

        onWarning: (event: WSWarningEvent) => {
            logger('WS onWarning:', event, 1);
            set(wsWarningAtom, event);
            // Add to dismissable warnings
            set(addWarningAtom, {
                run_id: event.run_id,
                type: event.type,
                message: event.message,
                data: event.data,
            });
        },

        onRetry: (event: WSRetryEvent) => {
            logger('WS onRetry:', event, 1);
            set(wsRetryAtom, {
                runId: event.run_id,
                attempt: event.attempt,
                maxAttempts: event.max_attempts,
                reason: event.reason,
                waitSeconds: event.wait_seconds,
            });

            // If reset is true, clear any partial content that was streamed
            if (event.reset) {
                logger(`WS onRetry: resetting run messages for run ${event.run_id}`, 1);
                set(activeRunAtom, (prev) => prev ? resetRunMessages(prev) : prev);
            }
        },

        onAgentActions: (event: WSAgentActionsEvent) => {
            logger('WS onAgentActions:', {
                runId: event.run_id,
                actionsCount: event.actions.length,
            }, 1);
            const actions = event.actions.map(toAgentAction);
            set(addAgentActionsAtom, actions);
            // Load item data for agent actions (fire and forget)
            loadItemDataForAgentActions(actions).catch(err => 
                logger(`WS onAgentActions: Failed to load item data for agent actions: ${err}`, 1)
            );
            // Auto-apply annotations if enabled
            autoApplyAnnotationAgentActions(event.run_id, actions);
        },

        onMissingZoteroData: (event: WSMissingZoteroDataEvent) => {
            logger('WS onMissingZoteroData:', {
                runId: event.run_id,
                itemCount: event.items.length,
                items: event.items,
            }, 1);
            // Get userId from store for pending sync check
            const userId = store.get(userIdAtom);
            // Process asynchronously to determine reasons and add warning
            handleMissingZoteroData(
                event,
                userId,
                (params) => set(addWarningAtom, params)
            ).catch(err => 
                logger(`WS onMissingZoteroData: Failed to handle missing data: ${err}`, 1)
            );
        },

        onOpen: () => {
            logger('WS onOpen: Connection established, waiting for ready...', 1);
            set(isWSConnectedAtom, true);
        },

        onClose: (code: number, reason: string, wasClean: boolean) => {
            logger(`WS onClose: code=${code}, reason=${reason}, clean=${wasClean}`, 1);
            // set(activeRunAtom, null);
            set(isWSConnectedAtom, false);
            set(isWSReadyAtom, false);
            set(isWSChatPendingAtom, false);
        }
    };
}

/**
 * Execute a WebSocket request with the given run and request.
 * Handles connection, callbacks, and error handling.
 * Model selection options are included in the request itself.
 */
async function executeWSRequest(
    run: AgentRun,
    request: AgentRunRequest,
    set: Setter
): Promise<void> {
    const callbacks = createWSCallbacks(set);

    try {
        logger('WS Starting connection for run:', run.id);
        const frontendVersion = Zotero.Beaver.pluginVersion || '';
        await agentService.connect(request, callbacks, frontendVersion);
        logger('WS Connection established and ready');
    } catch (error) {
        logger('WS connection error:', error, 1);
        const errorMessage = error instanceof Error ? error.message : 'Connection failed';
        set(wsErrorAtom, {
            event: 'error',
            type: 'connection_error',
            message: errorMessage,
            is_retryable: true,
        });
        set(activeRunAtom, (prev) => prev ? {
            ...prev,
            status: 'error',
            error: {
                type: 'connection_error',
                message: errorMessage,
                is_retryable: true,
            }
        } : prev);
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
        const isPending = get(isWSChatPendingAtom);
        logger('sendWSMessageAtom: Called at ' + Date.now() + ' with message: ' + message.substring(0, 50) + ' (isPending: ' + isPending + ')', 1);
        
        // Guard: Don't allow concurrent requests
        if (isPending) {
            logger('sendWSMessageAtom: Blocked - already have request in progress', 1);
            return;
        }
        
        // Reset state
        set(resetWSStateAtom);
        set(isWSChatPendingAtom, true);

        try {
            // Get current model and build model selection options for the request
            const model = get(selectedModelAtom);
            const modelOptions = buildModelSelectionOptions(model);

            // Log model and model selection info
            logger('Selected model:', model ? {
                id: model.id,
                access_id: model.access_id,
                name: model.name,
                provider: model.provider,
                is_custom: model.is_custom,
                use_app_key: model.use_app_key,
            } : null);
            logger('Model selection options:', {
                access_id: modelOptions.access_id || '(not set - using custom model or plan default)',
                hasApiKey: !!modelOptions.api_key,
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

        // Add current reader attachment as source if not already present in thread
        const readerState = getReaderState(get);
        const readerAttachment = get(currentReaderAttachmentAtom);
        if (readerAttachment && readerState) {
            const allUserAttachmentKeys = get(allUserAttachmentKeysAtom);
            const existingKeys = new Set([
                ...attachments.map(att => `${att.library_id}-${att.zotero_key}`),
                ...allUserAttachmentKeys
            ]);
            logger(`sendWSMessageAtom: Handeling reader attachment - existingKeys: ${JSON.stringify(existingKeys)}`, 1);
            const readerKey = `${readerAttachment.libraryID}-${readerAttachment.key}`;
            if (!existingKeys.has(readerKey)) {
                logger(`sendWSMessageAtom: Handeling reader attachment - Adding reader attachment: ${readerKey}`, 1);
                attachments.push({
                    library_id: readerAttachment.libraryID,
                    zotero_key: readerAttachment.key,
                    type: 'source',
                    include: 'fulltext'
                } as SourceAttachment);
            } else {
                logger(`sendWSMessageAtom: Handeling reader attachment - Skipping reader attachment: ${readerKey}`, 1);
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
            ? [{ function: "search_external_references", parameters: {} } as ToolRequest]
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
            // TESTING ATTACHMENTS
            // attachments: [{library_id: 1, zotero_key: 'VV4QGPZN', type: 'source', include: 'fulltext'}], // TRASH ATTACHMENT
            // attachments: [{library_id: 1, zotero_key: 'B3ISAGTY', type: 'source', include: 'fulltext'}], // TRASH ITEM
            // attachments: [{library_id: 3, zotero_key: 'FR35E8GK', type: 'source', include: 'fulltext'}], // UNSYNCED LIBRARY ITEM
            // attachments: [{library_id: 3, zotero_key: 'V4W5CH8S', type: 'source', include: 'fulltext'}], // UNSYNCED LIBRARY ATTACHMENT
            // attachments: [{library_id: 1, zotero_key: 'SUEAB6YR', type: 'source', include: 'fulltext'}], // ZOTERO NOTE
            // attachments: [{library_id: 1, zotero_key: '85JCJJKS', type: 'source', include: 'fulltext'}], // ZOTERO SCREENSHOT
            // attachments: [{library_id: 1, zotero_key: '6U4SGES3', type: 'source', include: 'fulltext'}], // UNSYNCED ATTACHMENT
            application_state: applicationState,
            filters: filtersPayload,
            ...(toolRequests ? { tool_requests: toolRequests } : {})
        };

        // Get current thread ID (null for new thread)
        const threadId = get(currentThreadIdAtom);

            // Get user ID for the run
            const userId = get(userIdAtom);
            if (!userId) {
                logger('User ID not found', 1);
                set(isWSChatPendingAtom, false);
                return;
            }

            // Create AgentRun shell and request
            const { run, request } = createAgentRunShell(
                userPrompt,
                threadId,
                userId,
                model?.name ?? 'unknown',
                modelOptions,
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
            await executeWSRequest(run, request, set);
        } catch (error) {
            // Catch any unexpected errors during message preparation
            logger('sendWSMessageAtom: Unexpected error:', error, 1);
            set(wsErrorAtom, {
                event: 'error',
                type: 'preparation_error',
                message: error instanceof Error ? error.message : 'Failed to prepare message',
                is_retryable: true,
            });
            set(activeRunAtom, null);
            set(isWSChatPendingAtom, false);
        }
    }
);

/**
 * Regenerate a response from a specific run.
 * 
 * Flow:
 * 1. Find the run to regenerate from (in threadRuns or activeRun)
 * 2. If active run, cancel it first
 * 3. Optionally delete applied agent actions (annotations, notes) if user confirms
 * 4. Remove runs from that point forward
 * 5. Clear related agent actions and citations
 * 6. Create new run with the same user_prompt
 * 7. Execute via WebSocket
 */
export const regenerateFromRunAtom = atom(
    null,
    async (get, set, runId: string) => {
        logger(`regenerateFromRunAtom: Regenerating from run ${runId}`, 1);

        try {
            // Get current model
            const model = get(selectedModelAtom);
            if (!model) {
                logger('regenerateFromRunAtom: No model selected', 1);
                return;
            }

            // Get user ID
            const userId = get(userIdAtom);
            if (!userId) {
                logger('regenerateFromRunAtom: No user ID found', 1);
                return;
            }

            // Find the run - check both threadRuns and activeRun
            const threadRuns = get(threadRunsAtom);
            const activeRun = get(activeRunAtom);
            
            let targetRun: AgentRun | null = null;
            let runIndex = threadRuns.findIndex(r => r.id === runId);
            
            if (runIndex >= 0) {
                targetRun = threadRuns[runIndex];
            } else if (activeRun?.id === runId) {
                // The run is currently active - cancel it and resubmit
                targetRun = activeRun;
                runIndex = threadRuns.length;
                await agentService.cancel();
                set(activeRunAtom, null);
                set(isWSChatPendingAtom, false);
            }
            
            if (!targetRun) {
                logger(`regenerateFromRunAtom: Run ${runId} not found`, 1);
                return;
            }

            // Get thread ID from the target run (may not be set in currentThreadIdAtom yet)
            const threadId = get(currentThreadIdAtom) || targetRun.thread_id;

            // Collect run IDs that will be removed (target run and all subsequent)
            const runIdsToRemove = threadRuns.slice(runIndex).map(r => r.id);

            // Find applied annotation actions for runs being removed
            const allAgentActions = get(threadAgentActionsAtom);
            const actionsToDelete = allAgentActions
                .filter(a => runIdsToRemove.includes(a.run_id))
                .filter(isAnnotationAgentAction)
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

            // Build model selection options
            const modelOptions = buildModelSelectionOptions(model);
            const customInstructions = getPref('customInstructions') || undefined;

            // Create new AgentRun shell with the same user_prompt
            const { run: newRun, request } = createAgentRunShell(
                targetRun.user_prompt,
                threadId,
                userId,
                model.name,
                modelOptions,
                model.provider,
                customInstructions,
                model.is_custom ? model.custom_model : undefined,
                targetRun.id, // ask backend to rewrite thread from this run forward
            );

            // Set active run - UI now shows user message + spinner
            set(activeRunAtom, newRun);

            // Execute the WebSocket request
            await executeWSRequest(newRun, request, set);
        } catch (error) {
            // Catch any unexpected errors during regeneration
            logger('regenerateFromRunAtom: Unexpected error:', error, 1);
            set(wsErrorAtom, {
                event: 'error',
                type: 'regeneration_error',
                message: error instanceof Error ? error.message : 'Failed to regenerate response',
                is_retryable: true,
            });
            set(activeRunAtom, null);
            set(isWSChatPendingAtom, false);
        }
    }
);

/**
 * Regenerate from a run with an edited user prompt.
 * Similar to regenerateFromRunAtom but accepts a modified user prompt.
 */
export const regenerateWithEditedPromptAtom = atom(
    null,
    async (get, set, params: { runId: string; editedPrompt: BeaverAgentPrompt }) => {
        const { runId, editedPrompt } = params;
        logger(`regenerateWithEditedPromptAtom: Regenerating run ${runId} with edited prompt`, 1);

        try {
            // Get current model
            const model = get(selectedModelAtom);
            if (!model) {
                logger('regenerateWithEditedPromptAtom: No model selected', 1);
                return;
            }

            // Get user ID
            const userId = get(userIdAtom);
            if (!userId) {
                logger('regenerateWithEditedPromptAtom: No user ID found', 1);
                return;
            }

            // Find the run - check both threadRuns and activeRun
            const threadRuns = get(threadRunsAtom);
            const activeRun = get(activeRunAtom);
            
            let targetRun: AgentRun | null = null;
            let runIndex = threadRuns.findIndex(r => r.id === runId);
            
            if (runIndex >= 0) {
                targetRun = threadRuns[runIndex];
            } else if (activeRun?.id === runId) {
                // The run is currently active - cancel it and resubmit
                targetRun = activeRun;
                runIndex = threadRuns.length;
                await agentService.cancel();
                set(activeRunAtom, null);
                set(isWSChatPendingAtom, false);
            }
            
            if (!targetRun) {
                logger(`regenerateWithEditedPromptAtom: Run ${runId} not found`, 1);
                return;
            }

            // Get thread ID from the target run
            const threadId = get(currentThreadIdAtom) || targetRun.thread_id;

            // Collect run IDs that will be removed (target run and all subsequent)
            const runIdsToRemove = threadRuns.slice(runIndex).map(r => r.id);

            // Find applied annotation actions for runs being removed
            const allAgentActions = get(threadAgentActionsAtom);
            const actionsToDelete = allAgentActions
                .filter(a => runIdsToRemove.includes(a.run_id))
                .filter(isAnnotationAgentAction)
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

            // Build model selection options
            const modelOptions = buildModelSelectionOptions(model);
            const customInstructions = getPref('customInstructions') || undefined;

            // Create new AgentRun shell with the EDITED user_prompt
            const { run: newRun, request } = createAgentRunShell(
                editedPrompt,
                threadId,
                userId,
                model.name,
                modelOptions,
                model.provider,
                customInstructions,
                model.is_custom ? model.custom_model : undefined,
                targetRun.id, // ask backend to rewrite thread from this run forward
            );

            // Set active run - UI now shows user message + spinner
            set(activeRunAtom, newRun);

            // Execute the WebSocket request
            await executeWSRequest(newRun, request, set);
        } catch (error) {
            logger('regenerateWithEditedPromptAtom: Unexpected error:', error, 1);
            set(wsErrorAtom, {
                event: 'error',
                type: 'regeneration_error',
                message: error instanceof Error ? error.message : 'Failed to regenerate with edited prompt',
                is_retryable: true,
            });
            set(activeRunAtom, null);
            set(isWSChatPendingAtom, false);
        }
    }
);

/**
 * Resume a failed run from its error point.
 * 
 * Flow:
 * 1. Find the failed run
 * 2. Create a new run with is_resume=true and empty content
 * 3. Execute via WebSocket
 * 
 * The backend will continue from where it left off and the UI will hide the error run
 * when displaying the resumed run.
 */
export const resumeFromRunAtom = atom(
    null,
    async (get, set, failedRunId: string) => {
        logger(`resumeFromRunAtom: Resuming from run ${failedRunId}`, 1);

        try {
            // Get current model
            const model = get(selectedModelAtom);
            if (!model) {
                logger('resumeFromRunAtom: No model selected', 1);
                return;
            }

            // Get user ID
            const userId = get(userIdAtom);
            if (!userId) {
                logger('resumeFromRunAtom: No user ID found', 1);
                return;
            }

            // Find the failed run
            const threadRuns = get(threadRunsAtom);
            const activeRun = get(activeRunAtom);
            
            let failedRun: AgentRun | null = null;
            const failedRunIndex = threadRuns.findIndex(r => r.id === failedRunId);
            
            if (failedRunIndex >= 0) {
                failedRun = threadRuns[failedRunIndex];
            } else if (activeRun?.id === failedRunId) {
                failedRun = activeRun;
            }
            
            if (!failedRun) {
                logger(`resumeFromRunAtom: Failed run ${failedRunId} not found`, 1);
                return;
            }

            // Verify it's an error run that can be resumed
            if (failedRun.status !== 'error' || !failedRun.error?.is_resumable) {
                logger(`resumeFromRunAtom: Run ${failedRunId} is not resumable`, 1);
                return;
            }

            // Get thread ID
            const threadId = get(currentThreadIdAtom) || failedRun.thread_id;
            if (!threadId) {
                logger('resumeFromRunAtom: No thread ID found', 1);
                return;
            }

            // Reset WS state and set pending
            set(resetWSStateAtom);
            set(isWSChatPendingAtom, true);

            // Build model selection options
            const modelOptions = buildModelSelectionOptions(model);
            const customInstructions = getPref('customInstructions') || undefined;

            // Create resume prompt with empty content
            const resumePrompt: BeaverAgentPrompt = {
                content: '',
                is_resume: true,
                resumes_run_id: failedRunId,
            };

            // Create new AgentRun shell with the resume prompt
            const { run: newRun, request } = createAgentRunShell(
                resumePrompt,
                threadId,
                userId,
                model.name,
                modelOptions,
                model.provider,
                customInstructions,
                model.is_custom ? model.custom_model : undefined,
            );

            // Set active run - UI now shows spinner
            set(activeRunAtom, newRun);

            // Execute the WebSocket request
            await executeWSRequest(newRun, request, set);
        } catch (error) {
            // Catch any unexpected errors during resume
            logger('resumeFromRunAtom: Unexpected error:', error, 1);
            set(wsErrorAtom, {
                event: 'error',
                type: 'resume_error',
                message: error instanceof Error ? error.message : 'Failed to resume run',
                is_retryable: true,
            });
            set(activeRunAtom, null);
            set(isWSChatPendingAtom, false);
        }
    }
);

/**
 * Close the WebSocket connection with proper cancellation.
 * Sends a cancel message to the backend before closing to ensure proper cleanup.
 */
export const closeWSConnectionAtom = atom(null, async (get, set) => {
    // Set pending to false immediately for better UI responsiveness
    set(isWSChatPendingAtom, false);

    // Mark active run as canceled if it exists
    const activeRun = get(activeRunAtom);
    if (activeRun && activeRun.status === 'in_progress') {
        const canceledRun: AgentRun = {
            ...activeRun,
            status: 'canceled',
            completed_at: new Date().toISOString(),
        };
        // Move canceled run to completed runs
        set(threadRunsAtom, (runs) => [...runs, canceledRun]);
        set(activeRunAtom, null);
    }
    
    // Send cancel message and close connection
    await agentService.cancel();
    set(isWSConnectedAtom, false);
    set(isWSReadyAtom, false);
});

/**
 * Clear the current thread and start fresh
 */
export const clearThreadAtom = atom(null, (_get, set) => {
    set(threadRunsAtom, []);
    set(activeRunAtom, null);
    set(currentThreadIdAtom, null);
    set(resetWSStateAtom);
    // Clear agent actions, citations, and warnings for the thread
    set(clearAgentActionsAtom);
    set(citationMetadataAtom, []);
    set(resetCitationMarkersAtom);  // Reset citation markers for cleared thread
    set(clearWarningsAtom);
});
