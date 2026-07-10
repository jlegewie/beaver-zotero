import { afterEach, describe, expect, it, vi } from 'vitest';
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
        };
        (Zotero as any).__beaverMuPDFWorkerClient_background = {
            inFlight: 1,
            oldestInFlightStartedAt: 19_200,
        };

        expect(getBusyContext()).toMatchObject({
            busy_extracting: 1,
            extracting_hot_pending: 2,
            extracting_background_pending: 1,
            extracting_hot_oldest_ms: 2_500,
            extracting_background_oldest_ms: 800,
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
});
