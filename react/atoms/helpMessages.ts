/**
 * Help message atoms for managing onboarding/guidance messages.
 * 
 * These atoms manage:
 * - Which messages have been dismissed
 * - Rate limiting (lastShown timestamp)
 * - Currently active help message target
 */

import { atom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';

// =============================================================================
// Types
// =============================================================================

/** State for a single dismissed message */
export interface DismissedMessage {
    at: string;  // ISO timestamp when dismissed
}

/** Persisted help message state */
export interface HelpMessageState {
    dismissed: Record<string, DismissedMessage>;  // messageId -> dismissal info
    lastShown: string | null;                      // ISO timestamp of last shown message
}

/** A registered help target from a component */
export interface HelpTarget {
    id: string;                    // Message ID from registry
    element: HTMLElement;          // Target DOM element
    isVisible: boolean;            // Whether element is in viewport
    enabled: boolean;              // Whether component conditions are met
}

// =============================================================================
// Constants
// =============================================================================

/** Minimum time between showing help messages (in milliseconds) */
export const HELP_MESSAGE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// =============================================================================
// Helper Functions
// =============================================================================

/** Load help message state from Zotero preferences */
function loadHelpMessageState(): HelpMessageState {
    const defaultState: HelpMessageState = { dismissed: {}, lastShown: null };
    try {
        const stored = getPref('helpMessageState');
        if (stored) {
            const parsed = JSON.parse(stored);
            // Ensure the parsed object has proper structure with defaults
            return {
                dismissed: parsed.dismissed ?? {},
                lastShown: parsed.lastShown ?? null,
            };
        }
    } catch (e) {
        console.error('Failed to parse helpMessageState:', e);
    }
    return defaultState;
}

/** Save help message state to Zotero preferences */
function saveHelpMessageState(state: HelpMessageState): void {
    try {
        setPref('helpMessageState', JSON.stringify(state));
    } catch (e) {
        console.error('Failed to save helpMessageState:', e);
    }
}

// =============================================================================
// Atoms
// =============================================================================

/** Persisted help message state (dismissed messages, last shown) */
export const helpMessageStateAtom = atom<HelpMessageState>(loadHelpMessageState());

/** Registry of currently mounted help targets */
export const helpTargetsAtom = atom<Map<string, HelpTarget>>(new Map());

/** Currently displayed help message ID (null if none) */
export const activeHelpMessageIdAtom = atom<string | null>(null);

/** Whether a help message is currently fading out */
export const helpMessageFadingOutAtom = atom<boolean>(false);

// =============================================================================
// Derived Atoms
// =============================================================================

/** Check if a specific message has been dismissed */
export const isMessageDismissedAtom = atom((get) => {
    const state = get(helpMessageStateAtom);
    return (messageId: string) => state?.dismissed ? messageId in state.dismissed : false;
});

/** Check if we're within the cooldown period */
export const isInCooldownAtom = atom((get) => {
    const state = get(helpMessageStateAtom);
    if (!state.lastShown) return false;
    
    const lastShownTime = new Date(state.lastShown).getTime();
    const now = Date.now();
    return (now - lastShownTime) < HELP_MESSAGE_COOLDOWN_MS;
});

// =============================================================================
// Action Atoms
// =============================================================================

/** Register a help target element */
export const registerHelpTargetAtom = atom(
    null,
    (get, set, target: HelpTarget) => {
        const targets = new Map(get(helpTargetsAtom));
        targets.set(target.id, target);
        set(helpTargetsAtom, targets);
    }
);

/** Unregister a help target element */
export const unregisterHelpTargetAtom = atom(
    null,
    (get, set, messageId: string) => {
        const targets = new Map(get(helpTargetsAtom));
        targets.delete(messageId);
        set(helpTargetsAtom, targets);
        
        // If this was the active message, clear it
        if (get(activeHelpMessageIdAtom) === messageId) {
            set(activeHelpMessageIdAtom, null);
        }
    }
);

/** Update a help target's visibility/enabled state */
export const updateHelpTargetAtom = atom(
    null,
    (get, set, update: { id: string; isVisible?: boolean; enabled?: boolean; element?: HTMLElement }) => {
        const targets = new Map(get(helpTargetsAtom));
        const existing = targets.get(update.id);
        if (existing) {
            targets.set(update.id, {
                ...existing,
                ...(update.isVisible !== undefined && { isVisible: update.isVisible }),
                ...(update.enabled !== undefined && { enabled: update.enabled }),
                ...(update.element !== undefined && { element: update.element }),
            });
            set(helpTargetsAtom, targets);
        }
    }
);

/** Show a help message (set as active) */
export const showHelpMessageAtom = atom(
    null,
    (get, set, messageId: string) => {
        set(activeHelpMessageIdAtom, messageId);
        
        // Update lastShown timestamp
        const state = get(helpMessageStateAtom);
        const newState: HelpMessageState = {
            ...state,
            lastShown: new Date().toISOString(),
        };
        set(helpMessageStateAtom, newState);
        saveHelpMessageState(newState);
    }
);

/** Dismiss a help message */
export const dismissHelpMessageAtom = atom(
    null,
    (get, set, messageId: string) => {
        // Start fade out
        set(helpMessageFadingOutAtom, true);
        
        // After fade animation, clear the active message and persist dismissal
        setTimeout(() => {
            set(activeHelpMessageIdAtom, null);
            set(helpMessageFadingOutAtom, false);
            
            // Persist dismissal
            const state = get(helpMessageStateAtom);
            const newState: HelpMessageState = {
                ...state,
                dismissed: {
                    ...state.dismissed,
                    [messageId]: { at: new Date().toISOString() },
                },
            };
            set(helpMessageStateAtom, newState);
            saveHelpMessageState(newState);
        }, 150); // Match fade-out animation duration
    }
);

/** Reset all help messages (for testing/debugging) */
export const resetHelpMessagesAtom = atom(
    null,
    (_get, set) => {
        const newState: HelpMessageState = { dismissed: {}, lastShown: null };
        set(helpMessageStateAtom, newState);
        set(activeHelpMessageIdAtom, null);
        set(helpTargetsAtom, new Map());
        saveHelpMessageState(newState);
    }
);

