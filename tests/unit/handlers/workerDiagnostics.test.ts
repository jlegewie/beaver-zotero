import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockClient = {
    getStats: vi.fn(),
    inFlight: 2,
    oldestInFlightStartedAt: 0,
};

const getExistingMuPDFWorkerClient = vi.fn();

vi.mock('../../../src/beaver-extract', () => ({
    getExistingMuPDFWorkerClient: (...args: unknown[]) =>
        getExistingMuPDFWorkerClient(...args),
}));

import {
    collectWorkerDiagnostics,
    createWorkerDispatchFlag,
    withWorkerDiagnostics,
} from '../../../src/services/agentDataProvider/workerDiagnostics';
import type { WSWorkerDiagnostics } from '../../../src/services/agentProtocol';

interface TestResponse {
    error: string;
    error_code?: string;
    worker_diagnostics?: WSWorkerDiagnostics | null;
}

const STATS = {
    hasWorker: true,
    spawnCount: 7,
    retryCount: 3,
    consecutiveStartFailures: 0,
    leaseReapCount: 1,
    lastLeaseReapOp: 'extractSerialized',
    lastLeaseReapAgeMs: 65_123,
};

describe('collectWorkerDiagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClient.getStats.mockReturnValue(STATS);
        mockClient.inFlight = 2;
        mockClient.oldestInFlightStartedAt = 0;
        getExistingMuPDFWorkerClient.mockReturnValue(mockClient);
    });

    it('maps client stats to the snake_case wire shape', () => {
        mockClient.oldestInFlightStartedAt = Date.now() - 5_000;
        const diagnostics = collectWorkerDiagnostics('hot', true);

        expect(getExistingMuPDFWorkerClient).toHaveBeenCalledWith('hot');
        expect(diagnostics).toMatchObject({
            slot: 'hot',
            lease_reaped: true,
            lease_reap_count: 1,
            last_lease_reap_op: 'extractSerialized',
            last_lease_reap_age_ms: 65_123,
            spawn_count: 7,
            retry_count: 3,
            consecutive_start_failures: 0,
            has_worker: true,
            in_flight: 2,
        });
        expect(diagnostics!.oldest_in_flight_age_ms).toBeGreaterThanOrEqual(5_000);
    });

    it('reports a null oldest-in-flight age when the slot is idle', () => {
        const diagnostics = collectWorkerDiagnostics('hot', false);
        expect(diagnostics!.oldest_in_flight_age_ms).toBeNull();
        expect(diagnostics!.lease_reaped).toBe(false);
    });

    it('returns null when the slot has no client', () => {
        getExistingMuPDFWorkerClient.mockReturnValue(null);
        expect(collectWorkerDiagnostics('hot', false)).toBeNull();
    });

    it('never throws when stats collection fails', () => {
        mockClient.getStats.mockImplementation(() => {
            throw new Error('boom');
        });
        expect(collectWorkerDiagnostics('hot', false)).toBeNull();
    });
});

describe('withWorkerDiagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClient.getStats.mockReturnValue(STATS);
        getExistingMuPDFWorkerClient.mockReturnValue(mockClient);
    });

    it('attaches a hot-slot snapshot to the response', () => {
        const response = withWorkerDiagnostics(
            { error: 'timed out', error_code: 'timeout' } as TestResponse,
            { workerDispatched: true, leaseReaped: true },
        );
        expect(response.worker_diagnostics).toMatchObject({
            slot: 'hot',
            lease_reaped: true,
            spawn_count: 7,
        });
        expect(response.error).toBe('timed out');
    });

    it('returns the response unchanged when no client exists', () => {
        getExistingMuPDFWorkerClient.mockReturnValue(null);
        const original = { error: 'timed out' } as TestResponse;
        const response = withWorkerDiagnostics(original, {
            workerDispatched: true,
            leaseReaped: false,
        });
        expect(response).toBe(original);
        expect(response.worker_diagnostics).toBeUndefined();
    });

    it('does not attach a snapshot when the request never reached the worker', () => {
        const original = { error: 'timed out' } as TestResponse;
        const response = withWorkerDiagnostics(original, {
            workerDispatched: false,
            leaseReaped: false,
        });
        expect(response).toBe(original);
        expect(response.worker_diagnostics).toBeUndefined();
        expect(getExistingMuPDFWorkerClient).not.toHaveBeenCalled();
    });
});

describe('createWorkerDispatchFlag', () => {
    it('starts false', () => {
        const flag = createWorkerDispatchFlag();
        expect(flag.value).toBe(false);
    });

    it('flips to true after mark()', () => {
        const flag = createWorkerDispatchFlag();
        flag.mark();
        expect(flag.value).toBe(true);
    });

    it('stays true when mark() is called more than once', () => {
        const flag = createWorkerDispatchFlag();
        flag.mark();
        flag.mark();
        expect(flag.value).toBe(true);
    });
});
