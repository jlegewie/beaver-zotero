import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';

const { mockSupabase } = vi.hoisted(() => ({
    mockSupabase: {
        auth: {
            getSession: vi.fn(),
            refreshSession: vi.fn(),
        },
    },
}));

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: mockSupabase,
}));

import { SessionExpiredError, SessionRefreshError } from '../../../react/types/apiErrors';
import { ApiService } from '../../../src/services/apiService';
import { getRuntimeAdapter, setRuntimeAdapter, type RuntimeAdapter } from '../../../src/platform/runtime';

describe('ApiService authentication recovery', () => {
    let service: ApiService;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        service = new ApiService('https://api.example.com');
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        mockSupabase.auth.getSession.mockReset();
        mockSupabase.auth.refreshSession.mockReset();

        mockSupabase.auth.getSession.mockResolvedValue({
            data: {
                session: {
                    access_token: 'stale-token',
                    expires_at: Math.floor(Date.now() / 1000) + 3600,
                },
            },
            error: null,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('refreshes and retries once when the backend returns 401', async () => {
        mockSupabase.auth.refreshSession.mockResolvedValue({
            data: {
                session: {
                    access_token: 'fresh-token',
                },
            },
            error: null,
        });

        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({
                detail: 'token has expired',
            }), {
                status: 401,
                statusText: 'Unauthorized',
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                ok: true,
            }), {
                status: 200,
                statusText: 'OK',
            }));

        const result = await service.post<{ ok: boolean }>('/api/v1/account/profile', {
            zotero_local_id: 'local-id',
        });

        expect(result).toEqual({ ok: true });
        expect(mockSupabase.auth.refreshSession).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
            Authorization: 'Bearer stale-token',
        });
        expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
            Authorization: 'Bearer fresh-token',
        });
        expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({
            zotero_local_id: 'local-id',
        }));
    });

    it('throws SessionExpiredError when refresh fails after a 401 response', async () => {
        mockSupabase.auth.refreshSession.mockResolvedValue({
            data: {
                session: null,
            },
            error: new AuthApiError('Invalid Refresh Token: Already Used', 400, 'refresh_token_not_found'),
        });

        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            detail: 'token has expired',
        }), {
            status: 401,
            statusText: 'Unauthorized',
        }));

        await expect(service.post('/api/v1/account/profile', {
            zotero_local_id: 'local-id',
        })).rejects.toBeInstanceOf(SessionExpiredError);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws SessionRefreshError when refresh fails with a retryable auth error', async () => {
        mockSupabase.auth.refreshSession.mockResolvedValue({
            data: {
                session: null,
            },
            error: new AuthRetryableFetchError('Temporary auth outage', 503),
        });

        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            detail: 'token has expired',
        }), {
            status: 401,
            statusText: 'Unauthorized',
        }));

        await expect(service.post('/api/v1/account/profile', {
            zotero_local_id: 'local-id',
        })).rejects.toBeInstanceOf(SessionRefreshError);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws SessionExpiredError when the retry still returns 401', async () => {
        mockSupabase.auth.refreshSession.mockResolvedValue({
            data: {
                session: {
                    access_token: 'fresh-token',
                },
            },
            error: null,
        });

        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({
                detail: 'token has expired',
            }), {
                status: 401,
                statusText: 'Unauthorized',
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                detail: 'token has expired',
            }), {
                status: 401,
                statusText: 'Unauthorized',
            }));

        await expect(service.post('/api/v1/account/profile', {
            zotero_local_id: 'local-id',
        })).rejects.toBeInstanceOf(SessionExpiredError);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws SessionRefreshError when getSession fails before the request is sent', async () => {
        mockSupabase.auth.getSession.mockResolvedValue({
            data: {
                session: null,
            },
            error: new Error('Transient storage error'),
        });

        await expect(service.post('/api/v1/account/profile', {
            zotero_local_id: 'local-id',
        })).rejects.toBeInstanceOf(SessionRefreshError);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws SessionExpiredError when getSession surfaces a non-retryable auth failure', async () => {
        mockSupabase.auth.getSession.mockResolvedValue({
            data: {
                session: null,
            },
            error: new AuthApiError('Invalid Refresh Token: Already Used', 400, 'refresh_token_not_found'),
        });

        await expect(service.post('/api/v1/account/profile', {
            zotero_local_id: 'local-id',
        })).rejects.toBeInstanceOf(SessionExpiredError);

        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('ApiService version headers', () => {
    let service: ApiService;
    let fetchMock: ReturnType<typeof vi.fn>;
    let originalAdapter: RuntimeAdapter;

    beforeEach(() => {
        originalAdapter = getRuntimeAdapter();

        service = new ApiService('https://api.example.com');
        fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            statusText: 'OK',
        }));
        vi.stubGlobal('fetch', fetchMock);

        mockSupabase.auth.getSession.mockReset();
        mockSupabase.auth.getSession.mockResolvedValue({
            data: {
                session: {
                    access_token: 'stale-token',
                    expires_at: Math.floor(Date.now() / 1000) + 3600,
                },
            },
            error: null,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setRuntimeAdapter(originalAdapter);
    });

    async function sentHeaders(): Promise<Record<string, string>> {
        await service.get('/api/v1/status');
        return fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    }

    it('attaches both version headers when the adapter reports both', async () => {
        setRuntimeAdapter({
            ...originalAdapter,
            getVersionHeaders: () => ({
                'X-Zotero-Version': '7.0.1',
                'X-Beaver-Version': '0.22.3',
            }),
        });

        const headers = await sentHeaders();
        expect(headers).toMatchObject({
            'X-Zotero-Version': '7.0.1',
            'X-Beaver-Version': '0.22.3',
        });
    });

    it('omits the plugin version header when the adapter does not report it', async () => {
        setRuntimeAdapter({
            ...originalAdapter,
            getVersionHeaders: () => ({
                'X-Zotero-Version': '7.0.1',
            }),
        });

        const headers = await sentHeaders();
        expect(headers['X-Zotero-Version']).toBe('7.0.1');
        expect(headers['X-Beaver-Version']).toBeUndefined();
    });

    it('omits the Zotero version header when the adapter does not report it', async () => {
        setRuntimeAdapter({
            ...originalAdapter,
            getVersionHeaders: () => ({
                'X-Beaver-Version': '0.22.3',
            }),
        });

        const headers = await sentHeaders();
        expect(headers['X-Beaver-Version']).toBe('0.22.3');
        expect(headers['X-Zotero-Version']).toBeUndefined();
    });

    it('omits both headers when the adapter reports nothing', async () => {
        setRuntimeAdapter({
            ...originalAdapter,
            getVersionHeaders: () => ({}),
        });

        const headers = await sentHeaders();
        expect(headers['X-Zotero-Version']).toBeUndefined();
        expect(headers['X-Beaver-Version']).toBeUndefined();
    });

    // `fetch` resolves once response headers arrive, with the body still
    // streaming, so a deadline released at that point leaves a stalled body
    // read unbounded. Mirrors how a real `fetch` errors the body stream when
    // its signal aborts.
    /** Responds with the given status, then stalls the body until aborted. */
    function respondWithStalledBody(status: number, statusText: string) {
        let sawSignal: AbortSignal | undefined;
        fetchMock.mockImplementation((_url: string, init: RequestInit) => {
            sawSignal = init.signal ?? undefined;
            return Promise.resolve(
                new Response(
                    new ReadableStream({
                        start(controller) {
                            sawSignal?.addEventListener('abort', () =>
                                controller.error(new DOMException('Aborted', 'AbortError')),
                            );
                        },
                    }),
                    { status, statusText },
                ),
            );
        });
        return () => sawSignal;
    }

    it('keeps the deadline armed while the response body is read', async () => {
        const signal = respondWithStalledBody(200, 'OK');

        await expect(service.get('/api/v1/status', { timeoutMs: 20 }))
            .rejects.toBeInstanceOf(SessionRefreshError);
        expect(signal()?.aborted).toBe(true);
    });

    // The status arrives before the deadline expires, so without classifying at
    // the deadline this would surface as that status rather than as a timeout.
    it('reports a timeout, not the HTTP status, when an error body stalls', async () => {
        respondWithStalledBody(400, 'Bad Request');

        await expect(service.get('/api/v1/status', { timeoutMs: 20 }))
            .rejects.toBeInstanceOf(SessionRefreshError);
    });

    it('leaves requests unbounded when no deadline is given', async () => {
        await expect(service.get('/api/v1/status')).resolves.toEqual({ ok: true });
        expect(fetchMock.mock.calls[0][1].signal).toBeUndefined();
    });

    // getAuthHeaders() awaits supabase.auth.getSession() before any fetch
    // exists, so a stalled auth lookup never observes the abort signal —
    // only the deadline race can stop the caller from waiting on it.
    it('rejects with SessionRefreshError when the auth lookup stalls', async () => {
        mockSupabase.auth.getSession.mockReturnValue(new Promise(() => {}));

        await expect(service.get('/api/v1/status', { timeoutMs: 20 }))
            .rejects.toBeInstanceOf(SessionRefreshError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Same gap on the 401 retry path: refreshAccessToken() awaits
    // supabase.auth.refreshSession(), which also never sees the signal.
    it('rejects with SessionRefreshError when the 401 refresh stalls', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            detail: 'token has expired',
        }), {
            status: 401,
            statusText: 'Unauthorized',
        }));
        mockSupabase.auth.refreshSession.mockReturnValue(new Promise(() => {}));

        await expect(service.get('/api/v1/status', { timeoutMs: 20 }))
            .rejects.toBeInstanceOf(SessionRefreshError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('omits both headers when the adapter does not implement getVersionHeaders', async () => {
        const { getVersionHeaders, ...rest } = originalAdapter;
        setRuntimeAdapter(rest);

        const headers = await sentHeaders();
        expect(headers['X-Zotero-Version']).toBeUndefined();
        expect(headers['X-Beaver-Version']).toBeUndefined();
    });

    it('still sends the request when the adapter throws', async () => {
        setRuntimeAdapter({
            ...originalAdapter,
            getVersionHeaders: () => {
                throw new Error('host unavailable');
            },
        });

        const headers = await sentHeaders();
        expect(headers['Authorization']).toBe('Bearer stale-token');
        expect(headers['X-Zotero-Version']).toBeUndefined();
        expect(headers['X-Beaver-Version']).toBeUndefined();
    });
});
