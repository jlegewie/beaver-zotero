/**
 * Actions V2.0 — Jotai atoms
 *
 * Replaces customPrompts.ts atoms with a two-layer architecture.
 */

import { atom } from 'jotai';
import { Action, ActionOverride, ActionTargetType, sameTargets } from '../types/actions';
import { ALL_BUILTIN_ACTIONS } from '../types/builtinActions';
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
import { getActionCommand, toSlashToken, type SlashCommandDescriptor } from '../utils/slashCommands';
import type { PromptAction } from '../agents/types';
import { MessageAttachment, messageAttachmentKey } from '../types/attachments/apiTypes';
import { toMessageAttachment } from '../types/attachments/converters';

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
        const builtinMap = new Map(ALL_BUILTIN_ACTIONS.map(a => [a.id, a]));
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
                if ((action.name ?? undefined) !== (base.name ?? undefined)) { override.name = action.name; hasChange = true; }
                if ((action.id_model ?? undefined) !== (base.id_model ?? undefined)) { override.id_model = action.id_model; hasChange = true; }
                if (!sameTargets(action.targets, base.targets)) { override.targets = action.targets; hasChange = true; }
                if ((action.category ?? undefined) !== (base.category ?? undefined)) { override.category = action.category; hasChange = true; }
                if ((action.argumentHint ?? undefined) !== (base.argumentHint ?? undefined)) { override.argumentHint = action.argumentHint; hasChange = true; }
                if ((action.sortOrder ?? undefined) !== (base.sortOrder ?? undefined)) { override.sortOrder = action.sortOrder; hasChange = true; }

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
            commandName: action ? getActionCommand(action) : toSlashToken(title),
            actionId: payload.actionId,
            targetType: payload.targetType,
            title,
            argumentHint: action?.argumentHint,
        };
        set(pendingPillInsertAtom, { descriptor, targetWindow: payload.targetWindow, nonce: Date.now() });
        set(markActionUsedAtom, payload.actionId);
    },
);

// ---------------------------------------------------------------------------
// Resolve /command pills to structured wire actions.
//
// Shared by the compose send path (sendComposedMessageAtom) and the message
// edit overlay (buildEditedPromptActionsAtom). Each pill's action prompt is
// resolved ({{ }} variables + targetType context items/collection); the
// resolved items/collection are returned for the caller to attach.
//
// When `persistedActions` is provided (editing a sent message), pills that
// were rebuilt from those wire actions (descriptor `persisted` flag) reuse
// their persisted entry verbatim instead of re-resolving: the original
// attachments still ride on the prompt, and the regenerated message keeps the
// meaning it had when sent (including pills whose action definition has since
// been deleted). Pills inserted during the edit never carry the flag, so a
// removed-and-reinserted /command resolves fresh like any new pill.
//
// Returns null when a pill's action cannot run right now (empty item variable,
// rejected item) — a popup has been shown and the send must be aborted.
// ---------------------------------------------------------------------------

interface ResolvedPillActions {
    actions: PromptAction[];
    items: Zotero.Item[];
    collection: CollectionReference | null;
}

export const resolvePillsToPromptActionsAtom = atom(
    null,
    async (
        get,
        set,
        payload: {
            pills: SlashCommandDescriptor[];
            persistedActions?: PromptAction[];
        },
    ): Promise<ResolvedPillActions | null> => {
        const { pills, persistedActions } = payload;
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

            const persisted = pill.persisted
                ? persistedActions?.find(a => a.command === pill.commandName)
                : undefined;
            if (persisted) {
                promptActions.push(persisted);
                continue;
            }

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
                return null;
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
                    return null;
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

        return { actions: promptActions, items: accumulatedItems, collection: accumulatedCollection };
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

        const resolved = await set(resolvePillsToPromptActionsAtom, { pills });
        if (!resolved) return false;
        const { actions: promptActions, items: accumulatedItems, collection: accumulatedCollection } = resolved;

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

// ---------------------------------------------------------------------------
// Build the wire `actions` (and any attachments they pull in) for an edited
// message about to be regenerated.
//
// Pills that survive from the original message reuse their persisted wire
// entry (see resolvePillsToPromptActionsAtom); pills added during the edit
// resolve like a fresh compose, and the items/collection their action pulls
// in are converted to message attachments here (deduped against the ones
// already on the message).
//
// Returns null when the edit cannot be submitted (a popup has been shown).
// ---------------------------------------------------------------------------

export const buildEditedPromptActionsAtom = atom(
    null,
    async (
        _get,
        set,
        payload: {
            pills: SlashCommandDescriptor[];
            persistedActions?: PromptAction[];
            existingAttachments?: MessageAttachment[];
        },
    ): Promise<{ actions?: PromptAction[]; addedAttachments: MessageAttachment[] } | null> => {
        const { pills, persistedActions, existingAttachments } = payload;
        if (pills.length === 0) return { actions: undefined, addedAttachments: [] };

        const resolved = await set(resolvePillsToPromptActionsAtom, { pills, persistedActions });
        if (!resolved) return null;

        const addedAttachments: MessageAttachment[] = [];
        const existingKeys = new Set((existingAttachments ?? []).map(messageAttachmentKey));

        if (resolved.items.length > 0) {
            // toMessageAttachment reads fields/creators, which lazy loading
            // may not have populated yet.
            const regularItems = resolved.items.filter(i => i.isRegularItem());
            if (regularItems.length > 0) {
                await Zotero.Items.loadDataTypes(regularItems, ['itemData', 'creators']);
            }
            const attachmentItems = resolved.items.filter(i => i.isAttachment());
            if (attachmentItems.length > 0) {
                await Zotero.Items.loadDataTypes(attachmentItems, ['itemData']);
                const parents = attachmentItems
                    .map(i => i.parentItem)
                    .filter((p): p is Zotero.Item => !!p);
                if (parents.length > 0) {
                    await Zotero.Items.loadDataTypes(parents, ['itemData', 'creators']);
                }
            }
            const noteItems = resolved.items.filter(i => i.isNote());
            await Promise.all(noteItems.map(i => i.loadDataType('note')));

            for (const item of resolved.items) {
                const attachment = toMessageAttachment(item);
                if (!attachment) continue;
                const key = messageAttachmentKey(attachment);
                if (existingKeys.has(key)) continue;
                existingKeys.add(key);
                addedAttachments.push(attachment);
            }
        }

        const hasCollection = (existingAttachments ?? []).some(a => a.type === 'collection');
        if (resolved.collection && !hasCollection) {
            addedAttachments.push({
                type: 'collection',
                library_id: resolved.collection.library_id,
                zotero_key: resolved.collection.zotero_key,
                name: resolved.collection.name,
                parent_key: resolved.collection.parent_key,
            });
        }

        return {
            actions: resolved.actions.length > 0 ? resolved.actions : undefined,
            addedAttachments,
        };
    },
);
