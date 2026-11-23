/**
 * A token refresh that fails for a reason other than the auth server rejecting
 * the refresh token must keep the saved session.
 */
import { describe, expect, it, vi } from 'vitest';
import { GoTrueClient } from '@supabase/auth-js';
import {
    guardTokenRefreshFetch,
    isAuthServerRejection,
    isTokenRefreshRequest,
} from '@beaver/agent-core/transport/tokenRefreshFetch';

const AUTH_URL = 'https://project.supabase.co/auth/v1';
const REFRESH_URL = `${AUTH_URL}/token?grant_type=refresh_token`;
const STORAGE_KEY = 'sb-project-auth-token';

const respond = (status: number, body: string, contentType?: string) =>
    new Response(body, {
        status,
        headers: contentType ? { 'content-type': contentType } : {},
    });
const json = (status: number, body: unknown) =>
    respond(status, JSON.stringify(body), 'application/json; charset=utf-8');

describe('guardTokenRefreshFetch', () => {
    it('recognizes only refresh-token grants', () => {
        expect(isTokenRefreshRequest(REFRESH_URL)).toBe(true);
        expect(isTokenRefreshRequest({ url: REFRESH_URL })).toBe(true);
        expect(isTokenRefreshRequest(`${AUTH_URL}/token?grant_type=password`)).toBe(false);
        expect(isTokenRefreshRequest('https://project.supabase.co/rest/v1/profiles')).toBe(false);
    });

    it('treats only a JSON client error as the auth server rejecting the token', () => {
        expect(isAuthServerRejection(json(400, { error_code: 'refresh_token_not_found' }))).toBe(true);
        expect(isAuthServerRejection(json(403, { error_code: 'session_expired' }))).toBe(true);
        expect(isAuthServerRejection(respond(403, '<html>Blocked</html>', 'text/html'))).toBe(false);
        expect(isAuthServerRejection(respond(400, 'bad', undefined))).toBe(false);
        expect(isAuthServerRejection(json(429, { error_code: 'over_request_rate_limit' }))).toBe(false);
        expect(isAuthServerRejection(json(408, {}))).toBe(false);
        expect(isAuthServerRejection(json(500, { msg: 'Database error' }))).toBe(false);
        expect(isAuthServerRejection(respond(522, '', 'text/html'))).toBe(false);
    });

    it.each([
        ['a server error', () => json(500, { msg: 'Database error' })],
        ['a CDN error page', () => respond(522, '<html>timed out</html>', 'text/html')],
        ['rate limiting', () => json(429, { error_code: 'over_request_rate_limit' })],
        ['a firewall block page', () => respond(403, '<html>Access denied</html>', 'text/html')],
    ])('turns %s on a refresh into a network failure', async (_label, make) => {
        const guarded = guardTokenRefreshFetch(vi.fn(async () => make()) as any);
        await expect(guarded(REFRESH_URL, { method: 'POST' })).rejects.toBeInstanceOf(TypeError);
    });

    it('passes through successes, rejections and every other request unchanged', async () => {
        const ok = json(200, { access_token: 'a' });
        const rejected = json(400, { error_code: 'refresh_token_already_used' });
        const other = respond(500, 'fail', 'text/plain');
        const base = vi.fn()
            .mockResolvedValueOnce(ok)
            .mockResolvedValueOnce(rejected)
            .mockResolvedValueOnce(other);
        const guarded = guardTokenRefreshFetch(base as any);
        await expect(guarded(REFRESH_URL)).resolves.toBe(ok);
        await expect(guarded(REFRESH_URL)).resolves.toBe(rejected);
        await expect(guarded(`${AUTH_URL}/token?grant_type=password`)).resolves.toBe(other);
        expect(base).toHaveBeenCalledTimes(3);
    });
});

describe('refresh failures through auth-js', () => {
    const expiredSession = () => ({
        access_token: 'expired-access',
        refresh_token: 'saved-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) - 600,
        user: { id: 'user-1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' },
    });

    const clientWith = async (response: () => Response, guard: boolean) => {
        const values = new Map<string, string>([[STORAGE_KEY, JSON.stringify(expiredSession())]]);
        const storage = {
            getItem: async (key: string) => values.get(key) ?? null,
            setItem: async (key: string, value: string) => { values.set(key, value); },
            removeItem: async (key: string) => { values.delete(key); },
        };
        const base = vi.fn(async () => response());
        const client = new GoTrueClient({
            url: AUTH_URL,
            storageKey: STORAGE_KEY,
            storage,
            autoRefreshToken: false,
            persistSession: true,
            detectSessionInUrl: false,
            fetch: (guard ? guardTokenRefreshFetch(base as any) : base) as any,
        });
        await client.initialize();
        return { client, values, base };
    };

    it('deletes the saved session on a proxy page without the guard', async () => {
        const { client, values } = await clientWith(() => respond(403, '<html>Blocked</html>', 'text/html'), false);
        const { error } = await client.getSession();
        expect(error?.name).toBe('AuthUnknownError');
        expect(values.has(STORAGE_KEY)).toBe(false);
    });

    it.each([
        ['a firewall block page', () => respond(403, '<html>Blocked</html>', 'text/html')],
        ['a server error', () => json(500, { msg: 'Database error' })],
        ['rate limiting', () => json(429, { error_code: 'over_request_rate_limit' })],
    ])('keeps the saved session through %s', async (_label, make) => {
        const { client, values, base } = await clientWith(make, true);
        vi.useFakeTimers();
        let result: Awaited<ReturnType<typeof client.getSession>>;
        try {
            // auth-js retries a network failure with backoff for one refresh tick (30 s).
            const pending = client.getSession();
            await vi.advanceTimersByTimeAsync(31_000);
            result = await pending;
        } finally {
            vi.useRealTimers();
        }
        const { data, error } = result;
        expect(base.mock.calls.length).toBeGreaterThan(1);
        expect(data.session).toBeNull();
        expect(error?.name).toBe('AuthRetryableFetchError');
        expect(values.has(STORAGE_KEY)).toBe(true);
    });

    it('still signs out when the auth server rejects the refresh token', async () => {
        const { client, values } = await clientWith(
            () => json(400, { code: 'refresh_token_not_found', error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }),
            true,
        );
        const { error } = await client.getSession();
        expect(error?.name).toBe('AuthApiError');
        expect(values.has(STORAGE_KEY)).toBe(false);
    });
});
