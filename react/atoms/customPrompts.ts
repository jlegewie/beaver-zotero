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
} from '../types/settings';
import { ProcessingMode } from '../types/profile';
import { isDatabaseSyncSupportedAtom, processingModeAtom } from './profile';

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
