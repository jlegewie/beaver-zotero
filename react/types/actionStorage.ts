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
    isStoredAction,
    isActionCustomizations,
    normalizeStoredAction,
    normalizeStoredOverride,
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
                // Validate custom actions and normalize legacy shapes
                // (single `targetType` → `targets` array)
                parsed.custom = parsed.custom.filter(isStoredAction).map(a => normalizeStoredAction(a as unknown as Record<string, unknown>));
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
            const o = normalizeStoredOverride(override);
            if (o.title !== undefined) merged.title = o.title;
            if (o.text !== undefined) merged.text = o.text;
            if (o.name !== undefined) merged.name = o.name;
            if (o.id_model !== undefined) merged.id_model = o.id_model;
            if (o.targets !== undefined) merged.targets = o.targets;
            if (o.category !== undefined) merged.category = o.category;
            if (o.argumentHint !== undefined) merged.argumentHint = o.argumentHint;
            if (o.sortOrder !== undefined) merged.sortOrder = o.sortOrder;
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
 * Check if the old customPrompts pref has any user-created content worth importing.
 * Returns false if legacy prompts have already been imported.
 */
export const hasOldCustomPrompts = (): boolean => {
    if (getPref('legacyPromptsImported')) return false;
    const oldPrompts = getCustomPromptsFromPreferences();
    return oldPrompts.some(p => !p.id?.startsWith('default-'));
};
