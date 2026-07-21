import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/getAPIBaseURL', () => ({
    default: 'https://api.example.com',
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
        },
    },
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    getZoteroUserIdentifier: vi.fn(),
}));

import {
    clearBackendHttpSuccess,
    recordBackendHttpSuccess,
} from '../../../src/services/backendReachability';
import {
    clearConnectionFailureReportState,
    reportConnectionFailure,
} from '../../../src/services/diagnosticsService';
import { supabase } from '../../../src/services/supabaseClient';
import { getZoteroUserIdentifier } from '../../../src/utils/zoteroUtils';
import type { ConnectionFailureEvidence } from '../../../src/services/connectionFailure';

const getSessionMock = vi.mocked(supabase.auth.getSession);
const getIdentifierMock = vi.mocked(getZoteroUserIdentifier);

const evidence: ConnectionFailureEvidence = {
    stage: 'opening',
    closeCode: 1006,
    closeReason: '',
    wasClean: false,
    socketOpened: false,
    readyReceived: false,
    timedOut: false,
    navigatorOnline: true,
    errorName: 'AgentConnectionError',
    wsUptimeMs: null,
    msSinceLastWsMessageMs: null,
};

describe('reportConnectionFailure', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        clearBackendHttpSuccess();
        clearConnectionFailureReportState();
        // Default: signed out — no token attached, identity available.
        getSessionMock.mockResolvedValue({
            data: { session: null },
            error: null,
        } as any);
        getIdentifierMock.mockReturnValue({
            userID: '5551234',
            localUserKey: 'aBcD1234',
            accountName: undefined,
            deviceName: undefined,
        } as any);
    });

    it('sends lifecycle evidence and recent profile reachability to the backend', async () => {
        recordBackendHttpSuccess('/api/v1/account/profile', Date.now() - 1_000);
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reportConnectionFailure({
            evidence: {
                ...evidence,
                stage: 'mid_run',
                socketOpened: true,
                readyReceived: true,
                wsUptimeMs: 184_000,
                msSinceLastWsMessageMs: 121_500,
            },
            run_id: 'run-1',
        });

        expect(result).toMatchObject({
            apiReachable: true,
            receivedHttpResponse: true,
            status: 204,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({
            phase: 'mid_run',
            stage: 'mid_run',
            close_code: 1006,
            socket_opened: true,
            ready_received: true,
            timed_out: false,
            ws_uptime_ms: 184_000,
            ms_since_last_ws_message_ms: 121_500,
            zotero_local_id: 'aBcD1234',
            zotero_user_id: '5551234',
            run_id: 'run-1',
            prior_backend_http_success_source: '/api/v1/account/profile',
        });
        expect(body.prior_backend_http_success_age_ms).toBeGreaterThanOrEqual(
            1_000,
        );
        expect(body.user_message).toBe(
            'The connection was lost before Beaver finished responding.',
        );
        expect(body.user_details).toContain(
            "Beaver's live connection was interrupted.",
        );
        expect(body.user_details).toContain('(error code 1006)');
        expect(body.user_details).not.toContain('<');
    });

    it('carries the connect attempt count when the caller retried before reporting', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);

        await reportConnectionFailure({
            evidence,
            run_id: 'run-3',
            connect_attempts: 3,
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body.connect_attempts).toBe(3);
    });

    it('reports connect_attempts as null when the caller does not track attempts', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);

        await reportConnectionFailure({ evidence });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body.connect_attempts).toBeNull();
    });

    it('attaches the cached session token so the backend can associate the user', async () => {
        getSessionMock.mockResolvedValue({
            data: { session: { access_token: 'cached-token' } },
            error: null,
        } as any);
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 202 }));
        vi.stubGlobal('fetch', fetchMock);

        await reportConnectionFailure({ evidence });

        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers).toMatchObject({
            Authorization: 'Bearer cached-token',
        });
    });

    it('still reports anonymously when the session lookup fails', async () => {
        getSessionMock.mockRejectedValue(new Error('auth stack broken'));
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 202 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reportConnectionFailure({ evidence });

        expect(result.apiReachable).toBe(true);
        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('still reports when the Zotero identity lookup throws', async () => {
        getIdentifierMock.mockImplementation(() => {
            throw new Error('Zotero not available');
        });
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 202 }));
        vi.stubGlobal('fetch', fetchMock);

        await reportConnectionFailure({ evidence });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body.zotero_local_id).toBeNull();
        expect(body.zotero_user_id).toBeNull();
    });

    it('returns failed fresh reachability evidence when the POST cannot connect', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockRejectedValue(new TypeError('connection refused')),
        );

        const result = await reportConnectionFailure({
            evidence,
            run_id: 'run-2',
        });

        expect(result).toMatchObject({
            apiReachable: false,
            receivedHttpResponse: false,
        });
    });

    it('distinguishes a non-2xx HTTP response from no HTTP response', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
        );

        const result = await reportConnectionFailure({ evidence });

        expect(result).toMatchObject({
            apiReachable: false,
            receivedHttpResponse: true,
            status: 503,
        });
    });

    describe('offline short-circuit', () => {
        it('resolves an unreachable result without calling fetch or looking up the session', async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);

            const result = await reportConnectionFailure({
                evidence: { ...evidence, navigatorOnline: false },
            });

            expect(result).toEqual({
                apiReachable: false,
                receivedHttpResponse: false,
                durationMs: 0,
            });
            expect(fetchMock).not.toHaveBeenCalled();
            expect(getSessionMock).not.toHaveBeenCalled();
        });
    });

    describe('in-flight sharing and cooldown', () => {
        it('shares the in-flight report between concurrent calls', async () => {
            let resolveFetch: (value: Response) => void = () => {};
            const fetchMock = vi.fn().mockReturnValue(
                new Promise<Response>((resolve) => {
                    resolveFetch = resolve;
                }),
            );
            vi.stubGlobal('fetch', fetchMock);

            const first = reportConnectionFailure({ evidence });
            const second = reportConnectionFailure({ evidence });

            resolveFetch(new Response(null, { status: 204 }));
            const [firstResult, secondResult] = await Promise.all([first, second]);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(secondResult).toBe(firstResult);
            expect(firstResult).toMatchObject({ apiReachable: true, status: 204 });
        });

        it('reuses an unreachable verdict for a failure within the cooldown window', async () => {
            const fetchMock = vi
                .fn()
                .mockRejectedValue(new TypeError('NetworkError'));
            vi.stubGlobal('fetch', fetchMock);

            const first = await reportConnectionFailure({ evidence });
            const second = await reportConnectionFailure({ evidence });

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(first.apiReachable).toBe(false);
            expect(second).toBe(first);
        });

        it('re-probes within the cooldown when the last report showed the API reachable', async () => {
            const fetchMock = vi
                .fn()
                .mockResolvedValue(new Response(null, { status: 204 }));
            vi.stubGlobal('fetch', fetchMock);

            const first = await reportConnectionFailure({ evidence });
            const second = await reportConnectionFailure({ evidence });

            expect(first.apiReachable).toBe(true);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(second).not.toBe(first);
        });

        it('runs a fresh report once the cooldown window has elapsed', async () => {
            const fetchMock = vi
                .fn()
                .mockRejectedValue(new TypeError('NetworkError'));
            vi.stubGlobal('fetch', fetchMock);

            let now = 1_000_000;
            vi.spyOn(Date, 'now').mockImplementation(() => now);

            await reportConnectionFailure({ evidence });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            now += 30_000; // matches the module's cooldown window
            await reportConnectionFailure({ evidence });

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });
});
