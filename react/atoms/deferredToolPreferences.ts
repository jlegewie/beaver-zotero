/**
 * Deferred Tool Preferences
 * 
 * Manages user preferences for how deferred tools (like edit_metadata) should behave.
 * 
 * Structure:
 * - toolToGroup: Maps tool names to group names (allows renaming tools while preserving preference)
 * - groupPreferences: Maps group names to the preference value
 * 
 * This two-level structure allows:
 * 1. Multiple tools to share the same preference (grouping)
 * 2. Renaming tools without losing preferences (just update toolToGroup)
 */

import { atom } from 'jotai';
import { getPref, setPref } from '../../src/utils/prefs';
import { logger } from '../../src/utils/logger';

// =============================================================================
// Types
// =============================================================================

export type DeferredToolPreference = 'always_ask' | 'always_apply' | 'continue_without_applying';

export interface DeferredToolPreferencesData {
    /** Maps tool names to group names */
    toolToGroup: Record<string, string>;
    /** Maps group names to preference values */
    groupPreferences: Record<string, DeferredToolPreference>;
}

// Default group mappings for known tools
const DEFAULT_TOOL_GROUPS: Record<string, string> = {
    'edit_metadata': 'metadata_edits',
    'create_collection': 'library_modifications',
};

// Default preferences for groups
const DEFAULT_GROUP_PREFERENCES: Record<string, DeferredToolPreference> = {
    'metadata_edits': 'always_ask',
    'library_modifications': 'always_ask',
};

// =============================================================================
// Preference Labels
// =============================================================================

export const DEFERRED_TOOL_PREFERENCE_LABELS: Record<DeferredToolPreference, string> = {
    'always_ask': 'Always ask',
    'always_apply': 'Always apply',
    'continue_without_applying': 'Always review later',
};

export const DEFERRED_TOOL_PREFERENCE_DESCRIPTIONS: Record<DeferredToolPreference, string> = {
    'always_ask': 'Prompt for approval before making changes',
    'always_apply': 'Apply changes immediately without prompting',
    'continue_without_applying': 'Queue changes for manual review later',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Load preferences from Zotero prefs
 */
function loadPreferences(): DeferredToolPreferencesData {
    try {
        const prefString = getPref('deferredToolPreferences');
        if (prefString && typeof prefString === 'string') {
            const parsed = JSON.parse(prefString);
            return {
                toolToGroup: { ...DEFAULT_TOOL_GROUPS, ...parsed.toolToGroup },
                groupPreferences: { ...DEFAULT_GROUP_PREFERENCES, ...parsed.groupPreferences },
            };
        }
    } catch (error) {
        logger(`deferredToolPreferences: Failed to load preferences: ${error}`, 1);
    }
    return {
        toolToGroup: { ...DEFAULT_TOOL_GROUPS },
        groupPreferences: { ...DEFAULT_GROUP_PREFERENCES },
    };
}

/**
 * Save preferences to Zotero prefs
 */
function savePreferences(data: DeferredToolPreferencesData): void {
    try {
        const prefString = JSON.stringify(data);
        setPref('deferredToolPreferences', prefString);
    } catch (error) {
        logger(`deferredToolPreferences: Failed to save preferences: ${error}`, 1);
    }
}

/**
 * Get the group name for a tool
 */
function getGroupForTool(data: DeferredToolPreferencesData, toolName: string): string {
    // Return existing group mapping, or use tool name as its own group
    return data.toolToGroup[toolName] ?? toolName;
}

/**
 * Get the preference for a tool
 */
function getPreferenceForTool(data: DeferredToolPreferencesData, toolName: string): DeferredToolPreference {
    const group = getGroupForTool(data, toolName);
    return data.groupPreferences[group] ?? 'always_ask';
}

// =============================================================================
// State Atoms
// =============================================================================

/**
 * Main atom for deferred tool preferences.
 * Initialized from Zotero prefs on first read.
 */
export const deferredToolPreferencesAtom = atom<DeferredToolPreferencesData>(loadPreferences());

// =============================================================================
// Derived Atoms
// =============================================================================

/**
 * Get the preference for a specific tool name.
 * Usage: const pref = useAtomValue(getPreferenceForToolAtom)('edit_metadata');
 */
export const getPreferenceForToolAtom = atom(
    (get) => (toolName: string): DeferredToolPreference => {
        const data = get(deferredToolPreferencesAtom);
        return getPreferenceForTool(data, toolName);
    }
);

/**
 * Get the group name for a specific tool.
 * Useful for displaying which group a tool belongs to.
 */
export const getGroupForToolAtom = atom(
    (get) => (toolName: string): string => {
        const data = get(deferredToolPreferencesAtom);
        return getGroupForTool(data, toolName);
    }
);

// =============================================================================
// Mutation Atoms
// =============================================================================

/**
 * Update the preference for a tool.
 * This updates the group preference, affecting all tools in the same group.
 */
export const updateToolPreferenceAtom = atom(
    null,
    (get, set, { toolName, preference }: { toolName: string; preference: DeferredToolPreference }) => {
        const currentData = get(deferredToolPreferencesAtom);
        
        // Ensure tool has a group mapping
        const group = getGroupForTool(currentData, toolName);
        
        const newData: DeferredToolPreferencesData = {
            toolToGroup: {
                ...currentData.toolToGroup,
                [toolName]: group,
            },
            groupPreferences: {
                ...currentData.groupPreferences,
                [group]: preference,
            },
        };
        
        set(deferredToolPreferencesAtom, newData);
        savePreferences(newData);
        
        logger(`deferredToolPreferences: Updated ${toolName} (group: ${group}) to ${preference}`, 1);
    }
);

/**
 * Add a tool to a specific group.
 * Useful for grouping multiple tools to share the same preference.
 */
export const addToolToGroupAtom = atom(
    null,
    (get, set, { toolName, groupName }: { toolName: string; groupName: string }) => {
        const currentData = get(deferredToolPreferencesAtom);
        
        const newData: DeferredToolPreferencesData = {
            toolToGroup: {
                ...currentData.toolToGroup,
                [toolName]: groupName,
            },
            groupPreferences: {
                ...currentData.groupPreferences,
                // Ensure group has a default preference if new
                [groupName]: currentData.groupPreferences[groupName] ?? 'always_ask',
            },
        };
        
        set(deferredToolPreferencesAtom, newData);
        savePreferences(newData);
        
        logger(`deferredToolPreferences: Added tool ${toolName} to group ${groupName}`, 1);
    }
);

/**
 * Reload preferences from Zotero prefs.
 * Useful if preferences were changed externally.
 */
export const reloadPreferencesAtom = atom(
    null,
    (_get, set) => {
        const data = loadPreferences();
        set(deferredToolPreferencesAtom, data);
    }
);
