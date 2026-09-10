import { beforeEach, expect, it, vi } from 'vitest';
import { borrowedWindowCommandError } from '../../../react/hooks/httpHandlers/borrowedWindowCommand';
import { handleTestOpenTableHttpRequest, handleTestCloseTableHttpRequest } from '../../../react/hooks/httpHandlers/testTableHandlers';
import { handleTestBeaverWindowHttpRequest } from '../../../react/hooks/httpHandlers/testApplicationStateHandlers';
import { store } from '../../../react/store';
import { BeaverUIFactory } from '../../../src/ui/ui';
import { openBeaverWindow } from '../../../react/ui/openBeaverWindow';

const state = vi.hoisted(() => ({ runtime: undefined as any, existing: undefined as any }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => state.runtime, getContextWindow: () => state.runtime.contextWindow }));
vi.mock('../../../src/ui/ui', () => ({ BeaverUIFactory: { findBeaverWindow: () => state.existing, closeBeaverWindow: vi.fn() } }));
vi.mock('../../../react/ui/openBeaverWindow', () => ({ openBeaverWindow: vi.fn() }));
vi.mock('../../../react/store', () => ({ store: { set: vi.fn(), get: vi.fn() } }));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({ getSearchableLibraryIds: vi.fn(() => []) }));
vi.mock('../../../react/atoms/applicationState', () => ({ getApplicationStateProvider: vi.fn() }));
vi.mock('../../../react/atoms/messageComposition', () => ({ currentReaderAttachmentAtom: {}, isReaderLibrarySearchable: vi.fn(), readerTextSelectionAtom: {} }));
vi.mock('../../../react/atoms/profile', () => ({ searchableLibraryIdsAtom: {} }));
vi.mock('../../../react/atoms/ui', () => ({ isBeaverUIVisibleAtom: {}, isBeaverWindowOpenAtom: {}, isLibraryTabAtom: {}, isSidebarVisibleAtom: {} }));
vi.mock('../../../react/atoms/zoteroContext', () => ({ currentNoteItemAtom: {} }));
vi.mock('../../../react/utils/readerUtils', () => ({ getCurrentReader: vi.fn() }));

let owner: any;
beforeEach(() => {
    vi.clearAllMocks();
    owner = { closed: false };
    state.runtime = { contextWindow: owner };
    state.existing = { closed: false, __beaverOwnerWindowRef: new WeakRef({ closed: false }) };
});
it('rejects a live singleton owned by another renderer', () => {
    expect(borrowedWindowCommandError()).toEqual({ ok: false, error: 'window_owned_by_another_renderer' });
    state.existing.__beaverOwnerWindowRef = new WeakRef(owner);
    expect(borrowedWindowCommandError()).toBeNull();
    state.existing = undefined;
    expect(borrowedWindowCommandError()).toBeNull();
    owner.closed = true;
    expect(borrowedWindowCommandError()).toEqual({ ok: false, error: 'window_unavailable' });
});
it.each(['table-open', 'table-close', 'window-open', 'window-close'])('refuses %s without writing to a foreign renderer or waiting on the wrong store', async command => {
    const result = command === 'table-open' ? await handleTestOpenTableHttpRequest()
        : command === 'table-close' ? await handleTestCloseTableHttpRequest()
        : await handleTestBeaverWindowHttpRequest({ open: command === 'window-open' });
    expect(result).toEqual({ ok: false, error: 'window_owned_by_another_renderer' });
    expect(store.set).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(openBeaverWindow).not.toHaveBeenCalled();
    expect(BeaverUIFactory.closeBeaverWindow).not.toHaveBeenCalled();
});
it('stages and opens a table in its own renderer', async () => {
    state.existing.__beaverOwnerWindowRef = new WeakRef(owner);
    const result = await handleTestOpenTableHttpRequest({ table: { id: 'test', columns: [], rows: [] } as any });
    expect(result.ok).toBe(true);
    expect(store.set).toHaveBeenCalledOnce();
    expect(openBeaverWindow).toHaveBeenCalledOnce();
});
it('rechecks ownership after asynchronous demo construction', async () => {
    const foreign = state.existing;
    state.existing = undefined;
    const pending = handleTestOpenTableHttpRequest();
    state.existing = foreign;
    expect(await pending).toEqual({ ok: false, error: 'window_owned_by_another_renderer' });
    expect(store.set).not.toHaveBeenCalled();
    expect(openBeaverWindow).not.toHaveBeenCalled();
});
