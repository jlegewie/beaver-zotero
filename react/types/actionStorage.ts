/**
 * Action storage — reads/writes the two-layer action model from Zotero prefs.
 *
 * Built-in actions come from code (`BUILTIN_ACTIONS`). User customizations
 * (overrides + custom actions) are stored in `beaver.actions`. Last-used
 * timestamps live in the separate `beaver.actionsLastUsed` pref.
 */

import { getPref, setPref } from '../../src/utils/prefs';
import {
    Action,
    ActionCustomizations,
    ActionLastUsedMap,
    ActionOverride,
    isAction,
    isActionCustomizations,
    generateActionId,
} from './actions';
import { BUILTIN_ACTIONS } from './builtinActions';
import { CustomPrompt, getCustomPromptsFromPreferences } from './settings';

// ---------------------------------------------------------------------------
// Read / write ActionCustomizations
// ---------------------------------------------------------------------------

const EMPTY_CUSTOMIZATIONS: ActionCustomizations = { version: 1, overrides: {}, custom: [] };

export const getActionCustomizations = (): ActionCustomizations => {
    try {
        const raw = getPref('actions');
        if (raw && typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            if (isActionCustomizations(parsed)) {
                // Validate custom actions
                parsed.custom = parsed.custom.filter(isAction);
                return parsed;
            }
        }
    } catch (e) {
        console.error('Error parsing actions pref:', e);
    }
    return { ...EMPTY_CUSTOMIZATIONS, overrides: {}, custom: [] };
};

export const saveActionCustomizations = (c: ActionCustomizations): void => {
    setPref('actions', JSON.stringify(c));
};

// ---------------------------------------------------------------------------
// Read / write last-used timestamps
// ---------------------------------------------------------------------------

export const getActionLastUsedMap = (): ActionLastUsedMap => {
    try {
        const raw = getPref('actionsLastUsed');
        if (raw && typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return parsed as ActionLastUsedMap;
            }
        }
    } catch (e) {
        console.error('Error parsing actionsLastUsed:', e);
    }
    return {};
};

export const saveActionLastUsed = (id: string, timestamp: string): void => {
    const map = getActionLastUsedMap();
    map[id] = timestamp;
    setPref('actionsLastUsed', JSON.stringify(map));
};

// ---------------------------------------------------------------------------
// Built-in helpers
// ---------------------------------------------------------------------------

const builtinIds = new Set(BUILTIN_ACTIONS.map(a => a.id));

export const isBuiltinAction = (id: string): boolean => builtinIds.has(id);

export const isBuiltinOverridden = (id: string): boolean => {
    if (!isBuiltinAction(id)) return false;
    const c = getActionCustomizations();
    const override = c.overrides[id];
    if (!override) return false;
    // Check if override has any non-hidden fields set
    return Object.keys(override).some(k => k !== 'hidden' && override[k as keyof ActionOverride] !== undefined);
};

export const getHiddenBuiltinActions = (): Action[] => {
    const c = getActionCustomizations();
    return BUILTIN_ACTIONS.filter(a => c.overrides[a.id]?.hidden === true);
};

// ---------------------------------------------------------------------------
// Two-layer merge
// ---------------------------------------------------------------------------

/**
 * Merge built-in defaults with user customizations to produce the final
 * action list. Filters hidden/deprecated, applies overrides, merges
 * lastUsed, and sorts by sortOrder.
 */
export const getMergedActions = (): Action[] => {
    const c = getActionCustomizations();
    const lastUsedMap = getActionLastUsedMap();
    const actions: Action[] = [];

    // 1. Built-in actions with overrides applied
    for (const builtin of BUILTIN_ACTIONS) {
        const override = c.overrides[builtin.id];
        if (override?.hidden) continue;
        if (builtin.deprecated && !override) continue;

        const merged: Action = { ...builtin };
        if (override) {
            if (override.title !== undefined) merged.title = override.title;

            if (override.text !== undefined) merged.text = override.text;
            if (override.id_model !== undefined) merged.id_model = override.id_model;
            if (override.targetType !== undefined) merged.targetType = override.targetType;
            if (override.sortOrder !== undefined) merged.sortOrder = override.sortOrder;
            if (override.minItems !== undefined) merged.minItems = override.minItems;
        }
        if (lastUsedMap[merged.id]) {
            merged.lastUsed = lastUsedMap[merged.id];
        }
        actions.push(merged);
    }

    // 2. Custom (user-created) actions
    for (const custom of c.custom) {
        const action: Action = { ...custom };
        if (lastUsedMap[action.id]) {
            action.lastUsed = lastUsedMap[action.id];
        }
        actions.push(action);
    }

    // 3. Sort by sortOrder (lower first), then by title as tiebreaker
    actions.sort((a, b) => {
        const orderDiff = (a.sortOrder ?? 999) - (b.sortOrder ?? 999);
        if (orderDiff !== 0) return orderDiff;
        return a.title.localeCompare(b.title);
    });

    return actions;
};

// ---------------------------------------------------------------------------
// Import from old customPrompts
// ---------------------------------------------------------------------------

/**
 * Import user-created prompts from the old `beaver.customPrompts` pref.
 * Excludes old default prompts (`default-*` IDs). Maps `requiresAttachment`
 * to `targetType: "attachment"`, everything else to `"global"`.
 */
export const importFromOldCustomPrompts = (): Action[] => {
    const oldPrompts = getCustomPromptsFromPreferences();
    return oldPrompts
        .filter(p => !p.id?.startsWith('default-'))
        .map((p: CustomPrompt): Action => ({
            id: generateActionId(),
            title: p.title,
            text: p.text,
            targetType: p.requiresAttachment ? 'attachment' : 'global',
            id_model: p.id_model,
            sortOrder: 999,
        }));
};

/**
 * Check if the old customPrompts pref has any user-created content worth importing.
 */
export const hasOldCustomPrompts = (): boolean => {
    const oldPrompts = getCustomPromptsFromPreferences();
    return oldPrompts.some(p => !p.id?.startsWith('default-'));
};
