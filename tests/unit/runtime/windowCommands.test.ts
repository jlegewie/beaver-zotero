import { beforeEach, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
const state = vi.hoisted(() => ({ store: undefined as any, load: vi.fn(), confirm: vi.fn() }));
vi.mock('../../../react/store', () => ({ store: {
    get: (...args: any[]) => state.store.get(...args),
    set: (...args: any[]) => state.store.set(...args),
} }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getHostWindow: () => ({ confirm: state.confirm }) }));
vi.mock('../../../react/atoms/threads', async () => ({
    loadThreadAtom: (await import('jotai')).atom(null, (_get, _set, request) => state.load(request)),
}));
vi.mock('../../../react/atoms/auth', async () => ({ userIdAtom: (await import('jotai')).atom('user') }));
import { windowCommands } from '../../../react/runtime/windowCommands';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { currentMessageContentAtom } from '../../../react/atoms/messageComposition';
import { windowSurfaceAtom } from '../../../react/atoms/windowSurface';

beforeEach(() => {
    state.store = createStore();
    state.load.mockReset().mockResolvedValue(true);
    state.confirm.mockReset().mockReturnValue(true);
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
    state.confirm.mockReturnValue(false);
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toEqual({ ok: false, canceled: true });
    expect(state.load).not.toHaveBeenCalled();
    expect(state.store.get(currentMessageContentAtom)).toBe('unsent draft');
});
it('keeps the current surface when stop-and-switch is canceled', async () => {
    await windowCommands['show-table']({ surface: { variant: 'search', table: { id: 'table', columns: [], rows: [] } as any } });
    state.load.mockResolvedValue(false);
    expect(await windowCommands['open-chat']({ threadId: 'requested' })).toEqual({ ok: false, canceled: true });
    expect(state.store.get(windowSurfaceAtom).kind).toBe('table');
});
it('reveals the same chat without replacing its draft or asking to switch', async () => {
    expect(await windowCommands['open-chat']({ threadId: 'current' })).toMatchObject({ ok: true });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(state.store.get(currentMessageContentAtom)).toBe('unsent draft');
});
