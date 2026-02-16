/**
 * Custom Prompts Atoms
 *
 * Reactive Jotai atoms for custom prompts (actions), replacing imperative reads from
 * Zotero preferences. Follows the same pattern as deferredToolPreferences.ts:
 * a base atom initialised from prefs, a write atom that updates both atom and
 * prefs, and derived atoms for filtered / projected views.
 */

import { atom } from 'jotai';
import {
    CustomPrompt,
    getCustomPromptsFromPreferences,
    saveCustomPromptsToPreferences,
    savePromptLastUsed,
} from '../types/settings';
import { ProcessingMode } from '../types/profile';
import { isDatabaseSyncSupportedAtom, processingModeAtom } from './profile';
import { resolvePromptVariables } from '../utils/promptVariables';
import { sendWSMessageAtom } from './agentRunAtoms';
import { currentMessageItemsAtom } from './messageComposition';

// =============================================================================
// Base atom – initialised once from Zotero prefs
// =============================================================================

export const customPromptsAtom = atom<CustomPrompt[]>(getCustomPromptsFromPreferences());

// =============================================================================
// Write atom – updates the atom AND persists to prefs in one step
// =============================================================================

export const saveCustomPromptsAtom = atom(
    null,
    (_get, set, prompts: CustomPrompt[]) => {
        set(customPromptsAtom, prompts);
        saveCustomPromptsToPreferences(prompts);
    },
);

// =============================================================================
// Write atom – marks a prompt as recently used (updates lastUsed timestamp)
// =============================================================================

export const markPromptUsedAtom = atom(
    null,
    (get, set, id: string) => {
        const timestamp = new Date().toISOString();
        const prompts = get(customPromptsAtom);
        const updated = prompts.map((p) =>
            p.id === id ? { ...p, lastUsed: timestamp } : p,
        );
        set(customPromptsAtom, updated);
        // Persist to separate preference so the main customPrompts pref stays clean
        savePromptLastUsed(id, timestamp);
    },
);

// =============================================================================
// Derived: context-filtered prompts (replaces getCustomPromptsForContext)
// =============================================================================

export const customPromptsForContextAtom = atom<CustomPrompt[]>((get) => {
    const prompts = get(customPromptsAtom);
    const isDatabaseSyncSupported = get(isDatabaseSyncSupportedAtom);
    const processingMode = get(processingModeAtom);

    return prompts
        .filter((prompt) => {
            if (
                prompt.requiresDatabaseSync &&
                (!isDatabaseSyncSupported || processingMode === ProcessingMode.FRONTEND)
            ) {
                return false;
            }
            return true;
        })
        .map((prompt, index) => ({
            ...prompt,
            index: index + 1,
        }));
});

// =============================================================================
// Derived: shortcut numbers currently in use (for PreferencePage)
// =============================================================================

export const usedShortcutsAtom = atom<number[]>((get) => {
    const prompts = get(customPromptsAtom);
    return prompts.filter((p) => p.shortcut != null).map((p) => p.shortcut!);
});

// =============================================================================
// Atomic prompt execution – resolves variables, adds items, sends message
// =============================================================================

/**
 * Resolve {{variables}} in prompt text and send the message atomically.
 * Ensures resolved items are in currentMessageItemsAtom before sendWSMessageAtom reads them.
 */
export const sendResolvedPromptAtom = atom(
    null,
    async (get, set, promptText: string) => {
        const { text, items } = await resolvePromptVariables(promptText);

        if (items.length > 0) {
            const currentItems = get(currentMessageItemsAtom);
            const existingKeys = new Set(currentItems.map(i => `${i.libraryID}-${i.key}`));
            const newItems = items.filter(i => !existingKeys.has(`${i.libraryID}-${i.key}`));
            if (newItems.length > 0) {
                set(currentMessageItemsAtom, [...currentItems, ...newItems]);
            }
        }

        return set(sendWSMessageAtom, text);
    },
);
