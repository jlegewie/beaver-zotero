import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), start: vi.fn(), harness: vi.fn() }));
import { handleTestVoiceHttpRequest } from '../../../react/hooks/httpHandlers/testVoiceHandlers';

beforeEach(() => {
    vi.clearAllMocks();
    (Zotero as any).Beaver = { account: { getSnapshot: () => ({ session: mocks.get() }) }, data: { env: 'development' }, voice: { start: mocks.start }, voiceHarness: { run: mocks.harness, start: mocks.start } };
});
it('rejects production requests before invoking any voice operation', async () => {
    (Zotero.Beaver.data as any).env = 'production';
    await expect(handleTestVoiceHttpRequest({ command: 'start' })).rejects.toThrow('unavailable');
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.harness).not.toHaveBeenCalled();
});
it('uses only a fake credential and the current user for synthetic sessions', async () => {
    mocks.get.mockReturnValue({ user: { id: 'user' }, access_token: 'real-secret' });
    await handleTestVoiceHttpRequest({ command: 'start' });
    expect(mocks.start.mock.calls[0][0]).toBe('user');
    const getAuth = mocks.start.mock.calls[0][1];
    expect(await getAuth()).toEqual({ userId: 'user', credential: 'fake-only' });
    mocks.get.mockReturnValue(null);
    expect(await getAuth()).toBeNull();
});

it('rejects a start without a signed-in identity', async () => {
    mocks.get.mockReturnValue(null);
    expect(await handleTestVoiceHttpRequest({ command: 'start' })).toMatchObject({ result: { error: { code: 'unauthenticated' } } });
    expect(mocks.start).not.toHaveBeenCalled();
});
