import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/getAPIBaseURL', () => ({
    default: 'https://api.example.com',
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

import {
    clearBackendHttpSuccess,
    recordBackendHttpSuccess,
} from '../../../src/services/backendReachability';
import { reportConnectionFailure } from '../../../src/services/diagnosticsService';
import type { ConnectionFailureEvidence } from '../../../src/services/connectionFailure';

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
};

describe('reportConnectionFailure', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        clearBackendHttpSuccess();
    });

    it('sends lifecycle evidence and recent profile reachability to the backend', async () => {
        recordBackendHttpSuccess('profile', Date.now() - 1_000);
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await reportConnectionFailure({
            evidence,
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
            phase: 'connect',
            stage: 'opening',
            close_code: 1006,
            socket_opened: false,
            ready_received: false,
            timed_out: false,
            run_id: 'run-1',
            prior_backend_http_success_source: 'profile',
        });
        expect(body.prior_backend_http_success_age_ms).toBeGreaterThanOrEqual(
            1_000,
        );
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
});
