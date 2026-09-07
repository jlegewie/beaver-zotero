import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    session: null as any,
    authChanged: vi.fn(), signOut: vi.fn(async () => ({ error: null })),
    callback: undefined as ((event: string, session: any) => void) | undefined,
}));
vi.mock('react', () => ({
    useEffect: (effect: () => void) => effect(),
    useState: (initial: unknown) => [initial, vi.fn()],
    useRef: (current: unknown) => ({ current }),
    useCallback: (callback: unknown) => callback,
}));
vi.mock('jotai', () => ({ useAtom: () => [mocks.session, vi.fn()], useSetAtom: () => vi.fn() }));
vi.mock('../../../react/atoms/auth', () => ({ sessionAtom: {}, resetLoginFormState: vi.fn() }));
vi.mock('../../../react/atoms/profile', () => ({ profileWithPlanAtom: {}, isProfileLoadedAtom: {}, profileSyncStatusAtom: {} }));
vi.mock('../../../react/atoms/threadList', () => ({ resetThreadStoreAtom: {} }));
vi.mock('../../../react/store', () => ({ store: { set: vi.fn() } }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({ supabase: { auth: {
    onAuthStateChange: (callback: typeof mocks.callback) => {
        mocks.callback = callback; return { data: { subscription: { unsubscribe: vi.fn() } } };
    },
    signOut: mocks.signOut,
} } }));

beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); mocks.session = null;
    (Zotero as any).Beaver = { voice: { authChanged: mocks.authChanged } };
});
it('revokes voice even when a sign-out event is deduplicated', async () => {
    const { useAuth } = await import('../../../react/hooks/useAuth'); useAuth();
    mocks.callback!('SIGNED_OUT', null);
    expect(mocks.authChanged).toHaveBeenCalledWith(null);
});
it('revokes voice on an account replacement but not token refresh', async () => {
    mocks.session = { user: { id: 'a' }, access_token: 'old' };
    const { useAuth } = await import('../../../react/hooks/useAuth'); useAuth();
    mocks.callback!('TOKEN_REFRESHED', { user: { id: 'a' }, access_token: 'new' });
    expect(mocks.authChanged).not.toHaveBeenCalled();
    mocks.callback!('SIGNED_IN', { user: { id: 'b' }, access_token: 'other' });
    expect(mocks.authChanged).toHaveBeenCalledWith('b');
});
it('revokes voice immediately when logout is requested', async () => {
    const { useAuth } = await import('../../../react/hooks/useAuth');
    const auth = useAuth(); await auth.signOut();
    expect(mocks.authChanged).toHaveBeenCalledWith(null);
    expect(mocks.authChanged.mock.invocationCallOrder[0]).toBeLessThan(mocks.signOut.mock.invocationCallOrder[0]);
});
