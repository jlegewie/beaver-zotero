import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

// =============================================================================
// Module mocks — mirror sendComposedMessage.test.ts so importing actions.ts
// doesn't drag in the WS / supabase / profile chains at import time.
// =============================================================================

vi.mock('../../../react/atoms/agentRunAtoms', async () => {
    const { atom } = await import('jotai');
    return { sendWSMessageAtom: atom(null, () => {}) };
});

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
    return { addPopupMessageAtom: atom(null, () => {}) };
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
    resolvePromptVariables: vi.fn(),
}));

vi.mock('../../../react/utils/actionVisibility', () => ({
    isActionVisible: vi.fn(() => true),
}));

vi.mock('../../../react/types/attachments/converters', () => ({
    toMessageAttachment: vi.fn(() => null),
}));

// The write path calls into actionStorage; capture the persisted customizations.
// `vi.hoisted` so the spy exists before the hoisted vi.mock factory runs.
const { saveActionCustomizationsMock } = vi.hoisted(() => ({ saveActionCustomizationsMock: vi.fn() }));
vi.mock('../../../react/types/actionStorage', () => ({
    // Return [] so saveActionsAtom's post-write refresh doesn't clobber the
    // seeded actions before we read importActionAtom's return value.
    getMergedActions: vi.fn(() => []),
    getActionCustomizations: vi.fn(() => ({ version: 1, overrides: {}, custom: [] })),
    saveActionCustomizations: saveActionCustomizationsMock,
    saveActionLastUsed: vi.fn(),
    isBuiltinAction: vi.fn((id: string) => id.startsWith('builtin-')),
}));

vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { searchableLibraryIdsAtom: atom<number[]>([1]) };
});

// =============================================================================
// Imports (after mocks)
// =============================================================================

import { actionsAtom, importActionAtom } from '../../../react/atoms/actions';
import { getActionCommand } from '../../../react/utils/slashCommands';
import type { Action } from '../../../react/types/actions';

const existing: Action = {
    id: 'custom-existing',
    title: 'Summarize',
    text: 'Summarize the items',
    name: 'summarize',
    targets: ['items'],
};

function makeStore(actions: Action[] = [existing]) {
    const store = createStore();
    store.set(actionsAtom, actions);
    return store;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('importActionAtom — conflict handling', () => {
    it('keeps a free id and a free command untouched', () => {
        const store = makeStore();
        const incoming: Action = { id: 'custom-fresh', title: 'Outline', text: 'Outline it', targets: ['global'] };
        const result = store.set(importActionAtom, incoming);
        expect(result.idReassigned).toBe(false);
        expect(result.commandRenamed).toBe(false);
        expect(result.action.id).toBe('custom-fresh');
        expect(result.command).toBe('outline');
        // A clash-free, title-derived command stays automatic (no explicit name).
        expect(result.action.name).toBeUndefined();
    });

    it('mints a new id when the incoming id collides with an existing custom action', () => {
        const store = makeStore();
        const incoming: Action = { id: 'custom-existing', title: 'Different', text: 'x', targets: ['global'] };
        const result = store.set(importActionAtom, incoming);
        expect(result.idReassigned).toBe(true);
        expect(result.action.id).not.toBe('custom-existing');
        expect(result.action.id.length).toBeGreaterThan(0);
    });

    it('mints a new id when the incoming id collides with a built-in', () => {
        const store = makeStore();
        const incoming: Action = { id: 'builtin-summarize', title: 'Mine', text: 'x', targets: ['global'] };
        const result = store.set(importActionAtom, incoming);
        expect(result.idReassigned).toBe(true);
        expect(result.action.id).not.toBe('builtin-summarize');
    });

    it('mints an id when the incoming id is empty', () => {
        const store = makeStore();
        const incoming: Action = { id: '', title: 'Mine', text: 'x', targets: ['global'] };
        const result = store.set(importActionAtom, incoming);
        expect(result.idReassigned).toBe(true);
        expect(result.action.id.length).toBeGreaterThan(0);
    });

    it('suffixes a colliding command and persists it as an explicit name', () => {
        const store = makeStore();
        // Same title → same derived command "summarize" as the existing action.
        const incoming: Action = { id: 'custom-2', title: 'Summarize', text: 'x', targets: ['global'] };
        const result = store.set(importActionAtom, incoming);
        expect(result.commandRenamed).toBe(true);
        expect(result.command).toBe('summarize-2');
        expect(result.action.name).toBe('summarize-2');
        expect(getActionCommand(result.action)).toBe('summarize-2');
    });

    it('walks the numeric suffix past multiple collisions', () => {
        const store = makeStore([
            existing,
            { id: 'c2', title: 'Summarize', text: 'x', name: 'summarize-2', targets: ['global'] },
        ]);
        const incoming: Action = { id: 'c3', title: 'Summarize', text: 'x', targets: ['global'] };
        const result = store.set(importActionAtom, incoming);
        expect(result.command).toBe('summarize-3');
    });

    it('strips runtime fields and assigns a default sortOrder', () => {
        const store = makeStore();
        const incoming: Action = {
            id: 'custom-fresh',
            title: 'Outline',
            text: 'x',
            targets: ['global'],
            lastUsed: '2024-01-01T00:00:00.000Z',
            deprecated: true,
            sortOrder: 5,
        };
        const result = store.set(importActionAtom, incoming);
        expect(result.action.lastUsed).toBeUndefined();
        expect(result.action.deprecated).toBeUndefined();
        expect(result.action.sortOrder).toBe(999);
    });

    it('never carries the built-in-only locked flag onto an imported copy', () => {
        const store = makeStore();
        const incoming: Action = { id: 'custom-fresh', title: 'Outline', text: 'x', targets: ['global'], locked: true };
        const result = store.set(importActionAtom, incoming);
        expect(result.action.locked).toBeUndefined();
        const saved = saveActionCustomizationsMock.mock.calls[0][0];
        expect('locked' in saved.custom[0]).toBe(false);
    });

    it('persists the imported action into custom customizations', () => {
        const store = makeStore();
        const incoming: Action = { id: 'custom-fresh', title: 'Outline', text: 'x', targets: ['global'] };
        store.set(importActionAtom, incoming);
        expect(saveActionCustomizationsMock).toHaveBeenCalledTimes(1);
        const saved = saveActionCustomizationsMock.mock.calls[0][0];
        expect(saved.custom.some((a: Action) => a.title === 'Outline')).toBe(true);
    });
});
