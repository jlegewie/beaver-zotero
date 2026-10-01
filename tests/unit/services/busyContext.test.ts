import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getBusyContext,
    stopBusyContextHeartbeat,
} from '../../../src/services/busyContext';

describe('getBusyContext extraction stats', () => {
    afterEach(() => {
        stopBusyContextHeartbeat();
        delete (Zotero as any).__beaverMuPDFWorkerClient_hot;
        delete (Zotero as any).__beaverMuPDFWorkerClient_background;
        vi.useRealTimers();
    });

    it('reports per-slot pending counts and oldest operation ages', () => {
        vi.useFakeTimers();
        vi.setSystemTime(20_000);
        (Zotero as any).__beaverMuPDFWorkerClient_hot = {
            inFlight: 2,
            oldestInFlightStartedAt: 17_500,
            hasWorker: true,
            totalSpawnCount: 3,
            totalLeaseReapCount: 1,
        };
        (Zotero as any).__beaverMuPDFWorkerClient_background = {
            inFlight: 1,
            oldestInFlightStartedAt: 19_200,
            hasWorker: false,
            totalSpawnCount: 5,
            totalLeaseReapCount: 0,
        };

        expect(getBusyContext()).toMatchObject({
            busy_extracting: 1,
            extracting_hot_pending: 2,
            extracting_background_pending: 1,
            extracting_hot_oldest_ms: 2_500,
            extracting_background_oldest_ms: 800,
            extracting_hot_has_worker: 1,
            extracting_hot_spawn_count: 3,
            extracting_hot_lease_reap_count: 1,
            extracting_background_has_worker: 0,
            extracting_background_spawn_count: 5,
            extracting_background_lease_reap_count: 0,
        });
    });

    it('returns zero ages when both workers are idle', () => {
        (Zotero as any).__beaverMuPDFWorkerClient_hot = {
            inFlight: 0,
            oldestInFlightStartedAt: 10,
        };

        expect(getBusyContext()).toMatchObject({
            busy_extracting: 0,
            extracting_hot_pending: 0,
            extracting_background_pending: 0,
            extracting_hot_oldest_ms: 0,
            extracting_background_oldest_ms: 0,
        });
    });

    it('defaults worker-health counters to zero when clients lack them', () => {
        (Zotero as any).__beaverMuPDFWorkerClient_hot = {
            inFlight: 1,
            oldestInFlightStartedAt: Date.now(),
        };

        expect(getBusyContext()).toMatchObject({
            extracting_hot_has_worker: 0,
            extracting_hot_spawn_count: 0,
            extracting_hot_lease_reap_count: 0,
            extracting_background_has_worker: 0,
            extracting_background_spawn_count: 0,
            extracting_background_lease_reap_count: 0,
        });
    });
});

describe('getBusyContext write queue', () => {
    let previousBeaver: unknown;

    beforeEach(() => {
        previousBeaver = (Zotero as any).Beaver;
        (Zotero as any).Beaver = {};
    });

    afterEach(() => {
        stopBusyContextHeartbeat();
        (Zotero as any).Beaver = previousBeaver;
        vi.useRealTimers();
    });

    it('reports a write holding the queue, its age, the writes behind it and the sync pause', () => {
        vi.useFakeTimers();
        vi.setSystemTime(700_000);
        (Zotero as any).Beaver.mutations = {
            getSnapshot: () => ({ active: 'mutation:1', activeStartedAt: 100_000, pending: 2, closing: false }),
        };
        (Zotero as any).Beaver.syncPause = { isSyncPaused: () => true };

        expect(getBusyContext()).toMatchObject({
            mutation_active: 1,
            mutation_active_ms: 600_000,
            mutation_pending: 2,
            sync_paused: 1,
        });
    });

    it('reads zero when the queue is idle or the services are missing', () => {
        expect(getBusyContext()).toMatchObject({
            mutation_active: 0,
            mutation_active_ms: 0,
            mutation_pending: 0,
            sync_paused: 0,
        });
    });
});
