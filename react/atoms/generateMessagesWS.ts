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
import { chatServiceWS, WSCallbacks, WSChatRequest, DeltaType } from '../../src/services/chatServiceWS';
import { logger } from '../../src/utils/logger';

// =============================================================================
// State Atoms
// =============================================================================

/** Whether a WebSocket chat request is currently in progress */
export const isWSChatPendingAtom = atom(false);

/** Whether the WebSocket is currently connected */
export const isWSConnectedAtom = atom(false);

/** Current message ID being streamed */
export const currentWSMessageIdAtom = atom<string | null>(null);

/** Accumulated content from delta events */
export const wsStreamedContentAtom = atom('');

/** Accumulated reasoning from delta events */
export const wsStreamedReasoningAtom = atom('');

/** Last error from WebSocket */
export const wsErrorAtom = atom<{ type: string; message: string } | null>(null);

/** Last warning from WebSocket */
export const wsWarningAtom = atom<{ type: string; message: string } | null>(null);

// =============================================================================
// Action Atoms
// =============================================================================

/**
 * Reset all WebSocket state atoms
 */
export const resetWSStateAtom = atom(null, (_get, set) => {
    set(isWSChatPendingAtom, false);
    set(isWSConnectedAtom, false);
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
 */
export const sendWSMessageAtom = atom(
    null,
    async (get, set, message: string) => {
        // Reset state
        set(resetWSStateAtom);
        set(isWSChatPendingAtom, true);

        // Generate a message ID for tracking
        const messageId = uuidv4();
        set(currentWSMessageIdAtom, messageId);

        // Create the request
        const request: WSChatRequest = {
            message
        };

        // Define callbacks
        const callbacks: WSCallbacks = {
            onDelta: (msgId: string, delta: string, type: DeltaType) => {
                logger(`WS onDelta: ${type} - ${delta.substring(0, 50)}...`, 1);
                
                if (type === 'content') {
                    set(wsStreamedContentAtom, (prev) => prev + delta);
                } else if (type === 'reasoning') {
                    set(wsStreamedReasoningAtom, (prev) => prev + delta);
                }
            },

            onComplete: (msgId: string) => {
                logger(`WS onComplete: ${msgId}`, 1);
                set(isWSChatPendingAtom, false);
            },

            onError: (type: string, message: string, msgId?: string, details?: string) => {
                logger(`WS onError: ${type} - ${message}`, 1);
                set(wsErrorAtom, { type, message });
                set(isWSChatPendingAtom, false);
            },

            onWarning: (msgId: string, type: string, message: string, data?: Record<string, any>) => {
                logger(`WS onWarning: ${type} - ${message}`, 1);
                set(wsWarningAtom, { type, message });
            },

            onOpen: () => {
                logger('WS onOpen', 1);
                set(isWSConnectedAtom, true);
            },

            onClose: (code: number, reason: string, wasClean: boolean) => {
                logger(`WS onClose: code=${code}, reason=${reason}, clean=${wasClean}`, 1);
                set(isWSConnectedAtom, false);
                set(isWSChatPendingAtom, false);
            }
        };

        try {
            await chatServiceWS.connect(request, callbacks);
        } catch (error) {
            logger(`WS connection error: ${error}`, 1);
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
    set(isWSChatPendingAtom, false);
});

