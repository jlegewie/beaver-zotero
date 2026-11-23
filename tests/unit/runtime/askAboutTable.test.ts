/**
 * "Ask Beaver" from a table in its own window: the chat window's renderer
 * opens its chat with the table attached (the `ask-about-table` command), and
 * never attaches a table from an excluded library.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';

const state = vi.hoisted(() => ({
    store: undefined as any,
    attach: vi.fn(),
    dispatch: vi.fn(),
    win: undefined as any,
}));
vi.mock('../../../react/store', () => ({ store: {
    get: (...args: any[]) => state.store.get(...args),
    set: (...args: any[]) => state.store.set(...args),
    sub: (...args: any[]) => state.store.sub(...args),
} }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getHostWindow: () => state.win }));
vi.mock('../../../react/atoms/messageComposition', async () => {
    const { atom } = await import('jotai');
    return {
        addItemToCurrentMessageItemsAtom: atom(null, (_get, _set, item) => state.attach(item)),
        composerDraftAtom: atom(''),
        hasComposerDraftAtom: atom(false),
    };
});
vi.mock('../../../react/atoms/profile', async () => {
    const { atom } = await import('jotai');
    return { accountGenerationAtom: atom(0), searchableLibraryIdsAtom: atom([1]) };
});
vi.mock('../../../react/atoms/threads', async () => ({
    loadThreadAtom: (await import('jotai')).atom(null, () => undefined),
    threadNavigationSeqAtom: (await import('jotai')).atom(0),
}));
vi.mock('../../../react/atoms/auth', async () => ({ userIdAtom: (await import('jotai')).atom('user') }));
vi.mock('../../../src/services/threads/finishedChat', () => ({ isFinishedChat: vi.fn(), hasThreadWriter: () => false, RESPONSE_FINISH_MESSAGE: '' }));
vi.mock('../../../react/runtime/threadWriter', () => ({ currentWriter: () => null }));
vi.mock('../../../react/runtime/threadAdmission', async () => ({ threadAdmissionAtom: (await import('jotai')).atom(null) }));
vi.mock('../../../react/runtime/threadProjection', async () => ({ threadPresenceAtom: (await import('jotai')).atom({ claims: [] }) }));
vi.mock('../../../react/atoms/agentRunAtoms', async () => ({ isWSChatPendingAtom: (await import('jotai')).atom(false) }));
vi.mock('../../../react/events/eventManager', () => ({ eventManager: { dispatch: (...args: any[]) => state.dispatch(...args) } }));

import { windowCommands } from '../../../react/runtime/windowCommands';
import { isThreadListViewAtom } from '../../../react/atoms/ui';

const table = { id: 42, libraryID: 1, key: 'TABLEKEY' };

beforeEach(() => {
    vi.clearAllMocks();
    state.store = createStore();
    state.win = { closed: false, focus: vi.fn(), setTimeout: (fn: () => void) => fn() };
    (Zotero as any).Items = {
        getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) =>
            key === 'MISSING' ? false : { ...table, libraryID, key }),
    };
});

describe('asking Beaver about a table from its window', () => {
    it("opens this window's chat with the table attached and the cursor in the composer", async () => {
        await expect(windowCommands['ask-about-table']({ libraryID: 1, key: 'TABLEKEY' })).resolves.toEqual({ ok: true, attached: true });
        expect(state.win.focus).toHaveBeenCalled();
        // Only the table: the library selection is not auto-attached.
        expect(state.dispatch).toHaveBeenCalledWith('toggleChat', { forceOpen: true, skipAutoPopulate: true });
        expect(state.attach).toHaveBeenCalledWith(expect.objectContaining({ key: 'TABLEKEY' }));
        expect(state.dispatch).toHaveBeenLastCalledWith('focusInput', {});
    });

    it('leaves the chat history for the chat, so the composer is not covered', async () => {
        state.store.set(isThreadListViewAtom, true);
        await windowCommands['ask-about-table']({ libraryID: 1, key: 'TABLEKEY' });
        expect(state.store.get(isThreadListViewAtom)).toBe(false);
    });

    it('opens the chat without a table from an excluded library', async () => {
        await expect(windowCommands['ask-about-table']({ libraryID: 3, key: 'TABLEKEY' })).resolves.toEqual({ ok: true, attached: false });
        expect(state.dispatch).toHaveBeenCalledWith('toggleChat', { forceOpen: true, skipAutoPopulate: true });
        expect(state.attach).not.toHaveBeenCalled();
    });

    it('opens the chat without a table that no longer exists', async () => {
        await expect(windowCommands['ask-about-table']({ libraryID: 1, key: 'MISSING' })).resolves.toEqual({ ok: true, attached: false });
        expect(state.attach).not.toHaveBeenCalled();
    });

    it('does nothing in a window that is closing', async () => {
        state.win.__beaverRuntime = { status: 'closing' };
        await expect(windowCommands['ask-about-table']({ libraryID: 1, key: 'TABLEKEY' })).resolves.toEqual({ ok: false, canceled: true });
        expect(state.dispatch).not.toHaveBeenCalled();
    });
});
