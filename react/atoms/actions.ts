/**
 * Actions V2.0 — Jotai atoms
 *
 * Replaces customPrompts.ts atoms with a two-layer architecture.
 */

import { atom } from 'jotai';
import { Action, ActionOverride, ActionTargetType } from '../types/actions';
import { BUILTIN_ACTIONS } from '../types/builtinActions';
import {
    getMergedActions,
    getActionCustomizations,
    saveActionCustomizations,
    saveActionLastUsed,
    isBuiltinAction,
} from '../types/actionStorage';
import { zoteroContextAtom } from './zoteroContext';
import { isActionVisible, ActionContext } from '../utils/actionVisibility';
import { resolvePromptVariables, EMPTY_VARIABLE_HINTS } from '../utils/promptVariables';
import { sendWSMessageAtom } from './agentRunAtoms';
import { currentMessageItemsAtom, currentMessageCollectionsAtom, pendingPillInsertAtom } from './messageComposition';
import { CollectionReference } from '../types/zotero';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { isRejectedItemValidation, itemValidationResultsAtom } from './itemValidation';
import { toSlashToken, type SlashCommandDescriptor } from '../utils/slashCommands';
import type { PromptAction } from '../agents/types';

// ---------------------------------------------------------------------------
// Base atom — initialised once from prefs + built-ins
// ---------------------------------------------------------------------------

export const actionsAtom = atom<Action[]>(getMergedActions());

// ---------------------------------------------------------------------------
// Write atom — saves actions back to prefs
//
// Key complexity: for built-in actions, we compute a surgical override by
// diffing each field against the built-in default. Custom actions are stored
// directly. `lastUsed` is always stripped (stored separately).
// ---------------------------------------------------------------------------

export const saveActionsAtom = atom(
    null,
    (_get, set, actions: Action[]) => {
        const c = getActionCustomizations();

        // Rebuild overrides from the actions list
        const builtinMap = new Map(BUILTIN_ACTIONS.map(a => [a.id, a]));
        const newOverrides: Record<string, ActionOverride> = {};
        const newCustom: Action[] = [];

        for (const action of actions) {
            if (isBuiltinAction(action.id)) {
                const base = builtinMap.get(action.id)!;
                const override: ActionOverride = {};
                let hasChange = false;

                // Compare each overridable field
                if (action.title !== base.title) { override.title = action.title; hasChange = true; }
                if (action.text !== base.text) { override.text = action.text; hasChange = true; }
                if ((action.id_model ?? undefined) !== (base.id_model ?? undefined)) { override.id_model = action.id_model; hasChange = true; }
                if (action.targetType !== base.targetType) { override.targetType = action.targetType; hasChange = true; }
                if ((action.category ?? undefined) !== (base.category ?? undefined)) { override.category = action.category; hasChange = true; }
                if ((action.placeholder ?? undefined) !== (base.placeholder ?? undefined)) { override.placeholder = action.placeholder; hasChange = true; }
                if ((action.sortOrder ?? undefined) !== (base.sortOrder ?? undefined)) { override.sortOrder = action.sortOrder; hasChange = true; }
                if ((action.minItems ?? undefined) !== (base.minItems ?? undefined)) { override.minItems = action.minItems; hasChange = true; }

                // Preserve hidden flag from existing override
                if (c.overrides[action.id]?.hidden) {
                    override.hidden = true;
                    hasChange = true;
                }

                if (hasChange) {
                    newOverrides[action.id] = override;
                }
            } else {
                // Custom action — strip lastUsed before persisting
                const { lastUsed, ...rest } = action;
                newCustom.push(rest);
            }
        }

        // Preserve overrides for hidden built-ins that aren't in the actions list
        for (const [id, override] of Object.entries(c.overrides)) {
            if (override.hidden && !newOverrides[id]) {
                newOverrides[id] = override;
            }
        }

        const newCustomizations = { version: 1 as const, overrides: newOverrides, custom: newCustom };
        saveActionCustomizations(newCustomizations);
        set(actionsAtom, getMergedActions());
    },
);

// ---------------------------------------------------------------------------
// Write atom — hide a built-in action
// ---------------------------------------------------------------------------

export const hideActionAtom = atom(
    null,
    (_get, set, id: string) => {
        const c = getActionCustomizations();
        c.overrides[id] = { ...c.overrides[id], hidden: true };
        saveActionCustomizations(c);
        set(actionsAtom, getMergedActions());
    },
);

// ---------------------------------------------------------------------------
// Write atom — restore a hidden built-in action
// ---------------------------------------------------------------------------

export const restoreActionAtom = atom(
    null,
    (_get, set, id: string) => {
        const c = getActionCustomizations();
        if (c.overrides[id]) {
            delete c.overrides[id].hidden;
            // If override is now empty, remove it entirely
            if (Object.keys(c.overrides[id]).length === 0) {
                delete c.overrides[id];
            }
        }
        saveActionCustomizations(c);
        set(actionsAtom, getMergedActions());
    },
);

// ---------------------------------------------------------------------------
// Write atom — reset a built-in to its default (delete entire override)
// ---------------------------------------------------------------------------

export const resetActionToDefaultAtom = atom(
    null,
    (_get, set, id: string) => {
        const c = getActionCustomizations();
        delete c.overrides[id];
        saveActionCustomizations(c);
        set(actionsAtom, getMergedActions());
    },
);

// ---------------------------------------------------------------------------
// Write atom — mark an action as recently used
// ---------------------------------------------------------------------------

export const markActionUsedAtom = atom(
    null,
    (get, set, id: string) => {
        const timestamp = new Date().toISOString();
        const actions = get(actionsAtom);
        set(actionsAtom, actions.map(a => a.id === id ? { ...a, lastUsed: timestamp } : a));
        saveActionLastUsed(id, timestamp);
    },
);

// ---------------------------------------------------------------------------
// Derived: action context (Zotero state + manually attached items)
// ---------------------------------------------------------------------------

export const actionContextAtom = atom<ActionContext>((get) => ({
    zotero: get(zoteroContextAtom),
    manualItems: get(currentMessageItemsAtom),
}));

// ---------------------------------------------------------------------------
// Derived: context-filtered actions
// ---------------------------------------------------------------------------

export const actionsForContextAtom = atom<Action[]>((get) => {
    const actions = get(actionsAtom);
    const ctx = get(actionContextAtom);
    return actions.filter(a => isActionVisible(a, ctx));
});

// ---------------------------------------------------------------------------
// Stage an action as a /command pill in the chat input.
//
// Single entry point used by the home launcher, action suggestions, the
// library context menu, and the reader toolbar. The pill is inserted into the
// input (via `pendingPillInsertAtom`, consumed by InputArea) and the user
// submits the message themselves; the action's prompt is resolved at send
// time in `sendComposedMessageAtom`, exactly like a slash-menu pill.
// ---------------------------------------------------------------------------

export const stageActionPillAtom = atom(
    null,
    (get, set, payload: {
        actionId: string;
        targetType?: ActionTargetType;
        fallbackTitle?: string;
        /** Window whose editor should receive the pill (where the user acted). */
        targetWindow?: Window;
    }) => {
        const action = get(actionsAtom).find(a => a.id === payload.actionId);
        const title = action?.title ?? payload.fallbackTitle ?? 'action';
        const descriptor: SlashCommandDescriptor = {
            commandName: toSlashToken(title),
            actionId: payload.actionId,
            targetType: payload.targetType,
            title,
        };
        set(pendingPillInsertAtom, { descriptor, targetWindow: payload.targetWindow, nonce: Date.now() });
        set(markActionUsedAtom, payload.actionId);
    },
);

// ---------------------------------------------------------------------------
// Send a composed message that contains one or more /command pills.
//
// The pill tokens stay verbatim in the message content; each pill's action
// prompt is resolved here ({{ }} variables + item/collection attachment) and
// sent as a structured `actions` entry on the prompt. The backend appends a
// definition block telling the model what each /command means.
// ---------------------------------------------------------------------------

export const sendComposedMessageAtom = atom(
    null,
    async (
        get,
        set,
        payload: {
            baseText: string;
            pills: SlashCommandDescriptor[];
        },
    ): Promise<boolean> => {
        const { baseText, pills } = payload;
        const actions = get(actionsAtom);
        const validationResults = get(itemValidationResultsAtom);

        const accumulatedItems: Zotero.Item[] = [];
        let accumulatedCollection: CollectionReference | null = null;
        // One entry per distinct command. Insertion-time collision handling
        // keeps tokens unique per distinct action, so first-wins dedup here
        // only collapses repeated pills of the same action.
        const promptActions: PromptAction[] = [];
        const seenCommands = new Set<string>();

        for (const pill of pills) {
            if (seenCommands.has(pill.commandName)) continue;
            seenCommands.add(pill.commandName);

            const action = actions.find(a => a.id === pill.actionId);
            if (!action) {
                // Action deleted since the pill was inserted — send the pill
                // identity without a prompt; the backend tells the model the
                // definition is unavailable.
                promptActions.push({
                    command: pill.commandName,
                    action_id: pill.actionId,
                    title: pill.title,
                    prompt: null,
                    target_type: pill.targetType,
                });
                continue;
            }

            const { text: resolvedText, items, collection, emptyItemVariables } =
                await resolvePromptVariables(action.text, pill.targetType);

            if (emptyItemVariables.length > 0) {
                const hint = EMPTY_VARIABLE_HINTS[emptyItemVariables[0]] ?? 'No items found for this prompt.';
                set(addPopupMessageAtom, {
                    type: 'warning',
                    title: 'Action skipped',
                    text: hint,
                    expire: true,
                    duration: 4000,
                });
                return false;
            }

            for (const item of items) {
                const key = `${item.libraryID}-${item.key}`;
                const cached = validationResults.get(key);
                if (isRejectedItemValidation(item, cached)) {
                    set(addPopupMessageAtom, {
                        type: 'error',
                        title: 'Action skipped',
                        text: cached?.reason || 'One or more items failed validation.',
                        expire: true,
                        duration: 4000,
                    });
                    return false;
                }
            }

            for (const item of items) {
                const key = `${item.libraryID}-${item.key}`;
                if (!accumulatedItems.some(i => `${i.libraryID}-${i.key}` === key)) {
                    accumulatedItems.push(item);
                }
            }
            if (collection && !accumulatedCollection) {
                accumulatedCollection = collection;
            }

            promptActions.push({
                command: pill.commandName,
                action_id: pill.actionId,
                // Prefer the pill's title snapshot: if the action was renamed
                // between staging and send, the metadata must still describe
                // the visible /token.
                title: pill.title ?? action.title,
                prompt: resolvedText,
                target_type: pill.targetType,
                category: action.category,
            });
        }

        if (accumulatedItems.length > 0) {
            const currentItems = get(currentMessageItemsAtom);
            const existingKeys = new Set(currentItems.map(i => `${i.libraryID}-${i.key}`));
            const newItems = accumulatedItems.filter(i => !existingKeys.has(`${i.libraryID}-${i.key}`));
            if (newItems.length > 0) {
                set(currentMessageItemsAtom, [...currentItems, ...newItems]);
            }
        }

        if (accumulatedCollection && (get(currentMessageCollectionsAtom) as CollectionReference[]).length === 0) {
            set(currentMessageCollectionsAtom, [accumulatedCollection]);
        }

        await set(sendWSMessageAtom, baseText.trim(), { actions: promptActions });
        return true;
    },
);
