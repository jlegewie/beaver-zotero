import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

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
// three atoms actions.ts uses.
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return {
        currentMessageItemsAtom: atom<unknown[]>([]),
        currentMessageCollectionsAtom: atom<unknown[]>([]),
        pendingPillInsertAtom: atom<unknown | null>(null),
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

vi.mock('../../../react/utils/promptVariables', () => ({
    EMPTY_VARIABLE_HINTS: {},
    resolvePromptVariables: vi.fn(async (text: string) => ({
        text: `resolved:${text}`,
        items: [],
        collection: null,
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

// =============================================================================
// Imports (after mocks)
// =============================================================================

import {
    actionsAtom,
    resolvePillsToPromptActionsAtom,
    sendComposedMessageAtom,
    stageActionPillAtom,
} from '../../../react/atoms/actions';
import {
    currentMessageItemsAtom,
    pendingPillInsertAtom,
} from '../../../react/atoms/messageComposition';
import { resolvePromptVariables } from '../../../react/utils/promptVariables';
import type { Action } from '../../../react/types/actions';

const sendWSMessageMock = (await import('../../../react/atoms/agentRunAtoms') as any).__sendWSMessageMock as ReturnType<typeof vi.fn>;
const addPopupMessageMock = (await import('../../../react/utils/popupMessageUtils') as any).__addPopupMessageMock as ReturnType<typeof vi.fn>;
const { isRejectedItemValidation } = await import('../../../react/atoms/itemValidation') as any;

const summarizeAction: Action = {
    id: 'custom-1',
    title: 'Summarize',
    text: 'Summarize the {{selected_items}}.',
    targets: ['items'],
    category: 'research',
};

function makeStore(actions: Action[] = [summarizeAction]) {
    const store = createStore();
    store.set(actionsAtom, actions);
    return store;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('sendComposedMessageAtom', () => {
    it('keeps pill tokens verbatim in content and sends structured actions', async () => {
        const store = makeStore();
        const ok = await store.set(sendComposedMessageAtom, {
            baseText: '/summarize and focus on methods ',
            pills: [{ commandName: 'summarize', actionId: 'custom-1', targetType: 'items', title: 'Summarize' }],
        });
        expect(ok).toBe(true);
        expect(sendWSMessageMock).toHaveBeenCalledTimes(1);
        const [message, options] = sendWSMessageMock.mock.calls[0];
        expect(message).toBe('/summarize and focus on methods');
        expect(options.actions).toEqual([{
            command: 'summarize',
            action_id: 'custom-1',
            title: 'Summarize',
            prompt: 'resolved:Summarize the {{selected_items}}.',
            target_type: 'items',
            category: 'research',
        }]);
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
        await store.set(sendComposedMessageAtom, {
            baseText: '/summarize then /summarize',
            pills: [
                { commandName: 'summarize', actionId: 'custom-1', title: 'Summarize' },
                { commandName: 'summarize', actionId: 'custom-1', title: 'Summarize' },
            ],
        });
        expect(sendWSMessageMock.mock.calls[0][1].actions).toHaveLength(1);
        expect(resolvePromptVariables).toHaveBeenCalledTimes(1);
    });

    it('aborts without sending when a variable resolves to no items', async () => {
        vi.mocked(resolvePromptVariables).mockResolvedValueOnce({
            text: 'x',
            items: [],
            collection: null,
            emptyItemVariables: ['selected_items'],
        } as any);
        const store = makeStore();
        const ok = await store.set(sendComposedMessageAtom, {
            baseText: '/summarize',
            pills: [{ commandName: 'summarize', actionId: 'custom-1' }],
        });
        expect(ok).toBe(false);
        expect(sendWSMessageMock).not.toHaveBeenCalled();
        expect(addPopupMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
    });

    it('aborts without sending when a resolved item is rejected by validation', async () => {
        const item = { libraryID: 1, key: 'ABC' };
        vi.mocked(resolvePromptVariables).mockResolvedValueOnce({
            text: 'x',
            items: [item],
            collection: null,
            emptyItemVariables: [],
        } as any);
        vi.mocked(isRejectedItemValidation).mockReturnValueOnce(true);
        const store = makeStore();
        const ok = await store.set(sendComposedMessageAtom, {
            baseText: '/summarize',
            pills: [{ commandName: 'summarize', actionId: 'custom-1' }],
        });
        expect(ok).toBe(false);
        expect(sendWSMessageMock).not.toHaveBeenCalled();
        expect(addPopupMessageMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });

    it('attaches resolved items to the current message', async () => {
        const item = { libraryID: 1, key: 'ABC' };
        vi.mocked(resolvePromptVariables).mockResolvedValueOnce({
            text: 'x',
            items: [item],
            collection: null,
            emptyItemVariables: [],
        } as any);
        const store = makeStore();
        await store.set(sendComposedMessageAtom, {
            baseText: '/summarize',
            pills: [{ commandName: 'summarize', actionId: 'custom-1' }],
        });
        expect(store.get(currentMessageItemsAtom)).toEqual([item]);
        expect(sendWSMessageMock).toHaveBeenCalled();
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
        expect(resolved?.actions[0].prompt).toBe('resolved:Summarize the {{selected_items}}.');
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
    it('stages a pill descriptor derived from the action title', () => {
        const store = makeStore();
        store.set(stageActionPillAtom, { actionId: 'custom-1', targetType: 'items' });
        const pending = store.get(pendingPillInsertAtom) as any;
        expect(pending.descriptor).toMatchObject({
            commandName: 'summarize',
            actionId: 'custom-1',
            targetType: 'items',
            title: 'Summarize',
        });
    });

    it('uses the fallback title when the action is unknown', () => {
        const store = makeStore([]);
        store.set(stageActionPillAtom, { actionId: 'missing', fallbackTitle: 'My Skill' });
        const pending = store.get(pendingPillInsertAtom) as any;
        expect(pending.descriptor.commandName).toBe('my-skill');
        expect(pending.descriptor.title).toBe('My Skill');
    });
});
