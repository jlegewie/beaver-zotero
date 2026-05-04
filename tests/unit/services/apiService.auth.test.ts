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

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: mockSupabase,
}));

import { SessionExpiredError, SessionRefreshError } from '../../../react/types/apiErrors';
import { ApiService } from '../../../src/services/apiService';

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
