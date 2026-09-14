import { beforeEach, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
const state = vi.hoisted(() => ({ store: undefined as any, load: vi.fn(), confirm: vi.fn(), finished: vi.fn(), writer: null as any, alert: vi.fn(), focus: vi.fn() }));
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
vi.mock('../../../src/services/threads/finishedChat', () => ({
    isFinishedChat: (...args: any[]) => state.finished(...args), hasThreadWriter: () => false,
    RESPONSE_FINISH_MESSAGE: 'Available when this response finishes.',
}));
vi.mock('../../../react/runtime/threadWriter', () => ({ currentWriter: () => state.writer }));
vi.mock('../../../react/runtime/threadAdmission', async () => ({ threadAdmissionAtom: (await import('jotai')).atom(null) }));
vi.mock('../../../react/runtime/threadProjection', async () => ({ threadPresenceAtom: (await import('jotai')).atom({ claims: [] }) }));
vi.mock('../../../react/atoms/agentRunAtoms', async () => ({ isWSChatPendingAtom: (await import('jotai')).atom(false) }));
vi.mock('../../../react/events/eventManager', () => ({ eventManager: { dispatch: vi.fn() } }));
import { windowCommands } from '../../../react/runtime/windowCommands';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { currentMessageContentAtom } from '../../../react/atoms/messageComposition';
import { windowSurfaceAtom } from '../../../react/atoms/windowSurface';

beforeEach(() => {
    state.store = createStore();
    state.load.mockReset().mockResolvedValue(true);
    vi.clearAllMocks();
    state.finished.mockReset().mockResolvedValue(true);
    state.writer = null;
    state.confirm.mockReset().mockReturnValue(0);
    (Zotero as any).Prompt = { confirm: state.confirm };
    state.store.set(currentThreadIdAtom, 'current');
    state.store.set(currentMessageContentAtom, 'unsent draft');
});
it('table and chat commands preserve the destination chat and draft', async () => {
    await windowCommands['show-table']({ surface: { variant: 'search', table: { id: 'table', columns: [], rows: [] } as any } });
    expect(state.store.get(windowSurfaceAtom).kind).toBe('table');
    await windowCommands['show-chat']();
    expect(state.store.get(windowSurfaceAtom).kind).toBe('thread');
    expect(state.store.get(currentThreadIdAtom)).toBe('current');
    expect(state.store.get(currentMessageContentAtom)).toBe('unsent draft');
    expect(state.load).not.toHaveBeenCalled();
});
it('does not replace a draft when its owner cancels', async () => {
    state.confirm.mockReturnValue(1);
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toEqual({ ok: false, canceled: true });
    expect(state.load).not.toHaveBeenCalled();
    expect(state.store.get(currentMessageContentAtom)).toBe('unsent draft');
});
it('reveals the composer and preserves its draft when loading fails', async () => {
    await windowCommands['show-table']({ surface: { variant: 'search', table: { id: 'table', columns: [], rows: [] } as any } });
    state.load.mockResolvedValue(false);
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toEqual({ ok: false, canceled: true });
    expect(state.store.get(windowSurfaceAtom).kind).toBe('thread');
    expect(state.store.get(currentMessageContentAtom)).toBe('unsent draft');
});
it('reveals the same chat without replacing its draft or asking to switch', async () => {
    expect(await windowCommands['open-chat']({ threadId: 'current' })).toMatchObject({ ok: true });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.load).toHaveBeenCalledWith(expect.objectContaining({ preserveDraft: true }));
    expect(state.store.get(currentMessageContentAtom)).toBe('unsent draft');
});

it('declines an unfinished requested chat before prompting or loading', async () => {
    state.finished.mockResolvedValue(false);
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toMatchObject({ ok: false });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.alert).toHaveBeenCalledWith('Available when this response finishes.');
});
it('keeps another destination response running without either confirmation', async () => {
    state.writer = {};
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toMatchObject({ ok: false });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.alert).toHaveBeenCalledWith('The Beaver window is responding to another chat. Try again when it finishes.');
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
it('rejects a draft edited and then restored during the initial server check', async () => {
    state.finished.mockImplementation(async () => {
        state.store.set(currentMessageContentAtom, 'changed');
        state.store.set(currentMessageContentAtom, 'unsent draft');
        return true;
    });
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toMatchObject({ ok: false });
    expect(state.load).not.toHaveBeenCalled();
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

it.each(['preparing', 'in_progress', 'awaiting_deferred', 'unknown', 'active'])('disables the menu while requested activity is %s', async phase => {
    const { canOpenFinishedChatAtom } = await import('../../../react/runtime/windowCommands');
    const { threadAdmissionAtom } = await import('../../../react/runtime/threadAdmission');
    const { isWSChatPendingAtom } = await import('../../../react/atoms/agentRunAtoms');
    const { activeRunAtom } = await import('@beaver/agent-core/run-state/atoms');
    state.store.set(threadAdmissionAtom, { threadId: 'current', tailRunId: null, activity: { state: 'idle', run_id: null } });
    expect(state.store.get(canOpenFinishedChatAtom)).toBe(true);
    if (phase === 'preparing') state.store.set(isWSChatPendingAtom, true);
    else if (phase === 'active' || phase === 'unknown') state.store.set(threadAdmissionAtom, { threadId: 'current', activity: { state: phase } });
    else state.store.set(activeRunAtom, { status: phase });
    expect(state.store.get(canOpenFinishedChatAtom)).toBe(false);
});

it('keeps failed availability checks separate from the displayed history tail', async () => {
    const { refreshFinishedChatAvailabilityAtom, canOpenFinishedChatAtom } = await import('../../../react/runtime/windowCommands');
    const { threadAdmissionAtom } = await import('../../../react/runtime/threadAdmission');
    const admission = { threadId: 'current', tailRunId: 'displayed', activity: { state: 'idle', run_id: null } };
    state.store.set(threadAdmissionAtom, admission);
    state.finished.mockResolvedValue(false);
    const refresh = state.store.set(refreshFinishedChatAvailabilityAtom);
    expect(state.store.get(canOpenFinishedChatAtom)).toBe(false);
    await refresh;
    expect(state.store.get(canOpenFinishedChatAtom)).toBe(false);
    expect(state.store.get(threadAdmissionAtom)).toBe(admission);
});

it.each(['navigation', 'account', 'admission'])('ignores availability received after %s changes', async change => {
    const { refreshFinishedChatAvailabilityAtom, canOpenFinishedChatAtom } = await import('../../../react/runtime/windowCommands');
    const { threadNavigationSeqAtom } = await import('../../../react/atoms/threads');
    const { accountGenerationAtom } = await import('../../../react/atoms/profile');
    const { threadAdmissionAtom } = await import('../../../react/runtime/threadAdmission');
    let finish!: (value: boolean) => void;
    state.finished.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const refresh = state.store.set(refreshFinishedChatAvailabilityAtom);
    if (change === 'navigation') state.store.set(threadNavigationSeqAtom, 1);
    else if (change === 'account') state.store.set(accountGenerationAtom, 1);
    else state.store.set(threadAdmissionAtom, { threadId: 'current', tailRunId: null, activity: { state: 'unknown', run_id: null } });
    finish(true);
    await refresh;
    expect(state.store.get(canOpenFinishedChatAtom)).toBe(false);
});

it('ignores an earlier availability result after a newer menu check', async () => {
    const { refreshFinishedChatAvailabilityAtom, canOpenFinishedChatAtom } = await import('../../../react/runtime/windowCommands');
    let finish!: (value: boolean) => void;
    state.finished.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(false);
    const older = state.store.set(refreshFinishedChatAvailabilityAtom);
    await state.store.set(refreshFinishedChatAvailabilityAtom);
    finish(true);
    await older;
    expect(state.store.get(canOpenFinishedChatAtom)).toBe(false);
});
