import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ signOut: vi.fn(async () => ({ error: null })), loading: true }));
vi.mock('jotai', () => ({ useAtomValue: () => mocks.loading }));
vi.mock('../../../react/atoms/auth', () => ({ authLoadingAtom: {} }));
vi.mock('@beaver/agent-core/transport/credentials', () => ({ credentials: { signOut: mocks.signOut } }));
import { useAuth } from '../../../react/hooks/useAuth';
beforeEach(() => vi.clearAllMocks());
it('uses the instance credential command for sign-out', async () => {
    await useAuth().signOut();
    expect(mocks.signOut).toHaveBeenCalledOnce();
});
it('renders the initialization state projected by instance auth', () => {
    mocks.loading = true; expect(useAuth().loading).toBe(true);
    mocks.loading = false; expect(useAuth().loading).toBe(false);
});
