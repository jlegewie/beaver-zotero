import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// =============================================================================
// Module Mocks (must be before imports of the module under test)
// =============================================================================

// The full agentRunAtoms module drags in the WS layer; replace the send atom
// with a spy so tests assert on the exact (message, options) payload.
vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    const sendWSMessageMock = vi.fn();
    return {
        sendWSMessageAtom: atom(null, (_get, _set, message: string, options?: unknown) =>
            sendWSMessageMock(message, options)),
        __sendWSMessageMock: sendWSMessageMock,
    };
});

// messageComposition transitively imports reader utils / popup UI; provide the
// atoms actions.ts uses. The add-items atom mirrors the real one closely enough
// for the staging assertions (append, dedupe by key).
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    const currentMessageItemsAtom = atom<any[]>([]);
    return {
        currentMessageItemsAtom,
        currentMessageCollectionsAtom: atom<unknown[]>([]),
        pendingPillInsertsAtom: atom<unknown[]>([]),
        addItemsToCurrentMessageItemsAtom: atom(null, (get, set, items: any[]) => {
            const current = get(currentMessageItemsAtom);
            const added = items.filter((i) => !current.some((c: any) => c.key === i.key));
            if (added.length > 0) set(currentMessageItemsAtom, [...current, ...added]);
        }),
    };
});

vi.mock('../../../react/atoms/zoteroContext', async () => {
    const { atom } = await import('jotai');
    return { zoteroContextAtom: atom({}) };
});

vi.mock('../../../react/utils/popupMessageUtils', async () => {
    const { atom } = await import('jotai');
    const addPopupMessageMock = vi.fn();
    return {
        addPopupMessageAtom: atom(null, (_get, _set, message: unknown) => addPopupMessageMock(message)),
        __addPopupMessageMock: addPopupMessageMock,
    };
});

vi.mock('../../../react/atoms/itemValidation', async () => {
    const { atom } = await import('jotai');
    return {
        itemValidationResultsAtom: atom(new Map()),
        isRejectedItemValidation: vi.fn(() => false),
    };
});

// Target binding is synchronous (staging) and prompt-variable resolution is
// not (send); both are stubbed so tests drive them independently.
vi.mock('../../../react/utils/promptVariables', () => ({
    EMPTY_VARIABLE_HINTS: {},
    resolveTargetContext: vi.fn(() => ({
        items: [],
        collections: [],
        itemsExcluded: false,
        collectionsExcluded: false,
    })),
    resolvePromptVariables: vi.fn(async (text: string) => ({
        text: `resolved:${text}`,
        items: [],
        collections: [],
        emptyItemVariables: [],
    })),
}));

// actionVisibility pulls in sourceUtils → supabaseClient; actions.ts only
// needs `isActionVisible` from it.
vi.mock('../../../react/utils/actionVisibility', () => ({
    isActionVisible: vi.fn(() => true),
}));

// converters pulls in src serializers → supabase-backed services; actions.ts
// only needs `toMessageAttachment` from it.
vi.mock('../../../react/types/attachments/converters', () => ({
    toMessageAttachment: vi.fn(() => null),
}));

vi.mock('../../../react/types/actionStorage', () => ({
    getMergedActions: vi.fn(() => []),
    getActionCustomizations: vi.fn(() => ({ version: 1, overrides: {}, custom: [] })),
    saveActionCustomizations: vi.fn(),
    saveActionLastUsed: vi.fn(),
    isBuiltinAction: vi.fn((id: string) => id.startsWith('builtin-')),
}));

// actions.ts imports searchableLibraryIdsAtom from ./profile; mock it to avoid
// pulling the real profile → files → attachmentsService → supabaseClient chain,
// and to make the test items' library (1) searchable so the exclusion gate passes.
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return {
        searchableLibraryIdsAtom: atom<number[]>([1]),
    };
});

// =============================================================================
// Imports (after mocks)
// =============================================================================

import {
    actionsAtom,
    buildEditedPromptActionsAtom,
    resolveActionForStagingAtom,
    resolvePillsToPromptActionsAtom,
    sendComposedMessageAtom,
    stageActionPillAtom,
} from '../../../react/atoms/actions';
import {
    currentMessageCollectionsAtom,
    currentMessageItemsAtom,
    pendingPillInsertsAtom,
} from '../../../react/atoms/messageComposition';
import { resolvePromptVariables, resolveTargetContext } from '../../../react/utils/promptVariables';
import type { Action } from '../../../react/types/actions';

const sendWSMessageMock = (await import('../../../react/atoms/agentRunAtoms') as any).__sendWSMessageMock as ReturnType<typeof vi.fn>;
const addPopupMessageMock = (await import('../../../react/utils/popupMessageUtils') as any).__addPopupMessageMock as ReturnType<typeof vi.fn>;
const { isRejectedItemValidation } = await import('../../../react/atoms/itemValidation') as any;

const summarizeAction: Action = {
    id: 'custom-1',
    title: 'Summarize',
    text: 'Summarize the selected papers.',
    targets: ['items'],
    category: 'research',
};

const critiqueAction: Action = {
    id: 'custom-2',
    title: 'Critique',
    text: 'Critique it.',
    targets: ['items'],
    category: 'research',
};

function makeStore(actions: Action[] = [summarizeAction]) {
    const store = createStore();
    store.set(actionsAtom, actions);
    return store;
}

/** Stage an action the way a launcher surface does, returning its pill. */
function stage(
    store: ReturnType<typeof createStore>,
    payload: Parameters<typeof resolveActionForStagingAtom['write']>[2],
) {
    return store.set(resolveActionForStagingAtom, payload);
}

/** What the next staging call binds its target type to. */
function nextTargets(context: Partial<{
    items: any[];
    collections: any[];
    itemsExcluded: boolean;
    collectionsExcluded: boolean;
}>) {
    vi.mocked(resolveTargetContext).mockReturnValueOnce({
        items: [],
        collections: [],
        itemsExcluded: false,
        collectionsExcluded: false,
        ...context,
    } as any);
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('resolveActionForStagingAtom', () => {
    it('returns a pill for the action', () => {
        const store = makeStore();
        expect(stage(store, { actionId: 'custom-1', targetType: 'items' })).toMatchObject({
            commandName: 'summarize',
            actionId: 'custom-1',
            targetType: 'items',
            title: 'Summarize',
        });
    });

    it('attaches the targets the action binds to', () => {
        const item = { libraryID: 1, key: 'ABC' };
        nextTargets({ items: [item] });
        const store = makeStore();
        stage(store, { actionId: 'custom-1', targetType: 'items' });
        expect(store.get(currentMessageItemsAtom)).toEqual([item]);
    });

    it('leaves the action prompt alone until the message is sent', () => {
        const store = makeStore();
        stage(store, { actionId: 'custom-1', targetType: 'items' });
        expect(resolvePromptVariables).not.toHaveBeenCalled();
    });

    it('merges bound collections with the ones already on the message', () => {
        const a = { library_id: 1, zotero_key: 'COLLA', name: 'A', parent_key: null };
        const b = { library_id: 1, zotero_key: 'COLLB', name: 'B', parent_key: null };
        nextTargets({ collections: [a, b] });
        const store = makeStore();
        store.set(currentMessageCollectionsAtom, [a]);
        stage(store, { actionId: 'custom-1', targetType: 'collection' });
        // A was already attached; B must still reach the model.
        expect(store.get(currentMessageCollectionsAtom)).toEqual([a, b]);
    });

    it('leaves the composer alone when the caller keeps its own attachments', () => {
        const item = { libraryID: 1, key: 'ABC' };
        const collection = { library_id: 1, zotero_key: 'COLLA', name: 'A', parent_key: null };
        nextTargets({ items: [item], collections: [collection] });
        const store = makeStore();
        expect(stage(store, {
            actionId: 'custom-1', targetType: 'items', attachToComposer: false,
        })).toBeTruthy();
        expect(store.get(currentMessageItemsAtom)).toEqual([]);
        expect(store.get(currentMessageCollectionsAtom)).toEqual([]);
    });

    it('binds the context override instead of the live Zotero state', () => {
        const store = makeStore();
        const override = { items: [{ libraryID: 1, key: 'ABC' } as any], collections: [] };
        stage(store, { actionId: 'custom-1', targetType: 'items', contextOverride: override });
        expect(resolveTargetContext).toHaveBeenCalledWith('items', override);
    });

    it('stages nothing when the bound items are all in an excluded library', () => {
        nextTargets({ itemsExcluded: true });
        const store = makeStore();
        expect(stage(store, { actionId: 'custom-1', targetType: 'items' })).toBeNull();
        expect(store.get(currentMessageItemsAtom)).toEqual([]);
        expect(addPopupMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    it('stages nothing when the bound collections are all in an excluded library', () => {
        nextTargets({ collectionsExcluded: true });
        const store = makeStore();
        expect(stage(store, { actionId: 'custom-1', targetType: 'collection' })).toBeNull();
        expect(store.get(currentMessageCollectionsAtom)).toEqual([]);
        expect(addPopupMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    it('stages nothing when a bound item is rejected by validation', () => {
        nextTargets({ items: [{ libraryID: 1, key: 'ABC' }] });
        vi.mocked(isRejectedItemValidation).mockReturnValueOnce(true);
        const store = makeStore();
        expect(stage(store, { actionId: 'custom-1', targetType: 'items' })).toBeNull();
        expect(store.get(currentMessageItemsAtom)).toEqual([]);
        expect(addPopupMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    it('uses the fallback title when the action definition is unavailable', () => {
        const store = makeStore([]);
        expect(stage(store, { actionId: 'missing', fallbackTitle: 'My Skill' }))
            .toMatchObject({ commandName: 'my-skill', title: 'My Skill' });
    });
});

describe('sendComposedMessageAtom', () => {
    it('keeps pill tokens verbatim in content and sends structured actions', async () => {
        const store = makeStore();
        const pill = stage(store, { actionId: 'custom-1', targetType: 'items' })!;
        const ok = await store.set(sendComposedMessageAtom, {
            baseText: '/summarize and focus on methods ',
            pills: [pill],
        });
        expect(ok).toBe(true);
        const [message, options] = sendWSMessageMock.mock.calls[0];
        expect(message).toBe('/summarize and focus on methods');
        expect(options.actions).toEqual([{
            command: 'summarize',
            action_id: 'custom-1',
            title: 'Summarize',
            prompt: 'resolved:Summarize the selected papers.',
            target_type: 'items',
            category: 'research',
        }]);
    });

    it('does not re-bind the action targets at send', async () => {
        const store = makeStore();
        const pill = stage(store, { actionId: 'custom-1', targetType: 'items' })!;
        await store.set(sendComposedMessageAtom, { baseText: '/summarize', pills: [pill] });
        // Passing no target type is what keeps the send from re-reading the
        // Zotero selection; only the prompt text is resolved.
        expect(resolvePromptVariables).toHaveBeenCalledWith('Summarize the selected papers.', undefined);
    });

    it('sends the attachments the user is left with', async () => {
        const kept = { libraryID: 1, key: 'KEEP' };
        const removed = { libraryID: 1, key: 'DROP' };
        nextTargets({ items: [kept, removed] });
        const store = makeStore();
        const pill = stage(store, { actionId: 'custom-1', targetType: 'items' })!;
        // The user removes one of the bound targets before sending.
        store.set(currentMessageItemsAtom, [kept]);
        await store.set(sendComposedMessageAtom, { baseText: '/summarize', pills: [pill] });
        expect(store.get(currentMessageItemsAtom)).toEqual([kept]);
    });

    it('attaches the items a {{variable}} prompt resolves to', async () => {
        // Prompt variables still resolve on the way out, and the items they
        // name are merged in as they always have been.
        const item = { libraryID: 1, key: 'ABC' };
        vi.mocked(resolvePromptVariables).mockResolvedValueOnce({
            text: 'x', items: [item], collections: [], emptyItemVariables: [],
        } as any);
        const store = makeStore();
        const pill = stage(store, { actionId: 'custom-1', targetType: 'items' })!;
        await store.set(sendComposedMessageAtom, { baseText: '/summarize', pills: [pill] });
        expect(store.get(currentMessageItemsAtom)).toEqual([item]);
    });

    it('aborts without sending when a variable resolves to no items', async () => {
        vi.mocked(resolvePromptVariables).mockResolvedValueOnce({
            text: 'x', items: [], collections: [], emptyItemVariables: ['selected_items'],
        } as any);
        const store = makeStore();
        const pill = stage(store, { actionId: 'custom-1', targetType: 'items' })!;
        const ok = await store.set(sendComposedMessageAtom, { baseText: '/summarize', pills: [pill] });
        expect(ok).toBe(false);
        expect(sendWSMessageMock).not.toHaveBeenCalled();
        expect(addPopupMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    });

    it('aborts without sending when a variable resolves to an excluded item', async () => {
        // Library 2 is not in the searchable set ([1]).
        vi.mocked(resolvePromptVariables).mockResolvedValueOnce({
            text: 'x', items: [{ libraryID: 2, key: 'XYZ' }], collections: [], emptyItemVariables: [],
        } as any);
        const store = makeStore();
        const pill = stage(store, { actionId: 'custom-1', targetType: 'items' })!;
        const ok = await store.set(sendComposedMessageAtom, { baseText: '/summarize', pills: [pill] });
        expect(ok).toBe(false);
        expect(sendWSMessageMock).not.toHaveBeenCalled();
        expect(addPopupMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    it('prefers the pill title snapshot over the current action title', async () => {
        const store = makeStore([{ ...summarizeAction, title: 'Renamed Later' }]);
        await store.set(sendComposedMessageAtom, {
            baseText: '/summarize',
            pills: [{ commandName: 'summarize', actionId: 'custom-1', title: 'Summarize' }],
        });
        expect(sendWSMessageMock.mock.calls[0][1].actions[0].title).toBe('Summarize');
    });

    it('sends prompt: null when the action was deleted after staging', async () => {
        const store = makeStore([]);
        const ok = await store.set(sendComposedMessageAtom, {
            baseText: '/gone please',
            pills: [{ commandName: 'gone', actionId: 'deleted-id', title: 'Gone' }],
        });
        expect(ok).toBe(true);
        const [message, options] = sendWSMessageMock.mock.calls[0];
        expect(message).toBe('/gone please');
        expect(options.actions).toEqual([{
            command: 'gone',
            action_id: 'deleted-id',
            title: 'Gone',
            prompt: null,
            target_type: undefined,
        }]);
    });

    it('dedupes repeated pills of the same command', async () => {
        const store = makeStore();
        const pill = stage(store, { actionId: 'custom-1', targetType: 'items' })!;
        await store.set(sendComposedMessageAtom, {
            baseText: '/summarize then /summarize',
            pills: [pill, pill],
        });
        expect(sendWSMessageMock.mock.calls[0][1].actions).toHaveLength(1);
        expect(resolvePromptVariables).toHaveBeenCalledTimes(1);
    });
});

describe('buildEditedPromptActionsAtom', () => {
    const collectionAction: Action = {
        id: 'custom-1',
        title: 'Summarize',
        text: 'Summarize the collection.',
        targets: ['collection'],
        category: 'research',
    };

    /** Collections a pill added during the edit resolves to on submit. */
    function nextEditTargets(collections: any[]) {
        vi.mocked(resolvePromptVariables).mockResolvedValueOnce({
            text: 'x', items: [], collections, emptyItemVariables: [],
        } as any);
    }

    it('binds the targets of a pill added during the edit', async () => {
        // The overlay has no composer to attach to, so unlike a compose pill
        // its targets are resolved when the edit is submitted.
        const store = makeStore([collectionAction]);
        await store.set(buildEditedPromptActionsAtom, {
            pills: [{ commandName: 'summarize', actionId: 'custom-1', targetType: 'collection' }],
            existingAttachments: [],
        });
        expect(resolvePromptVariables).toHaveBeenCalledWith('Summarize the collection.', 'collection');
    });

    it('adds only the collections the edited message is missing', async () => {
        const a = { library_id: 1, zotero_key: 'COLLA', name: 'A', parent_key: null };
        const b = { library_id: 1, zotero_key: 'COLLB', name: 'B', parent_key: null };
        nextEditTargets([a, b]);
        const store = makeStore([collectionAction]);
        const result = await store.set(buildEditedPromptActionsAtom, {
            pills: [{ commandName: 'summarize', actionId: 'custom-1' }],
            existingAttachments: [{ type: 'collection', ...a }],
        });
        // A is already attached to the message; only B is newly added.
        expect(result?.addedAttachments).toEqual([{ type: 'collection', ...b }]);
    });

    it('adds every resolved collection when the message carries none', async () => {
        const a = { library_id: 1, zotero_key: 'COLLA', name: 'A', parent_key: null };
        const b = { library_id: 1, zotero_key: 'COLLB', name: 'B', parent_key: null };
        nextEditTargets([a, b]);
        const store = makeStore([collectionAction]);
        const result = await store.set(buildEditedPromptActionsAtom, {
            pills: [{ commandName: 'summarize', actionId: 'custom-1' }],
            existingAttachments: [],
        });
        expect(result?.addedAttachments).toEqual([
            { type: 'collection', ...a },
            { type: 'collection', ...b },
        ]);
    });

    it('does not let an item attachment sharing a key mask a collection', async () => {
        // Collection and item keys are separate Zotero namespaces, so an item
        // attachment with the same key must not dedup the collection away.
        const a = { library_id: 1, zotero_key: 'SAMEKEY', name: 'A', parent_key: null };
        nextEditTargets([a]);
        const store = makeStore([collectionAction]);
        const result = await store.set(buildEditedPromptActionsAtom, {
            pills: [{ commandName: 'summarize', actionId: 'custom-1' }],
            existingAttachments: [{ type: 'source', library_id: 1, zotero_key: 'SAMEKEY' }],
        });
        expect(result?.addedAttachments).toEqual([{ type: 'collection', ...a }]);
    });
});

describe('resolvePillsToPromptActionsAtom (edited-message reuse)', () => {
    const persistedAction = {
        command: 'summarize',
        action_id: 'custom-1',
        title: 'Summarize',
        prompt: 'Original resolved prompt',
        target_type: 'items' as const,
    };

    it('reuses the persisted wire entry for pills flagged as persisted', async () => {
        const store = makeStore();
        const resolved = await store.set(resolvePillsToPromptActionsAtom, {
            pills: [{ commandName: 'summarize', actionId: 'custom-1', title: 'Summarize', persisted: true }],
            persistedActions: [persistedAction],
        });
        expect(resolved?.actions).toEqual([persistedAction]);
        expect(resolvePromptVariables).not.toHaveBeenCalled();
    });

    it('resolves fresh for a reinserted pill with the same command (no persisted flag)', async () => {
        const store = makeStore();
        const resolved = await store.set(resolvePillsToPromptActionsAtom, {
            pills: [{ commandName: 'summarize', actionId: 'custom-1', title: 'Summarize' }],
            persistedActions: [persistedAction],
        });
        expect(resolvePromptVariables).toHaveBeenCalledTimes(1);
        expect(resolved?.actions[0].prompt).toBe('resolved:Summarize the selected papers.');
    });

    it('reuses the persisted entry for surviving pills of deleted actions', async () => {
        const store = makeStore([]);
        const resolved = await store.set(resolvePillsToPromptActionsAtom, {
            pills: [{ commandName: 'summarize', actionId: 'custom-1', title: 'Summarize', missing: true, persisted: true }],
            persistedActions: [persistedAction],
        });
        expect(resolved?.actions).toEqual([persistedAction]);
    });
});

describe('stageActionPillAtom', () => {
    it('hands the resolved pill to the input', () => {
        const store = makeStore();
        expect(store.set(stageActionPillAtom, { actionId: 'custom-1', targetType: 'items' })).toBe(true);
        const pending = store.get(pendingPillInsertsAtom) as any[];
        expect(pending).toHaveLength(1);
        expect(pending[0].descriptor).toMatchObject({
            commandName: 'summarize',
            actionId: 'custom-1',
            targetType: 'items',
            title: 'Summarize',
        });
    });

    it('queues a second pill instead of displacing an unclaimed one', () => {
        // An editor claims a pill on a timer, so one staged moments ago may
        // still be waiting; both actions were launched and both are inserted.
        const store = makeStore([summarizeAction, critiqueAction]);
        store.set(stageActionPillAtom, { actionId: 'custom-1', targetType: 'items' });
        store.set(stageActionPillAtom, { actionId: 'custom-2', targetType: 'items' });
        const pending = store.get(pendingPillInsertsAtom) as any[];
        expect(pending.map(p => p.descriptor.commandName)).toEqual(['summarize', 'critique']);
    });

    it('stages no pill when the action cannot run', () => {
        nextTargets({ itemsExcluded: true });
        const store = makeStore();
        expect(store.set(stageActionPillAtom, { actionId: 'custom-1', targetType: 'items' })).toBe(false);
        expect(store.get(pendingPillInsertsAtom)).toEqual([]);
    });
});
