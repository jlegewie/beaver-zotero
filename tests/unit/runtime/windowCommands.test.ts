import { beforeEach, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
const state = vi.hoisted(() => ({ store: undefined as any, load: vi.fn(), confirm: vi.fn(), alert: vi.fn(), focus: vi.fn() }));
vi.mock('../../../react/store', () => ({ store: {
    get: (...args: any[]) => state.store.get(...args),
    set: (...args: any[]) => state.store.set(...args),
    sub: (...args: any[]) => state.store.sub(...args),
} }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getHostWindow: () => ({ focus: state.focus, alert: state.alert, setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() }) }));
vi.mock('../../../react/atoms/threads', async () => ({
    loadThreadAtom: (await import('jotai')).atom(null, (_get, _set, request) => state.load(request)),
    threadNavigationSeqAtom: (await import('jotai')).atom(0),
}));
vi.mock('../../../react/atoms/auth', async () => ({ userIdAtom: (await import('jotai')).atom('user') }));
vi.mock('../../../react/events/eventManager', () => ({ eventManager: { dispatch: vi.fn() } }));
import { windowCommands } from '../../../react/runtime/windowCommands';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { currentMessageContentAtom } from '../../../react/atoms/messageComposition';

beforeEach(() => {
    state.store = createStore();
    state.load.mockReset().mockResolvedValue(true);
    vi.clearAllMocks();
    state.confirm.mockReset().mockReturnValue(0);
    (Zotero as any).Prompt = { confirm: state.confirm };
    state.store.set(currentThreadIdAtom, 'current');
    state.store.set(currentMessageContentAtom, 'unsent draft');
});
it('does not replace a draft when its owner cancels', async () => {
    state.confirm.mockReturnValue(1);
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toEqual({ ok: false, canceled: true });
    expect(state.load).not.toHaveBeenCalled();
    expect(state.store.get(currentMessageContentAtom)).toBe('unsent draft');
});
it('preserves the draft when loading fails', async () => {
    state.load.mockResolvedValue(false);
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toEqual({ ok: false, canceled: true });
    expect(state.store.get(currentMessageContentAtom)).toBe('unsent draft');
});
it('reveals the same chat without replacing its draft or asking to switch', async () => {
    expect(await windowCommands['open-chat']({ threadId: 'current' })).toMatchObject({ ok: true });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.load).toHaveBeenCalledWith(expect.objectContaining({ preserveDraft: true }));
    expect(state.store.get(currentMessageContentAtom)).toBe('unsent draft');
});

it('opens a chat whose response is still going, and the destination\'s own response goes on', async () => {
    // The destination shows the chat's session; nothing is stopped on either side.
    const { activeRunAtom } = await import('@beaver/agent-core/run-state/atoms');
    state.store.set(activeRunAtom, { id: 'destination-run', status: 'in_progress' });
    state.store.set(currentMessageContentAtom, '');
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toMatchObject({ ok: true });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.alert).not.toHaveBeenCalled();
    expect(state.load).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'requested', preserveDraft: false }));
});
it('does not prompt for whitespace and passes a guard that rejects later edits', async () => {
    state.store.set(currentMessageContentAtom, '  \n ');
    state.load.mockImplementation(async request => {
        expect(request.canCommit()).toBe(true);
        state.store.set(currentMessageContentAtom, 'new edit');
        expect(request.canCommit()).toBe(false);
        return false;
    });
    await windowCommands['open-chat']({ threadId: 'requested' });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.store.get(currentMessageContentAtom)).toBe('new edit');
});

it('preserves edits made while refreshing the same finished chat', async () => {
    state.load.mockImplementation(async request => {
        state.store.set(currentMessageContentAtom, 'newer same-chat draft');
        expect(request.preserveDraft).toBe(true);
        expect(request.canCommit()).toBe(true);
        return true;
    });
    expect(await windowCommands['open-chat']({ threadId: 'current' })).toMatchObject({ ok: true });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.store.get(currentMessageContentAtom)).toBe('newer same-chat draft');
});

it('rejects navigation during destination loading', async () => {
    const { threadNavigationSeqAtom } = await import('../../../react/atoms/threads');
    state.load.mockImplementation(async request => {
        state.store.set(threadNavigationSeqAtom, 1);
        expect(request.canCommit()).toBe(false);
        return false;
    });
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toMatchObject({ ok: false });
});
