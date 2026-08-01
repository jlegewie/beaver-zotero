/**
 * Actions V2.0 — Jotai atoms
 *
 * Replaces customPrompts.ts atoms with a two-layer architecture.
 */

import { atom } from 'jotai';
import { v4 as uuidv4 } from 'uuid';
import { Action, ActionOverride, ActionTargetType, generateActionId, sameTargets } from '../types/actions';
import { ALL_BUILTIN_ACTIONS } from '../types/builtinActions';
import {
    getMergedActions,
    getActionCustomizations,
    saveActionCustomizations,
    saveActionLastUsed,
    isBuiltinAction,
    isLockedBuiltinAction,
} from '../types/actionStorage';
import { zoteroContextAtom } from './zoteroContext';
import { isActionVisible, ActionContext } from '../utils/actionVisibility';
import {
    resolvePromptVariables,
    resolveTargetContext,
    EMPTY_VARIABLE_HINTS,
    type TargetTypeContext,
} from '../utils/promptVariables';
import { sendWSMessageAtom } from './agentRunAtoms';
import {
    currentMessageItemsAtom,
    currentMessageCollectionsAtom,
    pendingPillInsertsAtom,
    addItemsToCurrentMessageItemsAtom,
} from './messageComposition';
import { CollectionReference, collectionReferenceKey } from '../types/zotero';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { isRejectedItemValidation, itemValidationResultsAtom } from './itemValidation';
import { searchableLibraryIdsAtom } from './profile';
import { getActionCommand, toSlashToken, type SlashCommandDescriptor } from '../utils/slashCommands';
import type { PromptAction } from '../agents/types';
import { MessageAttachment, messageAttachmentKey, messageAttachmentLookupKeys } from '../types/attachments/apiTypes';
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
                // Locked built-ins are entirely code-managed. Do not turn a
                // mutated value from any caller into a persisted override.
                if (base.locked) continue;
                const override: ActionOverride = {};
                let hasChange = false;

                // Compare each overridable field
                if (action.title !== base.title) { override.title = action.title; hasChange = true; }
                if (action.text !== base.text) { override.text = action.text; hasChange = true; }
                // Persist "" (not undefined) when clearing a built-in's default
                // description: an undefined field is dropped from the serialized
                // override, which would resurrect the base description on merge.
                if ((action.description ?? undefined) !== (base.description ?? undefined)) { override.description = action.description ?? ''; hasChange = true; }
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
                // Custom action — strip runtime-only `lastUsed` and the
                // built-in-only `locked` flag (locking is code-defined and must
                // never live in user data) before persisting.
                const { lastUsed: _lastUsed, locked: _locked, ...rest } = action;
                newCustom.push(rest);
            }
        }

        // Preserve overrides for hidden built-ins that aren't in the actions list
        for (const [id, override] of Object.entries(c.overrides)) {
            if (override.hidden && !newOverrides[id] && !isLockedBuiltinAction(id)) {
                newOverrides[id] = override;
            }
        }

        const newCustomizations = { version: 1 as const, overrides: newOverrides, custom: newCustom };
        saveActionCustomizations(newCustomizations);
        set(actionsAtom, getMergedActions());
    },
);

// ---------------------------------------------------------------------------
// Write atom — import a shared action, resolving id + command conflicts
//
// A `.beaveraction` file carries the author's id and (optional) slash-command
// name. Neither can be trusted to be free on the importing machine, so:
//   - id: kept only when it clashes with nothing (no built-in, no existing
//     custom action); otherwise a fresh id is minted so the import never
//     overwrites or shadows an existing action.
//   - command: kept when its /token is free; otherwise a numeric suffix is
//     appended and persisted as an explicit `name` so it stays stable.
//
// Shared by every import entry point (preferences Import button, drag & drop).
// Returns the stored action plus what had to change, for user-facing messaging.
// ---------------------------------------------------------------------------

export interface ActionImportResult {
    action: Action;
    /** The /command the imported action ended up with. */
    command: string;
    /** True when the author's id collided and a new one was minted. */
    idReassigned: boolean;
    /** True when the /command had to be renamed to avoid a clash. */
    commandRenamed: boolean;
}

export const importActionAtom = atom(
    null,
    (get, set, incoming: Action): ActionImportResult => {
        const actions = get(actionsAtom);

        // --- Resolve id conflict ---
        const idTaken = !incoming.id
            || isBuiltinAction(incoming.id)
            || actions.some(a => a.id === incoming.id);
        const id = idTaken ? generateActionId() : incoming.id;
        const idReassigned = id !== incoming.id;

        // --- Resolve slash-command conflict ---
        const takenCommands = new Set(actions.map(a => getActionCommand(a)));
        const desiredCommand = getActionCommand(incoming); // explicit name or title-derived
        let command = desiredCommand;
        if (takenCommands.has(command)) {
            let suffix = 2;
            while (takenCommands.has(`${desiredCommand}-${suffix}`)) suffix++;
            command = `${desiredCommand}-${suffix}`;
        }
        const commandRenamed = command !== desiredCommand;

        // Persist an explicit name only when we disambiguated, or the incoming
        // action already carried one. A clash-free title-derived command stays
        // automatic (name unset) so future title edits keep updating it.
        const name = commandRenamed ? command : incoming.name;

        // Strip local/runtime and built-in-only fields the importer owns.
        // `locked` never rides along: a duplicated/imported action is editable.
        const { lastUsed: _lastUsed, deprecated: _deprecated, locked: _locked, ...rest } = incoming;
        const newAction: Action = {
            ...rest,
            id,
            name,
            sortOrder: 999,
        };

        set(saveActionsAtom, [...actions, newAction]);
        return { action: newAction, command, idReassigned, commandRenamed };
    },
);

// ---------------------------------------------------------------------------
// Write atom — hide a built-in action
// ---------------------------------------------------------------------------

export const hideActionAtom = atom(
    null,
    (_get, set, id: string) => {
        if (isLockedBuiltinAction(id)) return;
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
        if (isLockedBuiltinAction(id)) return;
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
        if (isLockedBuiltinAction(id)) return;
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

export const actionContextAtom = atom<ActionContext>((get) => {
    const zotero = get(zoteroContextAtom);
    const searchableLibraryIds = get(searchableLibraryIdsAtom);

    // Actions stage their target for a run, so the context an action is chosen
    // from must contain only items Beaver can actually use.
    const selectedItems = zotero.selectedItems.filter(
        (item: Zotero.Item) => searchableLibraryIds.includes(item.libraryID),
    );

    // Collection targets are filtered on the same principle, so a label never
    // promises collections the run will not touch.
    const { libraryView } = zotero;
    const selectedCollections = libraryView.selectedCollections.filter(
        (collection) => searchableLibraryIds.includes(collection.libraryId),
    );
    const droppedCollections = libraryView.selectedCollections.length - selectedCollections.length;
    const selectedLibraryIds = libraryView.selectedLibraryIds.filter(
        (libraryId) => searchableLibraryIds.includes(libraryId),
    );

    const itemsChanged = selectedItems.length !== zotero.selectedItems.length;
    const libraryViewChanged = droppedCollections > 0
        || selectedLibraryIds.length !== libraryView.selectedLibraryIds.length;

    if (!itemsChanged && !libraryViewChanged) {
        return { zotero, manualItems: get(currentMessageItemsAtom) };
    }

    return {
        zotero: {
            ...zotero,
            selectedItems,
            libraryView: libraryViewChanged
                ? {
                    ...libraryView,
                    selectedCollections,
                    selectedLibraryIds,
                    selectedRowCount: libraryView.selectedRowCount - droppedCollections,
                }
                : libraryView,
        },
        manualItems: get(currentMessageItemsAtom),
    };
});

// ---------------------------------------------------------------------------
// Derived: context-filtered actions
// ---------------------------------------------------------------------------

export const actionsForContextAtom = atom<Action[]>((get) => {
    const actions = get(actionsAtom);
    const ctx = get(actionContextAtom);
    return actions.filter(a => isActionVisible(a, ctx));
});

// ---------------------------------------------------------------------------
// Bind an action to its targets the moment the user picks it.
//
// Shared by every surface that launches an action: the slash menu, the home
// launcher, action suggestions, the library context menu, and the reader
// toolbar. Picking an action attaches the items/collections its target type
// binds to, so what it will run on is visible in the composer and can be
// edited — or removed — before sending. Nothing is re-bound at send time.
//
// Synchronous on purpose: the pill and its attachments land in the same click,
// leaving no window in which the draft can change underneath them.
//
// Returns the descriptor of the pill to insert, or null when the action cannot
// run right now — a popup explains why and nothing is staged.
// ---------------------------------------------------------------------------

export const resolveActionForStagingAtom = atom(
    null,
    (get, set, payload: {
        actionId: string;
        targetType?: ActionTargetType;
        /** Title to show when the action definition is not available here. */
        fallbackTitle?: string;
        /** Target context to bind instead of the live Zotero state. The library
         *  context menu binds the rows the user right-clicked, which are not
         *  always what the current selection resolves to. */
        contextOverride?: TargetTypeContext;
        /** Attach the resolved targets to the composer. The message edit
         *  overlay passes false: it carries its own attachment list, which the
         *  regenerate path extends on submit. */
        attachToComposer?: boolean;
    }): SlashCommandDescriptor | null => {
        const { actionId, targetType, contextOverride, attachToComposer = true } = payload;
        const action = get(actionsAtom).find(a => a.id === actionId);

        // The action definition is not available here (it was deleted between
        // rendering the surface and clicking it). Stage the pill identity
        // anyway; the send path tells the model the definition is unavailable.
        if (!action) {
            const title = payload.fallbackTitle ?? 'action';
            set(markActionUsedAtom, actionId);
            return { commandName: toSlashToken(title), actionId, targetType, title };
        }

        const { items, collections, itemsExcluded, collectionsExcluded } =
            resolveTargetContext(targetType, contextOverride);

        // The target exists but sits entirely in an excluded library. Running
        // the action would give the model a target type with nothing behind it,
        // so fail the same way an explicitly referenced excluded item does.
        if (itemsExcluded || collectionsExcluded) {
            set(addPopupMessageAtom, {
                type: 'error',
                title: 'Action skipped',
                text: itemsExcluded
                    ? 'This action targets an item in a library you excluded from Beaver. You can change excluded libraries in Beaver Preferences.'
                    : 'This action targets a collection in a library you excluded from Beaver. You can change excluded libraries in Beaver Preferences.',
                expire: true,
                duration: 5000,
            });
            return null;
        }

        const validationResults = get(itemValidationResultsAtom);
        const rejected = items.find(item =>
            isRejectedItemValidation(item, validationResults.get(`${item.libraryID}-${item.key}`)));
        if (rejected) {
            const validation = validationResults.get(`${rejected.libraryID}-${rejected.key}`);
            set(addPopupMessageAtom, {
                type: 'error',
                title: 'Action skipped',
                text: validation?.reason || 'One or more items failed validation.',
                expire: true,
                duration: 4000,
            });
            return null;
        }

        if (attachToComposer) {
            // Goes through the shared add path, so the targets are validated in
            // the background like any other attachment the user adds.
            if (items.length > 0) void set(addItemsToCurrentMessageItemsAtom, items);
            if (collections.length > 0) {
                // Merge rather than replace: the composer may already carry
                // collections the user attached.
                const current = get(currentMessageCollectionsAtom) as CollectionReference[];
                const existingKeys = new Set(current.map(collectionReferenceKey));
                const added = collections.filter(c => !existingKeys.has(collectionReferenceKey(c)));
                if (added.length > 0) set(currentMessageCollectionsAtom, [...current, ...added]);
            }
        }

        set(markActionUsedAtom, action.id);
        return {
            commandName: getActionCommand(action),
            actionId: action.id,
            targetType,
            title: action.title,
            argumentHint: action.argumentHint,
        };
    },
);

// ---------------------------------------------------------------------------
// Stage an action as a /command pill in the chat input.
//
// Used by the surfaces that do not own an editor handle (home launcher, action
// suggestions, library context menu, reader toolbar): the pill is handed to
// InputArea via `pendingPillInsertsAtom`, which inserts it. The user submits
// the message themselves. The slash menu owns its editor, so it calls
// `resolveActionForStagingAtom` and inserts the pill itself.
// ---------------------------------------------------------------------------

export const stageActionPillAtom = atom(
    null,
    (get, set, payload: {
        actionId: string;
        targetType?: ActionTargetType;
        fallbackTitle?: string;
        contextOverride?: TargetTypeContext;
        /** Window whose editor should receive the pill (where the user acted). */
        targetWindow?: Window;
    }): boolean => {
        const descriptor = set(resolveActionForStagingAtom, {
            actionId: payload.actionId,
            targetType: payload.targetType,
            fallbackTitle: payload.fallbackTitle,
            contextOverride: payload.contextOverride,
        });
        if (!descriptor) return false;
        // Queue rather than replace: an editor claims a pill on a timer, so one
        // staged moments ago may still be waiting, and dropping it would lose an
        // action the user launched whose targets are already attached.
        set(pendingPillInsertsAtom, [
            ...get(pendingPillInsertsAtom),
            { descriptor, targetWindow: payload.targetWindow },
        ]);
        return true;
    },
);

// ---------------------------------------------------------------------------
// Build the structured wire actions for the /command pills in a message.
//
// Shared by the compose send path (sendComposedMessageAtom) and the message
// edit overlay (buildEditedPromptActionsAtom). Only the action's prompt text is
// resolved here: an action binds its targets when the user picks it, so the
// message runs on exactly what is attached to it, including anything the user
// added or removed since.
//
// `bindTargets` resolves the target context as well. The edit overlay passes
// it: its pills have no composer to attach to, so the targets of a pill added
// during the edit are resolved when the edit is submitted.
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
    collections: CollectionReference[];
}

export const resolvePillsToPromptActionsAtom = atom(
    null,
    async (
        get,
        set,
        payload: {
            pills: SlashCommandDescriptor[];
            persistedActions?: PromptAction[];
            bindTargets?: boolean;
        },
    ): Promise<ResolvedPillActions | null> => {
        const { pills, persistedActions, bindTargets } = payload;
        const actions = get(actionsAtom);
        const validationResults = get(itemValidationResultsAtom);
        const searchableLibraryIds = get(searchableLibraryIdsAtom);

        const accumulatedItems: Zotero.Item[] = [];
        const accumulatedCollections: CollectionReference[] = [];
        const seenItemKeys = new Set<string>();
        const seenCollectionKeys = new Set<string>();
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

            const { text: resolvedText, items, collections, emptyItemVariables, targetContextExcluded } =
                await resolvePromptVariables(action.text, bindTargets ? pill.targetType : undefined);

            // The action is bound to a target that exists but sits entirely in
            // an excluded library. Sending it would give the model a target
            // type with nothing attached, so fail the same way an explicitly
            // referenced excluded item does.
            if (targetContextExcluded) {
                set(addPopupMessageAtom, {
                    type: 'error',
                    title: 'Action skipped',
                    text: 'This action targets an item in a library you excluded from Beaver. You can change excluded libraries in Beaver Preferences.',
                    expire: true,
                    duration: 5000,
                });
                return null;
            }

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
                // Enforce library exclusion directly
                if (!searchableLibraryIds.includes(item.libraryID)) {
                    set(addPopupMessageAtom, {
                        type: 'error',
                        title: 'Action skipped',
                        text: 'This action references an item in a library you excluded from Beaver. You can change excluded libraries in Beaver Preferences.',
                        expire: true,
                        duration: 5000,
                    });
                    return null;
                }
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
                if (!seenItemKeys.has(key)) {
                    seenItemKeys.add(key);
                    accumulatedItems.push(item);
                }
            }

            for (const collection of collections) {
                // A collection-bound action carries no items, so the per-item
                // check above never sees it — gate each collection's library here.
                if (!searchableLibraryIds.includes(collection.library_id)) {
                    set(addPopupMessageAtom, {
                        type: 'error',
                        title: 'Action skipped',
                        text: 'This action targets a collection in a library you excluded from Beaver. You can change excluded libraries in Beaver Preferences.',
                        expire: true,
                        duration: 5000,
                    });
                    return null;
                }
                const key = collectionReferenceKey(collection);
                if (!seenCollectionKeys.has(key)) {
                    seenCollectionKeys.add(key);
                    accumulatedCollections.push(collection);
                }
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
                description: action.description,
            });
        }

        return { actions: promptActions, items: accumulatedItems, collections: accumulatedCollections };
    },
);

// ---------------------------------------------------------------------------
// Send a composed message that contains one or more /command pills.
//
// The pill tokens stay verbatim in the message content and travel as
// structured `actions` entries on the prompt; the backend appends a definition
// block telling the model what each /command means.
//
// An action's targets were attached when the user picked it, so nothing is
// attached here — what the user is left with is what gets sent. The exception
// is a prompt carrying {{variables}}: those resolve on the way out, and the
// items they name are merged in as they always have been.
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
        const { actions: promptActions, items: variableItems, collections: variableCollections } = resolved;

        if (variableItems.length > 0) {
            const currentItems = get(currentMessageItemsAtom);
            const existingKeys = new Set(currentItems.map(i => `${i.libraryID}-${i.key}`));
            const newItems = variableItems.filter(i => !existingKeys.has(`${i.libraryID}-${i.key}`));
            if (newItems.length > 0) {
                set(currentMessageItemsAtom, [...currentItems, ...newItems]);
            }
        }

        if (variableCollections.length > 0) {
            const currentCollections = get(currentMessageCollectionsAtom) as CollectionReference[];
            const existingCollectionKeys = new Set(currentCollections.map(collectionReferenceKey));
            const newCollections = variableCollections.filter(
                c => !existingCollectionKeys.has(collectionReferenceKey(c)),
            );
            if (newCollections.length > 0) {
                set(currentMessageCollectionsAtom, [...currentCollections, ...newCollections]);
            }
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
// resolve like a fresh compose, and the items/collections their action pulls
// in are converted to message attachments here (deduped against the ones
// already on the message).
//
// Unlike the composer, this overlay has nowhere to attach a pill's targets
// when it is inserted, so it binds them on submit.
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

        const resolved = await set(resolvePillsToPromptActionsAtom, {
            pills,
            persistedActions,
            bindTargets: true,
        });
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
                const aliases = messageAttachmentLookupKeys(attachment);
                if (aliases.some(key => existingKeys.has(key))) continue;
                existingKeys.add(messageAttachmentKey(attachment));
                addedAttachments.push(attachment);
            }
        }

        // Add each resolved collection the message doesn't already carry, so
        // widening the selection still reaches the regenerated action. Keyed
        // against the existing *collection* attachments only: collection and
        // item keys are separate Zotero namespaces, so the shared item key set
        // above could otherwise mask a collection that merely shares a key.
        const existingCollectionKeys = new Set(
            (existingAttachments ?? [])
                .filter(a => a.type === 'collection')
                .flatMap(a => messageAttachmentLookupKeys(a)),
        );
        for (const collection of resolved.collections) {
            const attachment: MessageAttachment = {
                type: 'collection',
                library_id: collection.library_id,
                zotero_key: collection.zotero_key,
                library_ref: collection.library_ref,
                name: collection.name,
                parent_key: collection.parent_key,
            };
            const aliases = messageAttachmentLookupKeys(attachment);
            if (aliases.some(key => existingCollectionKeys.has(key))) continue;
            aliases.forEach(key => existingCollectionKeys.add(key));
            addedAttachments.push(attachment);
        }

        return {
            actions: resolved.actions.length > 0 ? resolved.actions : undefined,
            addedAttachments,
        };
    },
);
