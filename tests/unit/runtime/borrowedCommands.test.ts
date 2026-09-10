import { beforeEach, expect, it, vi } from 'vitest';
import { openBeaverWindow } from '../../../react/ui/openBeaverWindow';
import { openPreferencesWindow } from '../../../react/ui/openPreferencesWindow';
import { notifyNavigationUnavailable } from '../../../react/utils/navigationNotice';
import { openBeaverWindow as openChat } from '../../../src/ui/openBeaverWindow';
import { openPreferencesWindow as openPreferences } from '../../../src/ui/openPreferencesWindow';
import { store } from '../../../react/store';

const state = vi.hoisted(() => ({ runtime: undefined as any }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ tryGetWindowRuntime: () => state.runtime }));
vi.mock('../../../src/ui/openBeaverWindow', () => ({ openBeaverWindow: vi.fn() }));
vi.mock('../../../src/ui/openPreferencesWindow', () => ({ openPreferencesWindow: vi.fn() }));
vi.mock('../../../react/store', () => ({ store: { set: vi.fn() } }));
vi.mock('../../../react/utils/popupMessageUtils', () => ({ addPopupMessageAtom: {} }));
beforeEach(() => { vi.clearAllMocks(); state.runtime = undefined; });

it('passes the renderer context to both window factories', () => {
    const owner = { closed: false };
    state.runtime = { contextWindow: owner };
    openBeaverWindow({ width: 900 });
    openPreferencesWindow('actions', '', 'action-id');
    expect(openChat).toHaveBeenCalledWith({ width: 900 }, owner);
    expect(openPreferences).toHaveBeenCalledWith('actions', '', 'action-id', owner);
});
it.each(['missing', 'closed'])('ignores late window commands when their renderer is %s', condition => {
    if (condition === 'closed') state.runtime = { contextWindow: { closed: true } };
    expect(() => openBeaverWindow()).not.toThrow();
    expect(() => openPreferencesWindow()).not.toThrow();
    expect(openChat).not.toHaveBeenCalled();
    expect(openPreferences).not.toHaveBeenCalled();
});
it('reports activation failures only in their live owning renderer', () => {
    const owner = { closed: false } as Window;
    const foreign = { closed: false } as Window;
    notifyNavigationUnavailable(owner);
    state.runtime = { contextWindow: owner };
    notifyNavigationUnavailable(foreign);
    expect(store.set).not.toHaveBeenCalled();
    notifyNavigationUnavailable(owner);
    expect(store.set).toHaveBeenCalledOnce();
    expect(vi.mocked(store.set).mock.calls[0][1]).toMatchObject({ id: 'navigation-window-unavailable', type: 'warning' });
    (owner as any).closed = true;
    notifyNavigationUnavailable(owner);
    expect(store.set).toHaveBeenCalledOnce();
});
