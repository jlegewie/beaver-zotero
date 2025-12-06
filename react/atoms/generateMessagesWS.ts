/**
 * WebSocket-based message generation atoms
 * 
 * This module provides Jotai atoms for WebSocket-based chat completion,
 * as an alternative to the SSE-based generateMessages.ts.
 * 
 * It will eventually replace the SSE implementation as more features are added.
 */

import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { chatServiceWS, WSCallbacks, WSChatRequest, WSReadyData, WSConnectOptions, DeltaType } from '../../src/services/chatServiceWS';
import { logger } from '../../src/utils/logger';
import { selectedModelAtom, FullModelConfig } from './models';
import { getPref } from '../../src/utils/prefs';

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
 * - access_id: Included for non-custom models (from PlanModelAccess)
 * - api_key: Included for user-key models (not app-key, not custom)
 */
function buildConnectOptions(model: FullModelConfig | null): WSConnectOptions {
    if (!model) return {};

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

/** Current message ID being streamed */
export const currentWSMessageIdAtom = atom<string | null>(null);

/** Accumulated content from delta events */
export const wsStreamedContentAtom = atom('');

/** Accumulated reasoning from delta events */
export const wsStreamedReasoningAtom = atom('');

/** Last error from WebSocket */
export const wsErrorAtom = atom<{ type: string; message: string; details?: string } | null>(null);

/** Last warning from WebSocket */
export const wsWarningAtom = atom<{ type: string; message: string; data?: Record<string, any> } | null>(null);

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
    set(currentWSMessageIdAtom, null);
    set(wsStreamedContentAtom, '');
    set(wsStreamedReasoningAtom, '');
    set(wsErrorAtom, null);
    set(wsWarningAtom, null);
});

/**
 * Send a chat message via WebSocket
 * 
 * This is a simple implementation for testing. It will be expanded
 * to match the full functionality of generateResponseAtom.
 * 
 * Event flow:
 * 1. onOpen - WebSocket connection established
 * 2. onReady - Server validation complete (auth, profile, model)
 * 3. onDelta - Streaming content chunks
 * 4. onComplete - Response finished
 * 5. onClose - Connection closed
 * 
 * Errors can occur at any stage, warnings are non-fatal.
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

        // Generate message IDs for tracking
        const userMessageId = uuidv4();
        const assistantMessageId = uuidv4();
        set(currentWSMessageIdAtom, assistantMessageId);

        // Create the request
        const request: WSChatRequest = {
            type: 'chat',
            // thread_id: undefined, // Omit for new thread
            message: {
                id: userMessageId,
                content: message,
                // attachments, application_state, filters, tool_requests can be added later
            },
            assistant_message_id: assistantMessageId,
            // custom_instructions: undefined,
        };

        // Define callbacks with detailed logging
        const callbacks: WSCallbacks = {
            onReady: (data: WSReadyData) => {
                logger(`WS onReady: model=${data.modelName}, charge=${data.chargeType}, ` +
                       `mode=${data.processingMode}, indexing=${data.indexingComplete}`, 1);
                console.log('[WS] Ready event received:', {
                    modelId: data.modelId,
                    modelName: data.modelName,
                    subscriptionStatus: data.subscriptionStatus,
                    chargeType: data.chargeType,
                    processingMode: data.processingMode,
                    indexingComplete: data.indexingComplete,
                });
                set(isWSReadyAtom, true);
                set(wsReadyDataAtom, data);
            },

            onDelta: (msgId: string, delta: string, type: DeltaType) => {
                const preview = delta.length > 50 ? delta.substring(0, 50) + '...' : delta;
                logger(`WS onDelta: ${type} - "${preview}"`, 1);
                console.log('[WS] Delta event:', { messageId: msgId, type, deltaLength: delta.length });
                
                if (type === 'content') {
                    set(wsStreamedContentAtom, (prev) => prev + delta);
                } else if (type === 'reasoning') {
                    set(wsStreamedReasoningAtom, (prev) => prev + delta);
                }
            },

            onComplete: (msgId: string) => {
                logger(`WS onComplete: ${msgId}`, 1);
                console.log('[WS] Complete event:', { messageId: msgId });
                // Note: Message content is done, but don't set pending=false until onDone
            },

            onDone: () => {
                logger('WS onDone: Request fully complete', 1);
                console.log('[WS] Done event: Full request finished (safe to close or send another)');
                // Connection-per-request policy: close after each completed request
                chatServiceWS.close();
                set(isWSChatPendingAtom, false);
            },

            onError: (type: string, errorMessage: string, msgId?: string, details?: string) => {
                logger(`WS onError: ${type} - ${errorMessage}`, 1);
                console.error('[WS] Error event:', {
                    type,
                    message: errorMessage,
                    messageId: msgId,
                    details,
                });
                set(wsErrorAtom, { type, message: errorMessage, details });
                set(isWSChatPendingAtom, false);
            },

            onWarning: (msgId: string, type: string, warningMessage: string, data?: Record<string, any>) => {
                logger(`WS onWarning: ${type} - ${warningMessage}`, 1);
                console.warn('[WS] Warning event:', {
                    messageId: msgId,
                    type,
                    message: warningMessage,
                    data,
                });
                set(wsWarningAtom, { type, message: warningMessage, data });
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
                type: 'connection_error', 
                message: error instanceof Error ? error.message : 'Connection failed' 
            });
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

